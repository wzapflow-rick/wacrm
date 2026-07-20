import { headers } from 'next/headers'

import { auth } from '@/lib/auth/better-auth'

/**
 * Lightweight session helpers for server actions that only need the caller's
 * identity (not full account/role context — for that use getCurrentAccount /
 * requireRole from '@/lib/auth/account').
 *
 * There is no RLS anymore, so any action using these MUST still scope its
 * queries by the returned user id.
 */

export interface SessionUser {
  id: string
  email: string
  name?: string | null
}

/** Returns the signed-in user, or null when there is no valid session. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return null
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  }
}

/** Like getSessionUser but throws when unauthenticated (use in actions). */
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) throw new Error('Unauthorized')
  return user
}
