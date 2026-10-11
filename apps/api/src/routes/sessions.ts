import type { ScoreReport } from "@sim/engine";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import { tx } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../http-errors.js";
import { scoreAndStore } from "../scoring-service.js";
import { sessionSeats } from "../seats.js";

const NewSession = z
  .object({
    courseId: z.string().uuid(),
    labId: z.string().uuid(),
    caseIds: z.array(z.string()).min(1),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    allowRetry: z.boolean().default(false),
  })
  .refine((s) => s.endsAt > s.startsAt, { message: "endsAt must be after startsAt", path: ["endsAt"] });

/** Loads a session the current staff user may manage (their own, or any for admins). */
export async function staffSession(app: FastifyInstance, req: FastifyRequest, id: string) {
  const { rows } = await app.db.query("SELECT * FROM sessions WHERE id = $1", [id]);
  const s = rows[0];
  if (!s) throw notFound("session");
  if (req.user.role !== "admin" && s.instructor_id !== req.user.id) throw forbidden("not your session");
  return s;
}

export async function sessionRoutes(app: FastifyInstance) {
  const staff = { preHandler: requireRole("instructor", "admin") };

  app.post("/api/sessions", staff, async (req, reply) => {
    const s = NewSession.parse(req.body);
    if (req.user.role !== "admin") {
      const m = await app.db.query("SELECT 1 FROM course_members WHERE course_id = $1 AND user_id = $2", [s.courseId, req.user.id]);
      if (!m.rowCount) throw forbidden("you do not teach this course");
    }
    const cases: { caseId: string; version: number }[] = [];
    for (const caseId of s.caseIds) {
      const { rows } = await app.db.query("SELECT version FROM case_versions WHERE case_id = $1 AND status = 'published'", [caseId]);
      if (!rows[0]) throw badRequest(`case "${caseId}" has no published version`);
      cases.push({ caseId, version: rows[0].version });
    }
    const { rows } = await app.db.query(
      `INSERT INTO sessions (course_id, lab_id, instructor_id, cases, starts_at, ends_at, allow_retry)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, status`,
      [s.courseId, s.labId, req.user.id, JSON.stringify(cases), s.startsAt, s.endsAt, s.allowRetry],
    );
    return reply.code(201).send({ id: rows[0].id, status: rows[0].status, cases });
  });

  app.get("/api/sessions", staff, async (req) => {
    const { rows } = await app.db.query(
      `SELECT s.id, s.status, s.cases, s.starts_at AS "startsAt", s.ends_at AS "endsAt", s.allow_retry AS "allowRetry",
              c.code AS course, l.name AS lab
       FROM sessions s JOIN courses c ON c.id = s.course_id JOIN labs l ON l.id = s.lab_id
       WHERE $1 OR s.instructor_id = $2 ORDER BY s.starts_at DESC`,
      [req.user.role === "admin", req.user.id],
    );
    return rows;
  });

  // Sessions a student can join now: their course, inside the time window, not ended.
  app.get("/api/my/sessions", { preHandler: requireRole("student") }, async (req) => {
    const { rows } = await app.db.query(
      `SELECT s.id, s.status, s.cases, s.starts_at AS "startsAt", s.ends_at AS "endsAt", c.code AS course, l.name AS lab,
              l.id AS "labId"
       FROM sessions s
       JOIN course_members m ON m.course_id = s.course_id AND m.user_id = $1
       JOIN courses c ON c.id = s.course_id JOIN labs l ON l.id = s.lab_id
       WHERE s.status <> 'ended' AND now() BETWEEN s.starts_at AND s.ends_at
       ORDER BY s.starts_at`,
      [req.user.id],
    );
    for (const s of rows) {
      const titles = await app.db.query(
        "SELECT case_id, version, title FROM case_versions WHERE (case_id, version) IN (SELECT x->>'caseId', (x->>'version')::int FROM jsonb_array_elements($1::jsonb) x)",
        [JSON.stringify(s.cases)],
      );
      const attempts = await app.db.query("SELECT id, case_id, status, attempt_no FROM attempts WHERE session_id = $1 AND student_id = $2 ORDER BY attempt_no", [s.id, req.user.id]);
      s.cases = s.cases.map((c: { caseId: string; version: number }) => ({
        ...c,
        title: titles.rows.find((t) => t.case_id === c.caseId)?.title,
        attempts: attempts.rows.filter((a) => a.case_id === c.caseId).map((a) => ({ id: a.id, status: a.status, attemptNo: a.attempt_no })),
      }));
    }
    return rows;
  });

  const setStatus = (status: "open" | "paused" | "ended") => async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const s = await staffSession(app, req, id);
    if (s.status === "ended") throw conflict("session already ended");
    let finished = 0;
    await tx(app.db, async (q) => {
      await q.query("UPDATE sessions SET status = $2 WHERE id = $1", [id, status]);
      if (status === "ended") {
        // Close and score any attempt still running so no student is left without a result.
        const open = await q.query("UPDATE attempts SET status = 'finished', finished_at = now() WHERE session_id = $1 AND status = 'in_progress' RETURNING id", [id]);
        for (const a of open.rows) await scoreAndStore(q, a.id);
        finished = open.rowCount ?? 0;
      }
    });
    app.live.publish({ type: "session", sessionId: id, status });
    return { id, status, ...(status === "ended" ? { attemptsClosed: finished } : {}) };
  };
  app.post("/api/sessions/:id/pause", staff, setStatus("paused"));
  app.post("/api/sessions/:id/resume", staff, setStatus("open"));
  app.post("/api/sessions/:id/end", staff, setStatus("ended"));

  app.post("/api/sessions/:id/retry", staff, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { studentId, caseId } = z.object({ studentId: z.string().uuid(), caseId: z.string() }).parse(req.body);
    const s = await staffSession(app, req, id);
    if (!s.cases.some((c: { caseId: string }) => c.caseId === caseId)) throw badRequest("case is not in this session");
    await app.db.query("INSERT INTO retry_grants (session_id, student_id, case_id, granted_by) VALUES ($1, $2, $3, $4)", [id, studentId, caseId, req.user.id]);
    return reply.code(201).send({ ok: true });
  });

  app.get("/api/sessions/:id/live", staff, async (req) => {
    const { id } = req.params as { id: string };
    const s = await staffSession(app, req, id);
    return { id, status: s.status, seats: await sessionSeats(app.db, id) };
  });

  app.get("/api/sessions/:id/results", staff, async (req) => {
    const { id } = req.params as { id: string };
    await staffSession(app, req, id);
    return sessionResults(app, id);
  });
}

