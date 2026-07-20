-- ============================================================
-- ZapFlow CRM — compatibility prelude for self-hosted Postgres
-- ============================================================
-- Run this ONCE, BEFORE the existing migrations in supabase/migrations/*.sql.
--
-- Why this exists:
-- The CRM's migrations were written for the Supabase platform and reference
-- objects that only exist there: the `auth` schema (auth.users, auth.uid()),
-- and the `storage` schema (storage.buckets, storage.objects, ...).
--
-- This file recreates minimal, compatible versions of those objects so the
-- original migrations run unchanged on a stock Postgres (your VPS). Data
-- isolation that Supabase enforced with RLS is now enforced in the application
-- layer (see src/lib/auth/account-context.ts). The app connects as the table
-- OWNER role, which bypasses RLS, so the leftover RLS policies are inert.
--
-- Apply order (via psql or pgAdmin):
--   1. db/00_compat.sql              (this file)
--   2. supabase/migrations/001_*.sql … 036_*.sql   (in numeric order)
--   3. db/10_better_auth.sql         (Better Auth tables — added in phase 2)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ------------------------------------------------------------
-- auth schema (replacement for Supabase Auth)
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;

-- Users table. Better Auth writes here (configured in phase 2). Columns are a
-- superset of what the CRM triggers read (email, raw_user_meta_data) and what
-- Better Auth needs. FKs across the app reference auth.users(id).
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  name TEXT,
  image TEXT,
  raw_user_meta_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Returns the current request's user id, read from a session GUC if the app
-- chooses to set it (SET LOCAL app.user_id = '...'). Returns NULL otherwise.
-- The app enforces isolation in code, so this is only a compatibility stub for
-- the legacy RLS policies.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.role', true), ''), 'authenticated')
$$;

CREATE OR REPLACE FUNCTION auth.email()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.email', true), '')
$$;

-- ------------------------------------------------------------
-- storage schema (replacement for Supabase Storage — real files live in MinIO)
-- ------------------------------------------------------------
-- These tables/functions exist only so the storage-related migrations
-- (avatars, chat-media, flow-media buckets + their RLS policies) run without
-- error. Actual file storage is handled by MinIO via src/lib/storage/minio.ts.
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bucket_id TEXT REFERENCES storage.buckets(id),
  name TEXT,
  owner UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB
);

-- Supabase helper: splits an object path into its folder segments.
CREATE OR REPLACE FUNCTION storage.foldername(name TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT string_to_array(name, '/')
$$;

CREATE OR REPLACE FUNCTION storage.filename(name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (string_to_array(name, '/'))[array_upper(string_to_array(name, '/'), 1)]
$$;

CREATE OR REPLACE FUNCTION storage.extension(name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (string_to_array(storage.filename(name), '.'))[
    array_upper(string_to_array(storage.filename(name), '.'), 1)
  ]
$$;
