/**
 * Procedural auscultation sounds (PLACEHOLDERS — not recordings).
 *
 * Each generator returns float samples in [-1, 1] whose length is an exact number of
 * cardiac / respiratory cycles, and all events are mixed circularly, so the files loop
 * seamlessly with `audio.loop = true`.
 */
import { biquad, bandNoise, mulberry32, normalizePeak, smoothstep } from "./dsp.js";

export const SAMPLE_RATE = 22050;
/** Output peak level (fraction of full scale) — well below clipping. */
const PEAK = 0.85;

/** Add src into dst at offset, wrapping around the end (seamless loops). */
function mixCircular(dst: Float64Array, src: Float64Array, offset: number, gain = 1): void {
  const n = dst.length;
  for (let i = 0; i < src.length; i++) {
    const j = (((offset + i) % n) + n) % n;
    dst[j]! += src[i]! * gain;
  }
}

/** Band-limited noise of length n whose end flows smoothly into its start. */
function loopNoise(n: number, lo: number, hi: number, rand: () => number, order = 2): Float64Array {
  const m = Math.round(0.05 * SAMPLE_RATE);
  const raw = bandNoise(n + m, SAMPLE_RATE, lo, hi, rand, order);
  const out = raw.slice(0, n);
  for (let i = 0; i < m; i++) {
    const w = smoothstep(i / m);
    out[i] = raw[n + i]! * (1 - w) + raw[i]! * w;
  }
  return out;
}

function finish(buf: Float64Array): Float64Array {
  // Remove DC / sub-audible rumble, then normalise.
  biquad(buf, SAMPLE_RATE, "highpass", 18);
  return normalizePeak(buf, PEAK);
}

// ───────────────────────────── Heart ─────────────────────────────

/**
 * One valve-closure component: a short damped low-frequency oscillation with a slight
 * downward chirp, a 2nd harmonic and a little band noise for texture ("thump").
 */
function valveThump(f0: number, dur: number, rand: () => number): Float64Array {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float64Array(n);
  const tex = bandNoise(n, SAMPLE_RATE, f0 * 0.8, f0 * 3, rand, 1);
  const attack = 0.006;
  const tau = dur / 4.5;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = (t < attack ? smoothstep(t / attack) : Math.exp(-(t - attack) / tau)) * (1 - smoothstep((t - dur * 0.8) / (dur * 0.2)));
    const f = f0 * (1.15 - 0.25 * Math.min(1, t / dur));
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    out[i] = env * (Math.sin(phase) + 0.35 * Math.sin(2 * phase + 0.7) + 0.25 * tex[i]!);
  }
  return out;
}

export interface HeartOptions {
  bpm?: number;
  beats?: number;
  murmur?: "none" | "ejection-systolic";
  seed?: number;
}

export function heartSounds(opts: HeartOptions = {}): Float64Array {
  const bpm = opts.bpm ?? 80;
  const beats = opts.beats ?? 12;
  const rand = mulberry32(opts.seed ?? 1);
  const rr = 60 / bpm;
  const n = Math.round(beats * rr * SAMPLE_RATE);
  const out = new Float64Array(n);
  // Systole (S1→S2) shortens slightly with rate; ~0.30 s at 80 bpm.
  const systole = 0.3 * Math.sqrt(rr / 0.75);
  const s = (sec: number) => Math.round(sec * SAMPLE_RATE);

  // Stethoscope "room": very quiet low band noise.
  const floor = loopNoise(n, 25, 400, rand);
  for (let i = 0; i < n; i++) out[i] = floor[i]! * 0.012;

  for (let b = 0; b < beats; b++) {
    const t0 = 0.08 + b * rr;
    const jitter = 1 + (rand() - 0.5) * 0.08;
    // S1: mitral (M1) then tricuspid (T1) closure — low pitched, longer.
    mixCircular(out, valveThump(58, 0.12, rand), s(t0), 1.0 * jitter);
    mixCircular(out, valveThump(72, 0.1, rand), s(t0 + 0.022), 0.55 * jitter);
    // S2: aortic (A2) then pulmonary (P2) closure — higher pitched, shorter, softer at apex.
    mixCircular(out, valveThump(95, 0.08, rand), s(t0 + systole), 0.72 * jitter);
    mixCircular(out, valveThump(110, 0.065, rand), s(t0 + systole + 0.025), 0.35 * jitter);

    if (opts.murmur === "ejection-systolic") {
      // Crescendo–decrescendo ("diamond") harsh murmur between S1 and S2.
      const start = t0 + 0.07;
      const len = systole - 0.1;
      const m = Math.round(len * SAMPLE_RATE);
      const noise = bandNoise(m, SAMPLE_RATE, 140, 480, rand, 2);
      const rough = bandNoise(m, SAMPLE_RATE, 20, 60, rand, 1); // slow roughness modulation
      const mur = new Float64Array(m);
      for (let i = 0; i < m; i++) {
        const x = i / m;
        const diamond = x < 0.4 ? x / 0.4 : (1 - x) / 0.6;
        const env = Math.pow(Math.max(0, diamond), 1.3) * smoothstep(x / 0.05) * smoothstep((1 - x) / 0.05);
        mur[i] = noise[i]! * env * (1 + 0.35 * rough[i]!);
      }
      mixCircular(out, mur, s(start), 0.26);
    }
  }
  return finish(out);
}

