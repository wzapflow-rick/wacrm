// ============================================================
// Server-side data + auth client — Supabase-shaped shim.
// ============================================================
// Drop-in for the old `@/lib/supabase/server` `createClient()`. Returns an
// object with the subset of the Supabase client the server code uses:
//   .from(table) / .rpc(fn, args)   → node-postgres query-builder shim
//   .auth.getUser() / getSession()  → Better Auth session (from cookies)
//   .auth.signOut() / updateUser()  → Better Auth
//   .storage.from(bucket)           → MinIO (see src/lib/storage) — Phase 4
//
// NOTE ON ISOLATION: with Supabase gone there is no RLS. Server routes must
// scope queries by accountId themselves. The account context helper
// (src/lib/auth/account-context.ts) returns a *scoped* client for that; this
// raw client is unscoped and should only be used behind an explicit account
// filter, exactly as the public-API service-role client always has been.

import { headers } from 'next/headers'

import { auth } from '@/lib/auth/better-auth'
import { createDbClient, type DbClient } from '@/lib/db/client'
import { createServerStorage, type StorageClient } from '@/lib/storage/server'

/** Supabase-shaped user object. The code only reads `id` and `email`. */
export interface ShimUser {
  id: string
  email: string | null
  user_metadata: Record<string, unknown>
  app_metadata: Record<string, unknown>
}

export interface ShimSession {
  user: ShimUser
  expires_at: number | null
}

interface AuthResult<T> {
  data: T
  error: { message: string } | null
}

export interface ServerClient extends DbClient {
  auth: {
    getUser(): Promise<AuthResult<{ user: ShimUser | null }>>
    getSession(): Promise<AuthResult<{ session: ShimSession | null }>>
    signOut(): Promise<{ error: { message: string } | null }>
    updateUser(attrs: {
      password?: string
      email?: string
      data?: Record<string, unknown>
    }): Promise<AuthResult<{ user: ShimUser | null }>>
  }
  storage: StorageClient
}

function toShimUser(user: {
  id: string
  email?: string | null
  name?: string | null
  image?: string | null
}): ShimUser {
  return {
    id: user.id,
    email: user.email ?? null,
    user_metadata: { full_name: user.name ?? null, avatar_url: user.image ?? null },
    app_metadata: {},
  }
}

export async function createClient(): Promise<ServerClient> {
  const db = createDbClient()
  const hdrs = await headers()

  const resolveSession = async () => {
    try {
      return await auth.api.getSession({ headers: hdrs })
    } catch (err) {
      console.log('[v0] server auth.getSession failed:', (err as Error).message)
      return null
    }
  }

  return {
    from: db.from.bind(db),
    rpc: db.rpc.bind(db),
    storage: createServerStorage(),
    auth: {
      async getUser() {
        const session = await resolveSession()
        return {
          data: { user: session?.user ? toShimUser(session.user) : null },
          error: session?.user ? null : { message: 'Auth session missing' },
        }
      },
      async getSession() {
        const session = await resolveSession()
        if (!session?.user) {
          return { data: { session: null }, error: null }
        }
        return {
          data: {
            session: {
              user: toShimUser(session.user),
              expires_at: session.session?.expiresAt
                ? Math.floor(new Date(session.session.expiresAt).getTime() / 1000)
                : null,
            },
          },
          error: null,
        }
      },
      async signOut() {
        try {
          await auth.api.signOut({ headers: hdrs })
          return { error: null }
        } catch (err) {
          return { error: { message: (err as Error).message } }
        }
      },
      async updateUser(attrs) {
        try {
          if (attrs.password) {
            await auth.api.changePassword({
              headers: hdrs,
              body: { newPassword: attrs.password, currentPassword: '' },
            })
          }
          const session = await resolveSession()
          return {
            data: { user: session?.user ? toShimUser(session.user) : null },
            error: null,
          }
        } catch (err) {
          return { data: { user: null }, error: { message: (err as Error).message } }
        }
      },
    },
  }
}
