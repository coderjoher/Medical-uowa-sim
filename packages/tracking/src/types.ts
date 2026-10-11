/** A MediaPipe hand landmark in normalized image coordinates (x right, y down, 0..1). */
export interface Landmark {
  x: number;
  y: number;
  z: number;
}

/** One detected hand in one camera frame. */
export interface DetectedHand {
  /** 21 landmarks in MediaPipe order. */
  landmarks: Landmark[];
  /** Detection/handedness confidence 0..1. */
  score: number;
  /** Handedness as the student sees it (already corrected for camera mirroring). */
  handedness: "left" | "right";
}

export interface HandFrame {
  /** Frame timestamp in ms (performance.now() or video time). */
  tMs: number;
  hands: DetectedHand[];
}

export type Pose = "none" | "point" | "pinch" | "open_palm";

export type GestureEvent =
  | { type: "pinch-start"; x: number; y: number; tMs: number }
  | { type: "pinch-end"; x: number; y: number; tMs: number; reason: "released" | "lost" }
  | { type: "menu"; tMs: number }
  | { type: "swipe"; direction: "left" | "right"; tMs: number }
  | { type: "hand-lost"; tMs: number }
  | { type: "hand-found"; tMs: number; lostForMs: number };

/** MediaPipe landmark indices. */
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;
