import type { CaseDefinition } from "@sim/shared";
import type { LoggedAction } from "./vitals.js";

export type Area = "history" | "examination" | "investigations" | "diagnosis" | "management" | "safety";
export const AREAS: readonly Area[] = ["history", "examination", "investigations", "diagnosis", "management", "safety"];

export interface ScoredAction extends LoggedAction {
  payload?: Record<string, unknown>;
}

export interface ScoreItem {
  area: Area | "questions";
  ref: string;
  /** Points earned (negative for penalties). */
  points: number;
  /** Points available (0 for penalties and neutral items). */
  max: number;
  done: boolean;
  atMs?: number;
  /** A key decision is one the student is expected to make (max > 0). */
  key: boolean;
  note?: string;
  feedback?: string;
}

export interface ScoreReport {
  caseId: string;
  caseVersion: number;
  areas: Record<Area, { points: number; max: number }>;
  decisions: { points: number; max: number; pct: number };
  questions: { points: number; max: number; pct: number };
  weights: { decisions: number; questions: number };
  /** Final score, 0-100. */
  totalPct: number;
  passed: boolean;
  passMark: number;
  criticalErrors: { ref: string; feedback?: string }[];
  items: ScoreItem[];
}

const MIN = 60_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

function firstOf(log: readonly ScoredAction[], type: string): Map<string, ScoredAction> {
  const m = new Map<string, ScoredAction>();
  for (const a of log) if (a.type === type && a.ref && !m.has(a.ref)) m.set(a.ref, a);
  return m;
}

/**
 * Scores an attempt from its action log. Pure and deterministic, so a corrected rubric
 * re-scores stored attempts exactly. Gesture or input method never affects the score:
 * only `type`, `ref`, `caseTimeMs` and `payload` are read.
 */
