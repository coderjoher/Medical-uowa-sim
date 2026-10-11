import { describe, expect, it } from "vitest";
import {
  computeCalibration,
  fingersExtended,
  HandInteraction,
  mulberry32,
  OneEuroFilter,
  pinchRatio,
  PinchDetector,
  snap,
  synthFrame,
  synthHand,
  toScreen,
  type GestureEvent,
  type HandFrame,
  type SynthPose,
} from "../src/index.js";

const FPS = 30;
const DT = 1000 / FPS;

/** A recording: a list of (duration ms, pose, position) segments, played at 30 fps. */
type Segment = { ms: number; pose: SynthPose | null; x?: number; y?: number; toX?: number; score?: number; hand?: "left" | "right" };
function record(segments: Segment[], noise = 0, seed = 1): HandFrame[] {
  const rand = mulberry32(seed);
  const frames: HandFrame[] = [];
  let t = 0;
  for (const s of segments) {
    const n = Math.max(1, Math.round(s.ms / DT));
    for (let i = 0; i < n; i++) {
      const x = s.toX !== undefined ? (s.x ?? 0.5) + ((s.toX - (s.x ?? 0.5)) * i) / (n - 1 || 1) : (s.x ?? 0.5);
      frames.push(synthFrame(t, s.pose, { x, y: s.y ?? 0.45, noise, rand, score: s.score ?? 0.95, handedness: s.hand ?? "right" }));
      t += DT;
    }
  }
  return frames;
}

function play(frames: HandFrame[], hi = new HandInteraction({ screenWidth: 1920, screenHeight: 1080 })) {
  const events: GestureEvent[] = [];
  const states = frames.map((f) => {
    const s = hi.process(f);
    events.push(...s.events);
    return s;
  });
  return { events, states, types: events.map((e) => (e.type === "swipe" ? `swipe-${e.direction}` : e.type)) };
}

describe("One Euro filter", () => {
  it("reduces jitter at rest", () => {
    const rand = mulberry32(7);
    const f = new OneEuroFilter({ minCutoff: 1.2, beta: 0.01, dCutoff: 1 });
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      const v = 500 + (rand() - 0.5) * 10;
      raw.push(v);
      out.push(f.filter(v, i * DT));
    }
    const sd = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
    };
    expect(sd(out.slice(30))).toBeLessThan(sd(raw.slice(30)) * 0.4);
  });

  it("follows fast movement with little lag", () => {
    const f = new OneEuroFilter({ minCutoff: 1.2, beta: 0.01, dCutoff: 1 });
    // A hand sweeping across the screen at 2000 px/s.
    let lag = 0;
    for (let i = 0; i < 30; i++) {
      const v = i * DT * 2;
      lag = v - f.filter(v, i * DT);
    }
    // Lag below one frame of movement (2000 px/s * 33 ms = 67 px).
    expect(lag).toBeLessThan(67);
  });
});

describe("hand geometry", () => {
  it("classifies fingers", () => {
    expect(fingersExtended(synthHand("open_palm", { x: 0.5, y: 0.5 }))).toEqual([true, true, true, true]);
    expect(fingersExtended(synthHand("point", { x: 0.5, y: 0.5 }))).toEqual([true, false, false, false]);
    expect(fingersExtended(synthHand("fist", { x: 0.5, y: 0.5 }))).toEqual([false, false, false, false]);
  });

  it("pinch ratio is independent of distance from the camera", () => {
    const near = pinchRatio(synthHand("pinch_open", { x: 0.5, y: 0.5, scale: 0.15 }));
    const far = pinchRatio(synthHand("pinch_open", { x: 0.5, y: 0.5, scale: 0.06 }));
    expect(near).toBeCloseTo(far, 6);
  });
});

describe("pinch hysteresis", () => {
  it("starts below the start threshold and only releases above the release threshold", () => {
    const p = new PinchDetector({ start: 0.3, release: 0.45 });
    expect(p.update(0.5)).toBe(false);
    expect(p.update(0.35)).toBe(false);
    expect(p.update(0.29)).toBe(true);
    expect(p.update(0.4)).toBe(true); // between thresholds: stays pinched
    expect(p.update(0.44)).toBe(true);
    expect(p.update(0.46)).toBe(false);
    expect(p.update(0.35)).toBe(false); // between thresholds: stays released
  });

  it("does not flicker when the ratio hovers around one threshold", () => {
    const p = new PinchDetector({ start: 0.3, release: 0.45 });
    const states = [0.29, 0.31, 0.29, 0.31, 0.3, 0.32].map((r) => p.update(r));
    expect(states).toEqual([true, true, true, true, true, true]);
  });

  it("rejects thresholds without a gap", () => {
    expect(() => new PinchDetector({ start: 0.4, release: 0.3 })).toThrow();
  });
});

