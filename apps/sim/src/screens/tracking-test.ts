import type { GestureEvent } from "@sim/tracking";
import { api } from "../api.js";
import type { Ctx } from "../context.js";
import { h, mount } from "../ui.js";

export interface TrackingTestOptions {
  targets: number;
  restSeconds: number;
  seatId: string | null;
}

interface Result {
  durationMs: number;
  targets: number;
  detected: number;
  strayPinches: number;
  falseClicks: number;
  restMs: number;
  handLost: number;
  recoveryMs: number[];
  trackingFps: number;
  renderFps: number;
  pipelineP95Ms: number | null;
}

const TARGET_PX = 88;
const TARGET_TIMEOUT_MS = 6000;

/**
 * Hand-tracking test for the PRD prototype go/no-go: measures intended pinches detected,
 * false clicks while pointing, hand losses and recovery, and frame rates, then saves the run.
 */
export async function trackingTestScreen(ctx: Ctx, opts: TrackingTestOptions): Promise<void> {
  const stage = h("div.tt-stage", { "aria-live": "polite" });
  const status = h("p.big-text");
  const progress = h("div.progress-bar");
  mount(h("main.tt", h("header.hud", h("strong", "Hand-tracking test"), status, h("div.progress", { style: { width: "240px" } }, progress)), stage));

  let handLost = 0;
  const recoveryMs: number[] = [];
  let onPinch: ((e: Extract<GestureEvent, { type: "pinch-start" }>) => void) | null = null;
  ctx.hand.enabled = true;
  ctx.hand.onGesture = (e) => {
    if (e.type === "hand-lost") handLost++;
    if (e.type === "hand-found") recoveryMs.push(Math.round(e.lostForMs));
    if (e.type === "pinch-start") onPinch?.(e);
  };

  // Render frame rate while the test runs.
  let frames = 0;
  let rafRunning = true;
  const raf = () => {
    frames++;
    if (rafRunning) requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  const fpsSamples: number[] = [];
  const fpsTimer = setInterval(() => fpsSamples.push(ctx.hand.fps), 1000);

  const started = performance.now();
  const W = () => innerWidth;
  const H = () => innerHeight;
  const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ---- Part 1: targets ----------------------------------------------------------------------
  status.textContent = "Part 1: point at each circle and pinch.";
  let detected = 0;
  let strayPinches = 0;
  for (let i = 0; i < opts.targets; i++) {
    progress.style.width = `${(i / (opts.targets + 1)) * 100}%`;
    const x = rand(0.12, 0.88) * W();
    const y = rand(0.2, 0.85) * H();
    const target = h("div.tt-target", { id: "tt-target", "data-hand-target": "", style: { left: `${x - TARGET_PX / 2}px`, top: `${y - TARGET_PX / 2}px`, width: `${TARGET_PX}px`, height: `${TARGET_PX}px` } }, String(i + 1));
    stage.replaceChildren(target);
    const hit = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), TARGET_TIMEOUT_MS);
      onPinch = (e) => {
        const r = target.getBoundingClientRect();
        const inside = e.x >= r.left - 24 && e.x <= r.right + 24 && e.y >= r.top - 24 && e.y <= r.bottom + 24;
        if (inside) {
          clearTimeout(timer);
          resolve(true);
        } else strayPinches++;
      };
      // Mouse clicks do not count: this measures the hand only.
    });
    onPinch = null;
    if (hit) detected++;
    target.classList.add(hit ? "hit" : "miss");
    await wait(450);
  }

  // ---- Part 2: point without pinching --------------------------------------------------------
  status.textContent = "Part 2: follow the dot with your index finger. Do not pinch.";
  const dot = h("div.tt-dot", { id: "tt-dot" });
  stage.replaceChildren(dot);
  let falseClicks = 0;
  onPinch = () => falseClicks++;
  const restStart = performance.now();
  const restMs = opts.restSeconds * 1000;
  await new Promise<void>((resolve) => {
    const step = () => {
      const t = (performance.now() - restStart) / 1000;
      dot.style.left = `${W() / 2 + Math.sin(t * 0.6) * W() * 0.32 - 20}px`;
      dot.style.top = `${H() / 2 + Math.sin(t * 0.9 + 1) * H() * 0.28 - 20}px`;
      progress.style.width = `${((opts.targets + Math.min(1, (performance.now() - restStart) / restMs)) / (opts.targets + 1)) * 100}%`;
      if (performance.now() - restStart >= restMs) resolve();
      else requestAnimationFrame(step);
    };
    step();
  });
  onPinch = null;

  const durationMs = Math.round(performance.now() - started);
  rafRunning = false;
  clearInterval(fpsTimer);
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
  const result: Result = {
    durationMs,
    targets: opts.targets,
    detected,
    strayPinches,
    falseClicks,
    restMs,
    handLost,
    recoveryMs,
    trackingFps: Math.round(median(fpsSamples.filter((f) => f > 0)) * 10) / 10,
    renderFps: Math.round((frames / (durationMs / 1000)) * 10) / 10,
    pipelineP95Ms: ctx.hand.pipelineP95,
  };
  ctx.hand.onGesture = () => {};
  showResult(ctx, result, opts);
}

