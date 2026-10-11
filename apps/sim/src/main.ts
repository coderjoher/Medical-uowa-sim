import { DEFAULT_REACH, synthFrame, type Calibration, type HandFrame, type SynthPose } from "@sim/tracking";
import { api, auth, ApiError } from "./api.js";
import type { Ctx, User } from "./context.js";
import { HandInput } from "./input/hand-input.js";
import { calibrationScreen } from "./screens/calibration.js";
import { consentScreen } from "./screens/consent.js";
import { debriefScreen } from "./screens/debrief.js";
import { labCheckScreen } from "./screens/labcheck.js";
import { loginScreen } from "./screens/login.js";
import { playerScreen } from "./screens/player.js";
import { sessionsScreen } from "./screens/sessions.js";
import { h, mount } from "./ui.js";

const params = new URLSearchParams(location.search);
const ctx: Ctx = { hand: new HandInput(), user: null, mode: "mouse", fakeHand: params.get("fakeHand") === "1" };

const store = {
  get<T>(k: string): T | null {
    try {
      const v = localStorage.getItem(k);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  },
  set(k: string, v: unknown) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
};

/** Test hook: drive the hand pipeline with synthetic landmarks (no camera). */
if (ctx.fakeHand) {
  ctx.hand.enableSynthetic();
  let t = 0;
  (window as unknown as { __sim: Record<string, unknown> }).__sim = {
    feed: (frame: HandFrame) => ctx.hand.process(frame),
    /** Feed `ms` of a pose with the fingertip at screen point (sx, sy). */
    hold: (pose: SynthPose | null, sx: number, sy: number, ms: number) => {
      const r = DEFAULT_REACH;
      const x = r.maxX - (sx / innerWidth) * (r.maxX - r.minX);
      const tipY = r.minY + (sy / innerHeight) * (r.maxY - r.minY);
      // synthHand places the index tip 0.85 hand sizes above the knuckle anchor.
      for (let i = 0; i < Math.round(ms / 33); i++) {
        t += 33;
        ctx.hand.process(synthFrame(t, pose, { x: x + 0.03, y: tipY + 0.085 }));
      }
    },
  };
}

async function startInput(choice: "hand" | "mouse"): Promise<void> {
  if (choice === "mouse") {
    ctx.mode = "mouse";
    ctx.hand.enabled = false;
    return;
  }
  if (ctx.fakeHand) {
    ctx.mode = "hand";
    ctx.hand.enabled = true;
    return;
  }
  try {
    await ctx.hand.start();
  } catch (e) {
    mount(h("main.center", h("div.card.narrow", h("h1", "Camera not available"), h("p", String((e as Error).message)), h("p", "Continuing with the mouse."))));
    await new Promise((r) => setTimeout(r, 2000));
    ctx.mode = "mouse";
    return;
  }
  const saved = store.get<Calibration>("sim.calibration");
  if (saved) {
    ctx.hand.applyCalibration(saved);
    ctx.hand.enabled = true;
    ctx.mode = "hand";
    return;
  }
  const ok = await new Promise<boolean>((resolve) => calibrationScreen(ctx, resolve));
  ctx.mode = ok ? "hand" : "mouse";
  if (!ok) ctx.hand.stop();
}

async function play(sessionId: string, caseId: string, seatId: string | null) {
  const r = await api<Parameters<typeof playerScreen>[1] & { resumed: boolean }>("POST", `/api/sessions/${sessionId}/attempts`, { caseId, ...(seatId ? { seatId } : {}) });
  store.set("sim.current", { attemptId: r.attempt.id, mode: null });
  const choice = await new Promise<"hand" | "mouse">((resolve) => consentScreen(resolve));
  store.set("sim.current", { attemptId: r.attempt.id, mode: choice });
  await startInput(choice);
  await runAttempt(r);
}

async function runAttempt(payload: Parameters<typeof playerScreen>[1]) {
  await playerScreen(ctx, payload, (attemptId, sc) => {
    store.set("sim.current", null);
    if (ctx.mode === "hand") store.set("sim.calibration", null);
    void debriefScreen(attemptId, sc, () => void home());
  });
}

async function home() {
  try {
    await sessionsScreen(ctx, (s, c, seat) => void play(s, c, seat).catch(showError));
  } catch (e) {
    showError(e);
  }
}

function showError(e: unknown) {
  if (e instanceof ApiError && e.status === 401) {
    auth.token = null;
    return loginScreen(ctx, () => void home());
  }
  mount(h("main.center", h("div.card.narrow", h("h1", "Something went wrong"), h("p", e instanceof Error ? e.message : String(e)), h("button.primary.big", { on: { click: () => location.reload() } }, "Reload"))));
}

/** Calibration is kept per attempt so a refresh does not ask for it again. */
ctx.hand.onStatus = () => {};
const origApply = ctx.hand.applyCalibration.bind(ctx.hand);
ctx.hand.applyCalibration = (c: Calibration) => {
  store.set("sim.calibration", c);
  origApply(c);
};

async function boot() {
  if (params.get("labcheck") === "1") return labCheckScreen(ctx);
  if (!auth.token) return loginScreen(ctx, () => void home());
  try {
    ctx.user = await api<User>("GET", "/api/me");
  } catch (e) {
    return showError(e);
  }
  // Resume an attempt interrupted by a refresh or crash.
  const current = store.get<{ attemptId: string; mode: "hand" | "mouse" | null }>("sim.current");
  if (current) {
    try {
      const payload = await api<Parameters<typeof playerScreen>[1]>("GET", `/api/attempts/${current.attemptId}`);
      if (payload.attempt.status === "in_progress") {
        const choice = current.mode ?? (await new Promise<"hand" | "mouse">((resolve) => consentScreen(resolve)));
        store.set("sim.current", { attemptId: current.attemptId, mode: choice });
        await startInput(choice);
        return runAttempt(payload);
      }
    } catch {
      /* fall through to the session list */
    }
    store.set("sim.current", null);
  }
  return home();
}

void boot();
