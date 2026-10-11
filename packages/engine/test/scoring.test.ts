import { describe, expect, it } from "vitest";
import { scoreAttempt, type ScoredAction } from "../src/index.js";
import { act, loadRefCase } from "./helpers.js";

const c = loadRefCase();
const score = (log: ScoredAction[]) => scoreAttempt(c, log);
const item = (log: ScoredAction[], ref: string) => score(log).items.find((i) => i.ref === ref);

describe("decision scoring (PRD examples)", () => {
  it("history: asking about radiation of pain earns +2", () => {
    expect(item([act("history.ask", "pc_radiation", 1)], "pc_radiation")?.points).toBe(2);
    expect(score([act("history.ask", "pc_radiation", 1)]).areas.history.points).toBe(2);
  });

  it("history: irrelevant questions count lightly against efficiency, never below zero", () => {
    const log = [act("history.ask", "pc_radiation", 1), act("history.ask", "sh_job", 2), act("history.ask", "sh_pets", 3)];
    expect(score(log).areas.history.points).toBe(1);
    expect(score([act("history.ask", "sh_job", 1), act("history.ask", "sh_pets", 1)]).areas.history.points).toBe(0);
  });

  it("history: asking the same question twice scores once", () => {
    expect(score([act("history.ask", "pc_radiation", 1), act("history.ask", "pc_radiation", 2)]).areas.history.points).toBe(2);
  });

  it("examination: auscultating the chest earns +3; irrelevant exam earns nothing", () => {
    expect(score([act("exam.perform", "chest_auscultation_front", 1)]).areas.examination.points).toBe(3);
    expect(score([act("exam.perform", "reflexes_knee", 1)]).areas.examination.points).toBe(0);
  });

  it("investigations: ECG +5, unnecessary CT -1", () => {
    expect(item([act("investigation.order", "ecg", 1)], "ecg")?.points).toBe(5);
    expect(item([act("investigation.order", "ct_chest", 1)], "ct_chest")?.points).toBe(-1);
    expect(score([act("investigation.order", "ecg", 1), act("investigation.order", "ct_chest", 2)]).areas.investigations.points).toBe(4);
  });

  it("diagnosis: correct +10, acceptable differential +4, wrong 0", () => {
    const dx = (main: string, differentials: string[] = []) => score([act("diagnosis.submit", undefined, 15, { main, differentials })]).areas.diagnosis.points;
    expect(dx("inferior_stemi")).toBe(10);
    expect(dx("inferior_stemi", ["aortic_dissection"])).toBe(14);
    expect(dx("inferior_stemi", ["aortic_dissection", "pericarditis", "gord"])).toBe(16);
    expect(dx("gord")).toBe(0);
    expect(dx("gord", ["aortic_dissection"])).toBe(4);
  });

  it("diagnosis: the last submission counts", () => {
    const log = [act("diagnosis.submit", undefined, 10, { main: "gord" }), act("diagnosis.submit", undefined, 12, { main: "inferior_stemi" })];
    expect(score(log).areas.diagnosis.points).toBe(10);
  });

  it("management: aspirin within 10 case-minutes +5, late gives latePoints", () => {
    expect(item([act("management.give", "aspirin", 9.9)], "aspirin")?.points).toBe(5);
    const late = item([act("management.give", "aspirin", 10.5)], "aspirin");
    expect(late?.points).toBe(2);
    expect(late?.note).toMatch(/after 10 min/);
  });

  it("management: wrong required order is penalized", () => {
    const inOrder = score([act("management.give", "aspirin", 2), act("management.give", "refer_cardiology", 4)]);
    const outOfOrder = score([act("management.give", "refer_cardiology", 2), act("management.give", "aspirin", 4)]);
    expect(inOrder.areas.management.points - outOfOrder.areas.management.points).toBe(1);
  });

  it("safety: contraindicated drug -10", () => {
    const r = score([act("management.give", "ibuprofen", 3)]);
    expect(r.areas.safety.points).toBe(-5);
    expect(score([act("management.give", "gtn", 3)]).areas.safety.points).toBe(-10);
  });
});

/** The ideal attempt for the reference case. */
const perfect = (): ScoredAction[] => [
  ...c.history.filter((h) => h.relevance !== "irrelevant").map((h, i) => act("history.ask", h.id, 0.1 * i)),
  ...c.examination.filter((e) => e.relevant).map((e, i) => act("exam.perform", e.id, 2 + 0.1 * i)),
  ...c.investigations.filter((t) => t.indicated).map((t, i) => act("investigation.order", t.id, 1 + 0.1 * i)),
  act("management.give", "oxygen", 1),
  act("management.give", "aspirin", 3),
  ...["ticagrelor", "morphine", "metoclopramide", "iv_access", "cardiac_monitoring", "heparin"].map((m, i) => act("management.give", m, 4 + 0.1 * i)),
  act("management.give", "refer_cardiology", 6),
  act("question.answer", "q_ecg_territory", 2, { selected: ["rca"] }),
  act("question.answer", "q_nitrate_ci", 7, { selected: ["pde5", "sbp_low", "rv_infarct"] }),
  act("question.answer", "q_reperfusion", 12, { selected: ["120"] }),
  act("diagnosis.submit", undefined, 13, { main: "inferior_stemi", differentials: ["aortic_dissection", "pericarditis"] }),
];

