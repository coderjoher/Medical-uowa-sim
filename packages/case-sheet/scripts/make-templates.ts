/**
 * Writes the blank case template and a filled example for every case in content/cases.
 * Usage: npm run case-templates
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateCase } from "@sim/shared";
import { caseToWorkbook, workbookBuffer } from "../src/index.js";

const out = "content/templates";
writeFileSync(join(out, "case-template.xlsx"), await workbookBuffer(caseToWorkbook()));
console.log(`✓ ${out}/case-template.xlsx`);
for (const f of readdirSync("content/cases").filter((x) => x.endsWith(".json"))) {
  const r = validateCase(JSON.parse(readFileSync(join("content/cases", f), "utf8")));
  if (!r.ok) {
    console.error(`✗ ${f} is not valid; skipped`);
    continue;
  }
  const name = `example-${f.replace(/\.json$/, "")}.xlsx`;
  writeFileSync(join(out, name), await workbookBuffer(caseToWorkbook(r.case)));
  console.log(`✓ ${out}/${name}`);
}
