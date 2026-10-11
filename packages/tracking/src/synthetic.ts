import type { DetectedHand, HandFrame, Landmark } from "./types.js";

/**
 * Synthetic hand landmarks for tests and the no-camera dev mode. Geometry is a simplified
 * upright hand facing the camera; hand size (wrist to middle knuckle) = `scale`.
 */
export type SynthPose = "open_palm" | "point" | "pinch" | "fist" | "pinch_open";

export interface SynthOptions {
  /** Palm-centre-ish anchor (middle knuckle) in normalized image coords. */
  x: number;
  y: number;
  scale?: number;
  /** Gaussian-ish jitter amplitude in normalized units. */
  noise?: number;
  rand?: () => number;
}

const EXT = [0.4, 0.65, 0.85]; // pip, dip, tip distances above the knuckle (in hand sizes)
const CURL: [number, number][] = [
  [0, 0.3],
  [0.05, 0.15],
  [0.05, -0.05],
]; // (dx, up) for pip, dip, tip of a curled finger

export function synthHand(pose: SynthPose, o: SynthOptions): Landmark[] {
  const s = o.scale ?? 0.1;
  const rnd = o.rand ?? Math.random;
  const n = () => (o.noise ? (rnd() + rnd() + rnd() - 1.5) * o.noise : 0);
  const P = (dx: number, up: number): Landmark => ({ x: o.x + dx * s + n(), y: o.y - up * s + n(), z: n() });

  const lms: Landmark[] = new Array(21);
  lms[0] = P(0, -1); // wrist
  const fingerX = [-0.3, -0.1, 0.1, 0.3];
  const extended =
    pose === "open_palm" ? [true, true, true, true] : pose === "point" || pose === "pinch" || pose === "pinch_open" ? [true, false, false, false] : [false, false, false, false];
  fingerX.forEach((fx, f) => {
    const base = 5 + f * 4;
    lms[base] = P(fx, 0); // MCP
    for (let j = 0; j < 3; j++) lms[base + 1 + j] = extended[f] ? P(fx, EXT[j]!) : P(fx + CURL[j]![0], CURL[j]![1]);
  });
  // Thumb, out to the side.
  lms[1] = P(-0.4, -0.7);
  lms[2] = P(-0.6, -0.4);
  lms[3] = P(-0.75, -0.15);
  lms[4] = P(-0.85, 0.05);
  if (pose === "pinch") {
    // Thumb tip meets index tip.
    const it = lms[8]!;
    lms[4] = { x: it.x + 0.05 * s + n(), y: it.y + 0.05 * s + n(), z: n() };
    lms[3] = P(-0.4, 0.4);
  }
  if (pose === "pinch_open") {
    // Fingers half closed: ratio between the start and release thresholds.
    const it = lms[8]!;
    lms[4] = { x: it.x - 0.38 * s, y: it.y, z: 0 };
  }
  return lms;
}

export function synthFrame(tMs: number, pose: SynthPose | null, o: SynthOptions & { handedness?: "left" | "right"; score?: number }): HandFrame {
  if (!pose) return { tMs, hands: [] };
  const hand: DetectedHand = { landmarks: synthHand(pose, o), score: o.score ?? 0.95, handedness: o.handedness ?? "right" };
  return { tMs, hands: [hand] };
}

/** Deterministic PRNG for reproducible noisy recordings. */
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
