/**
 * Sanity checks for content/assets (run after scripts/generate-assets.ts or after swapping in licensed files):
 *  - manifest.json lists every asset file and every listed file exists
 *  - WAVs: valid RIFF/PCM, 16-bit mono, 22.05/44.1 kHz, 5–15 s, < 1 MB, not clipping (< 0.98 FS), not silent,
 *    loop seam without a large jump
 *  - SVGs: well-formed XML (small tag-stack checker), <svg> root; ECGs carry all 12 lead labels
 *  - every asset path referenced by content/cases/*.json exists
 * Usage (repo root): npx tsx scripts/verify-assets.ts   (exit code 1 on any failure)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeWav } from "./audio/wav.js";
import { LEADS } from "./ecg/model.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "content/assets");
let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`  ✗ ${msg}`);
};
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Minimal XML well-formedness check: balanced tags, quoted attributes, no stray '<' or '&'. */
export function checkXml(xml: string): string | null {
  const stack: string[] = [];
  let i = 0;
  const body = xml.replace(/^\uFEFF/, "");
  while (i < body.length) {
    const lt = body.indexOf("<", i);
    const text = body.slice(i, lt === -1 ? body.length : lt);
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) return `unescaped & in text near offset ${i}`;
    if (lt === -1) break;
    if (body.startsWith("<!--", lt)) {
      const end = body.indexOf("-->", lt);
      if (end === -1) return "unterminated comment";
      i = end + 3;
      continue;
    }
    if (body.startsWith("<?", lt)) {
      const end = body.indexOf("?>", lt);
      if (end === -1) return "unterminated processing instruction";
      i = end + 2;
      continue;
    }
    const gt = body.indexOf(">", lt);
    if (gt === -1) return `unterminated tag at ${lt}`;
    const tag = body.slice(lt + 1, gt);
    if (tag.includes("<")) return `'<' inside tag at ${lt}`;
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const open = stack.pop();
      if (open !== name) return `closing </${name}> does not match <${open ?? "(none)"}> at ${lt}`;
    } else {
      const m = /^([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)$/s.exec(tag);
      if (!m) return `malformed tag <${tag.slice(0, 40)}…> at ${lt}`;
      const attrs = m[2]!;
      const names = [...attrs.matchAll(/([\w:.-]+)\s*=/g)].map((a) => a[1]);
      if (new Set(names).size !== names.length) return `duplicate attribute in <${m[1]}> at ${lt}`;
      if (!m[3]) stack.push(m[1]!);
    }
    i = gt + 1;
  }
  if (stack.length) return `unclosed <${stack.join("> <")}>`;
  return null;
}

// ── Manifest
const manifest = JSON.parse(readFileSync(join(assets, "manifest.json"), "utf8")) as { assets: Array<{ path: string; kind: string; placeholder: boolean }> };
const listed = new Set(manifest.assets.map((a) => a.path));
const onDisk = walk(assets)
  .map((p) => relative(assets, p).split("\\").join("/"))
  .filter((p) => !p.startsWith("previews/") && p !== "manifest.json" && p !== "README.md");
console.log("manifest");
for (const p of onDisk) if (!listed.has(p)) fail(`${p} is not in manifest.json`);
for (const a of manifest.assets) {
  if (!existsSync(join(assets, a.path))) fail(`manifest lists missing file ${a.path}`);
  if (!["sound", "ecg", "image"].includes(a.kind)) fail(`${a.path}: bad kind ${a.kind}`);
}
ok(`${manifest.assets.length} entries, ${onDisk.length} files`);

// ── Sounds
console.log("sounds");
for (const a of manifest.assets.filter((x) => x.kind === "sound")) {
  const buf = readFileSync(join(assets, a.path));
  try {
    const w = decodeWav(buf);
    const dur = w.samples.length / w.sampleRate;
    let pk = 0;
    let ss = 0;
    for (const s of w.samples) {
      pk = Math.max(pk, Math.abs(s));
      ss += s * s;
    }
    const peak = pk / 32768;
    const rms = Math.sqrt(ss / w.samples.length) / 32768;
    const seam = Math.abs(w.samples[w.samples.length - 1]! - w.samples[0]!) / 32768;
    const problems: string[] = [];
    if (![22050, 44100].includes(w.sampleRate)) problems.push(`sample rate ${w.sampleRate}`);
    if (w.channels !== 1 || w.bitsPerSample !== 16) problems.push(`${w.channels}ch ${w.bitsPerSample}-bit`);
    if (dur < 5 || dur > 15) problems.push(`duration ${dur.toFixed(2)} s`);
    if (buf.length > 1024 * 1024) problems.push(`size ${buf.length}`);
    if (peak >= 0.98) problems.push(`peak ${peak.toFixed(3)} FS (clipping risk)`);
    if (peak < 0.05 || rms < 0.005) problems.push(`too quiet (peak ${peak.toFixed(3)}, rms ${rms.toFixed(4)})`);
    if (seam > 0.05) problems.push(`loop seam jump ${seam.toFixed(3)} FS`);
    const line = `${a.path}: ${w.sampleRate} Hz, ${dur.toFixed(2)} s, ${(buf.length / 1024).toFixed(0)} KB, peak ${peak.toFixed(3)} FS, rms ${rms.toFixed(3)}, seam ${seam.toFixed(4)}`;
    if (problems.length) fail(`${line} — ${problems.join("; ")}`);
    else ok(line);
  } catch (e) {
    fail(`${a.path}: ${(e as Error).message}`);
  }
}

// ── SVGs
console.log("svg");
for (const a of manifest.assets.filter((x) => x.path.endsWith(".svg"))) {
  const xml = readFileSync(join(assets, a.path), "utf8");
  const err = checkXml(xml);
  if (err) {
    fail(`${a.path}: not well-formed: ${err}`);
    continue;
  }
  if (!/^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/.test(xml) || !xml.includes('xmlns="http://www.w3.org/2000/svg"')) {
    fail(`${a.path}: missing <svg xmlns> root`);
    continue;
  }
  if (a.kind === "ecg") {
    const labels = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!.trim());
    const missing = LEADS.filter((l) => !labels.includes(l));
    const count = labels.filter((l) => (LEADS as readonly string[]).includes(l)).length;
    if (missing.length) fail(`${a.path}: missing lead labels ${missing.join(", ")}`);
    else ok(`${a.path}: well-formed, 12 lead labels + rhythm strip (${count} lead labels), ${(xml.length / 1024).toFixed(0)} KB`);
  } else {
    if (!/placeholder/i.test(xml)) fail(`${a.path}: missing placeholder label`);
    else ok(`${a.path}: well-formed, labelled placeholder, ${(xml.length / 1024).toFixed(0)} KB`);
  }
}

// ── Case references
console.log("case references");
const casesDir = join(root, "content/cases");
for (const f of readdirSync(casesDir).filter((x) => x.endsWith(".json"))) {
  const text = readFileSync(join(casesDir, f), "utf8");
  const refs = [...text.matchAll(/"(sound|image|ecg)"\s*:\s*"([^"]+)"/g)].map((m) => m[2]!);
  for (const r of new Set(refs)) {
    if (existsSync(join(assets, r))) ok(`${f} → ${r}`);
    else fail(`${f} references missing asset ${r}`);
  }
}

if (failures) {
  console.error(`\n${failures} problem(s)`);
  process.exit(1);
}
console.log("\nall asset checks passed");
