/**
 * Drop-in replacement for the Supabase data client, backed by the
 * node-postgres query-builder shim. Exposes `.from(table)` and `.rpc(fn, args)`
 * so existing call sites keep working against your own Postgres.
 *
 * Account/user isolation (previously RLS) is applied by the scoped variant
 * created via `createScopedDbClient` — see src/lib/auth/account-context.ts.
 */
import { PgQueryBuilder, PgRpcBuilder } from './query-builder'

export interface DbClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from<T = any>(table: string): PgQueryBuilder<T>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc<T = any>(fn: string, args?: Record<string, unknown>): PgRpcBuilder<T>
}

export function createDbClient(): DbClient {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from<T = any>(table: string) {
      return new PgQueryBuilder<T>(table)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc<T = any>(fn: string, args: Record<string, unknown> = {}) {
      return new PgRpcBuilder<T>(fn, args)
    },
  }
}
