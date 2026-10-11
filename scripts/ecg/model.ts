/**
 * Parametric 12-lead ECG model (pure TypeScript, no I/O, deterministic).
 *
 * Each beat is a sum of Gaussian-shaped waves (P, Q, R, S and an asymmetric T) plus an
 * ST-segment offset that starts at the J point and merges into the T wave. Amplitudes are in
 * millivolts and are specified per lead.
 *
 * Limb leads are physiologically consistent: only leads I and II are specified and
 * III, aVR, aVL and aVF are derived with Einthoven's / Goldberger's relations, so e.g. inferior
 * ST elevation automatically produces reciprocal depression in aVL.
 */
import { mulberry32 } from "../audio/dsp.js";

export const LEADS = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"] as const;
export type Lead = (typeof LEADS)[number];
export type SpecifiedLead = "I" | "II" | "V1" | "V2" | "V3" | "V4" | "V5" | "V6";

/** Per-lead wave amplitudes in mV (signed: Q and S are normally negative). */
export interface LeadWaves {
  p: number;
  q: number;
  r: number;
  s: number;
  t: number;
  /** ST-segment offset at the J point (mV); positive = elevation. */
  st: number;
}

export interface EcgParams {
  /** Mean ventricular rate (beats/min). */
  heartRate: number;
  rhythm: "sinus" | "atrial-fibrillation";
  /** Beat-to-beat RR variability for AF as a fraction of the mean RR (irregularly irregular). */
  irregularity?: number;
  /** PR interval (s), P onset → QRS onset. */
  prInterval?: number;
  /** Amplitude of fibrillatory baseline waves in lead V1 (mV). Other leads are scaled from it. */
  fibrillationAmplitude?: number;
  /** Random noise amplitude (mV) and baseline wander (mV). */
  noise?: number;
  wander?: number;
  seed?: number;
  leads: Record<SpecifiedLead, LeadWaves>;
}

export interface Beat {
  /** Time of the R peak (s). */
  t: number;
  /** RR interval used to scale QT (s). */
  rr: number;
  hasP: boolean;
}

const gauss = (x: number, mu: number, sigma: number) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));

/** Beat times over [0, duration]. Includes beats slightly outside the window so waves at the edges are complete. */
export function beatTimes(p: EcgParams, duration: number): Beat[] {
  const rand = mulberry32((p.seed ?? 7) * 7919 + 1);
  const meanRr = 60 / p.heartRate;
  const beats: Beat[] = [];
  let t = -meanRr * (0.3 + rand() * 0.4);
  while (t < duration + 1) {
    let rr: number;
    if (p.rhythm === "atrial-fibrillation") {
      const irr = p.irregularity ?? 0.35;
      rr = meanRr * (1 + (rand() * 2 - 1) * irr * 1.4);
      rr = Math.max(0.33, rr);
    } else {
      // Mild respiratory sinus arrhythmia.
      rr = meanRr * (1 + 0.025 * Math.sin((2 * Math.PI * t) / 4.2));
    }
    beats.push({ t, rr, hasP: p.rhythm === "sinus" });
    t += rr;
  }
  return beats;
}

/** Signal of one specified lead (mV) at time x, from the beat list. */
function leadValue(w: LeadWaves, beats: Beat[], x: number, pr: number): number {
  let v = 0;
  for (const b of beats) {
    const d = x - b.t;
    if (d < -0.4 || d > 0.8) continue;
    const k = Math.sqrt(Math.min(1.3, Math.max(0.35, b.rr)));
    if (b.hasP) v += w.p * gauss(d, -(pr - 0.005), 0.022);
    v += w.q * gauss(d, -0.026, 0.008);
    v += w.r * gauss(d, 0, 0.011);
    v += w.s * gauss(d, 0.028, 0.0105);
    const tPeak = 0.3 * k;
    const tw = d < tPeak ? gauss(d, tPeak, 0.065 * k) : gauss(d, tPeak, 0.04 * k);
    v += w.t * tw;
    // ST offset: rises at the J point (~40–60 ms after R), holds, and blends into the T wave.
    if (w.st !== 0) {
      const rise = smooth((d - 0.036) / 0.026);
      const fall = 1 - smooth((d - tPeak) / (0.1 * k));
      // Slight convexity (dome) for elevation, slight downslope for depression.
      const dome = 1 + 0.15 * Math.sin(Math.PI * smooth((d - 0.05) / (tPeak - 0.05)));
      v += w.st * rise * fall * dome;
    }
  }
  return v;
}

