import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createDb, migrate, type Db } from "../src/db.js";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://sim:sim@localhost:5432/sim_test";
export const PW = "correct-horse-1";

export const refCase = () => JSON.parse(readFileSync(new URL("../../../content/cases/chest-pain-stemi.json", import.meta.url), "utf8"));

export interface World {
  app: FastifyInstance;
  db: Db;
  ids: Record<string, string>;
  tokens: Record<string, string>;
  as: (who: string) => { authorization: string };
}

/** Fresh schema, an app instance, and users for every role. */
export async function makeWorld(): Promise<World> {
  const db = createDb(TEST_DB);
  await db.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const app = await buildApp({ db, jwtSecret: "test-secret-0123456789-abcdefghij" });

  const ids: Record<string, string> = {};
  const hash = await hashPassword(PW);
  for (const [u, role] of [
    ["admin", "admin"],
    ["instructor", "instructor"],
    ["other_instructor", "instructor"],
    ["author", "case_author"],
    ["alice", "student"],
    ["bob", "student"],
    ["outsider", "student"],
  ] as const) {
    ids[u] = (await db.query("INSERT INTO users (username, display_name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id", [u, u.toUpperCase(), role, hash])).rows[0].id;
  }
  const tokens: Record<string, string> = {};
  for (const u of Object.keys(ids)) {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: u, password: PW } });
    tokens[u] = r.json().token;
  }
  return { app, db, ids, tokens, as: (who) => ({ authorization: `Bearer ${tokens[who]}` }) };
}

/** Course with instructor + alice + bob, a lab with seats, the reference case published, and an open session. */
export async function makeSession(w: World, opts: { allowRetry?: boolean; startsAt?: Date; endsAt?: Date } = {}) {
  const { app, as, ids } = w;
  const course = (await app.inject({ method: "POST", url: "/api/admin/courses", headers: as("admin"), payload: { code: `MED-${randomUUID().slice(0, 6)}`, title: "Clinical Reasoning" } })).json();
  await app.inject({ method: "POST", url: `/api/admin/courses/${course.id}/members`, headers: as("admin"), payload: { userIds: [ids.instructor, ids.alice, ids.bob] } });
  const lab = (await app.inject({ method: "POST", url: "/api/admin/labs", headers: as("admin"), payload: { name: `Lab ${randomUUID().slice(0, 6)}`, seats: ["Seat 01", "Seat 02"] } })).json();
  const existing = await w.db.query("SELECT 1 FROM case_versions WHERE case_id = 'chest-pain-stemi' AND status = 'published'");
  if (!existing.rowCount) {
    const imp = (await app.inject({ method: "POST", url: "/api/admin/cases", headers: as("author"), payload: refCase() })).json();
    await app.inject({ method: "POST", url: `/api/admin/cases/${imp.caseId}/${imp.version}/signoff`, headers: as("author") });
    await app.inject({ method: "POST", url: `/api/admin/cases/${imp.caseId}/${imp.version}/publish`, headers: as("admin") });
  }
  const now = Date.now();
  const res = await app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: as("instructor"),
    payload: {
      courseId: course.id,
      labId: lab.id,
      caseIds: ["chest-pain-stemi"],
      startsAt: (opts.startsAt ?? new Date(now - 60_000)).toISOString(),
      endsAt: (opts.endsAt ?? new Date(now + 3_600_000)).toISOString(),
      allowRetry: opts.allowRetry ?? false,
    },
  });
  if (res.statusCode !== 201) throw new Error(`session create failed: ${res.body}`);
  const labs = (await app.inject({ method: "GET", url: "/api/labs", headers: as("admin") })).json();
  const seats = labs.find((l: { id: string }) => l.id === lab.id).seats;
  return { sessionId: res.json().id as string, courseId: course.id as string, labId: lab.id as string, seatId: seats[0].id as string };
}

let seq = 0;
export const action = (type: string, ref: string | undefined, caseTimeMs: number, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  seq: seq++,
  caseTimeMs,
  clientTs: new Date().toISOString(),
  type,
  ...(ref !== undefined ? { ref } : {}),
  inputSource: "mouse",
  ...extra,
});
export const resetSeq = () => {
  seq = 0;
};
