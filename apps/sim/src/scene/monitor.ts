import { DynamicTexture, type Scene } from "@babylonjs/core";
import type { Vitals } from "@sim/shared";

/** Vital-signs monitor face drawn onto a dynamic texture, with a scrolling ECG trace. */
export class MonitorFace {
  readonly texture: DynamicTexture;
  private trace: number[] = [];
  private phase = 0;
  /** Draw upside down, for screens whose UVs are flipped vertically. */
  flipY = false;

  constructor(scene: Scene) {
    this.texture = new DynamicTexture("monitor-face", { width: 640, height: 400 }, scene, false);
  }

  draw(v: Vitals, dtS: number): void {
    const ctx = this.texture.getContext() as CanvasRenderingContext2D;
    const W = 640;
    const H = 400;
    ctx.setTransform(1, 0, 0, this.flipY ? -1 : 1, 0, this.flipY ? H : 0);
    ctx.fillStyle = "#06121a";
    ctx.fillRect(0, 0, W, H);

    // ECG-like trace driven by heart rate.
    this.phase += dtS * (v.hr / 60);
    const beat = this.phase % 1;
    const y = beat < 0.04 ? -60 : beat < 0.07 ? 30 : beat < 0.2 && beat > 0.14 ? -12 : 0;
    this.trace.push(y);
    if (this.trace.length > 380) this.trace.shift();
    ctx.strokeStyle = "#3ee07a";
    ctx.lineWidth = 3;
    ctx.beginPath();
    this.trace.forEach((t, i) => (i ? ctx.lineTo(10 + i, 110 + t) : ctx.moveTo(10, 110 + t)));
    ctx.stroke();

    const row = (label: string, value: string, unit: string, color: string, x: number, yy: number) => {
      ctx.fillStyle = color;
      ctx.font = "600 22px system-ui, sans-serif";
      ctx.fillText(label, x, yy);
      ctx.font = "700 64px system-ui, sans-serif";
      ctx.fillText(value, x, yy + 62);
      ctx.font = "500 20px system-ui, sans-serif";
      ctx.fillText(unit, x, yy + 88);
    };
    const alarm = (bad: boolean, ok: string) => (bad ? "#ff5a5a" : ok);
    row("HR", `${v.hr}`, "bpm", alarm(v.hr > 120 || v.hr < 50, "#3ee07a"), 410, 40);
    row("SpO₂", `${v.spo2}`, "%", alarm(v.spo2 < 92, "#4fd2ff"), 410, 210);
    row("NIBP", `${v.sbp}/${v.dbp}`, "mmHg", alarm(v.sbp < 90, "#f2f2f2"), 20, 210);
    row("RR", `${v.rr}`, "/min", alarm(v.rr > 24 || v.rr < 10, "#ffd25a"), 20, 330 - 30);
    row("TEMP", v.temp.toFixed(1), "°C", alarm(v.temp > 38, "#f2a8ff"), 220, 330 - 30);
    this.texture.update();
  }
}
