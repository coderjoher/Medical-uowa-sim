import type { InputSource } from "@sim/shared";
import {
  HandInteraction,
  MIN_TARGET_PX,
  snap,
  type Calibration,
  type GestureEvent,
  type HandFrame,
  type InteractionState,
  type Target,
} from "@sim/tracking";

/** A 3D or custom target the hand can hit, in addition to DOM buttons. */
export interface VirtualTarget {
  id: string;
  rect: () => { x: number; y: number; width: number; height: number } | null;
  activate: () => void;
  hover?: (on: boolean) => void;
}

export type TrackingStatus = "off" | "starting" | "tracking" | "no-hand" | "poor-light" | "error";

const DOM_TARGETS = "button:not([disabled]), [data-hand-target], input[type=checkbox], input[type=radio], a[href]";

/**
 * Turns hand tracking into UI input: a visible cursor, hover highlighting, pinch = click,
 * open palm = menu/cancel, swipe = change view. Mouse and touch keep working in parallel,
 * and every action knows which input produced it.
 */
export class HandInput {
  readonly interaction: HandInteraction;
  private cursorEl = document.getElementById("hand-cursor")!;
  private virtual = new Map<string, VirtualTarget>();
  private hovered: { kind: "dom"; el: Element } | { kind: "virtual"; t: VirtualTarget } | null = null;
  private dispatchingHand = false;
  private lastPointer: InputSource = "mouse";
  private worker: Worker | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private running = false;
  private inFlight = false;
  private frameTimes: number[] = [];
  private brightness = 1;
  private lumaCanvas = document.createElement("canvas");

  enabled = false;
  status: TrackingStatus = "off";
  last: InteractionState | null = null;
  /** Called for every processed frame (calibration and the camera preview listen). */
  onFrame: (s: InteractionState, raw: HandFrame) => void = () => {};
  onGesture: (e: GestureEvent) => void = () => {};
  onStatus: (s: TrackingStatus) => void = () => {};

  constructor() {
    this.interaction = new HandInteraction({ screenWidth: innerWidth, screenHeight: innerHeight });
    addEventListener("resize", () => this.interaction.setScreenSize(innerWidth, innerHeight));
    // Remember real pointer input so actions are logged with the right source.
    addEventListener(
      "pointerdown",
      (e: PointerEvent) => {
        if (e.isTrusted) this.lastPointer = e.pointerType === "touch" ? "touch" : "mouse";
      },
      true,
    );
    addEventListener("keydown", (e) => {
      if (e.isTrusted) this.lastPointer = "keyboard";
    }, true);
    this.lumaCanvas.width = 32;
    this.lumaCanvas.height = 18;
  }

  /** Input source for the action happening right now. */
  currentSource(): InputSource {
    return this.dispatchingHand ? "hand" : this.lastPointer;
  }

  get fps(): number {
    const t = this.frameTimes;
    if (t.length < 2) return 0;
    return ((t.length - 1) * 1000) / (t[t.length - 1]! - t[0]!);
  }

  get lightLevel(): number {
    return this.brightness;
  }

  get videoElement(): HTMLVideoElement | null {
    return this.video;
  }

  applyCalibration(c: Calibration): void {
    this.interaction.applyCalibration(c);
  }

  register(t: VirtualTarget): () => void {
    this.virtual.set(t.id, t);
    return () => this.virtual.delete(t.id);
  }

  private setStatus(s: TrackingStatus) {
    if (s !== this.status) {
      this.status = s;
      this.onStatus(s);
    }
  }

