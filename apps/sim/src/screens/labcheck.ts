import { api } from "../api.js";
import type { Ctx } from "../context.js";

import type { SimScene as SimSceneT } from "../scene/scene.js";
import { h, mount } from "../ui.js";
import { drawPreview } from "./calibration.js";

/**
 * Two-minute seat check before a session (PRD "Lab check routine"): camera, lighting, tracking
 * frame rate, 3D frame rate with the real room, and headphones. The result is saved per seat so
 * staff can see which seats are ready.
 */
export async function labCheckScreen(ctx: Ctx, seatId: string | null): Promise<void> {
  const rows = {
    camera: h("td", "…"),
    light: h("td", "…"),
    fps: h("td", "…"),
    render: h("td", "Measuring…"),
    hand: h("td", "…"),
    audio: h("td", "Not tested"),
  };
  const preview = h("canvas.calib-preview", { width: 480, height: 270, "aria-hidden": "true" });
  const verdict = h("p.big-text", { "aria-live": "polite" });
  const saved = h("p.muted", { role: "status" });
  let heard: boolean | null = null;
  let cameraOk = false;
  let renderFps: number | null = null;
  let seenHand = false;

  const tone = () => {
    const ac = new AudioContext();
    const o = ac.createOscillator();
    o.frequency.value = 440;
    o.connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 1);
  };
  const saveBtn = h("button.primary.big", { disabled: true, on: { click: () => void save() } }, "Save result");
  mount(
    h(
      "main.page.labcheck",
      h("h1", "Lab check"),
      h("p", "Sit as you will during the session and hold your hand up in front of the camera. The 3D room renders behind this panel to measure the frame rate."),
      preview,
      h(
        "table.areas",
        h(
          "tbody",
          h("tr", h("th", "Camera"), rows.camera),
          h("tr", h("th", "Lighting"), rows.light),
          h("tr", h("th", "Tracking frame rate (≥ 30 fps)"), rows.fps),
          h("tr", h("th", "3D frame rate (≥ 60 fps)"), rows.render),
          h("tr", h("th", "Hand detected"), rows.hand),
          h("tr", h("th", "Headphones"), rows.audio),
        ),
      ),
      h(
        "div.row",
        h("button.big", { on: { click: tone } }, "Play test tone"),
        h("button.big", { on: { click: () => ((heard = true), (rows.audio.textContent = "✓ Heard")) } }, "I heard it"),
        h("button.big", { on: { click: () => ((heard = false), (rows.audio.textContent = "✗ Not heard — check headphones")) } }, "I did not hear it"),
      ),
      verdict,
      h("div.row", saveBtn),
      saved,
      h("a", { href: "/" }, "Back to sign in"),
    ),
  );

  // 3D frame rate with the real room and patient, measured after the scene has warmed up.
  const canvas = document.getElementById("scene") as HTMLCanvasElement;
  canvas.style.visibility = "visible";
  // The 3D engine loads on demand, so sign-in and the session list stay light.
  const { SimScene } = await import("../scene/scene.js");
  const scene: SimSceneT = new SimScene(canvas);
  scene.vitals = { hr: 80, sbp: 120, dbp: 80, rr: 16, spo2: 98, temp: 36.8 };
  void scene.load("adult_male").then(() =>
    setTimeout(() => {
      const samples: number[] = [];
      const t = setInterval(() => {
        samples.push(scene.engine.getFps());
        if (samples.length >= 10) {
          clearInterval(t);
          renderFps = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
          rows.render.textContent = `${renderFps >= 60 ? "✓" : "✗"} ${renderFps} fps at ${innerWidth}×${innerHeight}`;
        }
      }, 500);
    }, 2000),
  );

  try {
    if (!ctx.fakeHand) await ctx.hand.start();
    cameraOk = true;
    rows.camera.textContent = "✓ Working";
  } catch (e) {
    rows.camera.textContent = `✗ ${(e as Error).message}`;
  }
  ctx.hand.enabled = false;
  ctx.hand.onFrame = (s) => {
    drawPreview(preview, ctx, s.landmarks);
    if (s.handPresent) seenHand = true;
  };

  const status = () => {
    const fps = ctx.hand.fps;
    const light = ctx.hand.lightLevel;
    return { fps, light, ok: cameraOk && fps >= 30 && light >= 0.18 && light <= 0.85 && seenHand && heard === true && (renderFps ?? 0) >= 60 };
  };
  const tick = setInterval(() => {
    const { fps, light, ok } = status();
    if (cameraOk) {
      rows.fps.textContent = `${fps >= 30 ? "✓" : "✗"} ${fps.toFixed(0)} fps`;
      rows.light.textContent = light < 0.18 ? "✗ Too dark — add front lighting" : light > 0.85 ? "✗ Too bright / backlit" : "✓ OK";
    }
    rows.hand.textContent = seenHand ? "✓ Yes" : "Waiting for a hand…";
    verdict.textContent = ok ? "✓ Seat ready" : "Checking… (all rows must pass, including the headphone test)";
    saveBtn.disabled = heard === null || renderFps === null;
  }, 500);

  const save = async () => {
    const { fps, light } = status();
    try {
      const r = await api<{ passed: boolean }>("POST", "/api/lab-checks", {
        ...(seatId ? { seatId } : {}),
        cameraOk,
        lightLevel: Math.round(light * 1000) / 1000,
        trackingFps: Math.round(fps * 10) / 10,
        ...(renderFps !== null ? { renderFps } : {}),
        handSeen: seenHand,
        audioOk: heard === true,
        details: { screen: `${innerWidth}x${innerHeight}`, pipelineP95Ms: ctx.hand.pipelineP95 },
      });
      saved.textContent = r.passed ? "Saved: seat ready." : "Saved: seat NOT ready — fix the rows marked ✗ and run the check again.";
    } catch (e) {
      saved.textContent = `Could not save: ${(e as Error).message}`;
    }
  };
  addEventListener("beforeunload", () => {
    clearInterval(tick);
    scene.dispose();
  });
}
