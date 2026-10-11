// Copies the MediaPipe WASM runtime and downloads the hand model into public/mediapipe so the
// app runs on the campus LAN with no internet. Run once at build time.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "mediapipe");
const require = createRequire(import.meta.url);
// The package does not export package.json; resolve its main entry and use that directory.
const pkgDir = dirname(require.resolve("@mediapipe/tasks-vision"));

mkdirSync(join(out, "wasm"), { recursive: true });
for (const f of readdirSync(join(pkgDir, "wasm"))) copyFileSync(join(pkgDir, "wasm", f), join(out, "wasm", f));
console.log("copied MediaPipe wasm");

const model = join(out, "hand_landmarker.task");
const url = process.env.HAND_MODEL_URL ?? "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
if (existsSync(model)) console.log("hand model already present");
else {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  writeFileSync(model, Buffer.from(await res.arrayBuffer()));
  console.log("downloaded hand model");
}
