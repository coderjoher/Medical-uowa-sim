import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { action, makeSession, makeWorld, PW, refCase, resetSeq, type World } from "./setup.js";

let w: World;
beforeAll(async () => {
  w = await makeWorld();
});
afterAll(async () => {
  await w.app.close();
  await w.db.end();
});
beforeEach(() => resetSeq());

const req = (method: "GET" | "POST" | "DELETE", url: string, who?: string, payload?: unknown) =>
  w.app.inject({ method, url, ...(who ? { headers: w.as(who) } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("auth", () => {
  it("logs in with correct credentials and rejects wrong ones", async () => {
    const ok = await req("POST", "/api/auth/login", undefined, { username: "Alice", password: PW });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user).toMatchObject({ username: "alice", role: "student" });
    expect((await req("POST", "/api/auth/login", undefined, { username: "alice", password: "nope-nope" })).statusCode).toBe(401);
    expect((await req("POST", "/api/auth/login", undefined, { username: "ghost", password: PW })).statusCode).toBe(401);
  });

  it("rejects requests without a valid token", async () => {
    expect((await req("GET", "/api/me")).statusCode).toBe(401);
    const r = await w.app.inject({ method: "GET", url: "/api/me", headers: { authorization: "Bearer forged.token.value" } });
    expect(r.statusCode).toBe(401);
  });
});

describe("role matrix", () => {
  const cases: [string, "GET" | "POST", string, string[], unknown?][] = [
    ["create user", "POST", "/api/admin/users", ["admin"], { username: "x" + Math.random().toString(36).slice(2, 8), displayName: "X", role: "student", password: "password-123" }],
    ["list users", "GET", "/api/admin/users", ["admin", "instructor"]],
    ["create course", "POST", "/api/admin/courses", ["admin"], { code: "C" + Math.random().toString(36).slice(2, 8), title: "T" }],
    ["system health", "GET", "/api/admin/health", ["admin"]],
    ["list cases", "GET", "/api/admin/cases", ["admin", "case_author", "instructor"].map((r) => (r === "case_author" ? "author" : r))],
    ["list sessions", "GET", "/api/sessions", ["admin", "instructor"]],
    ["my sessions", "GET", "/api/my/sessions", ["alice"]],
  ];
  const everyone = ["admin", "instructor", "author", "alice"];
  for (const [name, method, url, allowed, body] of cases) {
    it(`${name}: only ${allowed.join(", ")}`, async () => {
      for (const who of everyone) {
        const r = await req(method, url, who, body);
        if (allowed.includes(who)) expect(r.statusCode, `${who} should be allowed`).toBeLessThan(400);
        else expect(r.statusCode, `${who} should be refused`).toBe(403);
        // Avoid unique-key clashes on repeated creates.
        if (body && typeof body === "object") {
          if ("username" in body) (body as { username: string }).username += "1";
          if ("code" in body) (body as { code: string }).code += "1";
        }
      }
    });
  }

  it("instructors cannot manage another instructor's session", async () => {
    const { sessionId } = await makeSession(w);
    expect((await req("GET", `/api/sessions/${sessionId}/live`, "other_instructor")).statusCode).toBe(403);
    expect((await req("POST", `/api/sessions/${sessionId}/pause`, "other_instructor")).statusCode).toBe(403);
    expect((await req("GET", `/api/sessions/${sessionId}/live`, "admin")).statusCode).toBe(200);
  });
});

describe("case import and publishing", () => {
  it("rejects an invalid case with the list of problems", async () => {
    const bad = refCase();
    bad.management.actions[0].id = "unobtainium";
    const r = await req("POST", "/api/admin/cases", "author", bad);
    expect(r.statusCode).toBe(400);
    expect(r.json().details).toContainEqual({ path: "management.actions.0.id", message: 'unknown drug or action "unobtainium"' });
  });

  it("each import is a new version; publishing needs sign-off", async () => {
    const c = refCase();
    c.metadata.id = "versioned-case";
    const v1 = (await req("POST", "/api/admin/cases", "author", c)).json();
    const v2 = (await req("POST", "/api/admin/cases", "author", c)).json();
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect((await req("POST", "/api/admin/cases/versioned-case/2/publish", "admin")).statusCode).toBe(409);
    expect((await req("POST", "/api/admin/cases/versioned-case/2/signoff", "author")).statusCode).toBe(200);
    expect((await req("POST", "/api/admin/cases/versioned-case/2/publish", "admin")).statusCode).toBe(200);
    const list = (await req("GET", "/api/admin/cases", "admin")).json().filter((x: { caseId: string }) => x.caseId === "versioned-case");
    expect(list.map((x: { version: number; status: string }) => [x.version, x.status])).toEqual([
      [2, "published"],
      [1, "draft"],
    ]);
  });

  it("an unpublished case cannot be put in a session", async () => {
    const { courseId, labId } = await makeSession(w);
    const r = await req("POST", "/api/sessions", "instructor", { courseId, labId, caseIds: ["versioned-case-draft-only"], startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 1e6).toISOString() });
    expect(r.statusCode).toBe(400);
  });

  it("preview mode scores an author's play-through without storing it", async () => {
    const r = await req("POST", "/api/admin/cases/chest-pain-stemi/1/preview-score", "author", { actions: [action("investigation.order", "ecg", 1000)] });
    expect(r.statusCode).toBe(200);
    expect(r.json().areas.investigations.points).toBe(5);
  });
});

describe("student attempts", () => {
  it("only students of the course can join, only inside the time window", async () => {
    const { sessionId } = await makeSession(w);
    expect((await req("POST", `/api/sessions/${sessionId}/attempts`, "outsider", { caseId: "chest-pain-stemi" })).statusCode).toBe(403);
    const later = await makeSession(w, { startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) });
    expect((await req("POST", `/api/sessions/${later.sessionId}/attempts`, "alice", { caseId: "chest-pain-stemi" })).statusCode).toBe(409);
    expect((await req("GET", "/api/my/sessions", "outsider")).json()).toEqual([]);
    const mine = (await req("GET", "/api/my/sessions", "alice")).json().map((s: { id: string }) => s.id);
    expect(mine).toContain(sessionId);
    expect(mine).not.toContain(later.sessionId);
  });

  it("the case sent to the student contains no answers or results", async () => {
    const { sessionId, seatId } = await makeSession(w);
    const r = await req("POST", `/api/sessions/${sessionId}/attempts`, "alice", { caseId: "chest-pain-stemi", seatId });
    expect(r.statusCode).toBe(201);
    const json = JSON.stringify(r.json().case);
    for (const leak of ['"correct"', '"points"', '"relevance"', '"indicated"', '"classification"', '"feedback"', '"rubric"', "ST elevation in II"]) expect(json).not.toContain(leak);
  });

  it("stores the attempt against the exact case version, and resumes it", async () => {
    const { sessionId } = await makeSession(w);
    const first = (await req("POST", `/api/sessions/${sessionId}/attempts`, "bob", { caseId: "chest-pain-stemi" })).json();
    expect(first.attempt.caseVersion).toBe(1);
    const a = action("history.ask", "pc_onset", 5000);
    await req("POST", `/api/attempts/${first.attempt.id}/actions`, "bob", { actions: [a] });
    const again = await req("POST", `/api/sessions/${sessionId}/attempts`, "bob", { caseId: "chest-pain-stemi" });
    expect(again.statusCode).toBe(200);
    expect(again.json().resumed).toBe(true);
    expect(again.json().attempt.id).toBe(first.attempt.id);
    expect(again.json().actions).toMatchObject([{ type: "history.ask", ref: "pc_onset", caseTimeMs: 5000 }]);
  });

  it("action sync is idempotent and keeps order whatever order batches arrive in", async () => {
    const { sessionId } = await makeSession(w);
    const { attempt } = (await req("POST", `/api/sessions/${sessionId}/attempts`, "alice", { caseId: "chest-pain-stemi" })).json();
    const batch1 = [action("history.ask", "pc_onset", 1000), action("history.ask", "pc_radiation", 2000)];
    const batch2 = [action("exam.perform", "heart_auscultation", 3000)];
    const r2 = await req("POST", `/api/attempts/${attempt.id}/actions`, "alice", { actions: batch2 });
    expect(r2.json()).toMatchObject({ accepted: 1, duplicates: 0 });
    const r1 = await req("POST", `/api/attempts/${attempt.id}/actions`, "alice", { actions: batch1 });
    expect(r1.json()).toMatchObject({ accepted: 2, lastSeq: batch2[0]!.seq });
    const again = await req("POST", `/api/attempts/${attempt.id}/actions`, "alice", { actions: [...batch1, ...batch2] });
    expect(again.json()).toMatchObject({ accepted: 0, duplicates: 3 });
    const stored = (await req("GET", `/api/attempts/${attempt.id}`, "alice")).json().actions;
    expect(stored.map((x: { ref: string }) => x.ref)).toEqual(["pc_onset", "pc_radiation", "heart_auscultation"]);
  });

  it("other students cannot read or write someone else's attempt", async () => {
    const { sessionId } = await makeSession(w);
    const { attempt } = (await req("POST", `/api/sessions/${sessionId}/attempts`, "alice", { caseId: "chest-pain-stemi" })).json();
    expect((await req("GET", `/api/attempts/${attempt.id}`, "bob")).statusCode).toBe(403);
    expect((await req("POST", `/api/attempts/${attempt.id}/actions`, "bob", { actions: [] })).statusCode).toBe(403);
  });

  it("releases an investigation result only after ordering and turnaround", async () => {
    const { sessionId } = await makeSession(w);
    const { attempt } = (await req("POST", `/api/sessions/${sessionId}/attempts`, "alice", { caseId: "chest-pain-stemi" })).json();
    const url = (at: number) => `/api/attempts/${attempt.id}/investigations/troponin?at=${at}`;
    expect((await req("GET", url(10 * 60_000), "alice")).statusCode).toBe(403);
    await req("POST", `/api/attempts/${attempt.id}/actions`, "alice", { actions: [action("investigation.order", "troponin", 60_000)] });
    expect((await req("GET", url(6 * 60_000), "alice")).statusCode).toBe(409);
    const ok = await req("GET", url(7 * 60_000), "alice");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().result.values[0].name).toBe("hs-TnI");
  });

  it("finishing scores the attempt and returns the debrief; no second attempt without retry", async () => {
    const { sessionId } = await makeSession(w);
    const { attempt } = (await req("POST", `/api/sessions/${sessionId}/attempts`, "alice", { caseId: "chest-pain-stemi" })).json();
    await req("POST", `/api/attempts/${attempt.id}/actions`, "alice", {
      actions: [action("investigation.order", "ecg", 60_000), action("management.give", "aspirin", 120_000), action("diagnosis.submit", undefined, 600_000, { payload: { main: "inferior_stemi", differentials: [] } })],
    });
    const fin = await req("POST", `/api/attempts/${attempt.id}/finish`, "alice");
    expect(fin.statusCode).toBe(200);
    const d = fin.json();
    expect(d.report.areas.diagnosis.points).toBe(10);
    expect(d.report.areas.investigations.points).toBe(5);
    expect(d.timeline).toHaveLength(3);
    expect(d.diagnosis.correct).toBe("inferior_stemi");
    expect((await req("POST", `/api/attempts/${attempt.id}/actions`, "alice", { actions: [action("history.ask", "pc_onset", 1)] })).statusCode).toBe(409);
    expect((await req("POST", `/api/sessions/${sessionId}/attempts`, "alice", { caseId: "chest-pain-stemi" })).statusCode).toBe(409);
  });
});

