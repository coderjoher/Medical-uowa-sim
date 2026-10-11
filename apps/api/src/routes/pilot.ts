import { NON_CLINICAL_TYPES, toStudentCase } from "@sim/shared";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import { badRequest, conflict, forbidden, notFound } from "../http-errors.js";
import { loadActions, loadCase } from "../scoring-service.js";

const LabCheck = z.object({
  seatId: z.string().uuid().optional(),
  cameraOk: z.boolean(),
  lightLevel: z.number().min(0).max(1).optional(),
  trackingFps: z.number().min(0).max(1000).optional(),
  renderFps: z.number().min(0).max(1000).optional(),
  handSeen: z.boolean(),
  audioOk: z.boolean(),
  details: z.record(z.unknown()).optional(),
});

const TrackingTest = z.object({
  seatId: z.string().uuid().optional(),
  durationMs: z.number().int().min(1000).max(3_600_000),
  targets: z.number().int().min(1).max(1000),
  detected: z.number().int().min(0),
  falseClicks: z.number().int().min(0),
  restMs: z.number().int().min(0),
  handLost: z.number().int().min(0),
  recoveryMs: z.array(z.number().int().min(0)).max(1000),
  trackingFps: z.number().min(0).max(1000).optional(),
  renderFps: z.number().min(0).max(1000).optional(),
  pipelineP95Ms: z.number().min(0).max(10_000).optional(),
  feltReliable: z.boolean().optional(),
  details: z.record(z.unknown()).optional(),
});

const rating = z.number().int().min(1).max(5);
const Survey = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("student_case"), attemptId: z.string().uuid(), answers: z.object({ trackingReliable: z.boolean().optional(), usedHand: z.boolean(), useful: rating, comment: z.string().max(2000).optional() }) }),
  z.object({ kind: z.literal("student_course"), courseId: z.string().uuid(), answers: z.object({ trackingReliable: z.boolean(), useful: rating, comment: z.string().max(2000).optional() }) }),
  z.object({ kind: z.literal("instructor"), courseId: z.string().uuid(), answers: z.object({ willingNextSemester: z.boolean(), comment: z.string().max(2000).optional() }) }),
]);

const Review = z.object({ agrees: z.boolean(), comment: z.string().max(2000).optional() });

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

/** PRD success metrics and tracking targets, each with its target and whether it is met. */
export interface Metric {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  target: string;
  met: boolean | null;
  basis: string;
}