export function scoreAttempt(c: CaseDefinition, rawLog: readonly ScoredAction[]): ScoreReport {
  const log = [...rawLog].sort((a, b) => a.caseTimeMs - b.caseTimeMs);
  const items: ScoreItem[] = [];
  const fb = (f?: string) => (f ? { feedback: f } : {});
  const at = (a?: ScoredAction) => (a ? { atMs: a.caseTimeMs } : {});

  // History: essential/useful earn points; irrelevant ones cost a little efficiency.
  const asked = firstOf(log, "history.ask");
  for (const h of c.history) {
    const a = asked.get(h.id);
    if (h.relevance === "irrelevant") {
      if (a) items.push({ area: "history", ref: h.id, points: -c.rubric.irrelevantHistoryPenalty, max: 0, done: true, key: false, note: "irrelevant question", ...at(a) });
    } else {
      items.push({ area: "history", ref: h.id, points: a ? h.points : 0, max: h.points, done: !!a, key: h.points > 0, ...at(a), ...fb(h.feedback) });
    }
  }

  // Examination.
  const examined = firstOf(log, "exam.perform");
  for (const e of c.examination) {
    const a = examined.get(e.id);
    if (e.relevant) items.push({ area: "examination", ref: e.id, points: a ? e.points : 0, max: e.points, done: !!a, key: e.points > 0, ...at(a), ...fb(e.feedback) });
  }

  // Investigations: indicated earn points; unnecessary ones are penalized lightly.
  const ordered = firstOf(log, "investigation.order");
  for (const t of c.investigations) {
    const a = ordered.get(t.id);
    if (t.indicated) items.push({ area: "investigations", ref: t.id, points: a ? t.points : 0, max: t.points, done: !!a, key: t.points > 0, ...at(a), ...fb(t.feedback) });
    else if (a) items.push({ area: "investigations", ref: t.id, points: -t.penalty, max: 0, done: true, key: false, note: "not indicated", ...at(a), ...fb(t.feedback) });
  }

  // Diagnosis: the last submission counts.
  const dxEntries = log.filter((a) => a.type === "diagnosis.submit");
  const dx = dxEntries[dxEntries.length - 1];
  const main = typeof dx?.payload?.main === "string" ? dx.payload.main : undefined;
  const diffs = Array.isArray(dx?.payload?.differentials) ? (dx.payload.differentials as unknown[]).filter((d): d is string => typeof d === "string") : [];
  const d = c.diagnosis;
  items.push({ area: "diagnosis", ref: d.correct, points: main === d.correct ? d.correctPoints : 0, max: d.correctPoints, done: main === d.correct, key: true, note: "main diagnosis", ...at(dx), ...fb(d.feedback) });
  const listed = [...new Set(diffs)].filter((x) => x !== main).slice(0, d.maxDifferentials);
  // Max counts only the best `maxDifferentials` acceptable differentials, so it is achievable.
  d.acceptable
    .slice()
    .sort((x, y) => y.points - x.points)
    .forEach((x, i) => {
      const hit = listed.includes(x.id);
      const max = i < d.maxDifferentials ? x.points : 0;
      if (max > 0 || hit) items.push({ area: "diagnosis", ref: x.id, points: hit ? x.points : 0, max, done: hit, key: max > 0, note: "differential", ...at(hit ? dx : undefined) });
    });

  // Management and safety.
  const given = firstOf(log, "management.give");
  const criticalErrors: ScoreReport["criticalErrors"] = [];
  for (const m of c.management.actions) {
    const a = given.get(m.id);
    if (m.classification === "correct" || m.classification === "acceptable") {
      let pts = 0;
      let note: string | undefined;
      if (a) {
        const onTime = m.withinMin === undefined || a.caseTimeMs <= m.withinMin * MIN;
        pts = onTime ? m.points : m.latePoints;
        if (!onTime) note = `given after ${m.withinMin} min`;
      }
      items.push({ area: "management", ref: m.id, points: pts, max: m.points, done: !!a, key: m.classification === "correct", ...at(a), ...(note ? { note } : {}), ...fb(m.feedback) });
    } else if (m.classification === "harmful" && a) {
      items.push({ area: "safety", ref: m.id, points: -m.points, max: 0, done: true, key: false, note: m.critical ? "critical error" : "harmful", ...at(a), ...fb(m.feedback) });
      if (m.critical) criticalErrors.push({ ref: m.id, ...fb(m.feedback) });
    }
  }
  for (const o of c.management.requiredOrder) {
    const times = o.sequence.map((s) => given.get(s)?.caseTimeMs);
    if (times.some((t) => t === undefined)) continue;
    const inOrder = times.every((t, i) => i === 0 || t! >= times[i - 1]!);
    if (!inOrder) items.push({ area: "management", ref: o.sequence.join(">"), points: -o.penalty, max: 0, done: true, key: false, note: "wrong order", ...fb(o.feedback) });
  }

  // Area totals. Light penalties never take an area below zero; safety can go negative.
  const areas = Object.fromEntries(AREAS.map((a) => [a, { points: 0, max: 0 }])) as ScoreReport["areas"];
  for (const it of items) {
    if (it.area === "questions") continue;
    areas[it.area].points += it.points;
    areas[it.area].max += it.max;
  }
  for (const a of AREAS) {
    if (a !== "safety") areas[a].points = Math.max(0, areas[a].points);
    areas[a].points = round2(areas[a].points);
  }
  const decPoints = AREAS.reduce((s, a) => s + areas[a].points, 0);
  const decMax = AREAS.reduce((s, a) => s + areas[a].max, 0);

  // Questions: first answer counts; multiple-answer gets partial credit (hits - wrong picks).
  const answers = firstOf(log, "question.answer");
  let qPoints = 0;
  let qMax = 0;
  for (const q of c.questions) {
    const a = answers.get(q.id);
    const selected = Array.isArray(a?.payload?.selected) ? (a!.payload!.selected as unknown[]).filter((s): s is string => typeof s === "string") : [];
    const correct = new Set(q.correct);
    let pts = 0;
    if (q.type === "multiple") {
      const hits = selected.filter((s) => correct.has(s)).length;
      const wrong = selected.filter((s) => !correct.has(s)).length;
      pts = q.points * Math.max(0, (hits - wrong) / correct.size);
    } else {
      pts = selected.length === 1 && correct.has(selected[0]!) ? q.points : 0;
    }
    pts = round2(pts);
    qPoints += pts;
    qMax += q.points;
    items.push({ area: "questions", ref: q.id, points: pts, max: q.points, done: !!a, key: true, ...at(a), ...fb(q.feedback) });
  }

  const decPct = decMax > 0 ? Math.max(0, decPoints) / decMax : 0;
  const qPct = qMax > 0 ? qPoints / qMax : 0;
  const weights = qMax > 0 ? { decisions: c.rubric.decisionWeight, questions: c.rubric.questionWeight } : { decisions: 1, questions: 0 };
  const totalPct = round2(100 * (weights.decisions * decPct + weights.questions * qPct));

  return {
    caseId: c.metadata.id,
    caseVersion: c.metadata.version,
    areas,
    decisions: { points: round2(decPoints), max: round2(decMax), pct: round2(decPct * 100) },
    questions: { points: round2(qPoints), max: qMax, pct: round2(qPct * 100) },
    weights,
    totalPct,
    passed: criticalErrors.length === 0 && totalPct >= c.rubric.passMark,
    passMark: c.rubric.passMark,
    criticalErrors,
    items,
  };
}