  /** Starts the webcam and the tracking worker. */
  async start(): Promise<void> {
    if (this.running) return;
    this.setStatus("starting");
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }, audio: false });
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.srcObject = this.stream;
    await this.video.play();
    this.worker = new Worker(new URL("./tracking.worker.ts", import.meta.url), { type: "module" });
    await new Promise<void>((resolve, reject) => {
      this.worker!.onmessage = (e) => {
        if (e.data.type === "ready") resolve();
        else if (e.data.type === "error") reject(new Error(e.data.message));
      };
      this.worker!.postMessage({ type: "init", base: `${location.origin}/mediapipe`, delegate: "GPU" });
    });
    this.worker.onmessage = (e) => {
      if (e.data.type !== "result") return;
      this.inFlight = false;
      this.process({ tMs: e.data.tMs, hands: e.data.hands });
    };
    this.running = true;
    this.enabled = true;
    this.pump();
  }

  stop(): void {
    this.running = false;
    this.enabled = false;
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
    this.cursorEl.style.display = "none";
    this.setHover(null);
    this.setStatus("off");
  }

  private pump = () => {
    if (!this.running || !this.video) return;
    const v = this.video;
    const next = () => ("requestVideoFrameCallback" in v ? v.requestVideoFrameCallback(() => this.pump()) : requestAnimationFrame(this.pump));
    if (!this.inFlight && v.readyState >= 2) {
      this.inFlight = true;
      const tMs = performance.now();
      createImageBitmap(v)
        .then((bitmap) => {
          this.sampleLight(bitmap);
          this.worker?.postMessage({ type: "frame", bitmap, tMs }, [bitmap]);
        })
        .catch(() => (this.inFlight = false));
    }
    next();
  };

  /** Mean brightness of a tiny downscaled frame, to warn about poor lighting. */
  private sampleLight(bitmap: ImageBitmap) {
    if (this.frameTimes.length % 15 !== 0) return;
    const ctx = this.lumaCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(bitmap, 0, 0, 32, 18);
    const d = ctx.getImageData(0, 0, 32, 18).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
    this.brightness = sum / (d.length / 4) / 255;
  }

  /** Feeds one frame. Also the entry point for synthetic frames in tests (?fakeHand=1). */
  process(frame: HandFrame): void {
    this.frameTimes.push(frame.tMs);
    while (this.frameTimes.length > 30) this.frameTimes.shift();
    const s = this.interaction.process(frame);
    this.last = s;
    this.setStatus(!s.handPresent ? "no-hand" : this.brightness < 0.18 ? "poor-light" : "tracking");
    this.onFrame(s, frame);
    if (!this.enabled) return;
    this.render(s);
    for (const ev of s.events) this.handleGesture(ev);
  }

  /** Synthetic mode: enable the pipeline without a camera. */
  enableSynthetic(): void {
    this.enabled = true;
    this.running = false;
  }

  private targets(): (Target & { ref: { kind: "dom"; el: Element } | { kind: "virtual"; t: VirtualTarget } })[] {
    const out: (Target & { ref: { kind: "dom"; el: Element } | { kind: "virtual"; t: VirtualTarget } })[] = [];
    const layer = document.querySelector("[data-modal]:last-of-type") ?? document.getElementById("app")!;
    layer.querySelectorAll(DOM_TARGETS).forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") return;
      out.push({ id: `dom${i}`, x: r.x, y: r.y, width: r.width, height: r.height, ref: { kind: "dom", el } });
    });
    if (!document.querySelector("[data-modal]"))
      for (const t of this.virtual.values()) {
        const r = t.rect();
        if (!r) continue;
        // Enforce the minimum hit size around small 3D targets.
        const w = Math.max(r.width, MIN_TARGET_PX);
        const h = Math.max(r.height, MIN_TARGET_PX);
        out.push({ id: t.id, x: r.x + r.width / 2 - w / 2, y: r.y + r.height / 2 - h / 2, width: w, height: h, ref: { kind: "virtual", t } });
      }
    return out;
  }

  private render(s: InteractionState) {
    const el = this.cursorEl;
    if (!s.cursor || !s.handPresent) {
      el.style.display = s.handPresent ? "block" : "none";
      this.setHover(null);
      return;
    }
    const targets = this.targets();
    const hit = snap(s.cursor.x, s.cursor.y, targets, 36);
    const target = hit ? targets.find((t) => t.id === hit.target.id)!.ref : null;
    this.setHover(target);
    const x = hit && !s.pinching ? s.cursor.x + (hit.x - s.cursor.x) * 0.35 : s.cursor.x;
    const y = hit && !s.pinching ? s.cursor.y + (hit.y - s.cursor.y) * 0.35 : s.cursor.y;
    el.style.display = "block";
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.dataset.state = s.pinching ? "pinch" : target ? "hover" : s.pose === "open_palm" ? "palm" : "point";
  }

  private setHover(next: typeof this.hovered) {
    const same = (a: typeof this.hovered, b: typeof this.hovered) => (a?.kind === "dom" && b?.kind === "dom" && a.el === b.el) || (a?.kind === "virtual" && b?.kind === "virtual" && a.t === b.t) || (!a && !b);
    if (same(this.hovered, next)) return;
    if (this.hovered?.kind === "dom") this.hovered.el.classList.remove("hand-hover");
    if (this.hovered?.kind === "virtual") this.hovered.t.hover?.(false);
    this.hovered = next;
    if (next?.kind === "dom") next.el.classList.add("hand-hover");
    if (next?.kind === "virtual") next.t.hover?.(true);
  }

  private handleGesture(e: GestureEvent) {
    if (e.type === "pinch-start" && this.hovered) {
      const h = this.hovered;
      this.asHand(() => {
        if (h.kind === "dom") {
          (h.el as HTMLElement).focus?.({ preventScroll: true });
          (h.el as HTMLElement).click();
        } else h.t.activate();
      });
    }
    this.asHand(() => this.onGesture(e));
  }

  /** Runs `fn` with input source "hand" so recorded actions are attributed correctly. */
  asHand(fn: () => void): void {
    this.dispatchingHand = true;
    try {
      fn();
    } finally {
      this.dispatchingHand = false;
    }
  }
}