function showResult(ctx: Ctx, r: Result, opts: TrackingTestOptions) {
  const per5 = (n: number, ms: number) => (ms > 0 ? (n / ms) * 300_000 : 0);
  const recovery95 = r.recoveryMs.length ? [...r.recoveryMs].sort((a, b) => a - b)[Math.floor(0.95 * (r.recoveryMs.length - 1))]! : null;
  const rows: [string, string, string, boolean | null][] = [
    ["Intended pinches detected", `${Math.round((r.detected / r.targets) * 1000) / 10}% (${r.detected}/${r.targets})`, "≥ 95%", r.detected / r.targets >= 0.95],
    ["Unintended pinches", `${per5(r.falseClicks, r.restMs).toFixed(1)} per 5 min (${r.falseClicks})`, "≤ 1 per 5 min", per5(r.falseClicks, r.restMs) <= 1],
    ["Hand lost", `${per5(r.handLost, r.durationMs).toFixed(1)} per 5 min (${r.handLost})`, "≤ 1 per 5 min", per5(r.handLost, r.durationMs) <= 1],
    ["Recovery after loss (p95)", recovery95 === null ? "no losses" : `${recovery95} ms`, "< 1 s", recovery95 === null || recovery95 < 1000],
    ["Tracking frame rate", `${r.trackingFps} fps`, "≥ 30 fps", r.trackingFps >= 30],
    ["Screen frame rate", `${r.renderFps} fps`, "≥ 60 fps", r.renderFps >= 60],
    ["Tracking pipeline latency (p95)", r.pipelineP95Ms === null ? "—" : `${r.pipelineP95Ms} ms`, "≤ 100 ms end to end*", null],
  ];
  let felt: boolean | null = null;
  const saved = h("p.muted", { role: "status" });
  const save = async () => {
    try {
      await api("POST", "/api/tracking-tests", {
        ...(opts.seatId ? { seatId: opts.seatId } : {}),
        durationMs: r.durationMs,
        targets: r.targets,
        detected: r.detected,
        falseClicks: r.falseClicks,
        restMs: r.restMs,
        handLost: r.handLost,
        recoveryMs: r.recoveryMs,
        trackingFps: r.trackingFps,
        renderFps: r.renderFps,
        ...(r.pipelineP95Ms !== null ? { pipelineP95Ms: r.pipelineP95Ms } : {}),
        ...(felt !== null ? { feltReliable: felt } : {}),
        details: { strayPinches: r.strayPinches, userAgent: navigator.userAgent, screen: `${screen.width}x${screen.height}` },
      });
      saved.textContent = "Saved. Thank you.";
      saveBtn.disabled = true;
    } catch (e) {
      saved.textContent = `Could not save: ${(e as Error).message}`;
    }
  };
  const feltRow = h(
    "div.row",
    h("strong", "Did hand tracking feel reliable?"),
    ...([true, false] as const).map((v) => {
      const b = h("button.big", { "aria-pressed": "false", on: { click: () => ((felt = v), feltRow.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))), b.classList.add("active"), (saveBtn.disabled = false)) } }, v ? "Yes" : "No");
      return b;
    }),
  );
  const saveBtn = h("button.primary.big", { disabled: true, on: { click: () => void save() } }, "Save result");
  mount(
    h(
      "main.page",
      h("h1", "Hand-tracking test result"),
      h(
        "table.areas",
        h("thead", h("tr", h("th", "Measure"), h("th", "Result"), h("th", "Target"), h("th", ""))),
        h("tbody", ...rows.map(([m, v, t, ok]) => h("tr", h("td", m), h("td", v), h("td", t), h("td", { class: ok === null ? "muted" : ok ? "pass" : "fail" }, ok === null ? "see note" : ok ? "✓" : "✗")))),
      ),
      h("p.muted", "* Measured from camera frame capture to gesture processed. It excludes camera exposure and display time, so confirm the 100 ms end-to-end target with a high-speed camera."),
      h("section.card", feltRow, h("div.row", saveBtn, h("button.big", { on: { click: () => location.reload() } }, "Run again")), saved),
    ),
  );
  ctx.hand.enabled = false;
}
