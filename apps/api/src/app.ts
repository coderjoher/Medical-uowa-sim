import fastifyJwt from "@fastify/jwt";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AuthProvider } from "./auth.js";
import type { Db } from "./db.js";
import { HttpError } from "./http-errors.js";
import { LiveHub } from "./live.js";
import { adminRoutes } from "./routes/admin.js";
import { attemptRoutes } from "./routes/attempts.js";
import { authRoutes, localAuthProvider } from "./routes/auth.js";
import { caseRoutes } from "./routes/cases.js";
import { liveRoutes } from "./routes/live.js";
import { sessionRoutes } from "./routes/sessions.js";

export interface AppOptions {
  db: Db;
  jwtSecret: string;
  authProvider?: AuthProvider;
  logger?: boolean;
  /** File written by the backup job with the time of the last successful backup. */
  backupStatusFile?: string;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    live: LiveHub;
    opts: AppOptions;
  }
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  app.decorate("db", opts.db);
  app.decorate("live", new LiveHub());
  app.decorate("opts", opts);

  await app.register(fastifyJwt, { secret: opts.jwtSecret, sign: { expiresIn: "12h" } });
  await app.register(fastifyWebsocket);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    if (err instanceof ZodError) return reply.code(400).send({ error: "invalid request", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/api/health", async () => {
    await opts.db.query("SELECT 1");
    return { ok: true };
  });

  await app.register(authRoutes(opts.authProvider ?? localAuthProvider(opts.db)));
  await app.register(adminRoutes);
  await app.register(caseRoutes);
  await app.register(sessionRoutes);
  await app.register(attemptRoutes);
  await app.register(liveRoutes);
  return app;
}
