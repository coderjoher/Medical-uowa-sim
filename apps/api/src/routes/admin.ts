import { existsSync, readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword, requireRole } from "../auth.js";
import { conflict, notFound } from "../http-errors.js";

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
