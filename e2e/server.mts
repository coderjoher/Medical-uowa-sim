/** Test server for the browser tests: fresh database, demo data, API + built apps on one port. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "../apps/api/src/app.js";
import { createDb, migrate } from "../apps/api/src/db.js";
import { seedAdmin, seedDemo } from "../apps/api/src/seed-data.js";

const db = createDb(process.env.E2E_DATABASE_URL ?? "postgres://sim:sim@localhost:5432/sim_e2e");
await db.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
await migrate(db);
await seedAdmin(db, "admin-pass-123");
await seedDemo(db, "demo-pass-123");
const app = await buildApp({
  db,
  jwtSecret: "e2e-secret-0123456789-abcdefghijk",
  staticSites: [
    { prefix: "/staff/", root: fileURLToPath(new URL("../apps/dashboard/dist/", import.meta.url)) },
    { prefix: "/", root: fileURLToPath(new URL("../apps/sim/dist/", import.meta.url)) },
  ].filter((s) => existsSync(s.root)),
});
await app.listen({ port: Number(process.env.E2E_PORT ?? 4100), host: "127.0.0.1" });
console.log("e2e server ready");
