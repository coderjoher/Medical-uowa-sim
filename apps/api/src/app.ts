import fastifyHelmet from "@fastify/helmet";
import fastifyJwt from "@fastify/jwt";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
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
import { pilotRoutes } from "./routes/pilot.js";
import { sessionRoutes } from "./routes/sessions.js";

export interface AppOptions {
  db: Db;
  jwtSecret: string;
  authProvider?: AuthProvider;
  logger?: boolean;
  /** Where logs go (tests); defaults to stdout. */
  loggerStream?: NodeJS.WritableStream;
  /** File written by the backup job with the time of the last successful backup. */
  backupStatusFile?: string;
  /** Behind Caddy on the server: take the client address from X-Forwarded-For (for rate limits and logs). */
  trustProxy?: boolean;
  /** Login attempts allowed per client address and username per minute. */
  loginRateLimit?: number;
  /** Built web apps and media to serve, e.g. [{ prefix: "/", root: ".../sim/dist", spa: true }]. */
  staticSites?: { prefix: string; root: string; spa?: boolean }[];
}

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    live: LiveHub;
    opts: AppOptions;
  }
}

/** Cache policy per site: Vite's hashed build files never change; everything else revalidates or is cached a day. */
const cacheHeaders = (hashedBuild: boolean) => (reply: FastifyReply, path: string) => {
  if (hashedBuild && /[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8}\.(js|css|wasm|svg|png|woff2?)$/.test(path)) reply.header("cache-control", "public, max-age=31536000, immutable");
  else if (/\.(glb|task|wasm|wav|mp3|png|jpg|svg)$/.test(path)) reply.header("cache-control", "public, max-age=86400");
  else reply.header("cache-control", "no-cache");
};

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  if (opts.jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  const app = Fastify({
    logger: opts.logger
      ? {
          // Never write tokens to the logs (the live WebSocket carries one in its query string).
          serializers: { req: (r) => ({ method: r.method, url: r.url.replace(/([?&]token=)[^&]*/g, "$1[redacted]"), remoteAddress: r.ip }) },
          redact: ["req.headers.authorization"],
          ...(opts.loggerStream ? { stream: opts.loggerStream } : {}),
        }
      : false,
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: opts.trustProxy ?? false,
  });
  app.decorate("db", opts.db);
  app.decorate("live", new LiveHub());
  app.decorate("opts", opts);

  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_req, body, done) => done(null, body));
  // Spreadsheet uploads arrive as raw bytes.
  app.addContentTypeParser(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream"], { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // MediaPipe compiles its WebAssembly; nothing else needs eval.
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        workerSrc: ["'self'", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'", "ws:", "wss:", "data:", "blob:"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    // The lab PCs fetch the hand model and WebAssembly from this origin only.
    crossOriginEmbedderPolicy: false,
  });
  // Rate limits apply only where a route opts in (login).
  await app.register(fastifyRateLimit, { global: false });

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
  await app.register(pilotRoutes);

  // Serve the built student app and dashboard from the same origin (one server on the LAN).
  for (const [i, site] of (opts.staticSites ?? []).entries()) {
    await app.register(fastifyStatic, { root: site.root, prefix: site.prefix, decorateReply: i === 0, wildcard: true, cacheControl: false, setHeaders: cacheHeaders(!!site.spa) });
  }
  if (opts.staticSites?.length) {
    // Single-page apps: unknown non-API paths fall back to the site's index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      const site = [...opts.staticSites!].filter((s) => s.spa).sort((a, b) => b.prefix.length - a.prefix.length).find((s) => req.url.startsWith(s.prefix));
      if (!site) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html", site.root);
    });
  }
  return app;
}
