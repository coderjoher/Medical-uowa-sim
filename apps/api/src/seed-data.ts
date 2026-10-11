import { readdirSync, readFileSync } from "node:fs";
import { validateCase } from "@sim/shared";
import { hashPassword } from "./auth.js";
import type { Db } from "./db.js";

const upsertUser = async (db: Db, username: string, name: string, role: string, pw: string) =>
  (
    await db.query(
      "INSERT INTO users (username, display_name, role, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id",
      [username, name, role, await hashPassword(pw)],
    )
  ).rows[0].id as string;

export async function seedAdmin(db: Db, password: string): Promise<void> {
  if (password.length < 8) throw new Error("admin password must be 8+ characters");
  await upsertUser(db, "admin", "Administrator", "admin", password);
}

/** Demo course, lab with 30 seats, instructor, author, 5 students, every case in content/cases published, and an open session. */
export async function seedDemo(db: Db, password: string): Promise<void> {
  const instructor = await upsertUser(db, "instructor", "Dr Instructor", "instructor", password);
  await upsertUser(db, "author", "Dr Author", "case_author", password);
  const students = [];
  for (const i of [1, 2, 3, 4, 5]) students.push(await upsertUser(db, `student${i}`, `Student ${i}`, "student", password));
  const course = (await db.query("INSERT INTO courses (code, title) VALUES ('MED-401', 'Clinical Reasoning') ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title RETURNING id")).rows[0].id;
  await db.query("INSERT INTO course_members (course_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING", [course, [instructor, ...students]]);
  const lab = (await db.query("INSERT INTO labs (name) VALUES ('Sim Lab 1') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id")).rows[0].id;
  for (let i = 1; i <= 30; i++) await db.query("INSERT INTO seats (lab_id, label) VALUES ($1, $2) ON CONFLICT DO NOTHING", [lab, `Seat ${String(i).padStart(2, "0")}`]);

  // Every valid case in content/cases, published (reference case first).
  const dir = new URL("../../../content/cases/", import.meta.url);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => (a === "chest-pain-stemi.json" ? -1 : b === "chest-pain-stemi.json" ? 1 : a.localeCompare(b)));
  const published: { caseId: string; version: number }[] = [];
  for (const f of files) {
    const r = validateCase(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
    if (!r.ok) throw new Error(`case ${f} is invalid`);
    await db.query(
      "INSERT INTO case_versions (case_id, version, title, course_code, definition, status, published_at) VALUES ($1, 1, $2, $3, $4, 'published', now()) ON CONFLICT DO NOTHING",
      [r.case.metadata.id, r.case.metadata.title, r.case.metadata.course, r.case],
    );
    published.push({ caseId: r.case.metadata.id, version: 1 });
  }
  const now = Date.now();
  await db.query(
    "INSERT INTO sessions (course_id, lab_id, instructor_id, cases, starts_at, ends_at, allow_retry) SELECT $1, $2, $3, $4, $5, $6, true WHERE NOT EXISTS (SELECT 1 FROM sessions)",
    [course, lab, instructor, JSON.stringify(published), new Date(now - 60_000), new Date(now + 30 * 24 * 3600_000)],
  );
}
