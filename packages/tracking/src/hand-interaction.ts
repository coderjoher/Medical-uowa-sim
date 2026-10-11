import { DEFAULT_REACH, toScreen, type Calibration, type ReachBox } from "./calibration.js";
import { fingersExtended, handSize, palmCenter, pinchRatio } from "./geometry.js";
import { LandmarkFilter, OneEuroFilter, type OneEuroParams } from "./one-euro.js";
import { DEFAULT_PINCH, PinchDetector } from "./pinch.js";
import { LM, type DetectedHand, type GestureEvent, type HandFrame, type Landmark, type Pose } from "./types.js";

export interface InteractionConfig {
  screenWidth: number;
  screenHeight: number;
  hand: "left" | "right";
  reach: ReachBox;
  /** Frames whose confidence is below this are ignored. */
  minConfidence: number;
  /** A pinch must hold this long before it clicks (PRD: 150-200 ms). */
  pinchHoldMs: number;
  /**
   * An open palm must hold this long (and stay still) before it opens the menu. The PRD says
   * 150-200 ms; raise it if a resting open hand opens the menu too often in the lab.
   */
  palmHoldMs: number;
  /** Raw pinch must be released for this long before the pinch ends (prevents drag drop-outs). */
  pinchReleaseMs: number;
  /** No usable frame for this long = hand lost. */
  lostAfterMs: number;
  /** Swipe: palm must travel this many hand sizes horizontally within `swipeWindowMs`. */
  swipeMinHandSizes: number;
  swipeWindowMs: number;
  swipeCooldownMs: number;
  /** Palm may drift this many hand sizes during a menu hold. */
  palmStillHandSizes: number;
  landmarkFilter: OneEuroParams;
  cursorFilter: OneEuroParams;
  /** Camera image is un-mirrored (normal webcam); flip x so the cursor follows the hand. */
  mirror: boolean;
}

export const DEFAULT_CONFIG: Omit<InteractionConfig, "screenWidth" | "screenHeight"> = {
  hand: "right",
  reach: DEFAULT_REACH,
  minConfidence: 0.6,
  pinchHoldMs: 150,
  palmHoldMs: 200,
  pinchReleaseMs: 80,
  lostAfterMs: 250,
  swipeMinHandSizes: 1.5,
  swipeWindowMs: 350,
  swipeCooldownMs: 600,
  palmStillHandSizes: 0.35,
  landmarkFilter: { minCutoff: 1.5, beta: 8, dCutoff: 1 },
  cursorFilter: { minCutoff: 1.2, beta: 0.01, dCutoff: 1 },
  mirror: true,
};

export interface InteractionState {
  tMs: number;
  handPresent: boolean;
  /** Pose after hold/hysteresis rules. */
  pose: Pose;
  /** Raw per-frame pose, for the debug preview. */
  rawPose: Pose;
  pinching: boolean;
  cursor: { x: number; y: number } | null;
  events: GestureEvent[];
  /** Filtered landmarks of the tracked hand (for the camera-preview skeleton). */
  landmarks: Landmark[] | null;
}

interface TrailPoint {
  tMs: number;
  x: number;
  y: number;
  size: number;
}

/**
 * Turns MediaPipe frames into cursor movement and gesture events.
 *
 * Accuracy rules from the PRD: smoothing (One Euro), pinch hysteresis relative to hand size,
 * 150-200 ms hold before a gesture fires, low-confidence frames ignored. The click position is
 * taken from just before the pinch began, so closing the fingers does not drag the cursor off
 * the target.
 */
export class HandInteraction {
  private cfg: InteractionConfig;
  private lmFilter: LandmarkFilter;
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  private pinch: PinchDetector;

  private lastSeenMs: number | null = null;
  private lost = true;
  private everSeen = false;
  private lostAtMs = 0;

  private rawPinchSince: number | null = null;
  private rawPinchOffSince: number | null = null;
  private pinchActive = false;
  private pinchAnchor: { cursor: { x: number; y: number }; mid: { x: number; y: number } } | null = null;

  private palmSince: number | null = null;
  private palmStart: { x: number; y: number } | null = null;
  private palmFired = false;