describe("case result", () => {
  it("a perfect attempt scores 100% and passes", () => {
    const r = score(perfect());
    expect(r.decisions.pct).toBe(100);
    expect(r.questions.pct).toBe(100);
    expect(r.totalPct).toBe(100);
    expect(r.passed).toBe(true);
  });

  it("an empty attempt scores 0 and does not pass", () => {
    const r = score([]);
    expect(r.totalPct).toBe(0);
    expect(r.passed).toBe(false);
  });

  it("a critical error caps the result at not passed whatever the points", () => {
    const r = score([...perfect(), act("management.give", "gtn", 8)]);
    expect(r.totalPct).toBeGreaterThan(c.rubric.passMark);
    expect(r.passed).toBe(false);
    expect(r.criticalErrors.map((e) => e.ref)).toEqual(["gtn"]);
  });

  it("combines decisions and questions 70/30", () => {
    const noQuestions = perfect().filter((a) => a.type !== "question.answer");
    const r = score(noQuestions);
    expect(r.decisions.pct).toBe(100);
    expect(r.questions.pct).toBe(0);
    expect(r.totalPct).toBe(70);
  });

  it("uses the per-case weighting", () => {
    const custom = { ...c, rubric: { ...c.rubric, decisionWeight: 0.5, questionWeight: 0.5 } };
    expect(scoreAttempt(custom, perfect().filter((a) => a.type !== "question.answer")).totalPct).toBe(50);
  });

  it("scores decisions only when a case has no questions", () => {
    const noQ = { ...c, questions: [] };
    expect(scoreAttempt(noQ, perfect()).totalPct).toBe(100);
  });

  it("never scores input method: the same actions by hand or mouse give the same result", () => {
    const viaHand = perfect().map((a) => ({ ...a, inputSource: "hand" }));
    const viaMouse = perfect().map((a) => ({ ...a, inputSource: "mouse" }));
    expect(score(viaHand)).toEqual(score(viaMouse));
  });

  it("is independent of log order (re-scoring from a stored log)", () => {
    expect(score([...perfect()].reverse())).toEqual(score(perfect()));
  });

  it("re-scores with a corrected rubric", () => {
    const fixed = structuredClone(c);
    fixed.investigations.find((t) => t.id === "ecg")!.points = 8;
    const log = [act("investigation.order", "ecg", 1)];
    expect(scoreAttempt(c, log).areas.investigations.points).toBe(5);
    expect(scoreAttempt(fixed, log).areas.investigations.points).toBe(8);
  });
});

describe("questions", () => {
  const q = (ref: string, selected: string[]) => item([act("question.answer", ref, 1, { selected })], ref)?.points;

  it("single answer: right or nothing", () => {
    expect(q("q_ecg_territory", ["rca"])).toBe(2);
    expect(q("q_ecg_territory", ["lad"])).toBe(0);
    expect(q("q_ecg_territory", ["rca", "lad"])).toBe(0);
  });

  it("multiple answer: partial credit, wrong picks cancel right ones", () => {
    expect(q("q_nitrate_ci", ["pde5", "sbp_low", "rv_infarct"])).toBe(3);
    expect(q("q_nitrate_ci", ["pde5", "sbp_low"])).toBe(2);
    expect(q("q_nitrate_ci", ["pde5", "smoker"])).toBe(0);
    expect(q("q_nitrate_ci", ["smoker"])).toBe(0);
  });

  it("short answer chosen from a list", () => {
    expect(q("q_reperfusion", ["120"])).toBe(2);
    expect(q("q_reperfusion", ["60"])).toBe(0);
  });

  it("the first answer counts", () => {
    const log = [act("question.answer", "q_reperfusion", 1, { selected: ["60"] }), act("question.answer", "q_reperfusion", 2, { selected: ["120"] })];
    expect(item(log, "q_reperfusion")?.points).toBe(0);
  });
});

describe("debrief data", () => {
  it("lists missed key decisions with feedback", () => {
    const r = score([act("history.ask", "pc_onset", 1)]);
    const missed = r.items.filter((i) => i.key && !i.done).map((i) => i.ref);
    expect(missed).toContain("dh_pde5");
    expect(missed).toContain("aspirin");
    expect(r.items.find((i) => i.ref === "dh_pde5")?.feedback).toMatch(/sildenafil/i);
  });
});
