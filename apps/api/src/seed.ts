/** Seeds a fresh install: the admin account, plus demo data with SEED_DEMO=1. */
import { createDb, migrate } from "./db.js";
import { seedAdmin, seedDemo } from "./seed-data.js";

const db = createDb(process.env.DATABASE_URL ?? "postgres://sim:sim@localhost:5432/sim");
await migrate(db);
await seedAdmin(db, process.env.ADMIN_PASSWORD ?? "");
console.log("admin user ready");
if (process.env.SEED_DEMO === "1") {
  const pw = process.env.DEMO_PASSWORD;
  if (!pw) throw new Error("set DEMO_PASSWORD for the demo accounts");
  await seedDemo(db, pw);
  console.log("demo data ready: users instructor, author, student1-3");
}
await db.end();
