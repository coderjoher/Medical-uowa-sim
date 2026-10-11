import type { PinchThresholds } from "./pinch.js";

/** Area of the camera image (normalized coords) the student can comfortably reach. */
export interface ReachBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface Calibration {
  hand: "left" | "right";
  reach: ReachBox;
  pinch: PinchThresholds;
  /** Median hand size in normalized units, for reference/logging. */
  handSize: number;
}

export const DEFAULT_REACH: ReachBox = { minX: 0.2, maxX: 0.8, minY: 0.15, maxY: 0.75 };

export interface CalibrationSamples {
  hand: "left" | "right";
  /** Pinch ratios while the hand is open. */
  openRatios: number[];
  /** Pinch ratios while pinching. */
  pinchRatios: number[];
  /** Cursor anchor positions while the student sweeps their comfortable reach. */
  reachPoints: { x: number; y: number }[];
  handSizes: number[];
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
};

export type CalibrationResult = { ok: true; calibration: Calibration } | { ok: false; reason: string };

/**
 * Turns the ~10 s calibration (open hand, point around, pinch) into thresholds and a reach box.
 * Uses robust quantiles so a few bad frames do not skew the result.
 */
export function computeCalibration(s: CalibrationSamples): CalibrationResult {
  if (s.openRatios.length < 5 || s.pinchRatios.length < 5) return { ok: false, reason: "not enough open-hand or pinch samples" };
  if (s.reachPoints.length < 20) return { ok: false, reason: "not enough pointing samples; move your finger around the area you can reach" };

  const open = quantile(s.openRatios, 0.25);
  const closed = quantile(s.pinchRatios, 0.75);
  if (open - closed < 0.25) return { ok: false, reason: "pinch not distinct from open hand; touch thumb and index fingertips firmly" };
  const pinch = { start: closed + (open - closed) * 0.3, release: closed + (open - closed) * 0.5 };

  const x0 = quantile(s.reachPoints.map((p) => p.x), 0.05);
  const x1 = quantile(s.reachPoints.map((p) => p.x), 0.95);
  const y0 = quantile(s.reachPoints.map((p) => p.y), 0.05);
  const y1 = quantile(s.reachPoints.map((p) => p.y), 0.95);
  if (x1 - x0 < 0.1 || y1 - y0 < 0.08) return { ok: false, reason: "reach area too small; move your finger further left, right, up and down" };
  // Shrink slightly so screen edges are reachable without straining.
  const mx = (x1 - x0) * 0.05;
  const my = (y1 - y0) * 0.05;
  const reach = { minX: x0 + mx, maxX: x1 - mx, minY: y0 + my, maxY: y1 - my };

  return { ok: true, calibration: { hand: s.hand, reach, pinch, handSize: quantile(s.handSizes, 0.5) } };
}

/**
 * Maps a camera-space point to screen pixels. The camera image is not mirrored, so moving the
 * hand to the student's right lowers x; we flip it so the cursor follows the hand.
 */
export function toScreen(p: { x: number; y: number }, reach: ReachBox, width: number, height: number, mirror = true) {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  let u = clamp((p.x - reach.minX) / (reach.maxX - reach.minX));
  if (mirror) u = 1 - u;
  const v = clamp((p.y - reach.minY) / (reach.maxY - reach.minY));
  return { x: u * width, y: v * height };
}
