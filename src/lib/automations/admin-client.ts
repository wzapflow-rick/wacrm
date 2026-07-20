import { createDbClient, type DbClient } from '@/lib/db/client'

// Shared "admin" data client for the automation engine.
//
// Previously a Supabase service-role client (RLS-bypassing). With RLS gone and
// the app connecting as the table owner, the plain unscoped DbClient is the
// equivalent. Engine paths have no user session, so they MUST scope every
// query by account_id themselves.
let _adminClient: DbClient | null = null

export function supabaseAdmin(): DbClient {
  if (!_adminClient) {
    _adminClient = createDbClient()
  }
  return _adminClient
}
