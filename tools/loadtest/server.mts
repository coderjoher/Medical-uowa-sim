/**
 * Load-test server: the real API (buildApp) on its own database, with enough students, two
 * 60-seat labs and one open session per lab running the reference case.
 *
 *   npx tsx tools/loadtest/server.mts            # 120 students, port 4200, database sim_load
 *   STUDENTS=240 PORT=4200 npx tsx tools/loadtest/server.mts
 *
 * Env: PORT (4200), STUDENTS (120), LABS (2), SEATS_PER_LAB (60), LOAD_DATABASE_URL
 * (postgres://sim:sim@localhost:5432/sim_load), PASSWORD (load-pass-123), DB_POOL (20, the
 * production pool size in apps/api/src/db.ts).
 *
 * The schema is dropped and recreated on every start, so every run begins from an empty database.
 * Writes tools/loadtest/out/setup.json (sessions, server pid, database URL) and
 * tools/loadtest/out/students.csv (username,password) for run.mts.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { hashPassword } from "../../apps/api/src/auth.js";
import { migrate } from "../../apps/api/src/db.js";
import { seedAdmin, seedDemo } from "../../apps/api/src/seed-data.js";

const PORT = Number(process.env.PORT ?? 4200);
const STUDENTS = Number(process.env.STUDENTS ?? 120);
const LABS = Number(process.env.LABS ?? 2);
const SEATS_PER_LAB = Number(process.env.SEATS_PER_LAB ?? 60);
const PASSWORD = process.env.PASSWORD ?? "load-pass-123";
const DB_URL = process.env.LOAD_DATABASE_URL ?? "postgres://sim:sim@localhost:5432/sim_load";
const POOL = Number(process.env.DB_POOL ?? 20);
const OUT = new URL("./out/", import.meta.url);

/** Which code is under test: git commit, whether the tree is dirty, and a hash of the API sources. */
function codeVersion() {
  const root = new URL("../../", import.meta.url);
  const sh = (c: string) => {
    try {
      return execSync(c, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return null;
    }
  };
  const h = createHash("sha256");
  for (const dir of ["apps/api/src", "apps/api/src/routes", "apps/api/migrations", "packages/shared/src", "packages/engine/src"])
    for (const f of readdirSync(new URL(dir, root)).filter((f) => /\.(ts|sql)$/.test(f)).sort()) h.update(f).update(readFileSync(new URL(`${dir}/${f}`, root)));
  return { commit: sh("git rev-parse --short HEAD"), dirtyFiles: Number(sh("git status --porcelain | wc -l") ?? 0), apiSourceHash: h.digest("hex").slice(0, 12) };
}
const code = codeVersion();

// Create the database if it does not exist (the sim user has CREATEDB).
{
  const u = new URL(DB_URL);
  const name = u.pathname.slice(1);
  u.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: u.toString() });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  await admin.end();
}

// Same pool settings as production (apps/api/src/db.ts) unless DB_POOL overrides the size.
const db = new pg.Pool({ connectionString: DB_URL, max: POOL });
await db.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
await migrate(db);
await seedAdmin(db, PASSWORD);
await seedDemo(db, PASSWORD);

// Students: one shared hash (scrypt is slow and the password is the same for all).
const hash = await hashPassword(PASSWORD);
const usernames = Array.from({ length: STUDENTS }, (_, i) => `loadstudent${String(i + 1).padStart(3, "0")}`);
const studentIds = (
  await db.query(
    `INSERT INTO users (username, display_name, role, password_hash)
     SELECT u, 'Load Student ' || substr(u, 12), 'student', $2 FROM unnest($1::text[]) u RETURNING id`,
    [usernames, hash],
  )
).rows.map((r) => r.id as string);
const course = (await db.query("SELECT id FROM courses WHERE code = 'MED-401'")).rows[0].id as string;
const instructor = (await db.query("SELECT id FROM users WHERE username = 'instructor'")).rows[0].id as string;
await db.query("INSERT INTO course_members (course_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING", [course, studentIds]);

// Labs with seats, and one open session per lab running the reference case.
const sessions: { id: string; lab: string; labId: string }[] = [];
const now = Date.now();
for (let l = 0; l < LABS; l++) {
  const name = `Load Lab ${String.fromCharCode(65 + l)}`;
  const labId = (await db.query("INSERT INTO labs (name) VALUES ($1) RETURNING id", [name])).rows[0].id as string;
  await db.query("INSERT INTO seats (lab_id, label) SELECT $1, 'Seat ' || lpad(i::text, 2, '0') FROM generate_series(1, $2::int) i", [labId, SEATS_PER_LAB]);
  const id = (
    await db.query(
      `INSERT INTO sessions (course_id, lab_id, instructor_id, cases, starts_at, ends_at, allow_retry)
       VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING id`,
      [course, labId, instructor, JSON.stringify([{ caseId: "chest-pain-stemi", version: 1 }]), new Date(now - 60_000), new Date(now + 6 * 3600_000)],
    )
  ).rows[0].id as string;
  sessions.push({ id, lab: name, labId });
}

const app = await buildApp({ db, jwtSecret: process.env.JWT_SECRET ?? "load-secret-0123456789-abcdefghijkl", logger: process.env.LOG === "1" });
await app.listen({ port: PORT, host: process.env.HOST ?? "127.0.0.1" });

mkdirSync(OUT, { recursive: true });
writeFileSync(new URL("students.csv", OUT), "username,password\n" + usernames.map((u) => `${u},${PASSWORD}`).join("\n") + "\n");
writeFileSync(
  new URL("setup.json", OUT),
  JSON.stringify(
    {
      baseUrl: `http://127.0.0.1:${PORT}`,
      sessionIds: sessions.map((s) => s.id),
      sessions,
      studentsCsv: new URL("students.csv", OUT).pathname,
      instructor: { username: "instructor", password: PASSWORD },
      databaseUrl: DB_URL,
      serverPid: process.pid,
      dbPool: POOL,
      students: STUDENTS,
      code,
    },
    null,
    2,
  ),
);
for (const s of sessions) console.log(`session ${s.id}  ${s.lab} (${SEATS_PER_LAB} seats)`);
console.log(`code: commit ${code.commit}, ${code.dirtyFiles} uncommitted file(s), API source hash ${code.apiSourceHash}`);
console.log(`load server ready on :${PORT}, pid ${process.pid}, ${STUDENTS} students, db pool ${POOL}`);

const stop = async () => {
  await app.close();
  await db.end();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
