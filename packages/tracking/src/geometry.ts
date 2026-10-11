import { LM, type Landmark } from "./types.js";

export const dist = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Scale reference that does not change with pinching: wrist to middle-finger knuckle. */
export const handSize = (lms: readonly Landmark[]) => dist(lms[LM.WRIST]!, lms[LM.MIDDLE_MCP]!);

/** Thumb-tip to index-tip distance relative to hand size, so it is the same near or far from the camera. */
export const pinchRatio = (lms: readonly Landmark[]) => dist(lms[LM.THUMB_TIP]!, lms[LM.INDEX_TIP]!) / handSize(lms);

const FINGERS = [
  [LM.INDEX_PIP, LM.INDEX_TIP],
  [LM.MIDDLE_PIP, LM.MIDDLE_TIP],
  [LM.RING_PIP, LM.RING_TIP],
  [LM.PINKY_PIP, LM.PINKY_TIP],
] as const;

/** A finger is extended when its tip is clearly farther from the wrist than its middle joint. */
export function fingersExtended(lms: readonly Landmark[]): [boolean, boolean, boolean, boolean] {
  const w = lms[LM.WRIST]!;
  return FINGERS.map(([pip, tip]) => dist(w, lms[tip]!) > dist(w, lms[pip]!) * 1.1) as [boolean, boolean, boolean, boolean];
}

/** Palm centre: mean of wrist and the four knuckles. Stable under finger movement. */
export function palmCenter(lms: readonly Landmark[]): { x: number; y: number } {
  const ids = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
  const s = ids.reduce((acc, i) => ({ x: acc.x + lms[i]!.x, y: acc.y + lms[i]!.y }), { x: 0, y: 0 });
  return { x: s.x / ids.length, y: s.y / ids.length };
}
