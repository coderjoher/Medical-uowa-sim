import { existsSync, readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword, requireRole } from "../auth.js";
import { parseCsv } from "../csv.js";
import { tx } from "../db.js";
import { badRequest, conflict, notFound } from "../http-errors.js";

const NewUser = z.object({
  username: z.string().min(2).max(64).transform((s) => s.trim().toLowerCase()),
  displayName: z.string().min(1),
  role: z.enum(["student", "instructor", "case_author", "admin"]),
  password: z.string().min(8).optional(),
});
const NewCourse = z.object({ code: z.string().min(1), title: z.string().min(1) });
const Members = z.object({ userIds: z.array(z.string().uuid()).min(1) });
const NewLab = z.object({ name: z.string().min(1), seats: z.array(z.string().min(1)).default([]) });

const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === "23505";

export async function adminRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireRole("admin") };
  const staff = { preHandler: requireRole("admin", "instructor") };

  app.post("/api/admin/users", admin, async (req, reply) => {
    const u = NewUser.parse(req.body);
    try {
      const { rows } = await app.db.query(
        "INSERT INTO users (username, display_name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, username, display_name AS \"displayName\", role",
        [u.username, u.displayName, u.role, u.password ? await hashPassword(u.password) : null],
      );
      return reply.code(201).send(rows[0]);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict("username already exists");
      throw e;
    }
  });

  app.get("/api/admin/users", staff, async () => {
    const { rows } = await app.db.query('SELECT id, username, display_name AS "displayName", role FROM users ORDER BY username');
    return rows;
  });

  app.patch("/api/admin/users/:id", admin, async (req) => {
    const { id } = req.params as { id: string };
    const b = z
      .object({ displayName: z.string().min(1).optional(), role: z.enum(["student", "instructor", "case_author", "admin"]).optional(), password: z.string().min(8).optional() })
      .refine((x) => Object.keys(x).length > 0, "nothing to change")
      .parse(req.body);
    if (id === req.user.id && b.role && b.role !== "admin") throw conflict("you cannot remove your own admin role");
    const { rows } = await app.db.query(
      `UPDATE users SET display_name = coalesce($2, display_name), role = coalesce($3, role), password_hash = coalesce($4, password_hash)
       WHERE id = $1 RETURNING id, username, display_name AS "displayName", role`,
      [id, b.displayName ?? null, b.role ?? null, b.password ? await hashPassword(b.password) : null],
    );
    if (!rows[0]) throw notFound("user");
    return rows[0];
  });

  /**
   * Bulk import from CSV (e.g. the course roster exported from the student system).
   * Columns: username, display_name, role, password (optional), courses (optional, codes separated by "|").
   * All rows are checked first; if any row is wrong nothing is imported and every problem is listed.
   */
  app.post("/api/admin/users/import", admin, async (req, reply) => {
    const text = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (!text.trim()) throw badRequest("send the CSV as the request body");
    const rows = parseCsv(text);
    const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const col = (name: string) => header.indexOf(name);
    for (const required of ["username", "display_name", "role"]) if (col(required) < 0) throw badRequest(`missing column "${required}"`, [{ path: "line 1", message: `expected columns: username, display_name, role, password, courses` }]);
    const courses = new Map((await app.db.query("SELECT id, code FROM courses")).rows.map((c) => [String(c.code).toLowerCase(), c.id as string]));
    const errors: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    const parsed = rows.map((r, i) => {
      const line = `line ${i + 2}`;
      const get = (name: string) => (col(name) >= 0 ? (r[col(name)] ?? "").trim() : "");
      const username = get("username").toLowerCase();
      const role = get("role").toLowerCase().replace(" ", "_");
      const password = get("password");
      const codes = get("courses").split("|").map((c) => c.trim()).filter(Boolean);
      if (!/^[a-z0-9._@-]{2,64}$/.test(username)) errors.push({ path: line, message: `invalid username "${get("username")}"` });
      if (seen.has(username)) errors.push({ path: line, message: `username "${username}" appears twice` });
      seen.add(username);
      if (!get("display_name")) errors.push({ path: line, message: "display_name is empty" });
      if (!["student", "instructor", "case_author", "admin"].includes(role)) errors.push({ path: line, message: `role must be student, instructor, case_author or admin (got "${get("role")}")` });
      if (password && password.length < 8) errors.push({ path: line, message: "password must be at least 8 characters" });
      for (const c of codes) if (!courses.has(c.toLowerCase())) errors.push({ path: line, message: `unknown course "${c}"` });
      return { username, displayName: get("display_name"), role, password, courseIds: codes.map((c) => courses.get(c.toLowerCase())!).filter(Boolean) };
    });
    if (!parsed.length) throw badRequest("the CSV has no rows");
    if (errors.length) throw badRequest(`${errors.length} problem(s); nothing was imported`, errors);

    const summary = await tx(app.db, async (q) => {
      let created = 0;
      let updated = 0;
      let enrolled = 0;
      for (const u of parsed) {
        const hash = u.password ? await hashPassword(u.password) : null;
        const { rows: out } = await q.query(
          `INSERT INTO users (username, display_name, role, password_hash) VALUES ($1, $2, $3, $4)
           ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role,
             password_hash = coalesce(EXCLUDED.password_hash, users.password_hash)
           RETURNING id, (xmax = 0) AS inserted`,
          [u.username, u.displayName, u.role, hash],
        );
        if (out[0].inserted) created++;
        else updated++;
        for (const courseId of u.courseIds) {
          const r = await q.query("INSERT INTO course_members (course_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [courseId, out[0].id]);
          enrolled += r.rowCount ?? 0;
        }
      }
      return { created, updated, enrolled };
    });
    return reply.code(201).send(summary);
  });

  app.delete("/api/admin/users/:id", admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await app.db.query("DELETE FROM users WHERE id = $1", [id]);
    if (!r.rowCount) throw notFound("user");
    return reply.code(204).send();
  });

  app.post("/api/admin/courses", admin, async (req, reply) => {
    const c = NewCourse.parse(req.body);
    try {
      const { rows } = await app.db.query("INSERT INTO courses (code, title) VALUES ($1, $2) RETURNING id, code, title", [c.code, c.title]);
      return reply.code(201).send(rows[0]);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict("course code already exists");
      throw e;
    }
  });

  app.get("/api/courses", { preHandler: requireRole() }, async (req) => {
    const all = req.user.role === "admin" || req.user.role === "case_author";
    const { rows } = all
      ? await app.db.query("SELECT id, code, title FROM courses ORDER BY code")
      : await app.db.query("SELECT c.id, c.code, c.title FROM courses c JOIN course_members m ON m.course_id = c.id WHERE m.user_id = $1 ORDER BY c.code", [req.user.id]);
    return rows;
  });

  app.post("/api/admin/courses/:id/members", admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userIds } = Members.parse(req.body);
    await app.db.query("INSERT INTO course_members (course_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING", [id, userIds]);
    return reply.code(204).send();
  });

  app.get("/api/admin/courses/:id/members", admin, async (req) => {
    const { id } = req.params as { id: string };
    const { rows } = await app.db.query(
      'SELECT u.id, u.username, u.display_name AS "displayName", u.role FROM course_members m JOIN users u ON u.id = m.user_id WHERE m.course_id = $1 ORDER BY u.display_name',
      [id],
    );
    return rows;
  });

  app.post("/api/admin/labs", admin, async (req, reply) => {
    const l = NewLab.parse(req.body);
    try {
      const { rows } = await app.db.query("INSERT INTO labs (name) VALUES ($1) RETURNING id, name", [l.name]);
      const lab = rows[0];
      for (const label of l.seats) await app.db.query("INSERT INTO seats (lab_id, label) VALUES ($1, $2)", [lab.id, label]);
      return reply.code(201).send({ ...lab, seats: l.seats });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict("lab or seat already exists");
      throw e;
    }
  });

  app.get("/api/labs", { preHandler: requireRole() }, async () => {
    const { rows } = await app.db.query(
      "SELECT l.id, l.name, coalesce(json_agg(json_build_object('id', s.id, 'label', s.label) ORDER BY s.label) FILTER (WHERE s.id IS NOT NULL), '[]') AS seats FROM labs l LEFT JOIN seats s ON s.lab_id = l.id GROUP BY l.id ORDER BY l.name",
    );
    return rows;
  });

  app.get("/api/admin/health", admin, async () => {
    const [sessions, attempts, size] = await Promise.all([
      app.db.query("SELECT count(*)::int AS n FROM sessions WHERE status <> 'ended' AND now() BETWEEN starts_at AND ends_at"),
      app.db.query("SELECT count(*)::int AS n FROM attempts WHERE status = 'in_progress'"),
      app.db.query("SELECT pg_database_size(current_database())::bigint AS bytes"),
    ]);
    const f = app.opts.backupStatusFile;
    const lastBackup = f && existsSync(f) ? readFileSync(f, "utf8").trim() : null;
    return {
      server: { ok: true, uptimeS: Math.round(process.uptime()), node: process.version },
      activeSessions: sessions.rows[0].n,
      attemptsInProgress: attempts.rows[0].n,
      liveConnections: app.live.connectionCount,
      storage: { databaseBytes: Number(size.rows[0].bytes) },
      lastBackup,
    };
  });
}
