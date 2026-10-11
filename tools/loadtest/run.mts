/**
 * Load generator: S simulated students working a case at the same time while M instructors
 * watch seat status over the live WebSocket. Run it in a different process (or machine) from
 * the API.
 *
 * Local mode (after `npx tsx tools/loadtest/server.mts`):
 *   npx tsx tools/loadtest/run.mts --students=60 --duration=180
 *
 * Against a deployed server with existing accounts:
 *   BASE_URL=https://sim.example.edu SESSION_IDS=<id1>,<id2> STUDENTS_CSV=students.csv \
 *   INSTRUCTOR_USER=dr.x INSTRUCTOR_PASS=... npx tsx tools/loadtest/run.mts --students=60
 *
 * Every setting is an environment variable or a --flag (--duration=120 is DURATION=120):
 *   STUDENTS (60, up to 240+)        number of simulated students
 *   DURATION (180)                   seconds each student works the case after joining
 *   RAMP (20)                        seconds over which students log in (spread evenly)
 *   INTERVAL_MS (2000)               action sync interval
 *   INSTRUCTORS (2)                  live WebSockets, assigned round-robin to sessions
 *   SPEED (1)                        case clock speed. The whole case script (history, exam, tests,
 *                                    questions, diagnosis, management) is compressed into DURATION, but
 *                                    the case clock runs in real time because the server rejects result
 *                                    fetches whose case time is ahead of the wall clock. SPEED > 1 makes
 *                                    longer turnarounds fall inside the run; it disables result fetches.
 *   DUP_RATE (0.1)                   share of batches that re-send the previous batch (offline retry)
 *   INVESTIGATION_FETCH (1)          fetch investigation results once they are ready (0 = off)
 *   TRACKING_STATS (1)               log a tracking.stats action per case minute, as the client does
 *                                    (0 for servers older than the pilot release, which reject it)
 *   LABEL (local)                    report name
 *   MANIFEST (tools/loadtest/out/setup.json)  local mode: written by server.mts
 *   BASE_URL, SESSION_IDS, STUDENTS_CSV       remote mode (CSV: username,password[,sessionId][,seatLabel])
 *   INSTRUCTOR_USER, INSTRUCTOR_PASS          account for the live sockets (staff of the sessions)
 *   CASE_ID                          case to start (default: first case of the session)
 *   DATABASE_URL                     optional: verify results/action counts in the database too
 *   SERVER_PID                       optional: sample this process's CPU/RSS from /proc (same host only)
 */
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import WebSocket from "ws";

// ---------- configuration ----------
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z0-9-]+)=(.*)$/i.exec(a);
  if (m) process.env[m[1]!.toUpperCase().replace(/-/g, "_")] = m[2];
}
const env = (k: string, d?: string) => process.env[k] ?? d;
const num = (k: string, d: number) => Number(env(k, String(d)));

const manifestPath = env("MANIFEST", new URL("./out/setup.json", import.meta.url).pathname)!;
const remote = !!env("BASE_URL");
const manifest = !remote && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
if (!remote && !manifest) throw new Error(`no BASE_URL and no manifest at ${manifestPath}; start tools/loadtest/server.mts first`);

const cfg = {
  mode: remote ? "remote" : "local",
  baseUrl: (env("BASE_URL") ?? manifest.baseUrl).replace(/\/$/, "") as string,
  sessionIds: (env("SESSION_IDS") ?? env("SESSION_ID") ?? manifest?.sessionIds.join(",") ?? "").split(",").filter(Boolean) as string[],
  studentsCsv: (env("STUDENTS_CSV") ?? manifest?.studentsCsv) as string,
  instructorUser: env("INSTRUCTOR_USER") ?? manifest?.instructor.username,
  instructorPass: env("INSTRUCTOR_PASS") ?? manifest?.instructor.password,
  databaseUrl: env("DATABASE_URL") ?? manifest?.databaseUrl,
  serverPid: Number(env("SERVER_PID") ?? manifest?.serverPid ?? 0) || null,
  students: num("STUDENTS", 60),
  durationS: num("DURATION", 180),
  rampS: num("RAMP", 20),
  intervalMs: num("INTERVAL_MS", 2000),
  instructors: num("INSTRUCTORS", 2),
  speed: num("SPEED", 1),
  dupRate: num("DUP_RATE", 0.1),
  investigationFetch: num("INVESTIGATION_FETCH", 1) === 1 && num("SPEED", 1) <= 1,
  trackingStats: num("TRACKING_STATS", 1) === 1,
  caseId: env("CASE_ID"),
  label: env("LABEL", remote ? "remote" : "local")!,
};
if (!cfg.sessionIds.length) throw new Error("no session ids (SESSION_IDS)");
if (!cfg.studentsCsv) throw new Error("no STUDENTS_CSV");