export interface ResultRow {
  attemptId: string;
  studentId: string;
  studentName: string;
  username: string;
  caseId: string;
  caseVersion: number;
  attemptNo: number;
  totalPct: number;
  passed: boolean;
  criticalErrors: number;
  areas: ScoreReport["areas"];
  questionsPct: number;
}

/** Per student, per case and per cohort results, and the most missed key decisions per case. */
export async function sessionResults(app: FastifyInstance, sessionId: string) {
  const { rows } = await app.db.query(
    `SELECT a.id, a.student_id, u.display_name, u.username, a.case_id, a.case_version, a.attempt_no, r.total_pct, r.passed, r.report
     FROM attempts a JOIN results r ON r.attempt_id = a.id JOIN users u ON u.id = a.student_id
     WHERE a.session_id = $1 ORDER BY a.case_id, u.display_name, a.attempt_no`,
    [sessionId],
  );
  const results: ResultRow[] = rows.map((r) => ({
    attemptId: r.id,
    studentId: r.student_id,
    studentName: r.display_name,
    username: r.username,
    caseId: r.case_id,
    caseVersion: r.case_version,
    attemptNo: r.attempt_no,
    totalPct: Number(r.total_pct),
    passed: r.passed,
    criticalErrors: r.report.criticalErrors.length,
    areas: r.report.areas,
    questionsPct: r.report.questions.pct,
  }));

  // Cohort statistics use each student's latest attempt per case.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(`${r.case_id}|${r.student_id}`, r);
  const byCase = new Map<string, (typeof rows)[number][]>();
  for (const r of latest.values()) byCase.set(r.case_id, [...(byCase.get(r.case_id) ?? []), r]);

  const cohort = [...byCase.entries()].map(([caseId, rs]) => {
    const scores = rs.map((r) => Number(r.total_pct)).sort((a, b) => a - b);
    const missed = new Map<string, { ref: string; area: string; missed: number }>();
    for (const r of rs)
      for (const it of (r.report as ScoreReport).items)
        if (it.key && !it.done) {
          const k = `${it.area}:${it.ref}`;
          const m = missed.get(k) ?? { ref: it.ref, area: it.area, missed: 0 };
          m.missed++;
          missed.set(k, m);
        }
    return {
      caseId,
      students: rs.length,
      meanPct: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100,
      medianPct: scores.length % 2 ? scores[(scores.length - 1) / 2]! : (scores[scores.length / 2 - 1]! + scores[scores.length / 2]!) / 2,
      passRate: Math.round((rs.filter((r) => r.passed).length / rs.length) * 1000) / 10,
      mostMissed: [...missed.values()]
        .sort((a, b) => b.missed - a.missed || a.ref.localeCompare(b.ref))
        .slice(0, 10)
        .map((m) => ({ ...m, missedPct: Math.round((m.missed / rs.length) * 1000) / 10 })),
    };
  });
  return { results, cohort };
}
