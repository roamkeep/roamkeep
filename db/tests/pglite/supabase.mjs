// A stand-in for the parts of a Supabase project that db/schema.sql leans on,
// so the schema and the db/tests/*-verify.sql scripts can run in PGlite
// (Postgres compiled to WebAssembly, in-process, no server):
//
//   * the anon / authenticated / service_role roles, and Supabase's DEFAULT
//     PRIVILEGES, which grant every new public table and function to anon
//     and authenticated BY NAME. That is the trap REVOKE ... FROM PUBLIC
//     does not close, so the stand-in has to reproduce it or a missing
//     REVOKE ... FROM anon would pass here and leak there;
//   * auth.users plus auth.uid() / auth.jwt(), which read request.jwt.claims
//     exactly as the real ones do;
//   * pgcrypto in the `extensions` schema, on the search path;
//   * pg_net's net.http_post, recorded into net.calls instead of sent;
//   * the supabase_realtime publication.
//
// What it cannot stand in for, and staging must cover: GoTrue itself (the
// real sign-up path inserts into auth.users as supabase_auth_admin), the real
// pg_net worker, and whatever Supabase's own grants have drifted to since.

import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const read = (rel) => fs.readFileSync(ROOT + rel, 'utf8')

const SHIM = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto SCHEMA extensions;
GRANT USAGE ON SCHEMA public, extensions TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY, instance_id uuid, aud text, role text, email text,
  encrypted_password text, confirmation_token text, recovery_token text,
  email_change_token_new text, email_change text,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  created_at timestamptz, updated_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt() ->> 'role' $$;

CREATE SCHEMA net;
GRANT USAGE ON SCHEMA net TO anon, authenticated, service_role;
CREATE TABLE net.calls (id bigserial PRIMARY KEY, url text, body jsonb, headers jsonb);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}',
    headers jsonb DEFAULT '{}', timeout_milliseconds int DEFAULT 5000) RETURNS bigint
  LANGUAGE sql AS $$ INSERT INTO net.calls(url, body, headers) VALUES (url, body, headers) RETURNING id $$;

CREATE PUBLICATION supabase_realtime;
`

/** pg_net is not a PGlite extension; the stand-in above replaces it. */
export const prep = (sql) => sql.replace(/^CREATE EXTENSION IF NOT EXISTS pg_net;/m, '-- (pg_net: stand-in)')

/** The version a schema file stamps as its last statement. */
export const stampOf = (sql) => Number((sql.match(/GREATEST\(roamkeep_meta\.schema_version,\s*(\d+)\)/) || [])[1])

/** A fresh "project": an empty database with the Supabase stand-in. */
export async function project() {
  const db = await PGlite.create({ extensions: { pgcrypto } })
  await db.exec(SHIM)
  // Supabase's own search_path for the postgres role.
  await db.exec(`SET search_path TO "$user", public, extensions`)
  return db
}

export const addUser = (db, email) => db.query(
  `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
   VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           $1, crypt('Old-Pass-123', gen_salt('bf')), now(), now()) RETURNING id`, [email])
  .then((r) => r.rows[0].id)

/** Session-wide JWT claims, as PostgREST would set them for one request. */
export const actAs = (db, uid) => db.query(`SELECT set_config('request.jwt.claims', $1, false)`,
  [JSON.stringify({ sub: uid, role: 'authenticated' })])
export const signOut = (db) => db.query(`SELECT set_config('request.jwt.claims', '', false)`)

/**
 * The schema as of a git ref (default: the latest release tag), or null with
 * a reason when there is no history to read — the public mirror, a shallow
 * clone. The upgrade test needs a previous release to upgrade FROM.
 */
export function previousSchema(ref) {
  try {
    const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    ref = ref || git('describe', '--tags', '--abbrev=0', '--match', 'v*', '--exclude', '*-rc*').trim()
    return { ref, sql: git('show', `${ref}:db/schema.sql`) }
  } catch {
    return { ref: ref || '(no release tag)', sql: null }
  }
}

/** Run one verify script; print its grid; return the number of failures. */
export async function verify(db, file, label) {
  const res = await db.exec(read(file))
  const rows = res[res.length - 1].rows
  const bad = rows.filter((r) => r.status !== 'PASS' && r.status !== 'SKIP')
  console.log(`\n== ${label}: ${rows.length - bad.length}/${rows.length} ok`)
  for (const r of rows) {
    if (r.status !== 'PASS') console.log(`  ${r.status.padEnd(4)} ${r.step}  — ${r.detail}`)
  }
  await signOut(db)
  return bad.length
}
