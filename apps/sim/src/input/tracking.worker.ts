/// <reference lib="webworker" />
/**
 * MediaPipe Hand Landmarker in a Web Worker, so 3D rendering never stalls tracking (PRD).
 * Receives ImageBitmaps from the main thread and returns landmarks. Video never leaves the
 * browser: frames are transferred to this worker and closed after detection.
 */
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

type InMsg = { type: "init"; base: string; delegate: "GPU" | "CPU" } | { type: "frame"; bitmap: ImageBitmap; tMs: number };

let landmarker: HandLandmarker | null = null;

const post = (m: unknown) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === "init") {
    try {
      const fileset = await FilesetResolver.forVisionTasks(`${msg.base}/wasm`);
      const make = (delegate: "GPU" | "CPU") =>
        HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${msg.base}/hand_landmarker.task`, delegate },
          runningMode: "VIDEO",
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          ...(delegate === "GPU" ? { canvas: new OffscreenCanvas(1, 1) } : {}),
        });
      let delegate = msg.delegate;
      try {
        landmarker = await make(delegate);
      } catch {
        delegate = "CPU";
        landmarker = await make(delegate);
      }
      post({ type: "ready", delegate });
    } catch (err) {
      post({ type: "error", message: String(err) });
    }
    return;
  }
  if (msg.type === "frame") {
    const started = performance.now();
    try {
      if (!landmarker) return;
      const r = landmarker.detectForVideo(msg.bitmap, msg.tMs);
      const hands = r.landmarks.map((lms, i) => {
        const cat = r.handedness[i]?.[0];
        // MediaPipe labels assume a mirrored selfie image; our frames are not mirrored, so swap.
        const label = cat?.categoryName?.toLowerCase() === "left" ? "right" : "left";
        return { landmarks: lms.map((l) => ({ x: l.x, y: l.y, z: l.z })), score: cat?.score ?? 0, handedness: label };
      });
      post({ type: "result", tMs: msg.tMs, hands, inferMs: performance.now() - started });
    } finally {
      msg.bitmap.close();
    }
  }
};
