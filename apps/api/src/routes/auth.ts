import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole, verifyPassword, type AuthProvider, type AuthUser } from "../auth.js";
import type { Db } from "../db.js";

export const localAuthProvider = (db: Db): AuthProvider => ({
  async authenticate(username, password) {
    const { rows } = await db.query("SELECT id, username, display_name, role, password_hash FROM users WHERE username = $1", [username]);
    const u = rows[0];
    if (!u || !(await verifyPassword(password, u.password_hash))) return null;
    return { id: u.id, username: u.username, displayName: u.display_name, role: u.role };
  },
});

const Login = z.object({ username: z.string().min(1), password: z.string().min(1) });

export const authRoutes = (provider: AuthProvider) => async (app: FastifyInstance) => {
  app.post("/api/auth/login", async (req, reply) => {
    const { username, password } = Login.parse(req.body);
    const user = await provider.authenticate(username.trim().toLowerCase(), password);
    if (!user) return reply.code(401).send({ error: "wrong username or password" });
    const token = app.jwt.sign({ id: user.id, username: user.username, displayName: user.displayName, role: user.role } satisfies AuthUser);
    return { token, user };
  });

  app.get("/api/me", { preHandler: requireRole() }, async (req) => req.user);
};
