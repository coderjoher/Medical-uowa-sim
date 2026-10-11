import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toStudentCase, validateCase, type CaseDefinition } from "@sim/shared";
import { computeVitals, dueQuestions, scoreAttempt, type ScoredAction } from "../src/index.js";

const dir = new URL("../../../content/cases/", import.meta.url);
const cases: CaseDefinition[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    const r = validateCase(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
    if (!r.ok) throw new Error(`${f}: ${JSON.stringify(r.issues)}`);
    return r.case;
  });

/** The expected path through a case, built only from its data. */
function idealLog(c: CaseDefinition): ScoredAction[] {
  const log: ScoredAction[] = [];
  let t = 0;
  const at = () => (t += 10_000);
  for (const h of c.history) if (h.relevance !== "irrelevant") log.push({ type: "history.ask", ref: h.id, caseTimeMs: at() });
  for (const e of c.examination) if (e.relevant) log.push({ type: "exam.perform", ref: e.id, caseTimeMs: at() });
  for (const i of c.investigations) if (i.indicated) log.push({ type: "investigation.order", ref: i.id, caseTimeMs: at() });
  // Management: earliest first, respecting any required order, all inside their time windows.
  const wanted = c.management.actions.filter((a) => a.classification === "correct" || a.classification === "acceptable").map((a) => a.id);
  const ordered = [...new Set([...c.management.requiredOrder.flatMap((o) => o.sequence), ...wanted])].filter((id) => wanted.includes(id));
  let mt = 0;
  for (const id of ordered) log.push({ type: "management.give", ref: id, caseTimeMs: (mt += 5_000) });
  for (const q of c.questions) log.push({ type: "question.answer", ref: q.id, caseTimeMs: at(), payload: { selected: q.correct } });
  const diffs = [...c.diagnosis.acceptable].sort((a, b) => b.points - a.points).slice(0, c.diagnosis.maxDifferentials).map((a) => a.id);
  log.push({ type: "diagnosis.submit", caseTimeMs: at(), payload: { main: c.diagnosis.correct, differentials: diffs } });
  return log;
}

describe.each(cases.map((c) => [c.metadata.id, c] as const))("case %s", (_id, c) => {
  it("the ideal path scores 100% and passes; doing nothing fails", () => {
    const best = scoreAttempt(c, idealLog(c));
    expect(best.totalPct).toBe(100);
    expect(best.passed).toBe(true);
    const none = scoreAttempt(c, []);
    expect(none.totalPct).toBe(0);
    expect(none.passed).toBe(false);
  });

  it("every critical action fails the case even on the ideal path", () => {
    for (const a of c.management.actions.filter((x) => x.critical)) {
      const r = scoreAttempt(c, [...idealLog(c), { type: "management.give", ref: a.id, caseTimeMs: 60_000 }]);
      expect(r.passed, a.id).toBe(false);
    }
  });

  it("vitals stay physiological over the whole case, with and without treatment", () => {
    for (const log of [[], idealLog(c)])
      for (let m = 0; m <= c.metadata.timeLimitMin; m += 0.5) {
        const v = computeVitals(c.vitals, log, m * 60_000).values;
        for (const x of Object.values(v)) expect(Number.isFinite(x)).toBe(true);
        expect(v.spo2).toBeLessThanOrEqual(100);
        expect(v.dbp).toBeLessThan(v.sbp);
      }
  });

  it("every checkpoint question can be reached", () => {
    const end = c.metadata.timeLimitMin * 60_000;
    const reached = new Set([...dueQuestions(c.questions, idealLog(c).filter((a) => a.type !== "question.answer"), end, { aboutToDiagnose: true })].map((q) => q.id));
    expect([...reached].sort()).toEqual(c.questions.map((q) => q.id).sort());
  });

  it("the student view hides answers", () => {
    const json = JSON.stringify(toStudentCase(c));
    for (const leak of ['"relevance"', '"points"', '"indicated"', '"classification"', '"feedback"', '"rubric"', '"correct"']) expect(json).not.toContain(leak);
  });
});

it("finds every case file", () => {
  expect(cases.length).toBeGreaterThanOrEqual(3);
});
