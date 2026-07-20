#!/usr/bin/env node
// ============================================================
// ZapFlow CRM — schema applier for self-hosted Postgres (VPS)
// ============================================================
// Applies, in order and idempotently:
//   1. db/00_compat.sql                     (Supabase compatibility prelude)
//   2. supabase/migrations/001..036_*.sql   (original migrations, unchanged)
//   3. db/10_better_auth.sql                (Better Auth tables, if present)
//
// Usage (run as a SUPERUSER role for the one-time setup — it creates roles,
// a publication, and sets some function owners to `postgres`):
//
//   node --env-file-if-exists=.env.development.local db/apply.mjs
//   # or point at a specific DB:
//   DATABASE_URL=postgres://user:pass@host:5432/wacrm_teste?sslmode=require \
//     node db/apply.mjs
//
// Flags:
//   --dry-run   List the files that would run, in order, then exit.
//
// Each file runs inside its own transaction; a failure rolls that file back
// and aborts the run so you can fix and re-run (every file is idempotent).
// ============================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const migrationsDir = join(repoRoot, 'supabase', 'migrations');

const dryRun = process.argv.includes('--dry-run');

function buildFileList() {
  const files = [];

  const compat = join(__dirname, '00_compat.sql');
  if (existsSync(compat)) files.push(compat);

  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  for (const f of migrations) files.push(join(migrationsDir, f));

  const betterAuth = join(__dirname, '10_better_auth.sql');
  if (existsSync(betterAuth)) files.push(betterAuth);

  return files;
}

function rel(p) {
  return p.replace(repoRoot + '/', '');
}

async function main() {
  const files = buildFileList();

  if (dryRun) {
    console.log('[v0] Would apply these files in order:\n');
    files.forEach((f, i) => console.log(`  ${String(i + 1).padStart(2, '0')}. ${rel(f)}`));
    console.log(`\n[v0] ${files.length} file(s). (dry run — nothing executed)`);
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('[v0] ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  const rejectUnauthorized =
    process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false';

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized },
  });

  console.log('[v0] Connecting…');
  await client.connect();
  const { rows } = await client.query(
    'select current_database() db, current_user usr, (select rolsuper from pg_roles where rolname = current_user) is_super',
  );
  console.log(
    `[v0] Connected to "${rows[0].db}" as "${rows[0].usr}" (superuser: ${rows[0].is_super}).`,
  );
  if (!rows[0].is_super) {
    console.warn(
      '[v0] WARNING: not a superuser. Creating roles / publication and "OWNER TO postgres" may fail. See db/00_compat.sql header.',
    );
  }

  let applied = 0;
  try {
    for (const file of files) {
      const sql = readFileSync(file, 'utf8');
      process.stdout.write(`[v0] Applying ${rel(file)} … `);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        applied += 1;
        console.log('ok');
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        console.error(`\n[v0] Error in ${rel(file)}:\n${err.message}\n`);
        throw err;
      }
    }
    console.log(`\n[v0] Done. Applied ${applied}/${files.length} file(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[v0] Aborted:', err.message);
  process.exit(1);
});
