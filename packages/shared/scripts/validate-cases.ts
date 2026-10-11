/**
 * Validates every case JSON file in a directory. Exit code 1 if any case fails.
 * Usage: npm run validate-cases [-- <dir>]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateCase } from "../src/validate-case.js";

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
  if (r.ok) console.log(`✓ ${f} (${r.case.metadata.id} v${r.case.metadata.version})`);
  else {
    failed++;
    console.error(`✗ ${f}`);
    for (const i of r.issues) console.error(`    ${i.path || "(root)"}: ${i.message}`);
  }
}
process.exit(failed ? 1 : 0);
