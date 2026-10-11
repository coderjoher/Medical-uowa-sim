import { resultReadyAt } from "@sim/engine";
import { ActionLogEntry, NON_CLINICAL_TYPES, toStudentCase } from "@sim/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import { tx } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../http-errors.js";
import { loadActions, loadCase, scoreAndStore } from "../scoring-service.js";
import { sessionSeats } from "../seats.js";

const StartAttempt = z.object({ caseId: z.string(), seatId: z.string().uuid().optional() });
const ActionBatch = z.object({ actions: z.array(ActionLogEntry).max(500) });

export async function attemptRoutes(app: FastifyInstance) {
  const student = { preHandler: requireRole("student") };

  const ownAttempt = async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const { rows } = await app.db.query(
      "SELECT a.*, s.status AS session_status FROM attempts a JOIN sessions s ON s.id = a.session_id WHERE a.id = $1",
      [id],
    );
    const a = rows[0];
    if (!a) throw notFound("attempt");
    if (a.student_id !== req.user.id) throw forbidden("not your attempt");
    return a;
  };

  const publishSeat = async (sessionId: string, attemptId: string) => {
    const [seat] = await sessionSeats(app.db, sessionId, attemptId);
    if (seat) app.live.publish({ type: "seat", sessionId, seat });
  };

  const attemptPayload = async (a: { id: string; session_id: string; case_id: string; case_version: number; attempt_no: number; status: string; session_status: string }) => {
    const { definition } = await loadCase(app.db, a.case_id, a.case_version);
    return {
      attempt: { id: a.id, sessionId: a.session_id, caseId: a.case_id, caseVersion: a.case_version, attemptNo: a.attempt_no, status: a.status },
      sessionStatus: a.session_status,
      case: toStudentCase(definition),
      // The stored log lets the client resume exactly where it stopped after a refresh or crash.
      actions: await loadActions(app.db, a.id),
    };
  };

  // Start a case, or resume the attempt already in progress.
  app.post("/api/sessions/:id/attempts", student, async (req, reply) => {
    const { id: sessionId } = req.params as { id: string };
    const { caseId, seatId } = StartAttempt.parse(req.body);
    const created = await tx(app.db, async (q) => {
      const { rows } = await q.query(
        `SELECT s.*, (now() BETWEEN s.starts_at AND s.ends_at) AS in_window,
                EXISTS (SELECT 1 FROM course_members m WHERE m.course_id = s.course_id AND m.user_id = $2) AS member
         FROM sessions s WHERE s.id = $1 FOR UPDATE`,
        [sessionId, req.user.id],
      );
      const s = rows[0];
      if (!s) throw notFound("session");
      if (!s.member) throw forbidden("you are not enrolled in this course");
      if (s.status === "ended" || !s.in_window) throw conflict("this session is not open");
      const entry = (s.cases as { caseId: string; version: number }[]).find((c) => c.caseId === caseId);
      if (!entry) throw badRequest("case is not part of this session");
      if (seatId) {
        const seat = await q.query("SELECT 1 FROM seats WHERE id = $1 AND lab_id = $2", [seatId, s.lab_id]);
        if (!seat.rowCount) throw badRequest("seat is not in this session's lab");
      }

      const prev = await q.query("SELECT * FROM attempts WHERE session_id = $1 AND student_id = $2 AND case_id = $3 ORDER BY attempt_no DESC", [sessionId, req.user.id, caseId]);
      const inProgress = prev.rows.find((r) => r.status === "in_progress");
      if (inProgress) return { attempt: { ...inProgress, session_status: s.status }, resumed: true };
      if (prev.rowCount) {
        const grant = await q.query(
          "UPDATE retry_grants SET used = true WHERE id = (SELECT id FROM retry_grants WHERE session_id = $1 AND student_id = $2 AND case_id = $3 AND NOT used ORDER BY created_at LIMIT 1) RETURNING id",
          [sessionId, req.user.id, caseId],
        );
        if (!s.allow_retry && !grant.rowCount) throw conflict("you have already completed this case; ask your instructor for a retry");
      }
      const ins = await q.query(
        "INSERT INTO attempts (session_id, student_id, case_id, case_version, attempt_no, seat_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
        [sessionId, req.user.id, caseId, entry.version, (prev.rows[0]?.attempt_no ?? 0) + 1, seatId ?? null],
      );
      return { attempt: { ...ins.rows[0], session_status: s.status }, resumed: false };
    });
    await publishSeat(sessionId, created.attempt.id);
    return reply.code(created.resumed ? 200 : 201).send({ ...(await attemptPayload(created.attempt)), resumed: created.resumed });
  });

  app.get("/api/attempts/:id", student, async (req) => attemptPayload(await ownAttempt(req)));

  /**
   * Action log sync. The client buffers actions while offline and re-sends them; ids make the
   * insert idempotent and seq keeps the order whatever order batches arrive in.
   */
  app.post("/api/attempts/:id/actions", student, async (req) => {
    const a = await ownAttempt(req);
    const { actions } = ActionBatch.parse(req.body);
    if (a.status !== "in_progress") throw conflict("attempt is already finished");
    let accepted = 0;
    if (actions.length) {
      const r = await app.db.query(
        `INSERT INTO actions (id, attempt_id, seq, case_time_ms, client_ts, type, ref, payload, input_source)
         SELECT x.id, $1, x.seq, x.case_time_ms, x.client_ts, x.type, x.ref, x.payload, x.input_source
         FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, seq int, case_time_ms bigint, client_ts timestamptz, type text, ref text, payload jsonb, input_source text)
         ON CONFLICT DO NOTHING`,
        [
          a.id,
          JSON.stringify(
            actions.map((x) => ({ id: x.id, seq: x.seq, case_time_ms: x.caseTimeMs, client_ts: x.clientTs, type: x.type, ref: x.ref ?? null, payload: x.payload ?? null, input_source: x.inputSource })),
          ),
        ],
      );
      accepted = r.rowCount ?? 0;
    }
    const { rows } = await app.db.query("UPDATE attempts SET last_seen_at = now() WHERE id = $1 RETURNING (SELECT max(seq) FROM actions WHERE attempt_id = $1) AS max_seq", [a.id]);
    await publishSeat(a.session_id, a.id);
    return { accepted, duplicates: actions.length - accepted, lastSeq: rows[0].max_seq };
  });

  // Investigation results are released only after the test was ordered and its turnaround passed.
  app.get("/api/attempts/:id/investigations/:testId", student, async (req) => {
    const a = await ownAttempt(req);
    const { testId } = req.params as { testId: string };
    const { at } = z.object({ at: z.coerce.number().int().min(0) }).parse(req.query);
    // Case time cannot run ahead of the wall clock since the attempt started (pauses only slow it).
    if (at > Date.now() - new Date(a.started_at).getTime() + 5000) throw badRequest("case time is ahead of the attempt's elapsed time");
    const { definition } = await loadCase(app.db, a.case_id, a.case_version);
    const test = definition.investigations.find((t) => t.id === testId);
    if (!test) throw notFound("investigation");
    const { rows } = await app.db.query("SELECT min(case_time_ms) AS t FROM actions WHERE attempt_id = $1 AND type = 'investigation.order' AND ref = $2", [a.id, testId]);
    if (rows[0].t === null) throw forbidden("investigation has not been ordered");
    const readyAtMs = resultReadyAt(Number(rows[0].t), test.turnaroundMin);
    if (at < readyAtMs) throw conflict(`result not ready until case time ${readyAtMs} ms`);
    return { id: test.id, readyAtMs, result: test.result };
  });

  app.post("/api/attempts/:id/finish", student, async (req) => {
    const a = await ownAttempt(req);
    const report = await tx(app.db, async (q) => {
      if (a.status === "in_progress") await q.query("UPDATE attempts SET status = 'finished', finished_at = now() WHERE id = $1", [a.id]);
      return scoreAndStore(q, a.id);
    });
    await publishSeat(a.session_id, a.id);
    return debrief(app, a.case_id, a.case_version, report, a.id);
  });

  app.get("/api/attempts/:id/result", student, async (req) => {
    const a = await ownAttempt(req);
    if (a.status !== "finished") throw conflict("attempt is still in progress");
    const { rows } = await app.db.query("SELECT report FROM results WHERE attempt_id = $1", [a.id]);
    if (!rows[0]) throw notFound("result");
    return debrief(app, a.case_id, a.case_version, rows[0].report, a.id);
  });
}

/** Debrief for the student: score, pass status, their timeline against the expected path, and feedback. */
async function debrief(app: FastifyInstance, caseId: string, version: number, report: import("@sim/engine").ScoreReport, attemptId: string) {
  const { definition } = await loadCase(app.db, caseId, version);
  const timeline = (await loadActions(app.db, attemptId)).filter((x) => !(NON_CLINICAL_TYPES as readonly string[]).includes(x.type));
  return { report, timeline, diagnosis: { correct: definition.diagnosis.correct, feedback: definition.diagnosis.feedback ?? null } };
}
