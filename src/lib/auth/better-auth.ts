// ============================================================
// Better Auth server config — replaces Supabase Auth.
// ============================================================
// Email + password only (no OAuth / magic links unless asked).
//
// Bridge to the existing schema (the low-risk design):
//   - The CRM's user identity table is `auth.users` (UUID id), created by
//     db/00_compat.sql. Every domain FK (profiles.user_id, deals.assigned_to,
//     …) references it. A DB trigger (`on_auth_user_created` →
//     `handle_new_user`) bootstraps an `accounts` + `profiles` row on INSERT.
//   - We point Better Auth's user model at that table via `user.modelName =
//     "users"` (resolved to auth.users by the pool's search_path) and map its
//     camelCase attributes to the snake_case columns. `generateId: "uuid"`
//     makes Better Auth mint UUIDs so they fit the UUID `id` column.
//   - So signing up a user INSERTs into auth.users → the trigger fires →
//     account + profile are created with zero extra code. Session, account
//     (credentials) and verification tables are plain Better Auth tables in
//     `public` (see db/10_better_auth.sql).
//
// Required env (verified before this file is imported at runtime):
//   DATABASE_URL         Postgres (VPS), SSL.
//   BETTER_AUTH_SECRET   >=32 random chars (openssl rand -base64 32).
//   BETTER_AUTH_URL      canonical deployment URL (scheme + host).
// ============================================================

import { betterAuth } from 'better-auth'

import { pool } from '@/lib/db/pool'

const baseURL =
  process.env.BETTER_AUTH_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.V0_RUNTIME_URL)

export const auth = betterAuth({
  // Reuse the app's single pg Pool (SSL + search_path=public,auth).
  database: pool,
  baseURL,

  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
  },

  advanced: {
    database: {
      // Mint UUIDs for all ids so the user id fits auth.users.id (uuid) and
      // matches every domain FK's type.
      generateId: 'uuid',
    },
    // In dev (v0 preview iframe), force cross-site cookies so the session
    // cookie survives the cross-origin iframe.
    ...(process.env.NODE_ENV === 'development'
      ? {
          defaultCookieAttributes: {
            sameSite: 'none' as const,
            secure: true,
          },
        }
      : {}),
  },

  // Map Better Auth's user model onto the existing auth.users table.
  user: {
    modelName: 'users', // resolves to auth.users via pool search_path
    fields: {
      // attribute (camelCase) -> column (snake_case)
      emailVerified: 'email_verified',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      // `name`, `email`, `image`, `id` already match the columns.
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh once per day
  },

  trustedOrigins: [
    ...(process.env.BETTER_AUTH_URL ? [process.env.BETTER_AUTH_URL] : []),
    ...(process.env.V0_RUNTIME_URL ? [process.env.V0_RUNTIME_URL] : []),
    ...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []),
    ...(process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? [`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`]
      : []),
  ],
})
