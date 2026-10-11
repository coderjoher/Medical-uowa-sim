import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

export type Db = pg.Pool;

export function createDb(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 20 });
}

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

/** Applies any migration files not yet recorded in schema_migrations, in name order. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(readFileSync(new URL(name, MIGRATIONS_DIR), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      applied.push(name);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  return applied;
}

/** Runs `fn` in a transaction. */
export async function tx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
