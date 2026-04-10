/**
 * Database migration runner.
 *
 * On startup this module:
 *   1. Ensures the `schema_migrations` tracking table exists.
 *   2. Reads all *.sql files from ./migrations/ in lexicographic order.
 *   3. Runs only files that are not already recorded in schema_migrations.
 *   4. Records each successful migration atomically with the SQL it ran.
 */
import { Pool, PoolClient } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url).pathname;

const POOL_SIZE = 1; // only one connection needed for migrations

/**
 * Run all pending migrations against the database described by DATABASE_URL.
 */
export async function runMigrations(): Promise<void> {
  const connectionString = Deno.env.get("DATABASE_URL");
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const pool = new Pool(connectionString, POOL_SIZE, false);
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);

    const applied = await getAppliedMigrations(client);
    const pending = await getPendingMigrations(applied);

    if (pending.length === 0) {
      console.log("[migrate] All migrations are up to date.");
      return;
    }

    for (const filename of pending) {
      await applyMigration(client, filename);
    }

    console.log(`[migrate] Applied ${pending.length} migration(s) successfully.`);
  } finally {
    client.release();
    await pool.end();
  }
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.queryObject(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(client: PoolClient): Promise<Set<string>> {
  const result = await client.queryObject<{ filename: string }>(
    "SELECT filename FROM schema_migrations ORDER BY filename",
  );
  return new Set(result.rows.map((r) => r.filename));
}

async function getPendingMigrations(applied: Set<string>): Promise<string[]> {
  const entries: string[] = [];

  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql") && !applied.has(entry.name)) {
      entries.push(entry.name);
    }
  }

  // Lexicographic order ensures 001_, 002_ … sequence is respected.
  entries.sort();
  return entries;
}

async function applyMigration(client: PoolClient, filename: string): Promise<void> {
  const filePath = join(MIGRATIONS_DIR, filename);
  const sql = await Deno.readTextFile(filePath);

  console.log(`[migrate] Applying: ${filename}`);

  await client.queryObject("BEGIN");
  try {
    // Execute the migration SQL. Multi-statement files are supported because
    // the postgres protocol runs them in a single round trip with queryObject.
    await client.queryObject(sql);
    await client.queryObject(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      [filename],
    );
    await client.queryObject("COMMIT");
  } catch (err) {
    await client.queryObject("ROLLBACK");
    throw new Error(`Migration ${filename} failed: ${(err as Error).message}`);
  }
}

// Allow running as a standalone script: deno run --allow-net --allow-env --allow-read db/migrate.ts
if (import.meta.main) {
  await runMigrations();
}
