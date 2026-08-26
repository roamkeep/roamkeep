-- ============================================================
-- Roamkeep — consolidated schema (canonical)
--
-- This single file recreates the entire database from scratch and is
-- the source of truth for the schema. It folds together every numbered
-- migration in db/migrations/ (v2 → v5).
--
-- Properties:
--   • Idempotent & non-destructive. CREATE TABLE IF NOT EXISTS, ADD
--     COLUMN IF NOT EXISTS, DROP POLICY IF EXISTS + CREATE, CREATE OR
--     REPLACE FUNCTION. Safe to run against a brand-new project (creates
--     everything) AND against the live project (no-ops). It will NOT
--     drop or truncate existing data.
--   • Run it in: Supabase Dashboard → SQL Editor → New query → Run.
--
-- After running, in the Dashboard:
--   Authentication → Settings → "Enable email confirmations" → OFF
--   (lets family members sign up and use the app immediately).
--
-- The numbered files in db/migrations/ remain the historical record and
-- the per-delta path for upgrading a database that's on an older version.
-- For a fresh setup you only need THIS file.
-- ============================================================


-- pgcrypto provides gen_random_bytes for the invite-code generator. On
-- Supabase it lives in the `extensions` schema; IF NOT EXISTS is a no-op
-- there. The generator sets search_path to include `extensions` so the
-- unqualified call resolves wherever pgcrypto is installed.
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ── TABLES ────────────────────────────────────────────────
-- Order matters for foreign keys: keeps → keep_members → checkins →
-- keep_places, then keep_members.last_place_id is added once
-- keep_places exists.

