import type { Ctx } from "../context.js";
import { h, mount } from "../ui.js";
import { drawPreview } from "./calibration.js";

/** Two-minute seat check before a session: camera, lighting, tracking frame rate and audio. */
export async function labCheckScreen(ctx: Ctx): Promise<void> {
  const rows = {
    camera: h("td", "…"),
    light: h("td", "…"),
    fps: h("td", "…"),
    hand: h("td", "…"),
    audio: h("td", "Not tested"),
  };
  const preview = h("canvas.calib-preview", { width: 480, height: 270, "aria-hidden": "true" });
  const verdict = h("p.big-text", { "aria-live": "polite" });
  let heardOk = false;
  const tone = () => {
    const ac = new AudioContext();
    const o = ac.createOscillator();
    o.frequency.value = 440;
    o.connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 1);
  };
  mount(
    h(
      "main.page",
      h("h1", "Lab check"),
      h("p", "Sit as you will during the session and hold your hand up in front of the camera."),
      preview,
      h(
        "table.areas",
        h(
          "tbody",
          h("tr", h("th", "Camera"), rows.camera),
          h("tr", h("th", "Lighting"), rows.light),
          h("tr", h("th", "Tracking frame rate (≥ 30 fps)"), rows.fps),
          h("tr", h("th", "Hand detected"), rows.hand),
          h("tr", h("th", "Headphones"), rows.audio),
        ),
      ),
      h(
        "div.row",
        h("button.big", { on: { click: tone } }, "Play test tone"),
        h("button.big", { on: { click: () => ((heardOk = true), (rows.audio.textContent = "✓ Heard")) } }, "I heard it"),
        h("button.big", { on: { click: () => ((heardOk = false), (rows.audio.textContent = "✗ Not heard — check headphones")) } }, "I did not hear it"),
      ),
      verdict,
      h("a", { href: "/" }, "Back to sign in"),
    ),
  );
  try {
    await ctx.hand.start();
    rows.camera.textContent = "✓ Working";
  } catch (e) {
    rows.camera.textContent = `✗ ${(e as Error).message}`;
    verdict.textContent = "Seat not ready: the camera or tracking could not start.";
    return;
  }
  ctx.hand.enabled = false;
  let seenHand = false;
  ctx.hand.onFrame = (s) => {
    drawPreview(preview, ctx, s.landmarks);
    if (s.handPresent) seenHand = true;
  };
  const tick = setInterval(() => {
    const fps = ctx.hand.fps;
    const light = ctx.hand.lightLevel;
    rows.fps.textContent = `${fps >= 30 ? "✓" : "✗"} ${fps.toFixed(0)} fps`;
    rows.light.textContent = light < 0.18 ? "✗ Too dark — add front lighting" : light > 0.85 ? "✗ Too bright / backlit" : "✓ OK";
    rows.hand.textContent = seenHand ? "✓ Yes" : "Waiting for a hand…";
    const ok = fps >= 30 && light >= 0.18 && light <= 0.85 && seenHand && heardOk;
    verdict.textContent = ok ? "✓ Seat ready" : "Checking… (all rows must pass, including the headphone test)";
  }, 500);
  addEventListener("beforeunload", () => clearInterval(tick));
}
