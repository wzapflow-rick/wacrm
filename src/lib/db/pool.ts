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
    // Resolve unqualified table names against public first, then auth. The
    // query-builder shim targets public tables; Better Auth's user model is
    // mapped to `users`, which resolves to `auth.users` via this search_path
    // (the auth schema is created by db/00_compat.sql). Better Auth's own
    // session/account/verification tables live in public.
    options: '-c search_path=public,auth',
  })
}

/**
 * Lazily-created singleton pool.
 *
 * The pool is NOT created at import time. If it were, simply importing this
 * module (which `better-auth.ts` and ~30 route modules do) would call
 * `createPool()` and throw when `DATABASE_URL` is absent — exactly what
 * happens during `next build` in Docker, where the database URL is a runtime
 * secret, not a build arg. Deferring creation to the first real query keeps
 * the production build working without a database connection.
 */
export function getPool(): Pool {
  const existing = global.__wacrmPgPool
  if (existing) return existing
  const created = createPool()
  // Reuse across hot reloads in dev and across invocations in production
  // (a single long-lived server process on the VPS).
  global.__wacrmPgPool = created
  return created
}

/**
 * Backwards-compatible `pool` export.
 *
 * A Proxy that forwards every access to the real pool, creating it on first
 * use. This lets `better-auth.ts` keep doing `database: pool` — Better Auth
 * only touches the pool when it runs its first query at runtime, so the real
 * connection is still deferred past build time.
 */
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop) {
    const real = getPool() as unknown as Record<string | symbol, unknown>
    const value = real[prop]
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(real)
      : value
  },
})

/** Run a parameterized query and return all rows. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as never[])
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
  const client = await getPool().connect()
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
