import { buildApp } from "./app.js";
import { createDb, migrate } from "./db.js";

const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`missing environment variable ${k}`);
  return v;
};

const db = createDb(env("DATABASE_URL", "postgres://sim:sim@localhost:5432/sim"));
const applied = await migrate(db);
const app = await buildApp({
  db,
  jwtSecret: env("JWT_SECRET"),
  logger: true,
  backupStatusFile: process.env.BACKUP_STATUS_FILE ?? "/backups/last-success",
  staticSites: [
    ...(process.env.DASHBOARD_DIR ? [{ prefix: "/staff/", root: process.env.DASHBOARD_DIR }] : []),
    ...(process.env.SIM_DIR ? [{ prefix: "/", root: process.env.SIM_DIR }] : []),
  ],
});
if (applied.length) app.log.info({ applied }, "migrations applied");
await app.listen({ host: env("HOST", "0.0.0.0"), port: Number(env("PORT", "3000")) });
