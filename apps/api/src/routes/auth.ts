import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword, requireRole, verifyPassword, type AuthProvider, type AuthUser } from "../auth.js";
import type { Db } from "../db.js";

// Checked when the user does not exist, so a login takes the same time either way (no username probing).
const DUMMY_HASH = hashPassword("not-a-real-password-0000");

export const localAuthProvider = (db: Db): AuthProvider => ({
  async authenticate(username, password) {
    const { rows } = await db.query("SELECT id, username, display_name, role, password_hash FROM users WHERE username = $1", [username]);
    const u = rows[0];
    const ok = await verifyPassword(password, u?.password_hash ?? (await DUMMY_HASH));
    if (!u || !u.password_hash || !ok) return null;
    return { id: u.id, username: u.username, displayName: u.display_name, role: u.role };
  },
});

const Login = z.object({ username: z.string().min(1), password: z.string().min(1) });

export const authRoutes = (provider: AuthProvider) => async (app: FastifyInstance) => {
  app.post(
    "/api/auth/login",
    {
      config: {
        // Per client address and username: slows password guessing and keeps repeated failures
        // from tripping the university directory's account lockout.
        rateLimit: {
          // After body parsing, so the key can include the username.
          hook: "preHandler",
          max: app.opts.loginRateLimit ?? 10,
          timeWindow: "1 minute",
          keyGenerator: (req) => `${req.ip}|${String((req.body as { username?: unknown } | undefined)?.username ?? "").trim().toLowerCase()}`,
          errorResponseBuilder: (_req, ctx) => Object.assign(new Error(`Too many sign-in attempts. Try again in ${Math.ceil(ctx.ttl / 1000)} seconds.`), { statusCode: 429 }),
        },
      },
    },
    async (req, reply) => {
    const { username, password } = Login.parse(req.body);
    const user = await provider.authenticate(username.trim().toLowerCase(), password);
    if (!user) return reply.code(401).send({ error: "wrong username or password" });
    const token = app.jwt.sign({ id: user.id, username: user.username, displayName: user.displayName, role: user.role } satisfies AuthUser);
    return { token, user };
    },
  );

  app.get("/api/me", { preHandler: requireRole() }, async (req) => req.user);
};
