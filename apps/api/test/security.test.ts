import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { makeSession, makeWorld, PW, type World } from "./setup.js";

let w: World;
beforeAll(async () => {
  w = await makeWorld();
});
afterAll(async () => {
  await w.app.close();
  await w.db.end();
});

const login = (username: string, password: string, ip = "10.0.0.1") => w.app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password }, remoteAddress: ip });

describe("security", () => {
  it("rate-limits repeated sign-in attempts per address and username", async () => {
    for (let i = 0; i < 10; i++) expect((await login("bob", "wrong-password", "10.0.0.9")).statusCode).toBe(401);
    const blocked = await login("bob", PW, "10.0.0.9");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatch(/Too many sign-in attempts/);
    // Another seat, or another user at the same seat, is not blocked.
    expect((await login("bob", PW, "10.0.0.10")).statusCode).toBe(200);
    expect((await login("alice", PW, "10.0.0.9")).statusCode).toBe(200);
  });

  it("answers unknown users and wrong passwords the same way", async () => {
    const a = await login("nobody-here", "whatever-123", "10.0.1.1");
    const b = await login("alice", "whatever-123", "10.0.1.2");
    expect([a.statusCode, a.json()]).toEqual([b.statusCode, b.json()]);
  });

  it("sends security headers and a content security policy", async () => {
    const r = await w.app.inject({ method: "GET", url: "/api/health" });
    const csp = String(r.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["strict-transport-security"]).toBeDefined();
  });

  it("refuses investigation results for a case time ahead of the attempt", async () => {
    const { sessionId } = await makeSession(w);
    const { attempt } = (await w.app.inject({ method: "POST", url: `/api/sessions/${sessionId}/attempts`, headers: w.as("alice"), payload: { caseId: "chest-pain-stemi" } })).json();
    const { action } = await import("./setup.js");
    await w.app.inject({ method: "POST", url: `/api/attempts/${attempt.id}/actions`, headers: w.as("alice"), payload: { actions: [action("investigation.order", "ecg", 0)] } });
    const r = await w.app.inject({ method: "GET", url: `/api/attempts/${attempt.id}/investigations/ecg?at=3600000`, headers: w.as("alice") });
    expect(r.statusCode).toBe(400);
  });

  it("never writes tokens to the logs", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) });
    const app = await buildApp({ db: w.db, jwtSecret: "log-test-secret-0123456789-abcdefgh", logger: true, loggerStream: stream });
    const token = app.jwt.sign({ id: w.ids.alice!, username: "alice", displayName: "A", role: "student" });
    await app.inject({ method: "GET", url: `/api/live?session=x&token=${token}` });
    await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
    await app.close();
    const all = lines.join("\n");
    expect(all).toContain("token=[redacted]");
    expect(all).not.toContain(token);
  });

  it("refuses a short JWT secret", async () => {
    await expect(buildApp({ db: w.db, jwtSecret: "short" })).rejects.toThrow(/at least 32/);
  });
});