/** Relative size of fibrillatory waves per lead (largest in V1 and the inferior leads). */
const F_WAVE_SCALE: Record<Lead, number> = {
  I: 0.35, II: 0.7, III: 0.65, aVR: 0.5, aVL: 0.3, aVF: 0.65,
  V1: 1, V2: 0.8, V3: 0.55, V4: 0.45, V5: 0.35, V6: 0.3,
};

export interface EcgTraces {
  sampleRate: number;
  duration: number;
  beats: Beat[];
  /** Signals in mV, one per lead, all simultaneous over [0, duration). */
  leads: Record<Lead, Float64Array>;
}

/** Simulate all 12 leads simultaneously for `duration` seconds at `sampleRate` Hz. */
export function simulate(p: EcgParams, duration = 10, sampleRate = 250): EcgTraces {
  const n = Math.round(duration * sampleRate);
  const beats = beatTimes(p, duration);
  const pr = p.prInterval ?? 0.16;
  const spec: Partial<Record<Lead, Float64Array>> = {};
  for (const lead of ["I", "II", "V1", "V2", "V3", "V4", "V5", "V6"] as const) {
    const arr = new Float64Array(n);
    for (let i = 0; i < n; i++) arr[i] = leadValue(p.leads[lead], beats, i / sampleRate, pr);
    spec[lead] = arr;
  }
  const I = spec.I!;
  const II = spec.II!;
  const derive = (f: (i: number, ii: number) => number) => {
    const a = new Float64Array(n);
    for (let k = 0; k < n; k++) a[k] = f(I[k]!, II[k]!);
    return a;
  };
  const leads = {
    I,
    II,
    III: derive((i, ii) => ii - i),
    aVR: derive((i, ii) => -(i + ii) / 2),
    aVL: derive((i, ii) => i - ii / 2),
    aVF: derive((i, ii) => ii - i / 2),
    V1: spec.V1!, V2: spec.V2!, V3: spec.V3!, V4: spec.V4!, V5: spec.V5!, V6: spec.V6!,
  } as Record<Lead, Float64Array>;

  // Additive artefacts per displayed lead: fibrillatory waves, baseline wander, small noise.
  const rand = mulberry32((p.seed ?? 7) * 104729 + 3);
  const fAmp = p.rhythm === "atrial-fibrillation" ? (p.fibrillationAmplitude ?? 0.09) : 0;
  const noise = p.noise ?? 0.006;
  const wander = p.wander ?? 0.025;
  for (const lead of LEADS) {
    const arr = leads[lead];
    const comps = Array.from({ length: 4 }, () => ({ f: 4.5 + rand() * 3.5, ph: rand() * 6.283, a: 0.5 + rand() * 0.5 }));
    const wPh = rand() * 6.283;
    const wF = 0.15 + rand() * 0.15;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      let f = 0;
      if (fAmp) {
        for (const c of comps) f += c.a * Math.sin(2 * Math.PI * c.f * t + c.ph + 0.6 * Math.sin(1.3 * t + c.ph));
        f *= (fAmp * F_WAVE_SCALE[lead]) / 2;
      }
      lp += 0.35 * ((rand() * 2 - 1) - lp); // gently low-passed noise
      arr[i]! += f + wander * Math.sin(2 * Math.PI * wF * t + wPh) + noise * lp * 2;
    }
  }
  return { sampleRate, duration, beats, leads };
}

// ───────────────────────────── Presets ─────────────────────────────