describe("gesture timing", () => {
  it("a pinch shorter than 150 ms never clicks", () => {
    const { types } = play(record([{ ms: 300, pose: "point" }, { ms: 130, pose: "pinch" }, { ms: 300, pose: "point" }]));
    expect(types).not.toContain("pinch-start");
  });

  it("a pinch held 200 ms clicks exactly once and releases once", () => {
    const { types } = play(record([{ ms: 300, pose: "point" }, { ms: 200, pose: "pinch" }, { ms: 300, pose: "point" }]));
    expect(types.filter((t) => t === "pinch-start")).toHaveLength(1);
    expect(types.filter((t) => t === "pinch-end")).toHaveLength(1);
  });

  it("a long pinch-and-hold is one click (drag), not many", () => {
    const { types } = play(record([{ ms: 300, pose: "point" }, { ms: 3000, pose: "pinch" }, { ms: 300, pose: "point" }]));
    expect(types).toEqual(["pinch-start", "pinch-end"]);
  });

  it("an open palm shorter than 150 ms never opens the menu; 200 ms opens it once", () => {
    expect(play(record([{ ms: 300, pose: "point" }, { ms: 130, pose: "open_palm" }, { ms: 300, pose: "point" }])).types).not.toContain("menu");
    expect(play(record([{ ms: 300, pose: "point" }, { ms: 2000, pose: "open_palm" }, { ms: 300, pose: "point" }])).types.filter((t) => t === "menu")).toHaveLength(1);
  });

  it("clicks where the cursor was before the fingers closed", () => {
    const { events, states } = play(record([{ ms: 600, pose: "point", x: 0.5 }, { ms: 300, pose: "pinch", x: 0.5 }]));
    const click = events.find((e) => e.type === "pinch-start")!;
    const before = states[17]!.cursor!; // last pointing frame
    expect(click.type === "pinch-start" && Math.hypot(click.x - before.x, click.y - before.y)).toBeLessThan(5);
  });
});

describe("swipes", () => {
  it("detects a fast open-palm swipe in the direction of the hand", () => {
    // Image x decreasing = the student's hand moves to their right.
    const right = play(record([{ ms: 100, pose: "open_palm", x: 0.6 }, { ms: 250, pose: "open_palm", x: 0.6, toX: 0.35 }, { ms: 200, pose: "point", x: 0.35 }]));
    expect(right.types).toContain("swipe-right");
    expect(right.types).not.toContain("menu");
    const left = play(record([{ ms: 100, pose: "open_palm", x: 0.35 }, { ms: 250, pose: "open_palm", x: 0.35, toX: 0.6 }, { ms: 200, pose: "point", x: 0.6 }]));
    expect(left.types).toContain("swipe-left");
  });

  it("never swipes from normal pointing movement", () => {
    const { types } = play(record([{ ms: 250, pose: "point", x: 0.6, toX: 0.3 }, { ms: 250, pose: "point", x: 0.3, toX: 0.6 }]));
    expect(types.filter((t) => t.startsWith("swipe"))).toEqual([]);
  });

  it("slow open-palm drift is neither a swipe nor a menu", () => {
    const { types } = play(record([{ ms: 3000, pose: "open_palm", x: 0.4, toX: 0.6 }]));
    expect(types.filter((t) => t.startsWith("swipe"))).toEqual([]);
  });
});