CREATE TABLE IF NOT EXISTS keeps (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  -- Invite codes expire (72h by default, set by create_keep/rotate).
  code_expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS keep_members (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  keep_id           UUID REFERENCES keeps(id) ON DELETE CASCADE NOT NULL,
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name              TEXT NOT NULL,
  avatar            TEXT NOT NULL,
  lat               DOUBLE PRECISION,
  lng               DOUBLE PRECISION,
  battery           INTEGER DEFAULT 100,
  status            TEXT DEFAULT '📍 Location sharing on',
  sos               BOOLEAN DEFAULT FALSE,
  online            BOOLEAN DEFAULT TRUE,
  last_seen         TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  -- Added by later migrations; inlined here for fresh installs.
  fcm_token         TEXT,
  notify_on_checkin BOOLEAN NOT NULL DEFAULT TRUE,
  -- v8: two orthogonal axes + a time-boxed self-pause.
  --   member_type — life-stage / tracking policy (adult may pause &
  --                 reclassify; child may not self-pause/self-remove)
  --   role        — admin power (owner may rotate code, kick, manage)
  --   paused_until— NULL = active; else the future instant tracking
  --                 auto-resumes (adults only, ≤24h out)
  member_type       TEXT NOT NULL DEFAULT 'adult',
  role              TEXT NOT NULL DEFAULT 'member',
  paused_until      TIMESTAMPTZ,
  UNIQUE(keep_id, user_id)
);

-- v8: rate-limit log for join_keep_by_code. Only the DEFINER RPC
-- touches it — RLS is enabled with no policies (default deny), the
-- function bypasses RLS as its owner.
CREATE TABLE IF NOT EXISTS keep_join_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checkins (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  keep_id       UUID REFERENCES keeps(id) ON DELETE CASCADE NOT NULL,
  member_id     UUID REFERENCES keep_members(id) ON DELETE CASCADE NOT NULL,
  member_name   TEXT NOT NULL,
  member_avatar TEXT NOT NULL,
  place         TEXT NOT NULL,
  type          TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS keep_places (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keep_id    uuid NOT NULL REFERENCES keeps(id) ON DELETE CASCADE,
  name       text NOT NULL,
  icon       text NOT NULL DEFAULT '📍',
  lat        double precision NOT NULL,
  lng        double precision NOT NULL,
  radius_m   integer NOT NULL DEFAULT 100,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-member breadcrumb trail. Written ~every couple of minutes (the
-- client throttles by tracking mode), trimmed to 7 days. Drives the
-- map trail and the per-day history timeline. speed is the GPS-reported
-- speed in m/s (nullable — the timeline uses it to tell walks from
-- drives, falling back to distance/time when absent).
CREATE TABLE IF NOT EXISTS location_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keep_id     uuid NOT NULL REFERENCES keeps(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES keep_members(id) ON DELETE CASCADE,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  speed       double precision,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- Schema version marker + compatibility metadata (v12).
--
-- Exactly one row, enforced by the primary key: `id boolean PRIMARY KEY
-- DEFAULT true CHECK (id)` admits only the value true, so a second INSERT
-- conflicts rather than creating a silently divergent second row.
--
-- roamkeep_schema_version() below returns a NUMBER, never a verdict — a
-- database that answered "compatible: yes/no" would bake the client
-- policy of the day into every family's server, and changing that policy
-- later would become a migration for all of them. Returning `12` lets
-- each build decide for itself, per feature. Don't add a boolean here.
--
-- project_url is the project's own https://<ref>.supabase.co. The webhook
-- trigger functions need it to reach their Edge Functions, and this file
-- cannot know it when pasted into a SQL editor — it is set by the
-- provisioning wizard, by set_project_url() on the owner's next app open,
-- or by hand.
CREATE TABLE IF NOT EXISTS roamkeep_meta (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  schema_version integer NOT NULL,
  min_app_build  integer NOT NULL DEFAULT 0,   -- advisory only, never a hard block
  project_url    text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Patch columns onto databases that predate the migration that added
-- them (no-op on a fresh install where they're already inline above).
ALTER TABLE keep_members
  ADD COLUMN IF NOT EXISTS fcm_token text,
  ADD COLUMN IF NOT EXISTS notify_on_checkin boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_place_id uuid
    REFERENCES keep_places(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS member_type  text NOT NULL DEFAULT 'adult',
  ADD COLUMN IF NOT EXISTS role         text NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS paused_until timestamptz;

ALTER TABLE keeps
  ADD COLUMN IF NOT EXISTS code_expires_at timestamptz;

ALTER TABLE location_history
  ADD COLUMN IF NOT EXISTS speed double precision;


-- ── INDEXES ───────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_keep_places_keep_id ON keep_places(keep_id);

-- The notify-checkin edge function fans out on every checkins INSERT by
-- selecting members of the keep with a token; this is the hot path.
CREATE INDEX IF NOT EXISTS idx_keep_members_keep_token
  ON keep_members(keep_id) WHERE fcm_token IS NOT NULL;

-- "This member's points, newest first, within a time window" — the
-- query the breadcrumb trail runs.
CREATE INDEX IF NOT EXISTS idx_lochist_member_time
  ON location_history(keep_id, member_id, recorded_at DESC);

-- Timeline hot path: "this member's check-ins for one day, in order".
CREATE INDEX IF NOT EXISTS idx_checkins_member_time
  ON checkins(keep_id, member_id, created_at DESC);

-- v8: "this user's join attempts in the last hour" — the rate limiter.
CREATE INDEX IF NOT EXISTS idx_join_attempts_user_time
  ON keep_join_attempts(user_id, attempted_at DESC);


-- ── REPLICA IDENTITY ──────────────────────────────────────
-- Postgres default replica identity ships only the PK in DELETE WAL
-- records, so keep_id arrives NULL and the client's keep_id filter
-- rejects the realtime DELETE. FULL includes every column.

ALTER TABLE keep_places REPLICA IDENTITY FULL;


-- ── CHECK CONSTRAINTS ─────────────────────────────────────
-- Input-size limits; defence against a member stuffing giant values.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'keeps_name_len') THEN
    ALTER TABLE keeps ADD CONSTRAINT keeps_name_len CHECK (length(name) BETWEEN 1 AND 40);
  END IF;
  -- v8 widened this from exactly 6 to 6–16 chars: new codes are 12
  -- (31-symbol alphabet), and both lengths must validate during the
  -- grace window. Drop any prior definition so re-running converges.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'keeps_code_fmt') THEN
    ALTER TABLE keeps DROP CONSTRAINT keeps_code_fmt;
  END IF;
  ALTER TABLE keeps ADD CONSTRAINT keeps_code_fmt CHECK (code ~ '^[A-Z0-9]{6,16}$');

  -- v8: member_type / role value domains.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_member_type_values') THEN
    ALTER TABLE keep_members ADD CONSTRAINT nm_member_type_values
      CHECK (member_type IN ('adult', 'child'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_role_values') THEN
    ALTER TABLE keep_members ADD CONSTRAINT nm_role_values
      CHECK (role IN ('owner', 'member'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_name_len') THEN
    ALTER TABLE keep_members ADD CONSTRAINT nm_name_len CHECK (length(name) BETWEEN 1 AND 40);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_avatar_len') THEN
    ALTER TABLE keep_members ADD CONSTRAINT nm_avatar_len CHECK (length(avatar) BETWEEN 1 AND 8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_status_len') THEN
    ALTER TABLE keep_members ADD CONSTRAINT nm_status_len CHECK (length(status) <= 80);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_battery_range') THEN
    ALTER TABLE keep_members ADD CONSTRAINT nm_battery_range CHECK (battery BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_latlng_range') THEN
    ALTER TABLE keep_members ADD CONSTRAINT nm_latlng_range CHECK (
      (lat IS NULL AND lng IS NULL) OR
      (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180)
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_name_len') THEN
    ALTER TABLE checkins ADD CONSTRAINT ck_name_len CHECK (length(member_name) BETWEEN 1 AND 40);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_avatar_len') THEN
    ALTER TABLE checkins ADD CONSTRAINT ck_avatar_len CHECK (length(member_avatar) BETWEEN 1 AND 8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_place_len') THEN
    ALTER TABLE checkins ADD CONSTRAINT ck_place_len CHECK (length(place) BETWEEN 1 AND 120);
  END IF;

  -- checkins.type: 'left' was added in v4 on top of v3's three values.
  -- Drop any prior definition so re-running converges on the full set.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_type_values') THEN
    ALTER TABLE checkins DROP CONSTRAINT ck_type_values;
  END IF;
  ALTER TABLE checkins ADD CONSTRAINT ck_type_values
    CHECK (type IN ('manual', 'arrived', 'sos', 'left'));

  -- keep_places constraints.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'np_name_len') THEN
    ALTER TABLE keep_places ADD CONSTRAINT np_name_len CHECK (length(name) BETWEEN 1 AND 40);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'np_icon_len') THEN
    ALTER TABLE keep_places ADD CONSTRAINT np_icon_len CHECK (length(icon) BETWEEN 1 AND 8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'np_latlng_range') THEN
    ALTER TABLE keep_places ADD CONSTRAINT np_latlng_range
      CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'np_radius_range') THEN
    ALTER TABLE keep_places ADD CONSTRAINT np_radius_range CHECK (radius_m BETWEEN 25 AND 2000);
  END IF;

  -- location_history.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lh_latlng_range') THEN
    ALTER TABLE location_history ADD CONSTRAINT lh_latlng_range
      CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lh_speed_range') THEN
    ALTER TABLE location_history ADD CONSTRAINT lh_speed_range
      CHECK (speed IS NULL OR (speed >= 0 AND speed < 150));
  END IF;
END$$;


-- ── MEMBERSHIP HELPER (avoids RLS recursion) ──────────────
-- A policy on keep_members that subqueries keep_members recurses
-- ("infinite recursion detected in policy for relation keep_members").
-- This SECURITY DEFINER function reads keep_members as its owner, so the
-- read does NOT re-enter RLS — no recursion. Scoped to auth.uid(), so it
-- leaks nothing. Every "is the caller a member of this keep" check routes
-- through it. Defined before the policies that reference it.
CREATE OR REPLACE FUNCTION private_user_keep_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$ SELECT keep_id FROM keep_members WHERE user_id = auth.uid() $$;
REVOKE ALL ON FUNCTION private_user_keep_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private_user_keep_ids() TO authenticated;


-- ── ROW LEVEL SECURITY ────────────────────────────────────

ALTER TABLE keeps              ENABLE ROW LEVEL SECURITY;
ALTER TABLE keep_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkins           ENABLE ROW LEVEL SECURITY;
ALTER TABLE keep_places        ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_history   ENABLE ROW LEVEL SECURITY;
-- No policies on keep_join_attempts → default deny for clients; only the
-- DEFINER join RPC (running as owner) reads/writes it.
ALTER TABLE keep_join_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE roamkeep_meta      ENABLE ROW LEVEL SECURITY;

-- ROAMKEEP_META — readable by everyone including anon, because the
-- version check runs at connect time, BEFORE sign-in, and so cannot
-- require a session. Nothing sensitive lives here: it is the schema's own
-- version number. No write policy for anyone — the row is written by the
-- provisioning wizard (service role) or by set_project_url() below.
DROP POLICY IF EXISTS "Anyone can read schema metadata" ON roamkeep_meta;
CREATE POLICY "Anyone can read schema metadata"
  ON roamkeep_meta FOR SELECT TO anon, authenticated
  USING (true);

-- KEEPS — members-only read (prevents keep-code enumeration). Creation
-- goes exclusively through create_keep (SECURITY DEFINER). v8 DROPPED the
-- direct-INSERT policy: a client never needs it, and it let a caller
-- write a keep row bypassing the RPC.
DROP POLICY IF EXISTS "Authenticated users can read keeps" ON keeps;
DROP POLICY IF EXISTS "Members can read their keep" ON keeps;
CREATE POLICY "Members can read their keep"
  ON keeps FOR SELECT TO authenticated
  USING (id IN (SELECT private_user_keep_ids()));

DROP POLICY IF EXISTS "Authenticated users can create keeps" ON keeps;

-- KEEP_MEMBERS. v8 DROPPED the direct-INSERT policy too: joins go only
-- through join_keep_by_code (SECURITY DEFINER), which enforces the code,
-- the rate limit, and a fixed 'member' role. A direct INSERT would skip
-- all three (and let the caller self-assign 'owner').
DROP POLICY IF EXISTS "Members can read their keep" ON keep_members;
CREATE POLICY "Members can read their keep"
  ON keep_members FOR SELECT TO authenticated
  USING (keep_id IN (SELECT private_user_keep_ids()));

DROP POLICY IF EXISTS "Users can join a keep as themselves" ON keep_members;

-- Own-row UPDATE stays, but a BEFORE UPDATE trigger (below) forbids
-- changing the protected trio role/member_type/paused_until unless the
-- change comes through a DEFINER RPC. So a member can still move their
-- own lat/lng/battery/status/notify/fcm_token/online, but not privilege
-- or pause columns.
DROP POLICY IF EXISTS "Users can update own member row" ON keep_members;
CREATE POLICY "Users can update own member row"
  ON keep_members FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- v8: a CHILD cannot self-remove (deterrent, not a guarantee — the child
-- controls the device). Owners kick via remove_member. Adults may leave.
DROP POLICY IF EXISTS "Users can delete own member row" ON keep_members;
DROP POLICY IF EXISTS "Adults can delete own member row" ON keep_members;
CREATE POLICY "Adults can delete own member row"
  ON keep_members FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND member_type <> 'child');

-- CHECKINS
DROP POLICY IF EXISTS "Keep members can read checkins" ON checkins;
CREATE POLICY "Keep members can read checkins"
  ON checkins FOR SELECT TO authenticated
  USING (keep_id IN (SELECT private_user_keep_ids()));

DROP POLICY IF EXISTS "Keep members can insert checkins" ON checkins;
CREATE POLICY "Keep members can insert checkins"
  ON checkins FOR INSERT TO authenticated
  WITH CHECK (keep_id IN (SELECT private_user_keep_ids()));

-- KEEP_PLACES
DROP POLICY IF EXISTS "Members can read places" ON keep_places;
CREATE POLICY "Members can read places"
  ON keep_places FOR SELECT TO authenticated
  USING (keep_id IN (SELECT private_user_keep_ids()));

DROP POLICY IF EXISTS "Members can insert places" ON keep_places;
CREATE POLICY "Members can insert places"
  ON keep_places FOR INSERT TO authenticated
  WITH CHECK (
    keep_id IN (SELECT private_user_keep_ids())
    AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS "Members can update places" ON keep_places;
CREATE POLICY "Members can update places"
  ON keep_places FOR UPDATE TO authenticated
  USING (keep_id IN (SELECT private_user_keep_ids()));

DROP POLICY IF EXISTS "Members can delete places" ON keep_places;
CREATE POLICY "Members can delete places"
  ON keep_places FOR DELETE TO authenticated
  USING (keep_id IN (SELECT private_user_keep_ids()));

-- LOCATION_HISTORY — read across the keep, write/delete only your own.
DROP POLICY IF EXISTS "Members can read history" ON location_history;
CREATE POLICY "Members can read history"
  ON location_history FOR SELECT TO authenticated
  USING (keep_id IN (SELECT private_user_keep_ids()));

DROP POLICY IF EXISTS "Members can insert own history" ON location_history;
CREATE POLICY "Members can insert own history"
  ON location_history FOR INSERT TO authenticated
  WITH CHECK (
    keep_id IN (SELECT private_user_keep_ids())
    AND member_id IN (SELECT id FROM keep_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Members can delete own history" ON location_history;
CREATE POLICY "Members can delete own history"
  ON location_history FOR DELETE TO authenticated
  USING (member_id IN (SELECT id FROM keep_members WHERE user_id = auth.uid()));


-- ── CODE GENERATOR ────────────────────────────────────────
-- 12 chars from a 31-symbol unambiguous alphabet (no 0/O/1/I/L) via
-- pgcrypto ≈ 2^59 keyspace (replaces the old 6 md5-hex chars). The
-- modulo bias (256 = 8·31 + 8) is immaterial for a family invite code.
-- Internal helper — not granted to clients; the DEFINER RPCs call it.
CREATE OR REPLACE FUNCTION _roamkeep_gen_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public, extensions
AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- 31 symbols
  v_bytes bytea := gen_random_bytes(12);
  v_code  text := '';
  i int;
BEGIN
  FOR i IN 0..11 LOOP
    v_code := v_code || substr(alphabet, (get_byte(v_bytes, i) % 31) + 1, 1);
  END LOOP;
  RETURN v_code;
END;
$$;
REVOKE ALL ON FUNCTION _roamkeep_gen_code() FROM PUBLIC;


-- ── PROTECTED-COLUMN GUARD ────────────────────────────────
-- RLS can't restrict columns, and own-row UPDATE would otherwise let a
-- member rewrite role / member_type / paused_until (self-promote, escape
-- a pause, etc). This BEFORE UPDATE trigger blocks changes to those three
-- unless a transaction-local flag is set — and only the DEFINER RPCs set
-- it (a direct PostgREST call can't), so those columns move only through
-- the authorized RPCs.
CREATE OR REPLACE FUNCTION _roamkeep_guard_member_cols()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.role         IS DISTINCT FROM OLD.role
      OR NEW.member_type  IS DISTINCT FROM OLD.member_type
      OR NEW.paused_until IS DISTINCT FROM OLD.paused_until)
     AND coalesce(current_setting('roamkeep.priv', true), '') <> 'on' THEN
    RAISE EXCEPTION 'protected_column';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_member_cols ON keep_members;
CREATE TRIGGER trg_guard_member_cols
  BEFORE UPDATE ON keep_members
  FOR EACH ROW EXECUTE FUNCTION _roamkeep_guard_member_cols();


-- ── SECURITY DEFINER RPCs ─────────────────────────────────
-- create/join are atomic — they bypass row visibility during the race
-- between inserting the keep and checking membership. v8 adds role/type
-- management, the time-boxed pause, code rotation, and the owner kick.

-- v12: the compatibility check. Returns the version NUMBER so the client
-- decides what to do with it — see the roamkeep_meta comment above.
CREATE OR REPLACE FUNCTION roamkeep_schema_version()
RETURNS TABLE (schema_version integer, min_app_build integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT m.schema_version, m.min_app_build FROM roamkeep_meta m
$$;

-- Deliberately anon-callable, unlike every other function in this file:
-- the check runs before sign-in. Stated explicitly so it reads as a
-- decision rather than as something the v10 advisor cleanup missed.
REVOKE ALL ON FUNCTION public.roamkeep_schema_version() FROM public;
GRANT EXECUTE ON FUNCTION public.roamkeep_schema_version() TO anon, authenticated;

-- v12: let the owner's app tell the database its own URL, so a family who
-- upgraded by pasting this file into the SQL editor still gets working
-- webhooks without a manual step.
--
-- Two constraints, both load-bearing:
--   * Owner only, checked against keep_members.role rather than trusted
--     from the caller.
--   * The value must look like a Supabase project URL. The database POSTs
--     to whatever is stored here, so an unconstrained client-writable
--     endpoint would be an SSRF hole. The regex lives HERE, in the
--     client-callable path, and deliberately NOT as a CHECK on the column
--     — a self-hoster on a custom domain must still be able to set one by
--     direct SQL from the dashboard.
--
-- Write-once: it never overwrites a value already present, so the
-- wizard's value always wins over a client's.
CREATE OR REPLACE FUNCTION set_project_url(p_url text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_owner boolean;
BEGIN
  IF p_url IS NULL OR p_url !~ '^https://[a-z0-9]+\.supabase\.co$' THEN
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM keep_members
    WHERE user_id = auth.uid() AND role = 'owner'
  ) INTO v_is_owner;

  IF NOT v_is_owner THEN
    RETURN false;
  END IF;

  UPDATE roamkeep_meta
     SET project_url = p_url, updated_at = now()
   WHERE project_url IS NULL;

  RETURN FOUND;
END$$;

REVOKE ALL ON FUNCTION public.set_project_url(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_project_url(text) TO authenticated;

CREATE OR REPLACE FUNCTION create_keep(
  p_family_name text,
  p_display_name text,
  p_avatar text
)
RETURNS TABLE (member_id uuid, keep_id uuid, keep_code text, keep_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep keeps%ROWTYPE;
  v_member keep_members%ROWTYPE;
  v_code text;
  v_attempts int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF length(trim(p_family_name)) = 0 OR length(p_family_name) > 40 THEN
    RAISE EXCEPTION 'invalid_family_name';
  END IF;
  IF length(trim(p_display_name)) = 0 OR length(p_display_name) > 40 THEN
    RAISE EXCEPTION 'invalid_display_name';
  END IF;
  IF length(p_avatar) < 1 OR length(p_avatar) > 8 THEN
    RAISE EXCEPTION 'invalid_avatar';
  END IF;

  LOOP
    v_code := _roamkeep_gen_code();
    BEGIN
      INSERT INTO keeps (code, name, created_by, code_expires_at)
      VALUES (v_code, p_family_name, v_uid, now() + interval '72 hours')
      RETURNING * INTO v_keep;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempts := v_attempts + 1;
      IF v_attempts >= 10 THEN
        RAISE EXCEPTION 'code_generation_failed';
      END IF;
    END;
  END LOOP;

  -- Creator is the founding adult + owner.
  INSERT INTO keep_members (keep_id, user_id, name, avatar, role, member_type)
  VALUES (v_keep.id, v_uid, p_display_name, p_avatar, 'owner', 'adult')
  RETURNING * INTO v_member;

  RETURN QUERY SELECT v_member.id, v_keep.id, v_keep.code, v_keep.name;
END;
$$;

REVOKE ALL ON FUNCTION create_keep(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_keep(text, text, text) TO authenticated;

-- join_keep_by_code RETURNS a `status` (not RAISE) for the invalid_code /
-- too_many_attempts cases: the attempt log must persist to count future
-- tries, but a RAISE aborts the transaction and rolls the just-inserted
-- log row back (each PostgREST call is one transaction) — so failed
-- guesses would vanish and the limiter would never trip. Returning a row
-- COMMITS the log. The client maps a non-'ok' status to the same opaque
-- copy, so the oracle stays closed AND the throttle actually works.
-- Signature changed → DROP first (CREATE OR REPLACE can't change it).
DROP FUNCTION IF EXISTS join_keep_by_code(text, text, text);
CREATE OR REPLACE FUNCTION join_keep_by_code(
  p_code text,
  p_display_name text,
  p_avatar text
)
RETURNS TABLE (status text, member_id uuid, keep_id uuid, keep_code text, keep_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep keeps%ROWTYPE;
  v_member keep_members%ROWTYPE;
  v_recent int;
  v_code text := upper(trim(coalesce(p_code, '')));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- The joiner's OWN form fields fail with distinct errors and don't burn
  -- a rate-limit attempt (checked before any log write).
  IF length(trim(p_display_name)) = 0 OR length(p_display_name) > 40 THEN
    RAISE EXCEPTION 'invalid_display_name';
  END IF;
  IF length(p_avatar) < 1 OR length(p_avatar) > 8 THEN
    RAISE EXCEPTION 'invalid_avatar';
  END IF;

  -- Log FIRST, then rate-check, so malformed/wrong codes still count.
  -- >10 in the last hour (this one included) → throttled. RETURN (don't
  -- RAISE) so the log commits.
  INSERT INTO keep_join_attempts (user_id) VALUES (v_uid);
  SELECT count(*) INTO v_recent
    FROM keep_join_attempts
   WHERE user_id = v_uid
     AND attempted_at > now() - interval '1 hour';
  IF v_recent > 10 THEN
    RETURN QUERY SELECT 'too_many_attempts'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- Collapse {bad format, not found, expired} into ONE opaque outcome.
  IF v_code !~ '^[A-Z0-9]{6,16}$' THEN
    RETURN QUERY SELECT 'invalid_code'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;
  SELECT * INTO v_keep FROM keeps WHERE code = v_code;
  IF NOT FOUND OR (v_keep.code_expires_at IS NOT NULL AND v_keep.code_expires_at < now()) THEN
    RETURN QUERY SELECT 'invalid_code'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- Already a member? Return the existing row.
  SELECT * INTO v_member FROM keep_members
    WHERE keep_members.keep_id = v_keep.id
      AND keep_members.user_id = v_uid;
  IF FOUND THEN
    RETURN QUERY SELECT 'ok'::text, v_member.id, v_keep.id, v_keep.code, v_keep.name;
    RETURN;
  END IF;

  INSERT INTO keep_members (keep_id, user_id, name, avatar, role, member_type)
  VALUES (v_keep.id, v_uid, p_display_name, p_avatar, 'member', 'adult')
  RETURNING * INTO v_member;

  RETURN QUERY SELECT 'ok'::text, v_member.id, v_keep.id, v_keep.code, v_keep.name;
END;
$$;

REVOKE ALL ON FUNCTION join_keep_by_code(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION join_keep_by_code(text, text, text) TO authenticated;

-- rotate_keep_code: owner-only. Regenerate + reset the 72h expiry; also
-- the "my code expired" recovery path. Returns the fresh code + expiry.
CREATE OR REPLACE FUNCTION rotate_keep_code(p_keep_id uuid)
RETURNS TABLE (keep_code text, code_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_owner boolean;
  v_code text;
  v_expires timestamptz := now() + interval '72 hours';
  v_attempts int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = p_keep_id AND user_id = v_uid AND role = 'owner'
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  LOOP
    v_code := _roamkeep_gen_code();
    BEGIN
      UPDATE keeps SET code = v_code, code_expires_at = v_expires
       WHERE id = p_keep_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempts := v_attempts + 1;
      IF v_attempts >= 10 THEN
        RAISE EXCEPTION 'code_generation_failed';
      END IF;
    END;
  END LOOP;

  RETURN QUERY SELECT v_code, v_expires;
END;
$$;
REVOKE ALL ON FUNCTION rotate_keep_code(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rotate_keep_code(uuid) TO authenticated;

-- remove_member: owner-only kick. location_history + checkins cascade on
-- the member delete; we also delete history explicitly so the privacy
-- intent is visible and survives any future FK change. Owner can't remove
-- self (that's the leave path).
CREATE OR REPLACE FUNCTION remove_member(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep_id uuid;
  v_target_uid uuid;
  v_is_owner boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT keep_id, user_id INTO v_keep_id, v_target_uid
    FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  IF v_target_uid = v_uid THEN
    RAISE EXCEPTION 'cannot_remove_self';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner'
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  DELETE FROM location_history WHERE member_id = p_member_id;
  DELETE FROM keep_members WHERE id = p_member_id;
END;
$$;
REVOKE ALL ON FUNCTION remove_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION remove_member(uuid) TO authenticated;

-- set_member_role: owner-only (owner ⊆ adults, so "only adults change
-- roles" holds). Refuses to demote the last owner.
CREATE OR REPLACE FUNCTION set_member_role(p_member_id uuid, p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep_id uuid;
  v_cur_role text;
  v_is_owner boolean;
  v_owner_count int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_role NOT IN ('owner', 'member') THEN
    RAISE EXCEPTION 'invalid_role';
  END IF;

  SELECT keep_id, role INTO v_keep_id, v_cur_role
    FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner'
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  IF v_cur_role = 'owner' AND p_role = 'member' THEN
    SELECT count(*) INTO v_owner_count
      FROM keep_members WHERE keep_id = v_keep_id AND role = 'owner';
    IF v_owner_count <= 1 THEN
      RAISE EXCEPTION 'last_owner';
    END IF;
  END IF;

  PERFORM set_config('roamkeep.priv', 'on', true);
  UPDATE keep_members SET role = p_role WHERE id = p_member_id;
  PERFORM set_config('roamkeep.priv', 'off', true);  -- close the window
END;
$$;
REVOKE ALL ON FUNCTION set_member_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_member_role(uuid, text) TO authenticated;

-- set_member_type: OWNER-only reclassifies a member adult/child (same
-- admin bar as set_member_role — owners manage the family; this closes
-- the path where any adult could demote another adult to child). An owner
-- must stay an adult (child owner is incoherent).
CREATE OR REPLACE FUNCTION set_member_type(p_member_id uuid, p_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep_id uuid;
  v_cur_role text;
  v_is_owner boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_type NOT IN ('adult', 'child') THEN
    RAISE EXCEPTION 'invalid_type';
  END IF;

  SELECT keep_id, role INTO v_keep_id, v_cur_role
    FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner'
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  IF v_cur_role = 'owner' AND p_type = 'child' THEN
    RAISE EXCEPTION 'owner_must_be_adult';
  END IF;

  PERFORM set_config('roamkeep.priv', 'on', true);
  UPDATE keep_members SET member_type = p_type WHERE id = p_member_id;
  PERFORM set_config('roamkeep.priv', 'off', true);  -- close the window
END;
$$;
REVOKE ALL ON FUNCTION set_member_type(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_member_type(uuid, text) TO authenticated;

-- pause_member: an adult TIME-BOXES a pause of their OWN tracking
-- (p_until in the future, ≤24h out — always auto-resumes). Children are
-- refused (server-side deterrent; the child still controls the device).
CREATE OR REPLACE FUNCTION pause_member(p_member_id uuid, p_until timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner_uid uuid;
  v_type text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT user_id, member_type INTO v_owner_uid, v_type
    FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  IF v_owner_uid <> v_uid THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF v_type = 'child' THEN
    RAISE EXCEPTION 'child_cannot_pause';
  END IF;
  IF p_until IS NULL OR p_until <= now() OR p_until > now() + interval '24 hours' THEN
    RAISE EXCEPTION 'invalid_pause';
  END IF;

  PERFORM set_config('roamkeep.priv', 'on', true);
  UPDATE keep_members SET paused_until = p_until WHERE id = p_member_id;
  PERFORM set_config('roamkeep.priv', 'off', true);  -- close the window
END;
$$;
REVOKE ALL ON FUNCTION pause_member(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pause_member(uuid, timestamptz) TO authenticated;

-- resume_member: clear an adult's own pause early (self-service only).
CREATE OR REPLACE FUNCTION resume_member(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner_uid uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT user_id INTO v_owner_uid FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  IF v_owner_uid <> v_uid THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  PERFORM set_config('roamkeep.priv', 'on', true);
  UPDATE keep_members SET paused_until = NULL WHERE id = p_member_id;
  PERFORM set_config('roamkeep.priv', 'off', true);  -- close the window
END;
$$;
REVOKE ALL ON FUNCTION resume_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION resume_member(uuid) TO authenticated;

-- rename_keep: owner-only. Change the family name shown at the top of the
-- map. `keeps` has no UPDATE RLS policy (creation/rotation are the only
-- keep writes), so this DEFINER path is the only way to rename. Same
-- length rule as create_keep / the keeps_name_len constraint.
CREATE OR REPLACE FUNCTION rename_keep(p_keep_id uuid, p_name text)
RETURNS TABLE (keep_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_owner boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF length(trim(coalesce(p_name, ''))) = 0 OR length(p_name) > 40 THEN
    RAISE EXCEPTION 'invalid_family_name';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = p_keep_id AND user_id = v_uid AND role = 'owner'
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  UPDATE keeps SET name = trim(p_name) WHERE id = p_keep_id;
  RETURN QUERY SELECT trim(p_name);
END;
$$;
REVOKE ALL ON FUNCTION rename_keep(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rename_keep(uuid, text) TO authenticated;

-- update_member_profile: edit a member's display name + avatar. Allowed
-- for the member themselves OR an owner of that keep (owners set up a
-- child, fix a typo). name/avatar are NOT guard-protected columns, so no
-- roamkeep.priv flag is needed; this DEFINER path exists because the
-- owner-edits-another-member case is cross-row (RLS "update own row"
-- forbids it) and to give one validated path for both cases. Same length
-- rules as create_keep / the nm_name_len / nm_avatar_len constraints.
CREATE OR REPLACE FUNCTION update_member_profile(
  p_member_id uuid,
  p_name text,
  p_avatar text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep_id uuid;
  v_target_uid uuid;
  v_is_owner boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF length(trim(coalesce(p_name, ''))) = 0 OR length(p_name) > 40 THEN
    RAISE EXCEPTION 'invalid_display_name';
  END IF;
  IF length(coalesce(p_avatar, '')) < 1 OR length(p_avatar) > 8 THEN
    RAISE EXCEPTION 'invalid_avatar';
  END IF;

  SELECT keep_id, user_id INTO v_keep_id, v_target_uid
    FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  IF v_target_uid <> v_uid THEN
    SELECT EXISTS (
      SELECT 1 FROM keep_members
       WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner'
    ) INTO v_is_owner;
    IF NOT v_is_owner THEN
      RAISE EXCEPTION 'not_authorized';
    END IF;
  END IF;

  UPDATE keep_members
     SET name = trim(p_name), avatar = p_avatar
   WHERE id = p_member_id;
END;
$$;
REVOKE ALL ON FUNCTION update_member_profile(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION update_member_profile(uuid, text, text) TO authenticated;


-- ── REALTIME PUBLICATION ──────────────────────────────────
-- Supabase Realtime only streams tables in the supabase_realtime
-- publication. Guarded so re-running doesn't error on already-added.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND tablename = 'keep_members') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE keep_members;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND tablename = 'checkins') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE checkins;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND tablename = 'keep_places') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE keep_places;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND tablename = 'location_history') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE location_history;
  END IF;
END$$;

-- ── RETENTION ─────────────────────────────────────────────
-- Breadcrumbs are kept 7 days for the history timeline. The client
-- prunes its own rows on launch; this pg_cron sweep is the server-side
-- guarantee for devices that never come back online. Scheduled only if
-- the pg_cron extension is enabled (Dashboard → Database → Extensions);
-- cron.schedule() upserts by job name so re-running is safe.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'roamkeep-prune-location-history',
      '0 3 * * *',
      $job$DELETE FROM location_history WHERE recorded_at < now() - interval '7 days'$job$
    );
    -- v8: join-attempt log only needs a 1-day window (the rate limiter
    -- looks back 1 hour).
    PERFORM cron.schedule(
      'roamkeep-prune-join-attempts',
      '30 3 * * *',
      $job$DELETE FROM keep_join_attempts WHERE attempted_at < now() - interval '1 day'$job$
    );
  ELSE
    RAISE NOTICE 'pg_cron not enabled — skipping retention jobs. Enable the extension and re-run.';
  END IF;
END$$;

-- ── SCHEMA VERSION STAMP ──────────────────────────────────
-- LAST statement in the file, deliberately. If anything above fails, the
-- version is left untouched, so a half-applied schema reports the OLD
-- version and clients correctly refuse rather than assuming they got what
-- they asked for.
--
-- GREATEST(), not a plain assignment: this file is also re-run as the
-- upgrade path, and it must never walk a database BACKWARDS if someone
-- runs an older checkout of it against a newer database.

INSERT INTO roamkeep_meta (id, schema_version) VALUES (true, 12)
  ON CONFLICT (id) DO UPDATE
    SET schema_version = GREATEST(roamkeep_meta.schema_version, 12),
        updated_at = now();


-- ── DONE ──────────────────────────────────────────────────
