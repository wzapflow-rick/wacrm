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
  from<T = unknown>(table: string): PgQueryBuilder<T>
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): PgRpcBuilder<T>
}

export function createDbClient(): DbClient {
  return {
    from<T = unknown>(table: string) {
      return new PgQueryBuilder<T>(table)
    },
    rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}) {
      return new PgRpcBuilder<T>(fn, args)
    },
  }
}
