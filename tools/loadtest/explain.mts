/**
 * Query plans and timings for the hot queries of a lab session, against the database a load
 * run left behind (run after run.mts, before restarting server.mts).
 *
 *   npx tsx tools/loadtest/explain.mts
 *
 * Env: LOAD_DATABASE_URL (postgres://sim:sim@localhost:5432/sim_load), REPEAT (200).
 */
import pg from "pg";

const db = new pg.Client({ connectionString: process.env.LOAD_DATABASE_URL ?? "postgres://sim:sim@localhost:5432/sim_load" });
await db.connect();
const REPEAT = Number(process.env.REPEAT ?? 200);

// The seat query from apps/api/src/seats.ts (as of the pilot changes: $3 = types that do not move the step).
const SEATS = `SELECT a.id, a.student_id, u.display_name, s.label AS seat, a.case_id, a.attempt_no, a.status, a.last_seen_at,
            last.type AS last_type, last.ref AS last_ref, last.case_time_ms, last.input_source,
            (SELECT max(server_ts) FROM actions x WHERE x.attempt_id = a.id AND x.type = 'tracking.lost') AS lost_at,
            (SELECT max(server_ts) FROM actions x WHERE x.attempt_id = a.id AND x.type = 'tracking.recalibrate') AS recal_at,
            (SELECT x.payload->>'to' FROM actions x WHERE x.attempt_id = a.id AND x.type = 'input.switch' ORDER BY x.seq DESC LIMIT 1) AS switched_to
     FROM attempts a
     JOIN users u ON u.id = a.student_id
     LEFT JOIN seats s ON s.id = a.seat_id
     LEFT JOIN LATERAL (
       SELECT type, ref, case_time_ms, input_source FROM actions x
       WHERE x.attempt_id = a.id AND x.type <> ALL($3::text[])
       ORDER BY x.seq DESC LIMIT 1
     ) last ON true
     WHERE a.session_id = $1 AND ($2::uuid IS NULL OR a.id = $2)
     ORDER BY s.label NULLS LAST, u.display_name, a.attempt_no`;

const counts = (await db.query("SELECT (SELECT count(*) FROM attempts) AS attempts, (SELECT count(*) FROM actions) AS actions, (SELECT max(n) FROM (SELECT count(*) n FROM actions GROUP BY attempt_id) z) AS max_per_attempt")).rows[0];
console.log(`data: ${counts.attempts} attempts, ${counts.actions} actions (max ${counts.max_per_attempt} per attempt)\n`);

const { rows: busiest } = await db.query("SELECT session_id, count(*) n FROM attempts GROUP BY session_id ORDER BY n DESC LIMIT 1");
const sessionId = busiest[0].session_id;
const attemptId = (
  await db.query("SELECT x.attempt_id FROM actions x JOIN attempts a ON a.id = x.attempt_id WHERE a.session_id = $1 GROUP BY x.attempt_id ORDER BY count(*) DESC LIMIT 1", [sessionId])
).rows[0].attempt_id;
const NON_STEP = ["tracking.lost", "tracking.recalibrate", "tracking.stats", "input.switch"];

// Proposed rewrite: one pass over the attempt's actions instead of three correlated subqueries.
const SEATS_ONE_PASS = SEATS.replace(
  /\(SELECT max\(server_ts\)[\s\S]*?AS switched_to/,
  "flags.lost_at, flags.recal_at, flags.switched_to",
).replace(
  ") last ON true",
  `) last ON true
     LEFT JOIN LATERAL (
       SELECT max(server_ts) FILTER (WHERE type = 'tracking.lost') AS lost_at,
              max(server_ts) FILTER (WHERE type = 'tracking.recalibrate') AS recal_at,
              (array_agg(payload->>'to' ORDER BY seq DESC) FILTER (WHERE type = 'input.switch'))[1] AS switched_to
       FROM actions x WHERE x.attempt_id = a.id AND x.type IN ('tracking.lost', 'tracking.recalibrate', 'input.switch')
     ) flags ON true`,
);

const queries: [string, string, unknown[]][] = [
  ["seat status, one attempt (every action sync)", SEATS, [sessionId, attemptId, NON_STEP]],
  [`seat status, whole session of ${busiest[0].n} attempts (instructor connect, GET /live)`, SEATS, [sessionId, null, NON_STEP]],
  [`seat status, whole session, with SET jit = off`, "JIT_OFF", [sessionId, null, NON_STEP]],
  [`seat status, whole session, one-pass rewrite`, SEATS_ONE_PASS, [sessionId, null, NON_STEP]],
  [`seat status, whole session, index on actions (attempt_id, type) (in a rolled-back transaction)`, "WITH_INDEX", [sessionId, null, NON_STEP]],
  ["owner check (every request)", "SELECT a.*, s.status AS session_status FROM attempts a JOIN sessions s ON s.id = a.session_id WHERE a.id = $1", [attemptId]],
  ["last_seen + max(seq) (every action sync)", "SELECT (SELECT max(seq) FROM actions WHERE attempt_id = $1) AS max_seq", [attemptId]],
  ["investigation ordered-at (result fetch)", "SELECT min(case_time_ms) AS t FROM actions WHERE attempt_id = $1 AND type = 'investigation.order' AND ref = $2", [attemptId, "ecg"]],
  ["action log load (resume, finish, debrief)", "SELECT seq, case_time_ms, type, ref, payload, input_source FROM actions WHERE attempt_id = $1 ORDER BY seq", [attemptId]],
  ["case definition load (every investigation fetch, finish)", "SELECT definition, rubric_revision, status FROM case_versions WHERE case_id = $1 AND version = $2", ["chest-pain-stemi", 1]],
];

for (const [name, q, params] of queries) {
  let sql = q;
  if (q === "JIT_OFF") {
    await db.query("SET jit = off");
    sql = SEATS;
  }
  if (q === "WITH_INDEX") {
    await db.query("BEGIN");
    await db.query("CREATE INDEX actions_attempt_type_tmp ON actions (attempt_id, type, seq)");
    await db.query("ANALYZE actions");
    sql = SEATS;
  }
  const plan = (await db.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params)).rows.map((r) => r["QUERY PLAN"]).join("\n");
  const times: number[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const t = performance.now();
    await db.query(sql, params);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(`--- ${name}: median ${times[Math.floor(times.length / 2)]!.toFixed(2)} ms, p95 ${times[Math.floor(times.length * 0.95)]!.toFixed(2)} ms over ${REPEAT} runs (client round trip)`);
  console.log((process.env.PLANS === "0" ? plan.split("\n").filter((l) => /Execution Time|JIT|Timing|Functions/.test(l)).join("\n") : plan) + "\n");
  if (q === "JIT_OFF") await db.query("RESET jit");
  if (q === "WITH_INDEX") await db.query("ROLLBACK");
}
await db.end();
