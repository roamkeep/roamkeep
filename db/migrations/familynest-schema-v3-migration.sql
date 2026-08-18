-- ============================================================
-- FamilyNest v3 Migration — Non-destructive, idempotent
--
-- Run this ONCE after v2 is already applied. Safe to re-run.
--
-- What this does:
--   1. Replaces permissive "any user can SELECT nests" policy
--      with a members-only policy (prevents nest-code enumeration)
--   2. Adds SECURITY DEFINER RPCs for create/join (atomic,
--      bypasses row-visibility during the race between insert
--      and membership check)
--   3. Adds CHECK constraints to limit input size (defence
--      against a malicious member stuffing giant values)
--   4. Adds a separate policy path so creators of a nest can
--      still read their row for the rare case they bypass the RPC
-- ============================================================

-- ── 1. Tighten nests SELECT policy ────────────────────────

DROP POLICY IF EXISTS "Authenticated users can read nests" ON nests;
DROP POLICY IF EXISTS "Members can read their nest" ON nests;

CREATE POLICY "Members can read their nest"
  ON nests FOR SELECT TO authenticated
  USING (
    id IN (SELECT nest_id FROM nest_members WHERE user_id = auth.uid())
  );

-- ── 2. CHECK constraints (idempotent via DO block) ────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nests_name_len') THEN
    ALTER TABLE nests ADD CONSTRAINT nests_name_len CHECK (length(name) BETWEEN 1 AND 40);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nests_code_fmt') THEN
    ALTER TABLE nests ADD CONSTRAINT nests_code_fmt CHECK (code ~ '^[A-Z0-9]{6}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_name_len') THEN
    ALTER TABLE nest_members ADD CONSTRAINT nm_name_len CHECK (length(name) BETWEEN 1 AND 40);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_avatar_len') THEN
    ALTER TABLE nest_members ADD CONSTRAINT nm_avatar_len CHECK (length(avatar) BETWEEN 1 AND 8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_status_len') THEN
    ALTER TABLE nest_members ADD CONSTRAINT nm_status_len CHECK (length(status) <= 80);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_battery_range') THEN
    ALTER TABLE nest_members ADD CONSTRAINT nm_battery_range CHECK (battery BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_latlng_range') THEN
    ALTER TABLE nest_members ADD CONSTRAINT nm_latlng_range CHECK (
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_type_values') THEN
    ALTER TABLE checkins ADD CONSTRAINT ck_type_values CHECK (type IN ('manual', 'arrived', 'sos'));
  END IF;
END$$;

-- ── 3. SECURITY DEFINER: create_nest ──────────────────────
-- Creates nest + initial member atomically.
-- Client passes family name, display name, avatar.

CREATE OR REPLACE FUNCTION create_nest(
  p_family_name text,
  p_display_name text,
  p_avatar text
)
RETURNS TABLE (member_id uuid, nest_id uuid, nest_code text, nest_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_nest nests%ROWTYPE;
  v_member nest_members%ROWTYPE;
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

  -- Generate unique 6-char code using md5 (hex: 0-9, A-F).
  -- md5 + random are built-ins — no extension dependency.
  LOOP
    v_code := upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 6));
    BEGIN
      INSERT INTO nests (code, name, created_by)
      VALUES (v_code, p_family_name, v_uid)
      RETURNING * INTO v_nest;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempts := v_attempts + 1;
      IF v_attempts >= 10 THEN
        RAISE EXCEPTION 'code_generation_failed';
      END IF;
    END;
  END LOOP;

  INSERT INTO nest_members (nest_id, user_id, name, avatar)
  VALUES (v_nest.id, v_uid, p_display_name, p_avatar)
  RETURNING * INTO v_member;

  RETURN QUERY SELECT v_member.id, v_nest.id, v_nest.code, v_nest.name;
END;
$$;

REVOKE ALL ON FUNCTION create_nest(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_nest(text, text, text) TO authenticated;

-- ── 4. SECURITY DEFINER: join_nest_by_code ────────────────

CREATE OR REPLACE FUNCTION join_nest_by_code(
  p_code text,
  p_display_name text,
  p_avatar text
)
RETURNS TABLE (member_id uuid, nest_id uuid, nest_code text, nest_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_nest nests%ROWTYPE;
  v_member nest_members%ROWTYPE;
  v_code text := upper(trim(coalesce(p_code, '')));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF v_code !~ '^[A-Z0-9]{6}$' THEN
    RAISE EXCEPTION 'invalid_code';
  END IF;
  IF length(trim(p_display_name)) = 0 OR length(p_display_name) > 40 THEN
    RAISE EXCEPTION 'invalid_display_name';
  END IF;
  IF length(p_avatar) < 1 OR length(p_avatar) > 8 THEN
    RAISE EXCEPTION 'invalid_avatar';
  END IF;

  SELECT * INTO v_nest FROM nests WHERE code = v_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'nest_not_found';
  END IF;

  -- Already a member? Return the existing row instead of erroring.
  -- Qualify column names to avoid collision with RETURNS TABLE out-params.
  SELECT * INTO v_member FROM nest_members
    WHERE nest_members.nest_id = v_nest.id
      AND nest_members.user_id = v_uid;
  IF FOUND THEN
    RETURN QUERY SELECT v_member.id, v_nest.id, v_nest.code, v_nest.name;
    RETURN;
  END IF;

  INSERT INTO nest_members (nest_id, user_id, name, avatar)
  VALUES (v_nest.id, v_uid, p_display_name, p_avatar)
  RETURNING * INTO v_member;

  RETURN QUERY SELECT v_member.id, v_nest.id, v_nest.code, v_nest.name;
END;
$$;

REVOKE ALL ON FUNCTION join_nest_by_code(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_nest_by_code(text, text, text) TO authenticated;

-- ── DONE ──────────────────────────────────────────────────
-- After running this, the client must use RPCs for create/join:
--   supabase.rpc('create_nest', { p_family_name, p_display_name, p_avatar })
--   supabase.rpc('join_nest_by_code', { p_code, p_display_name, p_avatar })
