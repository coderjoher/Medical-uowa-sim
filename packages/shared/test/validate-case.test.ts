import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toStudentCase, validateCase } from "../src/index.js";

const refCase = () =>
  JSON.parse(readFileSync(new URL("../../../content/cases/chest-pain-stemi.json", import.meta.url), "utf8"));

const issuesOf = (input: unknown) => {
  const r = validateCase(input);
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
};

describe("case validation", () => {
  it("accepts the reference case", () => {
    expect(issuesOf(refCase())).toEqual([]);
  });

  it.each([
    ["metadata", (c: any) => delete c.metadata],
    ["metadata.title", (c: any) => delete c.metadata.title],
    ["metadata.version", (c: any) => delete c.metadata.version],
    ["patient", (c: any) => delete c.patient],
    ["patient.handover", (c: any) => delete c.patient.handover],
    ["history", (c: any) => delete c.history],
    ["history.0.answer", (c: any) => delete c.history[0].answer],
    ["examination", (c: any) => delete c.examination],
    ["examination.0.finding", (c: any) => delete c.examination[0].finding],
    ["vitals.initial", (c: any) => delete c.vitals.initial],
    ["investigations.0.turnaroundMin", (c: any) => delete c.investigations[0].turnaroundMin],
    ["diagnosis.correct", (c: any) => delete c.diagnosis.correct],
    ["management.actions", (c: any) => delete c.management.actions],
    ["questions.0.correct", (c: any) => delete c.questions[0].correct],
  ])("rejects a case missing %s", (path, mutate) => {
    const c = refCase();
    mutate(c);
    expect(issuesOf(c).some((i) => i.startsWith(path))).toBe(true);
  });

  it("flags unknown drugs, tests and exam points", () => {
    const c = refCase();
    c.management.actions[0].id = "unobtainium";
    c.investigations[0].id = "mri_toe";
    c.examination[0].id = "elbow_vibes";
    const issues = issuesOf(c);
    expect(issues).toContain('management.actions.0.id: unknown drug or action "unobtainium"');
    expect(issues).toContain('investigations.0.id: unknown test "mri_toe"');
    expect(issues).toContain('examination.0.id: unknown exam point "elbow_vibes"');
  });

  it("flags broken references", () => {
    const c = refCase();
    c.diagnosis.correct = "flu";
    c.diagnosis.acceptable[0].id = "gout";
    c.management.requiredOrder[0].sequence[1] = "refer_dermatology";
    c.vitals.onAction[0].onAction = "nothing";
    c.vitals.deterioration[0].unlessActions = ["nothing"];
    c.questions[0].correct = ["zzz"];
    c.questions[0].checkpoint = { kind: "after_action", action: "nothing" };
    const issues = issuesOf(c).join("\n");
    expect(issues).toMatch(/diagnosis\.correct/);
    expect(issues).toMatch(/diagnosis\.acceptable\.0\.id/);
    expect(issues).toMatch(/management\.requiredOrder\.0\.sequence\.1/);
    expect(issues).toMatch(/vitals\.onAction\.0\.onAction/);
    expect(issues).toMatch(/vitals\.deterioration\.0\.unlessActions\.0/);
    expect(issues).toMatch(/questions\.0\.correct\.0/);
    expect(issues).toMatch(/questions\.0\.checkpoint\.action/);
  });

  it("flags duplicate ids", () => {
    const c = refCase();
    c.history[1].id = c.history[0].id;
    expect(issuesOf(c).join()).toMatch(/duplicate id "pc_onset"/);
  });

  it.each([
    ["negative turnaround", (c: any) => (c.investigations[0].turnaroundMin = -1), "investigations.0.turnaroundMin"],
    ["impossible SpO2", (c: any) => (c.vitals.initial.spo2 = 140), "vitals.initial.spo2"],
    ["diastolic above systolic", (c: any) => (c.vitals.initial.dbp = 160), "vitals.initial.dbp"],
    ["weights not summing to 1", (c: any) => (c.rubric.decisionWeight = 0.8), "rubric"],
    ["single question with two answers", (c: any) => (c.questions[0].correct = ["lad", "rca"]), "questions.0.correct"],
    ["critical action that is not harmful", (c: any) => (c.management.actions[0].critical = true), "management.actions.0.critical"],
    ["no correct management", (c: any) => c.management.actions.forEach((a: any) => a.classification === "correct" && (a.classification = "acceptable")), "management.actions"],
  ])("rejects %s", (_name, mutate, path) => {
    const c = refCase();
    mutate(c);
    expect(issuesOf(c).some((i) => i.startsWith(path))).toBe(true);
  });
});

describe("student case view", () => {
  it("contains no answers, scores, feedback or investigation results", () => {
    const r = validateCase(refCase());
    if (!r.ok) throw new Error("reference case invalid");
    const json = JSON.stringify(toStudentCase(r.case));
    for (const leak of ["relevance", "relevant", "points", "penalty", "indicated", "classification", "critical", "correct", "acceptable", "feedback", "rubric", "requiredOrder", "latePoints", "withinMin", "authors"]) {
      expect(json, `student view leaks "${leak}"`).not.toContain(`"${leak}"`);
    }
    expect(json).not.toContain("ST elevation in II, III and aVF");
    expect(json).not.toContain("inferior_stemi\",\"correct");
  });
});
