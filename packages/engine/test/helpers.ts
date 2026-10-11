import { readFileSync } from "node:fs";
import { validateCase, type CaseDefinition } from "@sim/shared";
import type { ScoredAction } from "../src/index.js";

export function loadRefCase(): CaseDefinition {
  const raw = JSON.parse(readFileSync(new URL("../../../content/cases/chest-pain-stemi.json", import.meta.url), "utf8"));
  const r = validateCase(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.case;
}

export const min = (m: number) => Math.round(m * 60_000);

export const act = (type: string, ref: string | undefined, atMin: number, payload?: Record<string, unknown>): ScoredAction => ({
  type,
  ...(ref !== undefined ? { ref } : {}),
  caseTimeMs: min(atMin),
  ...(payload ? { payload } : {}),
});