// ───────────────────────────── Lungs ─────────────────────────────

export interface BreathOptions {
  /** Breaths per minute. */
  rate?: number;
  cycles?: number;
  /** Fraction of the cycle spent in inspiration. */
  inspFraction?: number;
  /** Relative loudness of expiration (vesicular: quiet and short). */
  expLevel?: number;
  /** Fraction of expiration during which breath sound is audible. */
  expAudible?: number;
  seed?: number;
}

interface Breath {
  n: number;
  cycle: number;
  insp: number;
  samples: Float64Array;
}

/** Vesicular breath sounds: band-limited noise under an inspiration/expiration envelope. */
function breathing(opts: BreathOptions = {}): Breath {
  const rate = opts.rate ?? 15;
  const cycles = opts.cycles ?? 2;
  const rand = mulberry32(opts.seed ?? 2);
  const cycle = 60 / rate;
  const insp = cycle * (opts.inspFraction ?? 0.38);
  const expLevel = opts.expLevel ?? 0.3;
  const expAudible = opts.expAudible ?? 0.35;
  const n = Math.round(cycles * cycle * SAMPLE_RATE);
  // Inspiratory noise is a little brighter than expiratory noise.
  const inNoise = loopNoise(n, 110, 650, rand);
  const exNoise = loopNoise(n, 90, 380, rand);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / SAMPLE_RATE) % cycle;
    let ein = 0;
    let eex = 0;
    if (t < insp) {
      const x = t / insp;
      // Rises through inspiration, peaks late, falls quickly at the turn.
      ein = smoothstep(x / 0.7) * (1 - smoothstep((x - 0.85) / 0.15));
    } else {
      const x = (t - insp) / (cycle - insp);
      eex = expLevel * smoothstep(x / 0.08) * (1 - smoothstep(x / expAudible));
    }
    out[i] = inNoise[i]! * ein + exNoise[i]! * eex;
  }
  return { n, cycle, insp, samples: out };
}

/** Slight chest-piece noise floor so a file never drops to digital silence. */
function addFloor(buf: Float64Array, seed: number): void {
  const floor = loopNoise(buf.length, 40, 300, mulberry32(seed));
  for (let i = 0; i < buf.length; i++) buf[i]! += floor[i]! * 0.01;
}

export function lungNormal(): Float64Array {
  const b = breathing({ seed: 21 });
  addFloor(b.samples, 22);
  return finish(b.samples);
}

/** Breath sounds with prolonged expiration and polyphonic musical expiratory wheeze. */
export function lungWheeze(): Float64Array {
  const b = breathing({ seed: 31, rate: 15, inspFraction: 0.32, expLevel: 0.55, expAudible: 0.85 });
  const rand = mulberry32(32);
  const out = b.samples;
  const voices = [
    { f: 410, a: 1.0 },
    { f: 545, a: 0.7 },
    { f: 720, a: 0.45 },
  ];
  const cycles = Math.round(b.n / (b.cycle * SAMPLE_RATE));
  for (let c = 0; c < cycles; c++) {
    const start = c * b.cycle + b.insp + 0.12;
    const len = (b.cycle - b.insp) * 0.78;
    const m = Math.round(len * SAMPLE_RATE);
    const w = new Float64Array(m);
    for (const v of voices) {
      const f0 = v.f * (1 + (rand() - 0.5) * 0.08);
      const vibRate = 4 + rand() * 3;
      const onset = rand() * 0.15;
      let phase = rand() * Math.PI * 2;
      for (let i = 0; i < m; i++) {
        const x = i / m;
        // Pitch drifts down as the airway narrows through expiration, with slight vibrato.
        const f = f0 * (1 - 0.1 * x) * (1 + 0.012 * Math.sin((2 * Math.PI * vibRate * i) / SAMPLE_RATE));
        phase += (2 * Math.PI * f) / SAMPLE_RATE;
        const env = smoothstep((x - onset) / 0.12) * (1 - smoothstep((x - 0.8) / 0.2)) * (0.75 + 0.25 * Math.sin(Math.PI * x));
        w[i]! += v.a * env * (Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.08 * Math.sin(3 * phase));
      }
    }
    mixCircular(out, w, Math.round(start * SAMPLE_RATE), 0.55);
  }
  addFloor(out, 33);
  return finish(out);
}

