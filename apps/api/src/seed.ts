/**
 * Seeds a fresh install: an admin account, plus demo data with SEED_DEMO=1
 * (course, lab, instructor, students, and the reference case published).
 */
import { readFileSync } from "node:fs";
import { validateCase } from "@sim/shared";
import { hashPassword } from "./auth.js";
import { createDb, migrate } from "./db.js";

const db = createDb(process.env.DATABASE_URL ?? "postgres://sim:sim@localhost:5432/sim");
await migrate(db);

const adminPw = process.env.ADMIN_PASSWORD;
if (!adminPw || adminPw.length < 8) throw new Error("set ADMIN_PASSWORD (8+ characters)");
const user = async (username: string, name: string, role: string, pw: string) =>
  (
    await db.query(
      "INSERT INTO users (username, display_name, role, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id",
      [username, name, role, await hashPassword(pw)],
    )
  ).rows[0].id as string;

await user("admin", "Administrator", "admin", adminPw);
console.log("admin user ready");

if (process.env.SEED_DEMO === "1") {
  const demoPw = process.env.DEMO_PASSWORD ?? "demo-pass-123";
  const instructor = await user("instructor", "Dr Instructor", "instructor", demoPw);
  await user("author", "Dr Author", "case_author", demoPw);
  const students = await Promise.all([1, 2, 3].map((i) => user(`student${i}`, `Student ${i}`, "student", demoPw)));
  const course = (await db.query("INSERT INTO courses (code, title) VALUES ('MED-401', 'Clinical Reasoning') ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title RETURNING id")).rows[0].id;
  await db.query("INSERT INTO course_members (course_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING", [course, [instructor, ...students]]);
  const lab = (await db.query("INSERT INTO labs (name) VALUES ('Sim Lab 1') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id")).rows[0].id;
  for (let i = 1; i <= 30; i++) await db.query("INSERT INTO seats (lab_id, label) VALUES ($1, $2) ON CONFLICT DO NOTHING", [lab, `Seat ${String(i).padStart(2, "0")}`]);

  const r = validateCase(JSON.parse(readFileSync(new URL("../../../content/cases/chest-pain-stemi.json", import.meta.url), "utf8")));
  if (!r.ok) throw new Error("reference case invalid");
  await db.query(
    "INSERT INTO case_versions (case_id, version, title, course_code, definition, status, published_at) VALUES ($1, 1, $2, $3, $4, 'published', now()) ON CONFLICT DO NOTHING",
    [r.case.metadata.id, r.case.metadata.title, r.case.metadata.course, r.case],
  );
  const now = new Date();
  await db.query(
    "INSERT INTO sessions (course_id, lab_id, instructor_id, cases, starts_at, ends_at, allow_retry) SELECT $1, $2, $3, $4, $5, $6, true WHERE NOT EXISTS (SELECT 1 FROM sessions)",
    [course, lab, instructor, JSON.stringify([{ caseId: r.case.metadata.id, version: 1 }]), now, new Date(now.getTime() + 30 * 24 * 3600_000)],
  );
  console.log(`demo data ready (users instructor, author, student1-3; password ${demoPw === "demo-pass-123" ? "demo-pass-123" : "from DEMO_PASSWORD"})`);
}
await db.end();