  private trail: TrailPoint[] = [];
  private lastSwipeMs = -Infinity;
  private cursorHistory: { tMs: number; x: number; y: number }[] = [];
  private cursor: { x: number; y: number } | null = null;

  constructor(config: Partial<InteractionConfig> & Pick<InteractionConfig, "screenWidth" | "screenHeight">) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this.lmFilter = new LandmarkFilter(this.cfg.landmarkFilter);
    this.fx = new OneEuroFilter(this.cfg.cursorFilter);
    this.fy = new OneEuroFilter(this.cfg.cursorFilter);
    this.pinch = new PinchDetector(DEFAULT_PINCH);
  }

  applyCalibration(c: Calibration): void {
    this.cfg = { ...this.cfg, hand: c.hand, reach: c.reach };
    this.pinch.setThresholds(c.pinch);
  }

  setScreenSize(width: number, height: number): void {
    this.cfg = { ...this.cfg, screenWidth: width, screenHeight: height };
  }

  get config(): Readonly<InteractionConfig> {
    return this.cfg;
  }

  private pickHand(hands: readonly DetectedHand[]): DetectedHand | null {
    const usable = hands.filter((h) => h.score >= this.cfg.minConfidence && h.landmarks.length === 21);
    return usable.find((h) => h.handedness === this.cfg.hand) ?? null;
  }

  private mapToScreen(p: { x: number; y: number }) {
    return toScreen(p, this.cfg.reach, this.cfg.screenWidth, this.cfg.screenHeight, this.cfg.mirror);
  }

  /** Cursor position at (or just before) time t, from recent history. */
  private cursorAt(tMs: number): { x: number; y: number } | null {
    for (let i = this.cursorHistory.length - 1; i >= 0; i--) if (this.cursorHistory[i]!.tMs <= tMs) return this.cursorHistory[i]!;
    return this.cursorHistory[0] ?? null;
  }

  private endPinch(events: GestureEvent[], tMs: number, reason: "released" | "lost") {
    if (this.pinchActive && this.cursor) events.push({ type: "pinch-end", x: this.cursor.x, y: this.cursor.y, tMs, reason });
    this.pinchActive = false;
    this.rawPinchSince = null;
    this.rawPinchOffSince = null;
    this.pinchAnchor = null;
    this.pinch.reset();
  }

  private noHand(tMs: number, events: GestureEvent[]): InteractionState {
    if (!this.lost && this.lastSeenMs !== null && tMs - this.lastSeenMs >= this.cfg.lostAfterMs) {
      this.lost = true;
      this.lostAtMs = tMs;
      this.endPinch(events, tMs, "lost");
      this.palmSince = null;
      this.trail = [];
      events.push({ type: "hand-lost", tMs });
    }
    return { tMs, handPresent: !this.lost, pose: this.pinchActive ? "pinch" : "none", rawPose: "none", pinching: this.pinchActive, cursor: this.cursor, events, landmarks: null };
  }

  process(frame: HandFrame): InteractionState {
    const { tMs } = frame;
    const events: GestureEvent[] = [];
    const hand = this.pickHand(frame.hands);
    if (!hand) return this.noHand(tMs, events);

    if (this.lost) {
      if (this.everSeen) events.push({ type: "hand-found", tMs, lostForMs: tMs - this.lostAtMs });
      this.lost = false;
      this.everSeen = true;
      // Start filters fresh so the cursor does not glide in from where the hand left.
      this.lmFilter.reset();
      this.fx.reset();
      this.fy.reset();
    }
    this.lastSeenMs = tMs;

    const lms = this.lmFilter.filter(hand.landmarks, tMs);
    const size = handSize(lms);
    const rawPinch = this.pinch.update(pinchRatio(lms));
    const ext = fingersExtended(lms);
    const rawPose: Pose = rawPinch ? "pinch" : ext.every(Boolean) ? "open_palm" : ext[0] && !ext[1] && !ext[2] && !ext[3] ? "point" : "none";

    // Cursor: index fingertip, or during a pinch the thumb-index midpoint offset to where the
    // cursor was when the pinch began.
    const tip = lms[LM.INDEX_TIP]!;
    const mid = { x: (tip.x + lms[LM.THUMB_TIP]!.x) / 2, y: (tip.y + lms[LM.THUMB_TIP]!.y) / 2 };
    let target: { x: number; y: number };
    if (rawPinch && this.pinchAnchor) {
      const m = this.mapToScreen(mid);
      const a = this.mapToScreen(this.pinchAnchor.mid);
      target = { x: this.pinchAnchor.cursor.x + (m.x - a.x), y: this.pinchAnchor.cursor.y + (m.y - a.y) };
    } else {
      target = this.mapToScreen(tip);
    }

    // Pinch onset: remember the cursor from slightly before the fingers started closing.
    if (rawPinch && this.rawPinchSince === null) {
      this.rawPinchSince = tMs;
      const before = this.cursorAt(tMs - 60) ?? this.cursor ?? target;
      this.pinchAnchor = { cursor: { ...before }, mid };
      target = { ...before };
    }
    if (!rawPinch && !this.pinchActive) {
      this.rawPinchSince = null;
      this.pinchAnchor = null;
    }

    const x = this.fx.filter(target.x, tMs);
    const y = this.fy.filter(target.y, tMs);
    this.cursor = rawPinch && this.pinchAnchor && !this.pinchActive ? { ...this.pinchAnchor.cursor } : { x, y };
    this.cursorHistory.push({ tMs, ...this.cursor });
    while (this.cursorHistory.length && this.cursorHistory[0]!.tMs < tMs - 500) this.cursorHistory.shift();

    // Pinch hold -> click.
    if (rawPinch) {
      this.rawPinchOffSince = null;
      if (!this.pinchActive && this.rawPinchSince !== null && tMs - this.rawPinchSince >= this.cfg.pinchHoldMs) {
        this.pinchActive = true;
        events.push({ type: "pinch-start", x: this.cursor.x, y: this.cursor.y, tMs });
      }
    } else if (this.pinchActive) {
      this.rawPinchOffSince ??= tMs;
      if (tMs - this.rawPinchOffSince >= this.cfg.pinchReleaseMs) this.endPinch(events, tMs, "released");
    }

    // Swipe: fast horizontal palm movement with an open hand.
    const palm = palmCenter(lms);
    if (rawPose === "open_palm") {
      this.trail.push({ tMs, x: palm.x, y: palm.y, size });
      while (this.trail.length && this.trail[0]!.tMs < tMs - this.cfg.swipeWindowMs) this.trail.shift();
      const first = this.trail[0]!;
      const dx = palm.x - first.x;
      const dy = palm.y - first.y;
      if (tMs - this.lastSwipeMs >= this.cfg.swipeCooldownMs && Math.abs(dx) >= this.cfg.swipeMinHandSizes * size && Math.abs(dy) < Math.abs(dx) * 0.5) {
        // Image x decreasing = hand moving to the student's right (when mirrored).
        const handRight = this.cfg.mirror ? dx < 0 : dx > 0;
        events.push({ type: "swipe", direction: handRight ? "right" : "left", tMs });
        this.lastSwipeMs = tMs;
        this.trail = [];
        this.palmSince = null;
        this.palmFired = true; // a swipe never also opens the menu
      }
    } else {
      this.trail = [];
    }

    // Open palm held still -> menu (once per hold).
    if (rawPose === "open_palm") {
      if (this.palmSince === null) {
        this.palmSince = tMs;
        this.palmStart = palm;
      } else if (this.palmStart && Math.hypot(palm.x - this.palmStart.x, palm.y - this.palmStart.y) > this.cfg.palmStillHandSizes * size) {
        // Moving: restart the hold from here.
        this.palmSince = tMs;
        this.palmStart = palm;
      }
      if (!this.palmFired && tMs - this.palmSince >= this.cfg.palmHoldMs) {
        events.push({ type: "menu", tMs });
        this.palmFired = true;
      }
    } else {
      this.palmSince = null;
      this.palmStart = null;
      this.palmFired = false;
    }

    const pose: Pose = this.pinchActive ? "pinch" : rawPose === "pinch" ? "point" : rawPose;
    return { tMs, handPresent: true, pose, rawPose, pinching: this.pinchActive, cursor: this.cursor, events, landmarks: lms };
  }
}