interface Cred {
  username: string;
  password: string;
  sessionId?: string;
  seatLabel?: string;
}
const creds: Cred[] = readFileSync(cfg.studentsCsv, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !/^username\s*,/i.test(l))
  .map((l) => {
    const [username, password, sessionId, seatLabel] = l.split(",").map((s) => s.trim());
    return { username: username!, password: password!, ...(sessionId ? { sessionId } : {}), ...(seatLabel ? { seatLabel } : {}) };
  });
if (creds.length < cfg.students) throw new Error(`STUDENTS=${cfg.students} but the CSV has only ${creds.length} accounts`);

// ---------- metrics ----------
const lat = new Map<string, number[]>();
const statuses = new Map<string, Map<string, number>>();
const timeline: { t: number; ep: string; ms: number; status: string }[] = [];
let t0 = performance.now();
let verifying = false;
const record = (ep: string, ms: number, status: string) => {
  if (verifying) {
    // Verification requests after the load phase are kept out of the latency figures.
    const m = verifyStatuses[ep] ?? (verifyStatuses[ep] = {});
    m[status] = (m[status] ?? 0) + 1;
    return;
  }
  if (!lat.has(ep)) lat.set(ep, []);
  lat.get(ep)!.push(ms);
  if (!statuses.has(ep)) statuses.set(ep, new Map());
  const s = statuses.get(ep)!;
  s.set(status, (s.get(status) ?? 0) + 1);
  timeline.push({ t: performance.now() - t0, ep, ms, status });
};
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};
const r1 = (x: number) => Math.round(x * 10) / 10;
const stats = (xs: number[]) => ({ count: xs.length, p50: r1(pct(xs, 50)), p95: r1(pct(xs, 95)), p99: r1(pct(xs, 99)), max: r1(xs.length ? Math.max(...xs) : NaN), mean: r1(xs.reduce((a, b) => a + b, 0) / (xs.length || 1)) });

const verifyStatuses: Record<string, Record<string, number>> = {};

class HttpFail extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

async function api<T = any>(ep: string, method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const start = performance.now();
  let res: Response;
  try {
    res = await fetch(cfg.baseUrl + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    record(ep, performance.now() - start, "ERR");
    throw e;
  }
  const text = await res.text();
  record(ep, performance.now() - start, String(res.status));
  if (!res.ok) throw new HttpFail(res.status, text);
  return text ? JSON.parse(text) : (undefined as T);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// ---------- resource sampling (server process, postgres, whole host) ----------
const CLK_TCK = (() => {
  try {
    return Number(execSync("getconf CLK_TCK").toString().trim()) || 100;
  } catch {
    return 100;
  }
})();
const procTicks = (pid: number | string) => {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, "utf8");
    const parts = f.slice(f.lastIndexOf(")") + 2).split(" ");
    return Number(parts[11]) + Number(parts[12]);
  } catch {
    return null;
  }
};
const procRssMb = (pid: number) => {
  try {
    const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) / 1024 : null;
  } catch {
    return null;
  }
};
/** Ticks per postgres process; CPU is summed per pid so backends that exit between samples do not skew it. */
const postgresTicks = () => {
  const t = new Map<string, number>();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (readFileSync(`/proc/${d}/comm`, "utf8").trim() !== "postgres") continue;
    } catch {
      continue;
    }
    const v = procTicks(d);
    if (v !== null) t.set(d, v);
  }
  return t;
};
const pgDelta = (a: Map<string, number>, b: Map<string, number>) => {
  let d = 0;
  for (const [pid, v] of b) d += v - (a.get(pid) ?? 0);
  return d;
};
const hostTicks = () => {
  const [, ...f] = readFileSync("/proc/stat", "utf8").split("\n")[0]!.trim().split(/\s+/);
  const n = f.map(Number);
  const idle = n[3]! + n[4]!;
  return { total: n.reduce((a, b) => a + b, 0), idle };
};
const samples: { t: number; serverCpuPct: number | null; serverRssMb: number | null; pgCpuPct: number; hostCpuPct: number }[] = [];
const canProc = existsSync("/proc/stat");
let sampler: NodeJS.Timeout | undefined;
function startSampler() {
  if (!canProc) return;
  let last = { at: performance.now(), srv: cfg.serverPid ? procTicks(cfg.serverPid) : null, pg: postgresTicks(), host: hostTicks() };
  sampler = setInterval(() => {
    const now = { at: performance.now(), srv: cfg.serverPid ? procTicks(cfg.serverPid) : null, pg: postgresTicks(), host: hostTicks() };
    const dt = (now.at - last.at) / 1000;
    const dh = now.host.total - last.host.total;
    samples.push({
      t: r1((now.at - t0) / 1000),
      serverCpuPct: now.srv !== null && last.srv !== null ? r1(((now.srv - last.srv) / CLK_TCK / dt) * 100) : null,
      serverRssMb: cfg.serverPid ? procRssMb(cfg.serverPid) : null,
      pgCpuPct: r1((pgDelta(last.pg, now.pg) / CLK_TCK / dt) * 100),
      hostCpuPct: dh ? r1((1 - (now.host.idle - last.host.idle) / dh) * 100) : 0,
    });
    last = now;
  }, 1000);
}
const loopDelay = monitorEventLoopDelay({ resolution: 10 });

