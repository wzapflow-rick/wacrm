-- ============================================================
-- Better Auth tables + signup bootstrap bridge
-- ============================================================
-- Applied by db/apply.mjs AFTER the compat prelude and the 001..036 migrations.
--
-- The user identity table is `auth.users` (from 00_compat.sql) — Better Auth's
-- user model is mapped onto it (see src/lib/auth/better-auth.ts). Here we add
-- the three remaining Better Auth tables, which live in `public`:
--   session      — active login sessions (cookie token -> user)
--   account      — credentials (email/password hash) and any future providers
--   verification — email-verification / reset tokens (unused for now)
--
-- Column names are camelCase (quoted) to match Better Auth's defaults exactly.
-- `userId` is UUID to reference auth.users(id). Ids are text (Better Auth mints
-- UUID strings via generateId:"uuid"; they fit either a text or uuid column —
-- text keeps session tokens/ids flexible).
-- ============================================================

-- ------------------------------------------------------------
-- session
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.session (
  "id"         TEXT PRIMARY KEY,
  "expiresAt"  TIMESTAMPTZ NOT NULL,
  "token"      TEXT NOT NULL UNIQUE,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "ipAddress"  TEXT,
  "userAgent"  TEXT,
  "userId"     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_user_id_idx ON public.session ("userId");
CREATE INDEX IF NOT EXISTS session_token_idx ON public.session ("token");

-- ------------------------------------------------------------
-- account (credentials / providers)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account (
  "id"                     TEXT PRIMARY KEY,
  "accountId"              TEXT NOT NULL,
  "providerId"             TEXT NOT NULL,
  "userId"                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  "accessToken"            TEXT,
  "refreshToken"           TEXT,
  "idToken"                TEXT,
  "accessTokenExpiresAt"   TIMESTAMPTZ,
  "refreshTokenExpiresAt"  TIMESTAMPTZ,
  "scope"                  TEXT,
  "password"               TEXT,
  "createdAt"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS account_user_id_idx ON public.account ("userId");

-- ------------------------------------------------------------
-- verification (email verification / password reset tokens)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.verification (
  "id"          TEXT PRIMARY KEY,
  "identifier"  TEXT NOT NULL,
  "value"       TEXT NOT NULL,
  "expiresAt"   TIMESTAMPTZ NOT NULL,
  "createdAt"   TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON public.verification ("identifier");

-- ------------------------------------------------------------
-- Signup bootstrap override
-- ------------------------------------------------------------
-- The original trigger (migration 017) reads full_name from
-- raw_user_meta_data, which Supabase Auth populated. Better Auth writes the
-- display name to auth.users.name instead and leaves raw_user_meta_data at
-- '{}'. Redefine the function to prefer raw_user_meta_data.full_name (kept for
-- any legacy path), then fall back to the `name` column, then the email. The
-- trigger `on_auth_user_created` created in 017 keeps pointing at this function.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(
    NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
    NULLIF(NEW.name, ''),
    ''
  );

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

-- Placeholder roles from the compat prelude get read access, mirroring how the
-- migrations grant the domain tables. The app connects as the table owner and
-- bypasses these anyway.
DO $$
BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.session, public.account, public.verification TO authenticated, service_role;
EXCEPTION WHEN undefined_object OR insufficient_privilege THEN
  RAISE NOTICE 'Skipped grants on Better Auth tables (roles missing or not owner).';
END $$;
