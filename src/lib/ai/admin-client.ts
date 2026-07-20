import { createDbClient, type DbClient } from '@/lib/db/client'

// Shared "admin" data client for the AI auto-reply path.
//
// The inbound WhatsApp webhook has no `auth.uid()`, so the bot reads config +
// conversation state and sends through this unscoped client. Previously a
// Supabase service-role client; with RLS gone and the app connecting as the
// table owner, the plain DbClient is the equivalent. Scope by account_id in
// the caller.
let _adminClient: DbClient | null = null

export function supabaseAdmin(): DbClient {
  if (!_adminClient) {
    _adminClient = createDbClient()
  }
  return _adminClient
}
