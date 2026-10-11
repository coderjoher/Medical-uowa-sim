/**
 * Validates every case JSON file in a directory. Exit code 1 if any case fails.
 * Usage: npm run validate-cases [-- <dir>]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { caseMedia, validateCase } from "../src/validate-case.js";

const mediaDir = process.env.MEDIA_DIR ?? "content/assets";

const dir = process.argv[2] ?? "content/cases";
let failed = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(join(dir, f), "utf8"));
  } catch (e) {
    console.error(`✗ ${f}: invalid JSON (${(e as Error).message})`);
    failed++;
    continue;
  }
  const r = validateCase(data);
  // Every sound, image and ECG the case refers to must exist in the media folder.
  const missing = r.ok ? caseMedia(r.case).filter((m) => normalize(m.path).startsWith("..") || !existsSync(join(mediaDir, m.path))) : [];
  if (missing.length) {
    failed++;
    console.error(`✗ ${f}`);
    for (const m of missing) console.error(`    ${m.where}: media file "${m.path}" not found in ${mediaDir}`);
  } else if (r.ok) console.log(`✓ ${f} (${r.case.metadata.id} v${r.case.metadata.version}, ${caseMedia(r.case).length} media files)`);
  else {
    failed++;
    console.error(`✗ ${f}`);
    for (const i of r.issues) console.error(`    ${i.path || "(root)"}: ${i.message}`);
  }
}
process.exit(failed ? 1 : 0);