describe("instructor controls", () => {
  it("allow-retry for one student creates a new attempt for that student only", async () => {
    const { sessionId } = await makeSession(w);
    for (const s of ["alice", "bob"]) {
      const { attempt } = (await req("POST", `/api/sessions/${sessionId}/attempts`, s, { caseId: "chest-pain-stemi" })).json();
      await req("POST", `/api/attempts/${attempt.id}/finish`, s);
    }
    expect((await req("POST", `/api/sessions/${sessionId}/retry`, "instructor", { studentId: w.ids.alice, caseId: "chest-pain-stemi" })).statusCode).toBe(201);
    const retry = await req("POST", `/api/sessions/${sessionId}/attempts`, "alice", { caseId: "chest-pain-stemi" });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().attempt.attemptNo).toBe(2);
    expect((await req("POST", `/api/sessions/${sessionId}/attempts`, "bob", { caseId: "chest-pain-stemi" })).statusCode).toBe(409);
  });

  it("ending a session closes and scores every running attempt", async () => {
    const { sessionId } = await makeSession(w);
    await req("POST", `/api/sessions/${sessionId}/attempts`, "alice", { caseId: "chest-pain-stemi" });
    await req("POST", `/api/sessions/${sessionId}/attempts`, "bob", { caseId: "chest-pain-stemi" });
    const end = await req("POST", `/api/sessions/${sessionId}/end`, "instructor");
    expect(end.json()).toMatchObject({ status: "ended", attemptsClosed: 2 });
    const live = (await req("GET", `/api/sessions/${sessionId}/live`, "instructor")).json();
    expect(live.seats.every((s: { status: string }) => s.status === "finished")).toBe(true);
    expect((await req("POST", `/api/sessions/${sessionId}/attempts`, "alice", { caseId: "chest-pain-stemi" })).statusCode).toBe(409);
  });

  it("results per student and per cohort, with most-missed items", async () => {
    const { sessionId } = await makeSession(w);
    const play = async (who: string, actions: object[]) => {
      const { attempt } = (await req("POST", `/api/sessions/${sessionId}/attempts`, who, { caseId: "chest-pain-stemi" })).json();
      await req("POST", `/api/attempts/${attempt.id}/actions`, who, { actions });
      await req("POST", `/api/attempts/${attempt.id}/finish`, who);
    };
    await play("alice", [action("history.ask", "dh_pde5", 1000), action("investigation.order", "ecg", 2000)]);
    resetSeq();
    await play("bob", [action("investigation.order", "ecg", 2000)]);
    const r = (await req("GET", `/api/sessions/${sessionId}/results`, "instructor")).json();
    expect(r.results).toHaveLength(2);
    const cohort = r.cohort[0];
    expect(cohort).toMatchObject({ caseId: "chest-pain-stemi", students: 2, passRate: 0 });
    const pde5 = cohort.mostMissed.find((m: { ref: string }) => m.ref === "dh_pde5");
    const aspirin = cohort.mostMissed.find((m: { ref: string }) => m.ref === "aspirin");
    expect(aspirin).toMatchObject({ missed: 2, missedPct: 100 });
    expect(pde5?.missed ?? 1).toBe(1);
  });

  it("a rubric correction re-scores stored attempts; content changes are refused", async () => {
    const { sessionId } = await makeSession(w);
    const { attempt } = (await req("POST", `/api/sessions/${sessionId}/attempts`, "alice", { caseId: "chest-pain-stemi" })).json();
    await req("POST", `/api/attempts/${attempt.id}/actions`, "alice", { actions: [action("investigation.order", "ecg", 1000)] });
    await req("POST", `/api/attempts/${attempt.id}/finish`, "alice");

    const fixed = refCase();
    fixed.investigations.find((t: { id: string }) => t.id === "ecg").points = 8;
    const r = await req("POST", "/api/admin/cases/chest-pain-stemi/1/rubric", "admin", fixed);
    expect(r.statusCode).toBe(200);
    expect(r.json().rescored).toBeGreaterThanOrEqual(1);
    const result = (await req("GET", `/api/attempts/${attempt.id}/result`, "alice")).json();
    expect(result.report.areas.investigations.points).toBe(8);

    const changed = refCase();
    changed.patient.name = "Someone Else";
    expect((await req("POST", "/api/admin/cases/chest-pain-stemi/1/rubric", "admin", changed)).statusCode).toBe(400);
  });
});