export async function pilotRoutes(app: FastifyInstance) {
  const signedIn = { preHandler: requireRole() };
  const staff = { preHandler: requireRole("admin", "instructor") };
  const academics = { preHandler: requireRole("admin", "case_author") };

  // ---- Lab check results per seat ------------------------------------------------------------
  app.post("/api/lab-checks", signedIn, async (req, reply) => {
    const b = LabCheck.parse(req.body);
    const passed = b.cameraOk && b.handSeen && b.audioOk && (b.trackingFps ?? 0) >= 30 && (b.renderFps ?? 0) >= 60 && (b.lightLevel ?? 0) >= 0.18 && (b.lightLevel ?? 1) <= 0.85;
    const { rows } = await app.db.query(
      `INSERT INTO lab_checks (seat_id, user_id, camera_ok, light_level, tracking_fps, render_fps, hand_seen, audio_ok, passed, user_agent, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [b.seatId ?? null, req.user.id, b.cameraOk, b.lightLevel ?? null, b.trackingFps ?? null, b.renderFps ?? null, b.handSeen, b.audioOk, passed, req.headers["user-agent"] ?? null, b.details ?? null],
    );
    return reply.code(201).send({ id: rows[0].id, passed });
  });

  app.get("/api/admin/lab-readiness", staff, async (req) => {
    const { labId } = z.object({ labId: z.string().uuid() }).parse(req.query);
    const { rows } = await app.db.query(
      `SELECT s.id AS "seatId", s.label, c.passed, c.created_at AS "checkedAt", c.tracking_fps AS "trackingFps", c.render_fps AS "renderFps",
              c.light_level AS "lightLevel", c.camera_ok AS "cameraOk", c.hand_seen AS "handSeen", c.audio_ok AS "audioOk"
       FROM seats s
       LEFT JOIN LATERAL (SELECT * FROM lab_checks x WHERE x.seat_id = s.id ORDER BY x.created_at DESC LIMIT 1) c ON true
       WHERE s.lab_id = $1 ORDER BY s.label`,
      [labId],
    );
    return rows.map((r) => ({ ...r, trackingFps: r.trackingFps === null ? null : Number(r.trackingFps), renderFps: r.renderFps === null ? null : Number(r.renderFps), lightLevel: r.lightLevel === null ? null : Number(r.lightLevel) }));
  });

  // ---- Hand-tracking test (prototype go/no-go) -------------------------------------------------
  app.post("/api/tracking-tests", signedIn, async (req, reply) => {
    const b = TrackingTest.parse(req.body);
    if (b.detected > b.targets) throw badRequest("detected cannot exceed targets");
    const { rows } = await app.db.query(
      `INSERT INTO tracking_tests (user_id, seat_id, duration_ms, targets, detected, false_clicks, rest_ms, hand_lost, recovery_ms, tracking_fps, render_fps, pipeline_p95_ms, felt_reliable, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [req.user.id, b.seatId ?? null, b.durationMs, b.targets, b.detected, b.falseClicks, b.restMs, b.handLost, b.recoveryMs, b.trackingFps ?? null, b.renderFps ?? null, b.pipelineP95Ms ?? null, b.feltReliable ?? null, b.details ?? null],
    );
    return reply.code(201).send({ id: rows[0].id });
  });

  app.get("/api/admin/tracking-tests", staff, async () => {
    const { rows } = await app.db.query(
      `SELECT t.id, u.display_name AS "user", s.label AS seat, t.created_at AS "createdAt", t.duration_ms AS "durationMs", t.targets, t.detected,
              t.false_clicks AS "falseClicks", t.rest_ms AS "restMs", t.hand_lost AS "handLost", t.recovery_ms AS "recoveryMs",
              t.tracking_fps::float AS "trackingFps", t.render_fps::float AS "renderFps", t.pipeline_p95_ms::float AS "pipelineP95Ms", t.felt_reliable AS "feltReliable"
       FROM tracking_tests t JOIN users u ON u.id = t.user_id LEFT JOIN seats s ON s.id = t.seat_id ORDER BY t.created_at DESC`,
    );
    return { runs: rows, metrics: trackingMetrics(rows) };
  });

  // ---- Surveys --------------------------------------------------------------------------------
  app.post("/api/surveys", signedIn, async (req, reply) => {
    const b = Survey.parse(req.body);
    const role = req.user.role;
    if (b.kind === "instructor" ? !["instructor", "admin"].includes(role) : role !== "student") throw forbidden("this survey is not for your role");
    if (b.kind === "student_case") {
      const a = await app.db.query("SELECT 1 FROM attempts WHERE id = $1 AND student_id = $2 AND status = 'finished'", [b.attemptId, req.user.id]);
      if (!a.rowCount) throw badRequest("survey must be about one of your finished attempts");
    } else {
      const m = await app.db.query("SELECT 1 FROM course_members WHERE course_id = $1 AND user_id = $2", [b.courseId, req.user.id]);
      if (!m.rowCount && role !== "admin") throw forbidden("you are not in this course");
    }
    try {
      await app.db.query("INSERT INTO surveys (user_id, kind, attempt_id, course_id, answers) VALUES ($1, $2, $3, $4, $5)", [
        req.user.id,
        b.kind,
        b.kind === "student_case" ? b.attemptId : null,
        b.kind === "student_case" ? null : b.courseId,
        b.answers,
      ]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw conflict("you already answered this survey");
      throw e;
    }
    return reply.code(201).send({ ok: true });
  });

  app.get("/api/my/surveys", signedIn, async (req) => {
    const { rows } = await app.db.query("SELECT kind, attempt_id AS \"attemptId\", course_id AS \"courseId\" FROM surveys WHERE user_id = $1", [req.user.id]);
    return rows;
  });

  // ---- Academic score review (sample of attempts per case) --------------------------------------
  app.get("/api/admin/score-review", academics, async (req) => {
    const { caseId, size } = z.object({ caseId: z.string(), size: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
    // A stable pseudo-random sample: the same attempts for every reviewer, so verdicts can be compared.
    const { rows } = await app.db.query(
      `SELECT a.id, a.case_version AS "caseVersion", r.total_pct::float AS "totalPct", r.passed,
              (SELECT agrees FROM score_reviews sr WHERE sr.attempt_id = a.id AND sr.reviewer_id = $2) AS "myVerdict",
              (SELECT count(*)::int FROM score_reviews sr WHERE sr.attempt_id = a.id) AS reviews,
              (SELECT count(*)::int FROM score_reviews sr WHERE sr.attempt_id = a.id AND sr.agrees) AS agrees
       FROM attempts a JOIN results r ON r.attempt_id = a.id
       WHERE a.case_id = $1 AND a.status = 'finished'
       ORDER BY md5(a.id::text) LIMIT $3`,
      [caseId, req.user.id, size],
    );
    return rows;
  });

  app.get("/api/admin/score-review/:attemptId", academics, async (req) => {
    const { attemptId } = req.params as { attemptId: string };
    const { rows } = await app.db.query("SELECT a.case_id, a.case_version, r.report FROM attempts a JOIN results r ON r.attempt_id = a.id WHERE a.id = $1", [attemptId]);
    if (!rows[0]) throw notFound("scored attempt");
    const { definition } = await loadCase(app.db, rows[0].case_id, rows[0].case_version);
    // Reviewers see the attempt anonymously: actions and score, not the student's name.
    const timeline = (await loadActions(app.db, attemptId)).filter((x) => !(NON_CLINICAL_TYPES as readonly string[]).includes(x.type));
    return { case: toStudentCase(definition), report: rows[0].report, timeline, diagnosis: { correct: definition.diagnosis.correct } };
  });

  app.post("/api/admin/score-review/:attemptId", academics, async (req, reply) => {
    const { attemptId } = req.params as { attemptId: string };
    const b = Review.parse(req.body);
    const exists = await app.db.query("SELECT 1 FROM results WHERE attempt_id = $1", [attemptId]);
    if (!exists.rowCount) throw notFound("scored attempt");
    await app.db.query(
      `INSERT INTO score_reviews (attempt_id, reviewer_id, agrees, comment) VALUES ($1, $2, $3, $4)
       ON CONFLICT (attempt_id, reviewer_id) DO UPDATE SET agrees = EXCLUDED.agrees, comment = EXCLUDED.comment, created_at = now()`,
      [attemptId, req.user.id, b.agrees, b.comment ?? null],
    );
    return reply.code(201).send({ ok: true });
  });

  // ---- Pilot report: PRD success metrics ----------------------------------------------------------
  app.get("/api/admin/pilot-report", staff, async (req) => {
    const { courseId } = z.object({ courseId: z.string().uuid().optional() }).parse(req.query);
    return pilotReport(app, courseId ?? null);
  });

  // The results report for the university (PRD pilot step 5), as a workbook.
  app.get("/api/admin/pilot-report.xlsx", staff, async (req, reply) => {
    const { courseId } = z.object({ courseId: z.string().uuid().optional() }).parse(req.query);
    const r = await pilotReport(app, courseId ?? null);
    const wb = new ExcelJS.Workbook();
    const sheet = (name: string, metrics: Metric[]) => {
      const ws = wb.addWorksheet(name);
      ws.columns = [
        { header: "Measure", key: "label", width: 52 },
        { header: "Result", key: "result", width: 14 },
        { header: "Target", key: "target", width: 34 },
        { header: "Met", key: "met", width: 10 },
        { header: "Basis", key: "basis", width: 70 },
      ];
      for (const m of metrics) ws.addRow({ ...m, result: m.value === null ? "no data" : `${m.value} ${m.unit}`, met: m.met === null ? "—" : m.met ? "yes" : "no" });
      ws.getRow(1).font = { bold: true };
    };
    sheet("Success metrics", r.success);
    sheet("Hand tracking", r.tracking);
    const c = wb.addWorksheet("Comments");
    c.columns = [{ header: "Comment", key: "c", width: 120 }];
    r.comments.forEach((x) => c.addRow({ c: x }));
    return reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", 'attachment; filename="pilot-report.xlsx"')
      .send(Buffer.from(await wb.xlsx.writeBuffer()));
  });
}

export function trackingMetrics(rows: { durationMs: number; targets: number; detected: number; falseClicks: number; restMs: number; handLost: number; recoveryMs: number[]; trackingFps: number | null; pipelineP95Ms: number | null; feltReliable: boolean | null }[]): Metric[] {
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  const targets = sum((r) => r.targets);
  const detected = sum((r) => r.detected);
  const restMin5 = sum((r) => r.restMs) / 300_000;
  const durMin5 = sum((r) => r.durationMs) / 300_000;
  const recoveries = rows.flatMap((r) => r.recoveryMs);
  const fps = rows.map((r) => r.trackingFps).filter((x): x is number => x !== null);
  const lat = rows.map((r) => r.pipelineP95Ms).filter((x): x is number => x !== null);
  const felt = rows.filter((r) => r.feltReliable !== null);
  const v = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
  const n = `${rows.length} test run(s)`;
  const perFive = (x: number, d: number) => (d > 0 ? x / d : null);
  const falsePer5 = perFive(sum((r) => r.falseClicks), restMin5);
  const lostPer5 = perFive(sum((r) => r.handLost), durMin5);
  const rec95 = quantile(recoveries, 0.95);
  const fpsMed = quantile(fps, 0.5);
  const latMedian = quantile(lat, 0.5);
  const reliable = pct(felt.filter((r) => r.feltReliable).length, felt.length);
  return [
    { key: "pinchDetected", label: "Intended pinches detected", value: pct(detected, targets), unit: "%", target: "≥ 95%", met: targets ? detected / targets >= 0.95 : null, basis: `${detected}/${targets} targets, ${n}` },
    { key: "falseClicks", label: "Unintended pinches (false clicks)", value: v(falsePer5), unit: "per 5 min", target: "≤ 1 per 5 min", met: falsePer5 === null ? null : falsePer5 <= 1, basis: `during ${(sum((r) => r.restMs) / 60000).toFixed(1)} min of pointing without pinching` },
    { key: "handLost", label: "Hand lost during use", value: v(lostPer5), unit: "per 5 min", target: "≤ 1 per 5 min", met: lostPer5 === null ? null : lostPer5 <= 1, basis: `${sum((r) => r.handLost)} losses in ${(sum((r) => r.durationMs) / 60000).toFixed(1)} min` },
    { key: "recovery", label: "Recovery after hand lost (p95)", value: rec95, unit: "ms", target: "< 1000 ms", met: rec95 === null ? (recoveries.length ? null : true) : rec95 < 1000, basis: `${recoveries.length} recoveries` },
    { key: "trackingFps", label: "Tracking frame rate (median of runs)", value: v(fpsMed), unit: "fps", target: "≥ 30 fps", met: fpsMed === null ? null : fpsMed >= 30, basis: n },
    {
      key: "pipelineLatency",
      label: "Tracking pipeline latency (median of run p95s)",
      value: v(latMedian),
      unit: "ms",
      target: "≤ 100 ms end to end",
      met: null,
      basis: "frame capture → gesture processed; excludes camera exposure and display time, so confirm end-to-end latency with a high-speed camera",
    },
    { key: "feltReliable", label: "Testers who felt tracking was reliable", value: reliable, unit: "%", target: "≥ 80%", met: reliable === null ? null : reliable >= 80, basis: `${felt.length} answers` },
  ];
}

export async function pilotReport(app: FastifyInstance, courseId: string | null) {
  const scope = courseId ? "AND s.course_id = $1" : "";
  const args = courseId ? [courseId] : [];

  const attempts = await app.db.query(
    `SELECT a.id, a.status, a.finished_at, a.last_seen_at,
            EXISTS (SELECT 1 FROM actions x WHERE x.attempt_id = a.id AND x.type = 'case.end') AS ended_by_student,
            (SELECT count(*)::int FROM actions x WHERE x.attempt_id = a.id AND x.type <> ALL(${courseId ? "$2" : "$1"}::text[]) AND x.type NOT IN ('case.start', 'case.end', 'case.pause', 'case.resume')) AS clinical,
            (SELECT count(*)::int FROM actions x WHERE x.attempt_id = a.id AND x.type <> ALL(${courseId ? "$2" : "$1"}::text[]) AND x.type NOT IN ('case.start', 'case.end', 'case.pause', 'case.resume') AND x.input_source = 'hand') AS by_hand
     FROM attempts a JOIN sessions s ON s.id = a.session_id WHERE true ${scope}`,
    [...args, NON_CLINICAL_TYPES],
  );
  const finished = attempts.rows.filter((r) => r.status === "finished" && r.ended_by_student && r.clinical > 0);
  const handOnly = finished.filter((r) => r.by_hand === r.clinical);
  // Lost to technical failure: retries granted for a technical reason, plus attempts closed by the
  // session end after the browser had stopped reporting for over 2 minutes (crash or network).
  const technicalRetries = (
    await app.db.query(`SELECT count(*)::int AS n FROM retry_grants g JOIN sessions s ON s.id = g.session_id WHERE g.reason = 'technical' ${scope}`, args)
  ).rows[0].n as number;
  const abandoned = attempts.rows.filter((r) => r.status === "finished" && !r.ended_by_student && r.finished_at && new Date(r.finished_at).getTime() - new Date(r.last_seen_at).getTime() > 120_000).length;

  const surveyScope = courseId ? "AND (course_id = $1 OR attempt_id IN (SELECT a.id FROM attempts a JOIN sessions s ON s.id = a.session_id WHERE s.course_id = $1))" : "";
  const surveys = (await app.db.query(`SELECT kind, answers FROM surveys WHERE true ${surveyScope}`, args)).rows as { kind: string; answers: Record<string, unknown> }[];
  const course = surveys.filter((s) => s.kind === "student_course");
  const caseSurveys = surveys.filter((s) => s.kind === "student_case");
  const instructors = surveys.filter((s) => s.kind === "instructor");
  const usefulRatings = [...course, ...caseSurveys].map((s) => s.answers.useful).filter((x): x is number => typeof x === "number");

  const reviews = (
    await app.db.query(
      `SELECT sr.attempt_id, sr.agrees FROM score_reviews sr JOIN attempts a ON a.id = sr.attempt_id JOIN sessions s ON s.id = a.session_id WHERE true ${scope}`,
      args,
    )
  ).rows as { attempt_id: string; agrees: boolean }[];
  const reviewedAttempts = new Set(reviews.map((r) => r.attempt_id)).size;
  const agreePct = pct(reviews.filter((r) => r.agrees).length, reviews.length);

  const trackingReliable = pct(course.filter((s) => s.answers.trackingReliable === true).length, course.length);
  const noMouse = pct(handOnly.length, finished.length);
  const useful = pct(usefulRatings.filter((r) => r >= 4).length, usefulRatings.length);
  const lost = pct(technicalRetries + abandoned, attempts.rows.length);
  const willing = pct(instructors.filter((s) => s.answers.willingNextSemester === true).length, instructors.length);

  const success: Metric[] = [
    { key: "trackingReliable", label: "Students rating hand tracking reliable", value: trackingReliable, unit: "%", target: "≥ 80%", met: trackingReliable === null ? null : trackingReliable >= 80, basis: `${course.length} end-of-course surveys` },
    { key: "noMouse", label: "Students who finish a case without switching to mouse", value: noMouse, unit: "%", target: "≥ 70%", met: noMouse === null ? null : noMouse >= 70, basis: `${handOnly.length}/${finished.length} finished attempts done entirely by hand` },
    { key: "useful", label: "Students rating the cases useful for learning", value: useful, unit: "%", target: "≥ 75%", met: useful === null ? null : useful >= 75, basis: `${usefulRatings.length} ratings (4 or 5 out of 5 counts as useful)` },
    { key: "lost", label: "Case sessions lost to technical failure", value: lost, unit: "%", target: "≤ 2%", met: lost === null ? null : lost <= 2, basis: `${technicalRetries} technical retries + ${abandoned} abandoned attempts of ${attempts.rows.length}` },
    { key: "willing", label: "Instructors willing to use it next semester", value: willing, unit: "%", target: "All pilot instructors", met: willing === null ? null : willing === 100, basis: `${instructors.length} instructor surveys` },
    {
      key: "scoreAgreement",
      label: "Academic reviewers agreeing scores reflect performance",
      value: agreePct,
      unit: "%",
      target: "Majority, on a sample of 20 attempts",
      met: agreePct === null ? null : agreePct > 50 && reviewedAttempts >= 20,
      basis: `${reviews.length} reviews of ${reviewedAttempts} attempts`,
    },
  ];

  const trackingRows = (
    await app.db.query(
      `SELECT duration_ms AS "durationMs", targets, detected, false_clicks AS "falseClicks", rest_ms AS "restMs", hand_lost AS "handLost", recovery_ms AS "recoveryMs",
              tracking_fps::float AS "trackingFps", pipeline_p95_ms::float AS "pipelineP95Ms", felt_reliable AS "feltReliable" FROM tracking_tests`,
    )
  ).rows;
  const comments = surveys.map((s) => s.answers.comment).filter((c): c is string => typeof c === "string" && c.trim() !== "");
  return { generatedAt: new Date().toISOString(), courseId, success, tracking: trackingMetrics(trackingRows), counts: { attempts: attempts.rows.length, finished: finished.length, surveys: surveys.length }, comments };
}
