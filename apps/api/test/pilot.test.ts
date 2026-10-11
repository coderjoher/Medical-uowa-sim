import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { action, makeSession, makeWorld, resetSeq, type World } from "./setup.js";

let w: World;
beforeAll(async () => {
  w = await makeWorld();
});
afterAll(async () => {
  await w.app.close();
  await w.db.end();
});
beforeEach(() => resetSeq());

const req = (method: "GET" | "POST", url: string, who?: string, payload?: unknown) =>
  w.app.inject({ method, url, ...(who ? { headers: w.as(who) } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });

/** A finished attempt by `who`, with every clinical action from `source`. */
async function finishedAttempt(sessionId: string, who: string, source: "hand" | "mouse" | "mixed") {
  const { attempt } = (await req("POST", `/api/sessions/${sessionId}/attempts`, who, { caseId: "chest-pain-stemi" })).json();
  const src = (i: number) => (source === "mixed" ? (i === 0 ? "hand" : "mouse") : source);
  await req("POST", `/api/attempts/${attempt.id}/actions`, who, {
    actions: [
      action("case.start", undefined, 0, { inputSource: "mouse" }),
      action("history.ask", "pc_onset", 1000, { inputSource: src(0) }),
      action("investigation.order", "ecg", 2000, { inputSource: src(1) }),
      ...(source === "mixed" ? [action("input.switch", undefined, 2500, { inputSource: "mouse", payload: { to: "mouse" } })] : []),
      action("tracking.stats", undefined, 2600, { inputSource: "system", payload: { fps: 31 } }),
      action("case.end", undefined, 3000, { inputSource: "mouse" }),
    ],
  });
  await req("POST", `/api/attempts/${attempt.id}/finish`, who);
  return attempt.id as string;
}

describe("lab checks", () => {
  it("stores a check per seat and shows the latest per seat", async () => {
    const { labId, seatId } = await makeSession(w);
    const fail = await req("POST", "/api/lab-checks", "alice", { seatId, cameraOk: true, lightLevel: 0.1, trackingFps: 31, renderFps: 61, handSeen: true, audioOk: true });
    expect(fail.json()).toMatchObject({ passed: false }); // too dark
    const ok = await req("POST", "/api/lab-checks", "alice", { seatId, cameraOk: true, lightLevel: 0.5, trackingFps: 31, renderFps: 61, handSeen: true, audioOk: true });
    expect(ok.json()).toMatchObject({ passed: true });
    const ready = (await req("GET", `/api/admin/lab-readiness?labId=${labId}`, "instructor")).json();
    expect(ready.find((s: { seatId: string }) => s.seatId === seatId)).toMatchObject({ passed: true, trackingFps: 31, renderFps: 61 });
    expect(ready.filter((s: { passed: boolean | null }) => s.passed === null)).toHaveLength(1); // the other seat was never checked
    expect((await req("GET", `/api/admin/lab-readiness?labId=${labId}`, "alice")).statusCode).toBe(403);
  });
});

describe("tracking tests", () => {
  it("computes the PRD tracking metrics across runs", async () => {
    const run = { durationMs: 300_000, targets: 40, detected: 39, falseClicks: 1, restMs: 300_000, handLost: 1, recoveryMs: [400], trackingFps: 31, renderFps: 60, pipelineP95Ms: 48, feltReliable: true };
    expect((await req("POST", "/api/tracking-tests", "alice", run)).statusCode).toBe(201);
    expect((await req("POST", "/api/tracking-tests", "bob", { ...run, detected: 37, falseClicks: 3, handLost: 0, recoveryMs: [], feltReliable: false })).statusCode).toBe(201);
    expect((await req("POST", "/api/tracking-tests", "bob", { ...run, detected: 41 })).statusCode).toBe(400);
    const { runs, metrics } = (await req("GET", "/api/admin/tracking-tests", "instructor")).json();
    expect(runs).toHaveLength(2);
    const m = Object.fromEntries(metrics.map((x: { key: string }) => [x.key, x]));
    expect(m.pinchDetected).toMatchObject({ value: 95, met: true }); // 76/80
    expect(m.falseClicks).toMatchObject({ value: 2, met: false }); // 4 in 10 min
    expect(m.handLost).toMatchObject({ value: 0.5, met: true });
    expect(m.recovery).toMatchObject({ value: 400, met: true });
    expect(m.trackingFps).toMatchObject({ value: 31, met: true });
    expect(m.pipelineLatency.met).toBeNull(); // needs an external measurement
    expect(m.feltReliable).toMatchObject({ value: 50, met: false });
  });
});

describe("surveys", () => {
  it("accepts each survey once, from the right role, about your own attempt", async () => {
    const { sessionId, courseId } = await makeSession(w);
    const attemptId = await finishedAttempt(sessionId, "alice", "hand");
    const caseSurvey = { kind: "student_case", attemptId, answers: { usedHand: true, trackingReliable: true, useful: 5 } };
    expect((await req("POST", "/api/surveys", "bob", caseSurvey)).statusCode).toBe(400); // not bob's attempt
    expect((await req("POST", "/api/surveys", "alice", caseSurvey)).statusCode).toBe(201);
    expect((await req("POST", "/api/surveys", "alice", caseSurvey)).statusCode).toBe(409);
    expect((await req("POST", "/api/surveys", "instructor", { kind: "student_course", courseId, answers: { trackingReliable: true, useful: 4 } })).statusCode).toBe(403);
    expect((await req("POST", "/api/surveys", "outsider", { kind: "student_course", courseId, answers: { trackingReliable: true, useful: 4 } })).statusCode).toBe(403);
    expect((await req("POST", "/api/surveys", "instructor", { kind: "instructor", courseId, answers: { willingNextSemester: true } })).statusCode).toBe(201);
    expect((await req("GET", "/api/my/surveys", "alice")).json()).toEqual([{ kind: "student_case", attemptId, courseId: null }]);
  });
});

describe("score review", () => {
  it("gives every reviewer the same anonymous sample and records verdicts", async () => {
    const { sessionId } = await makeSession(w, { allowRetry: true });
    for (let i = 0; i < 3; i++) await finishedAttempt(sessionId, i % 2 ? "bob" : "alice", "mouse");
    const a = (await req("GET", "/api/admin/score-review?caseId=chest-pain-stemi&size=2", "author")).json();
    const b = (await req("GET", "/api/admin/score-review?caseId=chest-pain-stemi&size=2", "admin")).json();
    expect(a.map((x: { id: string }) => x.id)).toEqual(b.map((x: { id: string }) => x.id));
    expect((await req("GET", "/api/admin/score-review?caseId=chest-pain-stemi", "instructor")).statusCode).toBe(403);

    const view = (await req("GET", `/api/admin/score-review/${a[0].id}`, "author")).json();
    expect(JSON.stringify(view)).not.toMatch(/ALICE|BOB/);
    expect(view.report.totalPct).toBeTypeOf("number");

    await req("POST", `/api/admin/score-review/${a[0].id}`, "author", { agrees: false });
    await req("POST", `/api/admin/score-review/${a[0].id}`, "author", { agrees: true, comment: "fair" }); // changes their verdict
    await req("POST", `/api/admin/score-review/${a[0].id}`, "admin", { agrees: true });
    const after = (await req("GET", "/api/admin/score-review?caseId=chest-pain-stemi&size=2", "author")).json();
    expect(after[0]).toMatchObject({ myVerdict: true, reviews: 2, agrees: 2 });
  });
});

describe("pilot report", () => {
  it("computes the PRD success metrics for a course", async () => {
    const { sessionId, courseId } = await makeSession(w, { allowRetry: true });
    const handAttempt = await finishedAttempt(sessionId, "alice", "hand");
    await finishedAttempt(sessionId, "bob", "mixed");
    await req("POST", `/api/sessions/${sessionId}/retry`, "instructor", { studentId: w.ids.bob, caseId: "chest-pain-stemi", reason: "technical" });
    await req("POST", "/api/surveys", "alice", { kind: "student_course", courseId, answers: { trackingReliable: true, useful: 5, comment: "Loved the ECG" } });
    await req("POST", "/api/surveys", "bob", { kind: "student_course", courseId, answers: { trackingReliable: false, useful: 3 } });
    await req("POST", "/api/surveys", "instructor", { kind: "instructor", courseId, answers: { willingNextSemester: true } });
    await req("POST", `/api/admin/score-review/${handAttempt}`, "author", { agrees: true });

    const r = (await req("GET", `/api/admin/pilot-report?courseId=${courseId}`, "admin")).json();
    const m = Object.fromEntries(r.success.map((x: { key: string }) => [x.key, x]));
    expect(m.trackingReliable).toMatchObject({ value: 50, met: false });
    expect(m.noMouse).toMatchObject({ value: 50, met: false }); // alice by hand, bob switched
    expect(m.useful).toMatchObject({ value: 50, met: false });
    expect(m.lost).toMatchObject({ value: 50, met: false }); // 1 technical retry of 2 attempts
    expect(m.willing).toMatchObject({ value: 100, met: true });
    expect(m.scoreAgreement).toMatchObject({ value: 100, met: false }); // fewer than 20 attempts reviewed
    expect(r.comments).toEqual(["Loved the ECG"]);
    expect(r.tracking.map((x: { key: string }) => x.key)).toContain("pinchDetected");
    expect((await req("GET", `/api/admin/pilot-report?courseId=${courseId}`, "alice")).statusCode).toBe(403);
    const xlsx = await req("GET", `/api/admin/pilot-report.xlsx?courseId=${courseId}`, "admin");
    expect(xlsx.statusCode).toBe(200);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
    expect(wb.getWorksheet("Success metrics")!.getRow(2).getCell(1).value).toBe("Students rating hand tracking reliable");
  });
});