describe("confidence, hand loss and selection", () => {
  it("ignores low-confidence frames: the cursor does not move", () => {
    const hi = new HandInteraction({ screenWidth: 1920, screenHeight: 1080 });
    const { states } = play(record([{ ms: 300, pose: "point", x: 0.5 }, { ms: 150, pose: "point", x: 0.25, score: 0.3 }]), hi);
    const atGood = states[8]!.cursor!;
    const atBad = states[states.length - 1]!.cursor!;
    expect(atBad).toEqual(atGood);
  });

  it("reports hand lost and found, and releases a held pinch when lost", () => {
    const { types, events } = play(record([{ ms: 300, pose: "point" }, { ms: 300, pose: "pinch" }, { ms: 600, pose: null }, { ms: 300, pose: "point" }]));
    expect(types).toEqual(["pinch-start", "pinch-end", "hand-lost", "hand-found"]);
    expect(events.find((e) => e.type === "pinch-end")).toMatchObject({ reason: "lost" });
    const found = events.find((e) => e.type === "hand-found");
    expect(found?.type === "hand-found" && found.lostForMs).toBeLessThan(1000);
  });

  it("a short dropout (< 250 ms) is not a hand loss", () => {
    const { types } = play(record([{ ms: 300, pose: "point" }, { ms: 150, pose: null }, { ms: 300, pose: "point" }]));
    expect(types).toEqual([]);
  });

  it("tracks only the hand chosen at calibration", () => {
    const { states } = play(record([{ ms: 300, pose: "point", hand: "left" }]));
    expect(states.every((s) => !s.handPresent)).toBe(true);
  });
});

describe("noisy replay", () => {
  it("one minute of jittery pointing produces no false clicks, swipes or menus", () => {
    const segs: Segment[] = [];
    for (let i = 0; i < 20; i++) segs.push({ ms: 1500, pose: "point", x: 0.35 + (i % 5) * 0.07, toX: 0.35 + ((i + 2) % 5) * 0.07 }, { ms: 1500, pose: "point", x: 0.35 + ((i + 2) % 5) * 0.07 });
    const { types } = play(record(segs, 0.004, 42));
    expect(types).toEqual([]);
  });

  it("detects every intended pinch in a noisy recording", () => {
    const segs: Segment[] = [];
    for (let i = 0; i < 20; i++) segs.push({ ms: 500, pose: "point" }, { ms: 300, pose: "pinch" });
    segs.push({ ms: 500, pose: "point" });
    const { types } = play(record(segs, 0.004, 9));
    expect(types.filter((t) => t === "pinch-start")).toHaveLength(20);
    expect(types.filter((t) => t === "pinch-end")).toHaveLength(20);
  });
});

describe("calibration", () => {
  const reachPoints = Array.from({ length: 100 }, (_, i) => ({ x: 0.3 + 0.4 * ((i % 10) / 9), y: 0.25 + 0.4 * (Math.floor(i / 10) / 9) }));

  it("maps the measured reach box to the full screen, mirrored", () => {
    const r = computeCalibration({ hand: "right", openRatios: Array(10).fill(1), pinchRatios: Array(10).fill(0.1), reachPoints, handSizes: [0.1] });
    if (!r.ok) throw new Error(r.reason);
    const { reach, pinch } = r.calibration;
    expect(toScreen({ x: reach.minX, y: reach.minY }, reach, 1920, 1080)).toEqual({ x: 1920, y: 0 });
    expect(toScreen({ x: reach.maxX, y: reach.maxY }, reach, 1920, 1080)).toEqual({ x: 0, y: 1080 });
    expect(toScreen({ x: 0, y: 0 }, reach, 1920, 1080)).toEqual({ x: 1920, y: 0 }); // clamped
    expect(pinch.start).toBeLessThan(pinch.release);
    expect(pinch.start).toBeGreaterThan(0.1);
    expect(pinch.release).toBeLessThan(1);
  });

  it("refuses a pinch that is not distinct from an open hand", () => {
    const r = computeCalibration({ hand: "right", openRatios: Array(10).fill(0.5), pinchRatios: Array(10).fill(0.4), reachPoints, handSizes: [0.1] });
    expect(r.ok).toBe(false);
  });

  it("refuses a tiny reach area", () => {
    const tiny = reachPoints.map((p) => ({ x: 0.5 + (p.x - 0.5) * 0.1, y: 0.5 + (p.y - 0.5) * 0.1 }));
    expect(computeCalibration({ hand: "right", openRatios: Array(10).fill(1), pinchRatios: Array(10).fill(0.1), reachPoints: tiny, handSizes: [0.1] }).ok).toBe(false);
  });
});

describe("snapping", () => {
  const targets = [
    { id: "a", x: 100, y: 100, width: 64, height: 64 },
    { id: "b", x: 300, y: 100, width: 64, height: 64 },
  ];
  it("snaps to the nearest target within range", () => {
    expect(snap(180, 130, targets)?.target.id).toBe("a");
    expect(snap(280, 130, targets)?.target.id).toBe("b");
    expect(snap(120, 120, targets)).toMatchObject({ x: 132, y: 132 });
  });
  it("does not snap outside the radius", () => {
    expect(snap(232, 300, targets)).toBeNull();
  });
});
