import type { ZodIssue } from "zod";
import { CaseDefinition } from "./case-schema.js";
import { ACTIONS_BY_ID, EXAM_POINTS_BY_ID, TESTS_BY_ID } from "./libraries/index.js";

export interface CaseIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; case: CaseDefinition; issues: [] }
  | { ok: false; issues: CaseIssue[] };

const fmtZod = (i: ZodIssue): CaseIssue => ({ path: i.path.join("."), message: i.message });

/**
 * Validates a case the way the import script must before publishing: schema first, then
 * the checks a schema cannot express (unknown drugs/tests/exam points, broken references,
 * duplicate ids, weights, physiological ranges).
 */
export function validateCase(input: unknown): ValidationResult {
  const parsed = CaseDefinition.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(fmtZod) };
  const c = parsed.data;
  const issues: CaseIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  const dupes = (path: string, ids: string[]) => {
    const seen = new Set<string>();
    ids.forEach((x, i) => {
      if (seen.has(x)) add(`${path}.${i}.id`, `duplicate id "${x}"`);
      seen.add(x);
    });
  };
  dupes("history", c.history.map((h) => h.id));
  dupes("examination", c.examination.map((e) => e.id));
  dupes("investigations", c.investigations.map((t) => t.id));
  dupes("diagnosis.options", c.diagnosis.options.map((d) => d.id));
  dupes("management.actions", c.management.actions.map((a) => a.id));
  dupes("questions", c.questions.map((q) => q.id));

  // Shared library references.
  c.examination.forEach((e, i) => {
    if (!EXAM_POINTS_BY_ID.has(e.id)) add(`examination.${i}.id`, `unknown exam point "${e.id}"`);
  });
  c.investigations.forEach((t, i) => {
    if (!TESTS_BY_ID.has(t.id)) add(`investigations.${i}.id`, `unknown test "${t.id}"`);
  });
  c.management.actions.forEach((a, i) => {
    if (!ACTIONS_BY_ID.has(a.id)) add(`management.actions.${i}.id`, `unknown drug or action "${a.id}"`);
  });

  // Internal references.
  const dxIds = new Set(c.diagnosis.options.map((d) => d.id));
  if (!dxIds.has(c.diagnosis.correct)) add("diagnosis.correct", `"${c.diagnosis.correct}" is not one of the diagnosis options`);
  c.diagnosis.acceptable.forEach((a, i) => {
    if (!dxIds.has(a.id)) add(`diagnosis.acceptable.${i}.id`, `"${a.id}" is not one of the diagnosis options`);
    if (a.id === c.diagnosis.correct) add(`diagnosis.acceptable.${i}.id`, "the correct diagnosis cannot also be an acceptable differential");
  });

  const mgmtIds = new Set(c.management.actions.map((a) => a.id));
  c.management.requiredOrder.forEach((o, i) =>
    o.sequence.forEach((s, j) => {
      if (!mgmtIds.has(s)) add(`management.requiredOrder.${i}.sequence.${j}`, `"${s}" is not a management action in this case`);
    }),
  );

  // Anything the student can do is a valid trigger.
  const actionRefs = new Set<string>([
    ...c.history.map((h) => h.id),
    ...c.examination.map((e) => e.id),
    ...c.investigations.map((t) => t.id),
    ...mgmtIds,
  ]);
  c.vitals.onAction.forEach((e, i) => {
    if (!actionRefs.has(e.onAction)) add(`vitals.onAction.${i}.onAction`, `"${e.onAction}" is not an action in this case`);
  });
  c.vitals.deterioration.forEach((e, i) =>
    e.unlessActions.forEach((a, j) => {
      if (!actionRefs.has(a)) add(`vitals.deterioration.${i}.unlessActions.${j}`, `"${a}" is not an action in this case`);
    }),
  );
  c.vitals.timed.forEach((e, i) => {
    if (e.atMin > c.metadata.timeLimitMin) add(`vitals.timed.${i}.atMin`, "event is after the case time limit");
  });

  c.questions.forEach((q, i) => {
    const optIds = new Set(q.options.map((o) => o.id));
    q.correct.forEach((cid, j) => {
      if (!optIds.has(cid)) add(`questions.${i}.correct.${j}`, `"${cid}" is not one of the options`);
    });
    if (q.type !== "multiple" && q.correct.length !== 1) add(`questions.${i}.correct`, `a ${q.type} question needs exactly one correct option`);
    if (q.checkpoint.kind === "after_action" && !actionRefs.has(q.checkpoint.action))
      add(`questions.${i}.checkpoint.action`, `"${q.checkpoint.action}" is not an action in this case`);
    if (q.checkpoint.kind === "time" && q.checkpoint.atMin > c.metadata.timeLimitMin)
      add(`questions.${i}.checkpoint.atMin`, "checkpoint is after the case time limit");
  });

  // Rubric sanity.
  const { decisionWeight, questionWeight } = c.rubric;
  if (Math.abs(decisionWeight + questionWeight - 1) > 1e-9) add("rubric", "decisionWeight + questionWeight must equal 1");
  if (c.questions.length === 0 && questionWeight > 0) add("rubric.questionWeight", "case has no questions but questionWeight > 0");
  if (!c.management.actions.some((a) => a.classification === "correct")) add("management.actions", "at least one action must be classified correct");
  c.management.actions.forEach((a, i) => {
    if (a.classification === "harmful" && a.points === 0) add(`management.actions.${i}.points`, "harmful actions need a penalty");
    if (a.critical && a.classification !== "harmful") add(`management.actions.${i}.critical`, "only harmful actions can be critical errors");
  });

  // Physiology sanity on the starting vitals.
  const v = c.vitals.initial;
  if (v.dbp >= v.sbp) add("vitals.initial.dbp", "diastolic must be below systolic");

  return issues.length ? { ok: false, issues } : { ok: true, case: c, issues: [] };
}
