import { Pool, type PoolClient, type QueryResultRow } from 'pg'

/**
 * Postgres connection pool for the self-hosted database (VPS).
 *
 * Replaces the Supabase platform. The app (running on Vercel) connects to your
 * own Postgres over SSL. The browser NEVER connects here — all access goes
 * through server-side code (API routes / server actions / the query-builder shim).
 *
 * Required env:
 *   DATABASE_URL  e.g. postgres://user:pass@host:5432/dbname?sslmode=require
 *
 * Optional env:
 *   DATABASE_SSL_REJECT_UNAUTHORIZED  "false" to allow self-signed certs (default: true)
 *   DATABASE_POOL_MAX                 max clients in the pool (default: 10)
 */

declare global {
  // eslint-disable-next-line no-var
  var __wacrmPgPool: Pool | undefined
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Point it at your Postgres (VPS), e.g. ' +
        'postgres://user:pass@host:5432/db?sslmode=require'
    )
  }

  const rejectUnauthorized =
    process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'

  // Enable SSL unless explicitly disabled (local dev without SSL).
  const wantsSsl =
    /sslmode=require|sslmode=verify/.test(connectionString) ||
    process.env.DATABASE_SSL === 'true'

  return new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: wantsSsl ? { rejectUnauthorized } : undefined,
  })
}

/**
 * Singleton pool. Reused across hot reloads in dev and across invocations
 * on the same serverless instance in production.
 */
export const pool: Pool = global.__wacrmPgPool ?? createPool()
if (process.env.NODE_ENV !== 'production') {
  global.__wacrmPgPool = pool
}

/** Run a parameterized query and return all rows. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await pool.query<T>(text, params as never[])
  return result.rows
}

/** Run a parameterized query and return the first row (or null). */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

/** Run work inside a transaction, committing on success and rolling back on error. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // ignore rollback failure
    }
    throw err
  } finally {
    client.release()
  }
}
