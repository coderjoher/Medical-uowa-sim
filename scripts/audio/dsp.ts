/**
 * Minimal, dependency-free DSP helpers for procedural placeholder sounds.
 * Everything is deterministic: noise comes from a seeded PRNG.
 */

/** Mulberry32 — small, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approximately Gaussian noise (sum of uniforms), unit-ish variance. */
export function gaussian(rand: () => number): number {
  return (rand() + rand() + rand() + rand() - 2) * 1.7320508;
}

/** White noise buffer. */
export function whiteNoise(n: number, rand: () => number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = gaussian(rand);
  return out;
}

export type BiquadType = "lowpass" | "highpass" | "bandpass";

/** RBJ cookbook biquad, applied in place (direct form I). */
export function biquad(buf: Float64Array, sampleRate: number, type: BiquadType, freq: number, q = Math.SQRT1_2): Float64Array {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === "lowpass") {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else if (type === "highpass") {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    // constant 0 dB peak gain
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x0 = buf[i]!;
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    buf[i] = y0;
  }
  return buf;
}

/** Band-limited noise: white noise through highpass(lo) then lowpass(hi), each applied `order` times. */
export function bandNoise(n: number, sampleRate: number, lo: number, hi: number, rand: () => number, order = 2): Float64Array {
  const buf = whiteNoise(n, rand);
  for (let k = 0; k < order; k++) {
    biquad(buf, sampleRate, "highpass", lo);
    biquad(buf, sampleRate, "lowpass", hi);
  }
  return normalizeRms(buf);
}

export function normalizeRms(buf: Float64Array, target = 1): Float64Array {
  let s = 0;
  for (const v of buf) s += v * v;
  const rms = Math.sqrt(s / Math.max(1, buf.length));
  if (rms > 0) for (let i = 0; i < buf.length; i++) buf[i] = (buf[i]! / rms) * target;
  return buf;
}

export function peak(buf: Float64Array): number {
  let p = 0;
  for (const v of buf) p = Math.max(p, Math.abs(v));
  return p;
}

/** Scale so the absolute peak equals `target` (fraction of full scale). */
export function normalizePeak(buf: Float64Array, target: number): Float64Array {
  const p = peak(buf);
  if (p > 0) for (let i = 0; i < buf.length; i++) buf[i] = (buf[i]! / p) * target;
  return buf;
}

/** Smooth 0→1 ramp (raised cosine) for x in [0,1], clamped. */
export function smoothstep(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

/** Add `src` into `dst` starting at sample `offset` (clipped to dst bounds), scaled by `gain`. */
export function mixInto(dst: Float64Array, src: Float64Array, offset: number, gain = 1): void {
  for (let i = 0; i < src.length; i++) {
    const j = offset + i;
    if (j >= 0 && j < dst.length) dst[j]! += src[i]! * gain;
  }
}
