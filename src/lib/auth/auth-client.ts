'use client'

// ============================================================
// Better Auth React client — the raw client.
// ============================================================
// The Supabase-shaped browser shim (src/lib/supabase/client.ts) wraps this
// into the `.auth.*` API the existing 45 client components expect, so most
// components don't import this directly. Import it when you want the native
// Better Auth API (e.g. useSession in new code).
//
// baseURL is inferred from window.location in the browser, so no env var is
// needed here; the server config owns trustedOrigins.

import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient()

export const { signIn, signUp, signOut, useSession, getSession } = authClient
