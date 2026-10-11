export interface Target {
  id: string;
  /** Screen rectangle in px. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Minimum on-screen size for hand targets (PRD: about 64 px). */
export const MIN_TARGET_PX = 64;

/** Distance from a point to a rectangle (0 when inside). */
export const distToRect = (px: number, py: number, t: Target) => {
  const dx = Math.max(t.x - px, 0, px - (t.x + t.width));
  const dy = Math.max(t.y - py, 0, py - (t.y + t.height));
  return Math.hypot(dx, dy);
};

/**
 * Magnetic snapping: if the cursor is inside or within `radius` px of a target, return the
 * nearest one and its centre. Inside wins over nearby; ties go to the smaller target.
 */
export function snap(px: number, py: number, targets: readonly Target[], radius = 32): { target: Target; x: number; y: number } | null {
  let best: Target | null = null;
  let bestD = Infinity;
  for (const t of targets) {
    const d = distToRect(px, py, t);
    if (d > radius) continue;
    if (d < bestD || (d === bestD && best && t.width * t.height < best.width * best.height)) {
      best = t;
      bestD = d;
    }
  }
  return best ? { target: best, x: best.x + best.width / 2, y: best.y + best.height / 2 } : null;
}
