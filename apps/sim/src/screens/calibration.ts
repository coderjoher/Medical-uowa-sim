import { computeCalibration, handSize, pinchRatio, type Calibration, type CalibrationSamples } from "@sim/tracking";
import type { Ctx } from "../context.js";
import { h, mount } from "../ui.js";

type Step = { key: "open" | "reach" | "pinch"; text: string; ms: number };
const STEPS: Step[] = [
  { key: "open", text: "Hold your hand up, open, facing the screen.", ms: 2000 },
  { key: "reach", text: "Point with your index finger and slowly draw a big circle covering the area you can comfortably reach.", ms: 5000 },
  { key: "pinch", text: "Pinch: touch your thumb and index fingertips together and hold.", ms: 2000 },
];

/** About 10 seconds: choose hand, open hand, comfortable reach, pinch (PRD calibration). */
export function calibrationScreen(ctx: Ctx, done: (ok: boolean) => void): void {
  const status = h("p.big-text", { "aria-live": "polite" });
  const bar = h("div.progress-bar");
  const progress = h("div.progress", bar);
  const preview = h("canvas.calib-preview", { width: 320, height: 180, "aria-hidden": "true" });

  const chooseHand = () =>
    mount(
      h(
        "main.center",
        h(
          "div.card.narrow",
          h("h1", "Calibrate hand tracking"),
          h("p", "Which hand will you use?"),
          h("div.row", h("button.primary.big", { on: { click: () => run("left") } }, "Left hand"), h("button.primary.big", { on: { click: () => run("right") } }, "Right hand")),
          h("button.link", { on: { click: () => done(false) } }, "Use the mouse instead"),
        ),
      ),
    );

  const run = (hand: "left" | "right") => {
    ctx.hand.enabled = false; // no clicking while calibrating
    mount(h("main.center", h("div.card.narrow", h("h1", "Calibrating"), status, progress, preview, h("button.link", { on: { click: () => finish(null) } }, "Cancel and use the mouse"))));
    const samples: CalibrationSamples = { hand, openRatios: [], pinchRatios: [], reachPoints: [], handSizes: [] };
    let step = 0;
    let stepStart = performance.now();
    let waitingForHand = true;
    status.textContent = STEPS[0]!.text;

    const prev = ctx.hand.onFrame;
    ctx.hand.onFrame = (_s, raw) => {
      const handData = raw.hands.find((x) => x.handedness === hand && x.score >= 0.6);
      drawPreview(preview, ctx, handData?.landmarks ?? null);
      const now = performance.now();
      if (!handData) {
        if (!waitingForHand) status.textContent = `${STEPS[step]!.text} (hand not visible — keep it in front of the camera)`;
        return;
      }
      if (waitingForHand) {
        waitingForHand = false;
        stepStart = now;
        status.textContent = STEPS[step]!.text;
      }
      const lms = handData.landmarks;
      const st = STEPS[step]!;
      if (st.key === "open") {
        samples.openRatios.push(pinchRatio(lms));
        samples.handSizes.push(handSize(lms));
      } else if (st.key === "reach") samples.reachPoints.push({ x: lms[8]!.x, y: lms[8]!.y });
      else samples.pinchRatios.push(pinchRatio(lms));
      const k = (now - stepStart) / st.ms;
      bar.style.width = `${Math.min(100, ((step + Math.min(1, k)) / STEPS.length) * 100)}%`;
      if (k >= 1) {
        step++;
        stepStart = now;
        if (step >= STEPS.length) {
          ctx.hand.onFrame = prev;
          const r = computeCalibration(samples);
          if (r.ok) finish(r.calibration);
          else retry(r.reason);
          return;
        }
        status.textContent = STEPS[step]!.text;
      }
    };
  };

  const retry = (reason: string) =>
    mount(
      h(
        "main.center",
        h(
          "div.card.narrow",
          h("h1", "Let's try that again"),
          h("p", reason),
          h("div.row", h("button.primary.big", { on: { click: chooseHand } }, "Try again"), h("button.big", { on: { click: () => finish(null) } }, "Use the mouse")),
        ),
      ),
    );

  const finish = (c: Calibration | null) => {
    ctx.hand.onFrame = () => {};
    if (c) {
      ctx.hand.applyCalibration(c);
      ctx.hand.enabled = true;
      done(true);
    } else done(false);
  };

  chooseHand();
}

/** Mirrored camera preview with the detected hand skeleton. */
export function drawPreview(canvas: HTMLCanvasElement, ctx: Ctx, lms: { x: number; y: number }[] | null): void {
  const g = canvas.getContext("2d");
  if (!g) return;
  const W = canvas.width;
  const H = canvas.height;
  g.save();
  g.translate(W, 0);
  g.scale(-1, 1);
  const v = ctx.hand.videoElement;
  if (v && v.readyState >= 2) g.drawImage(v, 0, 0, W, H);
  else {
    g.fillStyle = "#1d2a33";
    g.fillRect(0, 0, W, H);
  }
  if (lms) {
    const bones = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [5, 9, 10, 11, 12], [9, 13, 14, 15, 16], [13, 17, 18, 19, 20], [0, 17]];
    g.strokeStyle = "#3ee07a";
    g.lineWidth = 3;
    for (const b of bones) {
      g.beginPath();
      b.forEach((i, j) => (j ? g.lineTo(lms[i]!.x * W, lms[i]!.y * H) : g.moveTo(lms[i]!.x * W, lms[i]!.y * H)));
      g.stroke();
    }
  }
  g.restore();
}
