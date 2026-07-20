// ============================================================
// Better Auth HTTP handler — replaces Supabase Auth's endpoints.
// ============================================================
// The catch-all segment MUST be [...all]: createAuthClient() routes to
// /api/auth/<endpoint> by default and expects this exact mount point.

import { toNextJsHandler } from 'better-auth/next-js'

import { auth } from '@/lib/auth/better-auth'

export const { GET, POST } = toNextJsHandler(auth.handler)