const W = (p: number, q: number, r: number, s: number, t: number, st = 0): LeadWaves => ({ p, q, r, s, t, st });

/** Normal adult morphology. */
export const NORMAL_LEADS: Record<SpecifiedLead, LeadWaves> = {
  I: W(0.08, -0.04, 0.75, -0.1, 0.25),
  II: W(0.14, -0.05, 1.1, -0.2, 0.35),
  V1: W(0.07, 0, 0.22, -0.95, -0.05),
  V2: W(0.08, 0, 0.45, -1.35, 0.4),
  V3: W(0.08, -0.02, 0.8, -0.8, 0.45),
  V4: W(0.08, -0.05, 1.3, -0.4, 0.42),
  V5: W(0.08, -0.07, 1.35, -0.2, 0.35),
  V6: W(0.08, -0.07, 1.1, -0.1, 0.28),
};

function withChanges(changes: Partial<Record<SpecifiedLead, Partial<LeadWaves>>>): Record<SpecifiedLead, LeadWaves> {
  const out = {} as Record<SpecifiedLead, LeadWaves>;
  for (const k of Object.keys(NORMAL_LEADS) as SpecifiedLead[]) out[k] = { ...NORMAL_LEADS[k], ...(changes[k] ?? {}) };
  return out;
}

export interface EcgPreset {
  id: string;
  title: string;
  interpretation: string;
  params: EcgParams;
}

export const PRESETS: EcgPreset[] = [
  {
    id: "normal-sinus",
    title: "Normal sinus rhythm",
    interpretation: "Sinus rhythm ~72 bpm, normal axis, normal intervals, no ST changes.",
    params: { heartRate: 72, rhythm: "sinus", seed: 1, leads: NORMAL_LEADS },
  },
  {
    id: "inferior-stemi",
    title: "Acute inferior STEMI",
    interpretation: "Sinus rhythm ~98 bpm. ST elevation II, III, aVF (III > II) with reciprocal ST depression I and aVL.",
    params: {
      heartRate: 98,
      rhythm: "sinus",
      seed: 2,
      // I: depression; II: elevation. Derived ST: III +0.5, aVF +0.4, aVL -0.35, aVR -0.05 mV.
      leads: withChanges({
        I: { st: -0.2, t: 0.1 },
        II: { st: 0.3, t: 0.55, q: -0.12 },
        V1: { st: -0.05 },
        V2: { st: -0.08 },
      }),
    },
  },
  {
    id: "anterior-stemi",
    title: "Acute anterior STEMI",
    interpretation: "Sinus rhythm ~88 bpm. ST elevation V1–V4 with hyperacute T waves and loss of R-wave progression; mild reciprocal change inferiorly.",
    params: {
      heartRate: 88,
      rhythm: "sinus",
      seed: 3,
      leads: withChanges({
        I: { st: 0.06 },
        II: { st: -0.04 },
        V1: { r: 0.08, s: -0.9, st: 0.22, t: 0.25 },
        V2: { r: 0.15, q: -0.12, s: -0.9, st: 0.45, t: 0.75 },
        V3: { r: 0.35, q: -0.1, s: -0.6, st: 0.45, t: 0.8 },
        V4: { r: 0.8, st: 0.3, t: 0.65 },
        V5: { st: 0.08 },
      }),
    },
  },
  {
    id: "atrial-fibrillation",
    title: "Atrial fibrillation",
    interpretation: "Irregularly irregular narrow-complex rhythm, mean ventricular rate ~110 bpm, no P waves, fibrillatory baseline.",
    params: { heartRate: 110, rhythm: "atrial-fibrillation", irregularity: 0.32, fibrillationAmplitude: 0.15, seed: 4, leads: NORMAL_LEADS },
  },
  {
    id: "sinus-tachycardia",
    title: "Sinus tachycardia",
    interpretation: "Sinus rhythm ~125 bpm, P wave before every QRS, normal axis, no ST changes.",
    params: { heartRate: 125, rhythm: "sinus", prInterval: 0.14, seed: 5, leads: NORMAL_LEADS },
  },
];
