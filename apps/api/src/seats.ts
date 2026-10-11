import type { Db } from "./db.js";

const STEP_OF: Record<string, string> = {
  "case.start": "brief",
  "history.ask": "history",
  "exam.perform": "examination",
  "investigation.order": "investigations",
  "question.answer": "questions",
  "diagnosis.submit": "diagnosis",
  "management.give": "management",
  "case.end": "debrief",
};

export interface SeatStatus {
  attemptId: string;
  studentId: string;
  studentName: string;
  seat: string | null;
  caseId: string;
  attemptNo: number;
  status: "in_progress" | "finished";
  step: string;
  elapsedMs: number;
  inputSource: string | null;
  warnings: string[];
}

/** Live view of every attempt in a session (one row per student per case attempt). */
export async function sessionSeats(db: Db, sessionId: string, attemptId?: string): Promise<SeatStatus[]> {
  const { rows } = await db.query(
    `SELECT a.id, a.student_id, u.display_name, s.label AS seat, a.case_id, a.attempt_no, a.status, a.last_seen_at,
            last.type AS last_type, last.ref AS last_ref, last.case_time_ms, last.input_source,
            (SELECT max(server_ts) FROM actions x WHERE x.attempt_id = a.id AND x.type = 'tracking.lost') AS lost_at,
            (SELECT max(server_ts) FROM actions x WHERE x.attempt_id = a.id AND x.type = 'tracking.recalibrate') AS recal_at,
            (SELECT x.payload->>'to' FROM actions x WHERE x.attempt_id = a.id AND x.type = 'input.switch' ORDER BY x.seq DESC LIMIT 1) AS switched_to
     FROM attempts a
     JOIN users u ON u.id = a.student_id
     LEFT JOIN seats s ON s.id = a.seat_id
     LEFT JOIN LATERAL (
       SELECT type, ref, case_time_ms, input_source FROM actions x
       WHERE x.attempt_id = a.id AND x.type NOT IN ('tracking.lost', 'tracking.recalibrate', 'input.switch')
       ORDER BY x.seq DESC LIMIT 1
     ) last ON true
     WHERE a.session_id = $1 AND ($2::uuid IS NULL OR a.id = $2)
     ORDER BY s.label NULLS LAST, u.display_name, a.attempt_no`,
    [sessionId, attemptId ?? null],
  );
  const now = Date.now();
  return rows.map((r) => {
    const warnings: string[] = [];
    if (r.status === "in_progress") {
      if (now - new Date(r.last_seen_at).getTime() > 20_000) warnings.push("connection: no contact for over 20 s");
      if (r.lost_at && now - new Date(r.lost_at).getTime() < 30_000) warnings.push("tracking: hand lost recently");
      if (r.switched_to === "mouse") warnings.push("tracking: switched to mouse");
    }
    const step = r.status === "finished" ? "finished" : r.last_type === "view.change" ? (r.last_ref ?? "case") : (STEP_OF[r.last_type] ?? (r.last_type ? "case" : "joining"));
    return {
      attemptId: r.id,
      studentId: r.student_id,
      studentName: r.display_name,
      seat: r.seat,
      caseId: r.case_id,
      attemptNo: r.attempt_no,
      status: r.status,
      step,
      elapsedMs: Number(r.case_time_ms ?? 0),
      inputSource: r.input_source ?? null,
      warnings,
    };
  });
}
