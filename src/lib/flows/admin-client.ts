import { createDbClient, type DbClient } from '@/lib/db/client'

// Shared "admin" data client for the Flows engine.
//
// Previously a Supabase service-role client (RLS-bypassing). There is no RLS
// anymore, and the app connects to Postgres as the table owner, so the plain
// unscoped DbClient is the equivalent: engine/webhook paths have no user
// session, so they read config + state and write through this client and MUST
// scope every query by account_id themselves (same discipline as before).
let _adminClient: DbClient | null = null

export function supabaseAdmin(): DbClient {
  if (!_adminClient) {
    _adminClient = createDbClient()
  }
  return _adminClient
}
