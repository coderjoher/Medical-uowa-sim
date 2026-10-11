/**
 * Checks a filled case template and converts it to case JSON.
 * Usage: npm run import-case -- path/to/case.xlsx [output.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { formatIssue, importCaseWorkbook } from "../src/index.js";

const [file, outFile] = process.argv.slice(2);
if (!file) {
  console.error("usage: npm run import-case -- <case.xlsx> [output.json]");
  process.exit(2);
}
const r = await importCaseWorkbook(readFileSync(file));
if (!r.ok) {
  console.error(`✗ ${file}: ${r.issues.length} problem(s)`);
  for (const i of r.issues) console.error(`  ${formatIssue(i)}`);
  process.exit(1);
}
const json = JSON.stringify(r.case, null, 2) + "\n";
const target = outFile ?? `content/cases/${r.case.metadata.id}.json`;
writeFileSync(target, json);
console.log(`✓ ${file} → ${target}`);