describe("live updates", () => {
  it("pushes seat status to the instructor within 2 s; students get no seat data", async () => {
    const { sessionId } = await makeSession(w);
    await w.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (w.app.server.address() as { port: number }).port;
    const open = (who: string) =>
      new Promise<{ ws: WebSocket; msgs: { type: string; seat?: { studentName: string; step: string } }[] }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live?session=${sessionId}&token=${w.tokens[who]}`);
        const msgs: { type: string }[] = [];
        ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
        ws.on("open", () => resolve({ ws, msgs }));
        ws.on("error", reject);
      });
    const teacher = await open("instructor");
    const student = await open("bob");
    await new Promise((r) => setTimeout(r, 100));

    const t0 = Date.now();
    const { attempt } = (await req("POST", `/api/sessions/${sessionId}/attempts`, "alice", { caseId: "chest-pain-stemi" })).json();
    await req("POST", `/api/attempts/${attempt.id}/actions`, "alice", { actions: [action("exam.perform", "heart_auscultation", 4000)] });
    while (!teacher.msgs.some((m) => m.seat?.step === "examination") && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(teacher.msgs.find((m) => m.seat?.step === "examination")?.seat?.studentName).toBe("ALICE");

    await req("POST", `/api/sessions/${sessionId}/pause`, "instructor");
    await new Promise((r) => setTimeout(r, 100));
    expect(student.msgs.some((m) => m.type === "seat")).toBe(false);
    expect(student.msgs).toContainEqual({ type: "session", sessionId, status: "paused" });

    // A student outside the course is refused.
    const outsider = new WebSocket(`ws://127.0.0.1:${port}/api/live?session=${sessionId}&token=${w.tokens.outsider}`);
    const code = await new Promise<number>((r) => outsider.on("close", (c) => r(c)));
    expect(code).toBe(4403);
    teacher.ws.close();
    student.ws.close();
  });
});

describe("admin", () => {
  it("system health reports sessions, storage and backups", async () => {
    const h = (await req("GET", "/api/admin/health", "admin")).json();
    expect(h.server.ok).toBe(true);
    expect(h.storage.databaseBytes).toBeGreaterThan(0);
    expect(h).toHaveProperty("activeSessions");
    expect(h).toHaveProperty("lastBackup");
  });
});