/** Breath sounds plus fine, late-inspiratory crackles (short explosive clicks). */
export function lungCrackles(): Float64Array {
  const b = breathing({ seed: 41 });
  const rand = mulberry32(42);
  const out = b.samples;
  const cycles = Math.round(b.n / (b.cycle * SAMPLE_RATE));
  const clickLen = Math.round(0.007 * SAMPLE_RATE);
  for (let c = 0; c < cycles; c++) {
    const count = 14 + Math.floor(rand() * 6);
    for (let k = 0; k < count; k++) {
      // Concentrated in the second half of inspiration.
      const x = 0.45 + 0.52 * Math.sqrt(rand());
      const t = c * b.cycle + x * b.insp;
      const f = 650 + rand() * 500;
      const tau = 0.0009 + rand() * 0.0008;
      const sign = rand() < 0.5 ? -1 : 1;
      const amp = (0.5 + rand() * 0.5) * sign;
      const click = new Float64Array(clickLen);
      for (let i = 0; i < clickLen; i++) {
        const tt = i / SAMPLE_RATE;
        click[i] = Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt / tau) * smoothstep(tt / 0.0002);
      }
      mixCircular(out, click, Math.round(t * SAMPLE_RATE), amp * 5);
    }
  }
  addFloor(out, 43);
  return finish(out);
}

// ───────────────────────────── Abdomen ─────────────────────────────

/** Normal bowel sounds: quiet background with intermittent bubbling gurgles. */
export function bowelNormal(durationSec = 10): Float64Array {
  const rand = mulberry32(51);
  const n = Math.round(durationSec * SAMPLE_RATE);
  const out = new Float64Array(n);
  const floor = loopNoise(n, 40, 300, rand);
  for (let i = 0; i < n; i++) out[i] = floor[i]! * 0.015;
  // Gurgle clusters at irregular intervals (~30/min is normal: 5–34/min).
  const events = [0.6, 1.9, 3.4, 4.1, 5.8, 7.0, 8.6];
  for (const t0 of events) {
    const clusterLen = 0.25 + rand() * 0.7;
    const bubbles = 5 + Math.floor(rand() * 14);
    const level = 0.5 + rand() * 0.5;
    // Low murmur of moving fluid under the cluster.
    const m = Math.round(clusterLen * SAMPLE_RATE);
    const wash = bandNoise(m, SAMPLE_RATE, 180, 700, rand, 2);
    for (let i = 0; i < m; i++) wash[i]! *= Math.sin((Math.PI * i) / m) * 0.18 * level;
    mixCircular(out, wash, Math.round(t0 * SAMPLE_RATE));
    for (let k = 0; k < bubbles; k++) {
      const t = t0 + rand() * clusterLen;
      const dur = 0.02 + rand() * 0.05;
      const f0 = 160 + rand() * 380;
      const len = Math.round(dur * SAMPLE_RATE);
      const bub = new Float64Array(len);
      let phase = 0;
      for (let i = 0; i < len; i++) {
        const x = i / len;
        // Bubble resonance: pitch rises as the bubble collapses.
        const f = f0 * (1 + 0.6 * x);
        phase += (2 * Math.PI * f) / SAMPLE_RATE;
        bub[i] = Math.sin(phase) * smoothstep(x / 0.08) * Math.exp(-x * 3.2);
      }
      mixCircular(out, bub, Math.round(t * SAMPLE_RATE), level * (0.4 + rand() * 0.6));
    }
  }
  return finish(out);
}
