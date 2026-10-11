import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { createDb, migrate } from "./db.js";
import { combinedAuthProvider, ldapAuthProvider, ldapConfigFromEnv } from "./ldap.js";
import { localAuthProvider } from "./routes/auth.js";

const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`missing environment variable ${k}`);
  return v;
};

const db = createDb(env("DATABASE_URL", "postgres://sim:sim@localhost:5432/sim"));
const applied = await migrate(db);
// University sign-in through LDAP when LDAP_URL is set; local accounts (break-glass admin) still work.
const ldapConfig = ldapConfigFromEnv(process.env);
const authProvider = ldapConfig ? combinedAuthProvider(localAuthProvider(db), ldapAuthProvider(db, ldapConfig)) : undefined;
const app = await buildApp({
  db,
  jwtSecret: env("JWT_SECRET"),
  ...(authProvider ? { authProvider } : {}),
  logger: true,
  // Caddy terminates HTTPS in front of the API.
  trustProxy: process.env.TRUST_PROXY !== "0",
  backupStatusFile: process.env.BACKUP_STATUS_FILE ?? "/backups/last-success",
  staticSites: [
    // Case media (finding sounds, ECGs, images): content/assets in the repository by default.
    { prefix: "/media/", root: process.env.MEDIA_DIR ?? fileURLToPath(new URL("../../../content/assets/", import.meta.url)) },
    ...(process.env.DASHBOARD_DIR ? [{ prefix: "/staff/", root: process.env.DASHBOARD_DIR, spa: true }] : []),
    ...(process.env.SIM_DIR ? [{ prefix: "/", root: process.env.SIM_DIR, spa: true }] : []),
  ],
});
if (applied.length) app.log.info({ applied }, "migrations applied");
await app.listen({ host: env("HOST", "0.0.0.0"), port: Number(env("PORT", "3000")) });