// ---------- live sockets (instructors) ----------
interface Pending {
  attemptId: string;
  maxCt: number;
  sentAt: number;
  respAt?: number;
  seenAt?: number;
}
interface Watcher {
  idx: number;
  sessionId: string;
  ws?: WebSocket;
  seatMsgs: number;
  otherMsgs: number;
  disconnects: number;
  pending: Map<string, Pending[]>;
  resolved: Pending[];
  closing: boolean;
}
const watchers: Watcher[] = [];
const wsLagSend: number[] = [];
const wsLagResp: number[] = [];

function openWatcher(w: Watcher, token: string): Promise<void> {
  return new Promise((resolve) => {
    const url = cfg.baseUrl.replace(/^http/, "ws") + `/api/live?session=${encodeURIComponent(w.sessionId)}&token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    w.ws = ws;
    ws.on("open", () => resolve());
    ws.on("message", (data) => {
      const at = performance.now();
      let m: any;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m.type !== "seat") {
        w.otherMsgs++;
        return;
      }
      w.seatMsgs++;
      const list = w.pending.get(m.seat.attemptId);
      if (!list) return;
      while (list.length && list[0]!.maxCt <= Number(m.seat.elapsedMs)) {
        const p = list.shift()!;
        p.seenAt = at;
        w.resolved.push(p);
      }
    });
    ws.on("close", (code) => {
      if (w.closing) return;
      w.disconnects++;
      console.warn(`instructor socket ${w.idx} closed (${code}); reconnecting`);
      setTimeout(() => openWatcher(w, token), 1000);
    });
    ws.on("error", (e) => {
      console.warn(`instructor socket ${w.idx} error: ${(e as Error).message}`);
      resolve();
    });
  });
}

// ---------- simulated student ----------
interface StudentResult {
  username: string;
  sessionId?: string;
  attemptId?: string;
  ok: boolean;
  stage: string;
  error?: string;
  baselineActions: number;
  uniqueAcked: number;
  sentUnique: number;
  dupSent: number;
  dupReported: number;
  batches: number;
  investigations: number;
  finished: boolean;
}

let labsCache: Promise<any[]> | null = null;
const seatCounters = new Map<string, number>();

// Actions that do not move the seat's step/elapsed time on the instructor view (apps/api/src/seats.ts).
const NON_STEP = new Set(["tracking.lost", "tracking.recalibrate", "tracking.stats", "input.switch"]);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!;

async function student(i: number, cred: Cred, startAt: number): Promise<StudentResult> {
  const r: StudentResult = { username: cred.username, ok: false, stage: "login", baselineActions: 0, uniqueAcked: 0, sentUnique: 0, dupSent: 0, dupReported: 0, batches: 0, investigations: 0, finished: false };
  await sleep(startAt - performance.now());
  try {
    const { token } = await api("POST /api/auth/login", "POST", "/api/auth/login", undefined, { username: cred.username, password: cred.password });
    r.stage = "sessions";
    const mine: any[] = await api("GET /api/my/sessions", "GET", "/api/my/sessions", token);
    const sessionId = cred.sessionId ?? cfg.sessionIds[i % cfg.sessionIds.length]!;
    r.sessionId = sessionId;
    const sess = mine.find((s) => s.id === sessionId);
    if (!sess) throw new Error(`session ${sessionId} not visible to ${cred.username} (not enrolled, closed or outside its time window)`);
    const caseId = cfg.caseId ?? sess.cases[0].caseId;

    // Seat: the CSV's seat label, else the next free seat of the session's lab (wrapping round).
    r.stage = "labs";
    labsCache ??= api("GET /api/labs", "GET", "/api/labs", token);
    const lab = (await labsCache).find((l) => l.id === sess.labId);
    let seatId: string | undefined;
    if (lab?.seats.length) {
      const n = seatCounters.get(sessionId) ?? 0;
      seatCounters.set(sessionId, n + 1);
      seatId = (cred.seatLabel ? lab.seats.find((s: any) => s.label === cred.seatLabel) : lab.seats[n % lab.seats.length])?.id;
    }

    r.stage = "join";
    const joined = await api("POST /api/sessions/:id/attempts", "POST", `/api/sessions/${sessionId}/attempts`, token, { caseId, ...(seatId ? { seatId } : {}) });
    const attemptId: string = joined.attempt.id;
    r.attemptId = attemptId;
    const c = joined.case;
    // A resumed attempt keeps its stored log: continue after it.
    r.baselineActions = joined.actions.length;
    let seq = joined.actions.length ? Math.max(...joined.actions.map((a: any) => a.seq)) + 1 : 0;
    const ctBase = joined.actions.length ? Math.max(...joined.actions.map((a: any) => a.caseTimeMs)) : 0;

    // ---- the case: its steps compressed into DURATION seconds; the case clock runs at SPEED ----
    r.stage = "case";
    const myWatchers = watchers.filter((w) => w.sessionId === sessionId);
    for (const w of myWatchers) w.pending.set(attemptId, []);
    const joinedAt = performance.now();
    const endAt = joinedAt + cfg.durationS * 1000;
    const speed = cfg.speed;
    const caseTime = () => Math.round(ctBase + (performance.now() - joinedAt) * speed);

    const history = c.history.map((h: any) => h.id) as string[];
    const exams = c.examination.map((h: any) => h.id) as string[];
    // Shortest turnaround first, so as many results as possible come back within the run.
    const tests = ([...c.investigations] as { id: string; turnaroundMin: number }[]).sort((a, b) => a.turnaroundMin - b.turnaroundMin);
    const mgmt = c.management.actions.map((m: any) => m.id) as string[];
    const questions = [...c.questions] as { id: string; type: string; options: { id: string }[] }[];
    const dxOptions = c.diagnosis.options.map((o: any) => o.id) as string[];
    const ordered = new Map<string, number>(); // test id -> case time ordered
    const fetched = new Set<string>();
    let started = !!joined.actions.length;
    let diagnosed = false;
    let hand = Math.random() < 0.8;
    let lastStats = ctBase;

    const nextAction = (ct: number) => {
      const p = (performance.now() - joinedAt) / (endAt - joinedAt);
      let type: string;
      let ref: string | undefined;
      let payload: Record<string, unknown> | undefined;
      const roll = Math.random();
      if (!started) {
        started = true;
        type = "case.start";
      } else if (cfg.trackingStats && ct - lastStats >= 60_000) {
        // The client logs hand-tracking health once a minute (apps/sim/src/screens/player.ts).
        lastStats = ct;
        type = "tracking.stats";
        payload = { frames: 1800, lostFrames: Math.floor(Math.random() * 60), fps: 28 + Math.floor(Math.random() * 4), renderFps: 55 };
      } else if (roll < 0.02) {
        type = "tracking.lost";
      } else if (roll < 0.03) {
        type = "tracking.recalibrate";
      } else if (roll < 0.035) {
        hand = !hand;
        type = "input.switch";
        payload = { to: hand ? "hand" : "mouse" };
      } else if (roll < 0.12) {
        type = "view.change";
        ref = pick(["history", "examination", "investigations", "management", "case"]);
      } else if (p < 0.2) {
        type = "history.ask";
        ref = pick(history);
      } else if (p < 0.35) {
        type = "exam.perform";
        ref = pick(exams);
      } else if (p < 0.5 && ordered.size < tests.length) {
        type = "investigation.order";
        ref = tests.find((t) => !ordered.has(t.id))!.id;
        ordered.set(ref, ct);
      } else if (p < 0.75 && questions.length) {
        const q = questions.shift()!;
        type = "question.answer";
        ref = q.id;
        payload = { selected: q.type === "multi" ? q.options.slice(0, 2).map((o) => o.id) : [pick(q.options).id] };
      } else if (p < 0.85) {
        type = "management.give";
        ref = pick(mgmt);
      } else if (!diagnosed) {
        diagnosed = true;
        type = "diagnosis.submit";
        payload = { main: dxOptions[0], differentials: dxOptions.slice(1, 3) };
      } else {
        type = pick(["history.ask", "exam.perform", "view.change"]);
        ref = type === "history.ask" ? pick(history) : type === "exam.perform" ? pick(exams) : "case";
      }
      return {
        id: randomUUID(),
        seq: seq++,
        caseTimeMs: ct,
        clientTs: new Date().toISOString(),
        type,
        ...(ref !== undefined ? { ref } : {}),
        ...(payload ? { payload } : {}),
        inputSource: type === "case.start" || type === "tracking.stats" ? "system" : hand ? "hand" : "mouse",
      };
    };

    let unacked: any[] = []; // like the client's offline buffer: re-sent until the server acknowledges
    let prevBatch: any[] = [];
    const sendBatch = async (fresh: any[]) => {
      let batch = [...unacked, ...fresh];
      const retryCopy = Math.random() < cfg.dupRate && prevBatch.length;
      if (retryCopy) {
        // The previous batch's response was "lost": the client sends it again with the new actions.
        batch = [...prevBatch, ...batch];
      }
      const dupThis = retryCopy ? prevBatch.length : 0;
      if (!batch.length) return;
      const step = batch.filter((a) => !NON_STEP.has(a.type) && !prevBatch.includes(a));
      const maxCt = step.length ? Math.max(...step.map((a) => a.caseTimeMs)) : null;
      const entries: Pending[] = [];
      const sentAt = performance.now();
      if (maxCt !== null)
        for (const w of myWatchers) {
          const e: Pending = { attemptId, maxCt, sentAt };
          w.pending.get(attemptId)!.push(e);
          entries.push(e);
        }
      r.batches++;
      try {
        const res = await api("POST /api/attempts/:id/actions", "POST", `/api/attempts/${attemptId}/actions`, token, { actions: batch });
        const respAt = performance.now();
        for (const e of entries) e.respAt = respAt;
        r.uniqueAcked += res.accepted;
        r.dupReported += res.duplicates;
        r.dupSent += dupThis;
        prevBatch = batch.filter((a) => !prevBatch.includes(a));
        unacked = [];
      } catch (e) {
        // Keep the actions and retry on the next tick, as the client does.
        unacked = batch.filter((a) => !prevBatch.includes(a));
        for (const w of myWatchers) {
          const list = w.pending.get(attemptId)!;
          for (const x of entries) list.splice(list.indexOf(x), 1);
        }
        if (e instanceof HttpFail && e.status < 500 && e.status !== 429) throw e;
      }
    };

    // First tick is offset randomly so 60 clients do not fire in lock-step.
    let tick = performance.now() + Math.random() * cfg.intervalMs;
    while (tick < endAt) {
      await sleep(tick - performance.now());
      const n = 1 + Math.floor(Math.random() * 4);
      const base = caseTime();
      const fresh = Array.from({ length: n }, (_, k) => nextAction(base + k * Math.round((cfg.intervalMs * speed) / n)));
      r.sentUnique += fresh.length;
      await sendBatch(fresh);

      // Fetch at most one investigation result per tick once its turnaround has passed.
      if (cfg.investigationFetch) {
        const ct = caseTime();
        const ready = tests.find((t) => ordered.has(t.id) && !fetched.has(t.id) && ct >= ordered.get(t.id)! + Math.round(t.turnaroundMin * 60_000));
        if (ready && !unacked.length) {
          fetched.add(ready.id);
          await api("GET /api/attempts/:id/investigations/:testId", "GET", `/api/attempts/${attemptId}/investigations/${ready.id}?at=${ct}`, token).catch((e) => {
            if (e instanceof HttpFail && e.status >= 500) return;
            throw e;
          });
          r.investigations++;
        }
      }
      tick += cfg.intervalMs;
    }
    // case.end, flush anything unacknowledged, then finish.
    const endAction = { id: randomUUID(), seq: seq++, caseTimeMs: caseTime(), clientTs: new Date().toISOString(), type: "case.end", inputSource: "system" };
    r.sentUnique++;
    prevBatch = [];
    for (let k = 0; k < 5; k++) {
      await sendBatch(k === 0 ? [endAction] : []);
      if (!unacked.length) break;
      await sleep(1000);
    }
    if (unacked.length) throw new Error(`${unacked.length} actions never acknowledged`);
    r.stage = "finish";
    await api("POST /api/attempts/:id/finish", "POST", `/api/attempts/${attemptId}/finish`, token);
    r.finished = true;
    r.ok = true;
    r.stage = "done";
    (r as any).token = token;
  } catch (e) {
    r.error = (e as Error).message;
    console.warn(`${cred.username} failed at ${r.stage}: ${r.error}`);
  }
  return r;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const k = next++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

// ---------- run ----------
console.log(`load test "${cfg.label}": ${cfg.students} students, ${cfg.durationS}s each (ramp ${cfg.rampS}s), ${cfg.instructors} instructor sockets, ${cfg.sessionIds.length} session(s), ${cfg.baseUrl}`);
await api("GET /api/health", "GET", "/api/health");

let instructorToken: string | null = null;
if (cfg.instructors > 0 && cfg.instructorUser) {
  instructorToken = (await api("POST /api/auth/login (instructor)", "POST", "/api/auth/login", undefined, { username: cfg.instructorUser, password: cfg.instructorPass })).token;
  for (let k = 0; k < cfg.instructors; k++) {
    const w: Watcher = { idx: k, sessionId: cfg.sessionIds[k % cfg.sessionIds.length]!, seatMsgs: 0, otherMsgs: 0, disconnects: 0, pending: new Map(), resolved: [], closing: false };
    watchers.push(w);
    await openWatcher(w, instructorToken!);
  }
}

t0 = performance.now();
timeline.length = 0;
const cpu0 = process.cpuUsage();
loopDelay.enable();
startSampler();
const startWall = new Date();
const results = await Promise.all(creds.slice(0, cfg.students).map((c, i) => student(i, c, t0 + (cfg.rampS * 1000 * i) / cfg.students)));
const loadMs = performance.now() - t0;
loopDelay.disable();
if (sampler) clearInterval(sampler);
const genCpu = process.cpuUsage(cpu0);

// Let late seat messages arrive, then close the sockets.
await sleep(1500);
for (const w of watchers) {
  w.closing = true;
  w.ws?.close();
}
for (const w of watchers)
  for (const p of w.resolved) {
    wsLagSend.push(p.seenAt! - p.sentAt);
    if (p.respAt !== undefined) wsLagResp.push(p.seenAt! - p.respAt);
  }
const unseen = watchers.reduce((n, w) => n + [...w.pending.values()].reduce((m, l) => m + l.length, 0), 0);

// ---------- verification (not counted in load latencies) ----------
console.log("verifying stored results and action logs ...");
verifying = true;
const finishedOk = results.filter((r) => r.attemptId);
const apiCheck = await pool(finishedOk, 8, async (r) => {
  const token = (r as any).token as string | undefined;
  if (!token) return { attemptId: r.attemptId!, actions: null, scored: false };
  try {
    const a = await api("verify GET /api/attempts/:id", "GET", `/api/attempts/${r.attemptId}`, token);
    const res = await api("verify GET /api/attempts/:id/result", "GET", `/api/attempts/${r.attemptId}/result`, token).then(
      () => true,
      () => false,
    );
    return { attemptId: r.attemptId!, actions: a.actions.length as number, scored: res };
  } catch {
    return { attemptId: r.attemptId!, actions: null, scored: false };
  }
});
let dbCheck: { attempts: number; finished: number; results: number; perAttempt: Map<string, number> } | null = null;
if (cfg.databaseUrl) {
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  const { rows } = await client.query(
    `SELECT a.id, a.status, (SELECT count(*)::int FROM actions x WHERE x.attempt_id = a.id) AS n, (r.attempt_id IS NOT NULL) AS scored
     FROM attempts a LEFT JOIN results r ON r.attempt_id = a.id
     WHERE a.session_id = ANY($1::uuid[]) AND a.id = ANY($2::uuid[])`,
    [cfg.sessionIds, finishedOk.map((r) => r.attemptId)],
  );
  dbCheck = { attempts: rows.length, finished: rows.filter((x) => x.status === "finished").length, results: rows.filter((x) => x.scored).length, perAttempt: new Map(rows.map((x) => [x.id, x.n])) };
  await client.end();
}

// ---------- report ----------
const endpoints = [...lat.keys()].sort();
const loadS = loadMs / 1000;
const table = endpoints.map((ep) => {
  const s = stats(lat.get(ep)!);
  const st = Object.fromEntries(statuses.get(ep)!);
  const errors = Object.entries(st).filter(([k]) => !/^2/.test(k));
  return { endpoint: ep, ...s, rps: r1(s.count / loadS), statuses: st, errors: Object.fromEntries(errors) };
});
const all5xx = [...statuses.values(), ...Object.values(verifyStatuses).map((o) => new Map(Object.entries(o)))].reduce(
  (n, m) => n + [...m.entries()].filter(([k]) => /^5/.test(k)).reduce((a, [, v]) => a + v, 0),
  0,
);
const netErr = [...statuses.values()].reduce((n, m) => n + (m.get("ERR") ?? 0), 0);
const actionsLat = lat.get("POST /api/attempts/:id/actions") ?? [];

const lost: { attemptId: string; username: string; expected: number; api: number | null; db: number | null }[] = [];
for (const r of finishedOk) {
  const expected = r.baselineActions + r.sentUnique;
  const a = apiCheck.find((x) => x.attemptId === r.attemptId)?.actions ?? null;
  const d = dbCheck ? (dbCheck.perAttempt.get(r.attemptId!) ?? 0) : null;
  if (a !== expected || (d !== null && d !== expected)) lost.push({ attemptId: r.attemptId!, username: r.username, expected, api: a, db: d });
}
const scoredApi = apiCheck.filter((x) => x.scored).length;
const studentsOk = results.filter((r) => r.ok).length;
const dupSent = results.reduce((n, r) => n + r.dupSent, 0);
const dupReported = results.reduce((n, r) => n + r.dupReported, 0);
const actionsSent = results.reduce((n, r) => n + r.sentUnique, 0);

const sAvg = (k: "serverCpuPct" | "pgCpuPct" | "hostCpuPct" | "serverRssMb") => {
  const xs = samples.map((s) => s[k]).filter((x): x is number => x !== null);
  return xs.length ? { avg: r1(xs.reduce((a, b) => a + b, 0) / xs.length), p95: r1(pct(xs, 95)), max: r1(Math.max(...xs)) } : null;
};
const resources = {
  note: "CPU % is of one core (100% = one core busy); host % is of all cores",
  serverCpuPct: sAvg("serverCpuPct"),
  serverRssMb: cfg.serverPid ? { start: samples[0]?.serverRssMb ?? null, ...sAvg("serverRssMb") } : null,
  postgresCpuPct: canProc ? sAvg("pgCpuPct") : null,
  hostCpuPct: canProc ? sAvg("hostCpuPct") : null,
  generatorCpuPct: r1(((genCpu.user + genCpu.system) / 1000 / loadMs) * 100),
  generatorEventLoopDelayMs: { p50: r1(loopDelay.percentile(50) / 1e6), p99: r1(loopDelay.percentile(99) / 1e6), max: r1(loopDelay.max / 1e6) },
};

// Per 10 s: action-sync throughput and p95, to see whether latency drifts as logs grow.
const buckets: { t: number; requests: number; actionsP95: number | null }[] = [];
for (let b = 0; b * 10_000 < loadMs; b++) {
  const inB = timeline.filter((x) => x.t >= b * 10_000 && x.t < (b + 1) * 10_000);
  const act = inB.filter((x) => x.ep === "POST /api/attempts/:id/actions").map((x) => x.ms);
  buckets.push({ t: b * 10, requests: inB.length, actionsP95: act.length ? r1(pct(act, 95)) : null });
}

const lagSend = stats(wsLagSend);
const checks = [
  { name: "zero 5xx responses", pass: all5xx === 0, value: `${all5xx} (network errors: ${netErr})` },
  { name: "action sync p95 < 300 ms", pass: actionsLat.length > 0 && pct(actionsLat, 95) < 300, value: `${r1(pct(actionsLat, 95))} ms` },
  { name: "action sync p99 < 1000 ms", pass: actionsLat.length > 0 && pct(actionsLat, 99) < 1000, value: `${r1(pct(actionsLat, 99))} ms` },
  ...(watchers.length
    ? [{ name: "seat update lag p95 < 2000 ms", pass: wsLagSend.length > 0 && lagSend.p95 < 2000, value: `${lagSend.p95} ms (${wsLagSend.length} updates, ${unseen} never seen)` }]
    : []),
  { name: "all students completed the case", pass: studentsOk === cfg.students, value: `${studentsOk}/${cfg.students}` },
  {
    name: "all attempts finished and scored",
    pass: finishedOk.length === cfg.students && scoredApi === finishedOk.length && (!dbCheck || (dbCheck.results === dbCheck.attempts && dbCheck.finished === dbCheck.attempts && dbCheck.attempts === finishedOk.length)),
    value: dbCheck ? `db: ${dbCheck.attempts} attempts, ${dbCheck.finished} finished, ${dbCheck.results} results; api: ${scoredApi} results` : `api: ${scoredApi}/${finishedOk.length} results`,
  },
  { name: "no lost actions", pass: lost.length === 0, value: `${actionsSent} unique actions sent, ${lost.length} attempts with mismatched counts${dbCheck ? " (checked via API and DB)" : " (checked via API)"}` },
  { name: "duplicates detected = duplicates re-sent", pass: dupSent === dupReported, value: `${dupReported}/${dupSent}` },
];

const report = {
  label: cfg.label,
  startedAt: startWall.toISOString(),
  config: { ...cfg, instructorPass: undefined },
  host: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, nproc: (() => { try { return Number(execSync("nproc").toString()); } catch { return null; } })(), memGb: r1(os.totalmem() / 2 ** 30), node: process.version, platform: `${os.type()} ${os.release()}` },
  serverCode: manifest?.code ?? null,
  durationS: r1(loadS),
  throughput: { requestsPerS: r1(timeline.length / loadS), actionsPerS: r1(actionsSent / loadS), batches: results.reduce((n, r) => n + r.batches, 0), investigationFetches: results.reduce((n, r) => n + r.investigations, 0) },
  endpoints: table,
  verifyStatuses,
  websocket: {
    sockets: watchers.map((w) => ({ sessionId: w.sessionId, seatMessages: w.seatMsgs, otherMessages: w.otherMsgs, disconnects: w.disconnects })),
    lagFromSendMs: lagSend,
    lagFromResponseMs: stats(wsLagResp),
    neverSeen: unseen,
  },
  resources,
  timeseries: buckets,
  samples,
  checks,
  lost: lost.slice(0, 50),
  failures: results.filter((r) => !r.ok).map((r) => ({ username: r.username, stage: r.stage, error: r.error })),
  overall: checks.every((c) => c.pass) ? "PASS" : "FAIL",
};
const outDir = new URL("./out/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const outFile = env("OUT", new URL(`report-${cfg.label}-${startWall.toISOString().replace(/[:.]/g, "-")}.json`, outDir).pathname)!;
writeFileSync(outFile, JSON.stringify(report, null, 2));

// ---------- readable summary ----------
const pad = (s: unknown, n: number, right = false) => (right ? String(s).padStart(n) : String(s).padEnd(n));
console.log(`\n=== ${cfg.label}: ${cfg.students} students x ${cfg.durationS}s, ${r1(loadS)}s wall, host ${report.host.nproc} CPU(s) ===`);
console.log(pad("endpoint", 46) + pad("count", 7, true) + pad("rps", 7, true) + pad("p50", 8, true) + pad("p95", 8, true) + pad("p99", 8, true) + pad("max", 8, true) + "  errors");
for (const r of table)
  console.log(
    pad(r.endpoint, 46) + pad(r.count, 7, true) + pad(r.rps, 7, true) + pad(r.p50, 8, true) + pad(r.p95, 8, true) + pad(r.p99, 8, true) + pad(r.max, 8, true) + "  " + (Object.keys(r.errors).length ? JSON.stringify(r.errors) : "-"),
  );
console.log(`throughput: ${report.throughput.requestsPerS} req/s, ${report.throughput.actionsPerS} actions/s`);
console.log(
  `websocket: ${watchers.map((w) => w.seatMsgs).join(" + ")} seat messages; lag from POST sent p50 ${lagSend.p50} / p95 ${lagSend.p95} / p99 ${lagSend.p99} / max ${lagSend.max} ms; from response p95 ${report.websocket.lagFromResponseMs.p95} ms`,
);
const fmt = (x: any) => (x ? `avg ${x.avg} / p95 ${x.p95} / max ${x.max}` : "n/a");
console.log(`server CPU % (1 core = 100): ${fmt(resources.serverCpuPct)}; RSS MB: ${resources.serverRssMb ? `start ${r1(resources.serverRssMb.start ?? 0)} / max ${resources.serverRssMb.max}` : "n/a"}`);
console.log(`postgres CPU %: ${fmt(resources.postgresCpuPct)}; host CPU % (all cores): ${fmt(resources.hostCpuPct)}; generator CPU ${resources.generatorCpuPct}%, event-loop delay p99 ${resources.generatorEventLoopDelayMs.p99} ms`);
console.log("");
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${pad(c.name, 42)} ${c.value}`);
console.log(`\noverall: ${report.overall}   report: ${outFile}`);
process.exit(report.overall === "PASS" ? 0 : 1);
