import { scoreAttempt, type ScoreReport, type ScoredAction } from "@sim/engine";
import type { CaseDefinition } from "@sim/shared";
import type pg from "pg";
import type { Db } from "./db.js";
import { notFound } from "./http-errors.js";

type Queryable = Db | pg.PoolClient;

export async function loadCase(q: Queryable, caseId: string, version: number) {
  const { rows } = await q.query("SELECT definition, rubric_revision, status FROM case_versions WHERE case_id = $1 AND version = $2", [caseId, version]);
  if (!rows[0]) throw notFound("case version");
  return { definition: rows[0].definition as CaseDefinition, rubricRevision: rows[0].rubric_revision as number, status: rows[0].status as string };
}

export async function loadActions(q: Queryable, attemptId: string): Promise<ScoredAction[]> {
  const { rows } = await q.query("SELECT seq, case_time_ms, type, ref, payload, input_source FROM actions WHERE attempt_id = $1 ORDER BY seq", [attemptId]);
  return rows.map((r) => ({ seq: r.seq, caseTimeMs: Number(r.case_time_ms), type: r.type, ...(r.ref ? { ref: r.ref } : {}), ...(r.payload ? { payload: r.payload } : {}), inputSource: r.input_source }));
}

/** Scores an attempt from its stored action log with the case's current rubric, and stores the result. */
export async function scoreAndStore(q: Queryable, attemptId: string): Promise<ScoreReport> {
  const { rows } = await q.query("SELECT case_id, case_version FROM attempts WHERE id = $1", [attemptId]);
  if (!rows[0]) throw notFound("attempt");
  const { definition, rubricRevision } = await loadCase(q, rows[0].case_id, rows[0].case_version);
  const report = scoreAttempt(definition, await loadActions(q, attemptId));
  await q.query(
    `INSERT INTO results (attempt_id, case_id, case_version, rubric_revision, total_pct, passed, report)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (attempt_id) DO UPDATE SET rubric_revision = EXCLUDED.rubric_revision, total_pct = EXCLUDED.total_pct,
       passed = EXCLUDED.passed, report = EXCLUDED.report, scored_at = now()`,
    [attemptId, rows[0].case_id, rows[0].case_version, rubricRevision, report.totalPct, report.passed, report],
  );
  return report;
}
