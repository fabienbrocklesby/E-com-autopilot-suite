/**
 * PostgreSQL connection pool using the deno-postgres driver.
 * All database interactions in the app go through `query` and `queryOne`.
 */
import { Pool, PoolClient } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const POOL_SIZE = parseInt(Deno.env.get("DB_POOL_SIZE") ?? "10");

let _pool: Pool | null = null;

/** Returns the singleton connection pool, creating it on first call. */
function getPool(): Pool {
  if (_pool === null) {
    const connectionString = Deno.env.get("DATABASE_URL");
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    _pool = new Pool(connectionString, POOL_SIZE, true /* lazy */);
  }
  return _pool;
}

/**
 * Execute a parameterised SQL query and return all matching rows typed as T.
 *
 * @param sql  Parameterised SQL string using $1, $2 … placeholders.
 * @param args Ordered parameter values.
 */
export async function query<T>(sql: string, args: unknown[] = []): Promise<T[]> {
  const pool = getPool();
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    const result = await client.queryObject<T>({ text: sql, args });
    return result.rows;
  } finally {
    client?.release();
  }
}

/**
 * Execute a parameterised SQL query and return the first row, or null if no
 * rows match.
 */
export async function queryOne<T>(
  sql: string,
  args: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, args);
  return rows[0] ?? null;
}

/**
 * Execute a parameterised SQL query for side effects only (INSERT, UPDATE,
 * DELETE). Returns the number of rows affected.
 */
export async function execute(sql: string, args: unknown[] = []): Promise<number> {
  const pool = getPool();
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    const result = await client.queryObject({ text: sql, args });
    return result.rowCount ?? 0;
  } finally {
    client?.release();
  }
}

/**
 * Run multiple statements inside a single transaction. Rolls back on any error.
 */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.queryObject("BEGIN");
    const result = await fn(client);
    await client.queryObject("COMMIT");
    return result;
  } catch (err) {
    await client.queryObject("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
