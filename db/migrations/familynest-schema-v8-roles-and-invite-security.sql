-- ============================================================
-- FamilyNest v8 Migration — Family roles + invite/nest security
--
-- Run this ONCE after v7 is already applied. Safe to re-run
-- (idempotent, non-destructive to member data — but see the
-- CODE REGENERATION note below, which DOES rotate join codes).
--
-- Two workstreams land together because they both reshape
-- nest_members and share the create/join RPC rewrite:
--
-- WS1 — Family roles + member controls
--   • nest_members.member_type  adult | child   (life-stage / policy)
--   • nest_members.role         owner | member  (admin power)
--     …kept as SEPARATE, orthogonal axes on purpose. The nest creator
--     is an adult AND an owner. Only adults may reclassify member_type;
--     only owners may change role (an owner is always an adult, so this
--     still satisfies "only adults change roles"). Children may not.
--   • nest_members.paused_until timestamptz — an adult's TIME-BOXED,
--     auto-expiring self-pause of their own tracking. NULL = active.
--   • RPCs: pause_member / resume_member / set_member_role /
--     set_member_type, all SECURITY DEFINER with the authorization
--     baked in server-side.
--
--   HONEST CAVEAT (mirrored in app copy): the child controls their own
--   device — they can turn GPS off or uninstall the app. Blocking a
--   child from self-pausing / self-removing is a DETERRENT and a
--   family-trust boundary, NOT a cryptographic guarantee. We do not
--   claim enforcement we cannot deliver.
--
-- WS2 — Invite/nest security hardening
--   • Stronger codes: 12 chars from a 31-symbol unambiguous alphabet
--     (no 0/O/1/I/L) via pgcrypto gen_random_bytes ≈ 2^59 keyspace,
--     replacing the old 6 hex chars (~16.7M, non-crypto md5 RNG).
--   • nests.code_expires_at — codes expire (72h default) and rotate.
--   • Rate-limited join with a single opaque error, killing the
--     authenticated brute-force oracle (distinct not_found vs success).
--   • rotate_nest_code (owner-only) + remove_member (owner-only kick).
--   • Drops the direct-INSERT policies that let a client bypass the
--     create/join RPCs (and inject an arbitrary role).
--
-- CODE REGENERATION (destructive to existing invite codes):
--   Existing nests have their 6-char codes REGENERATED to the new
--   12-char format and their code_expires_at set to now()+30 days (a
--   longer grace than the 72h default, since the family didn't ask for
--   this rotation). Any code a family member currently holds STOPS
--   WORKING the moment this runs — owners must reshare via the Invite
--   screen. Join-format validation is widened to ^[A-Z0-9]{6,16}$ so
--   both old-length and new-length inputs pass the format gate and are
--   then judged solely by the (opaque) lookup.
-- ============================================================

-- pgcrypto for gen_random_bytes. On Supabase it already lives in the
-- `extensions` schema; IF NOT EXISTS makes this a no-op there. The code
-- generator sets search_path to include `extensions` so the unqualified
-- call resolves wherever pgcrypto is installed.
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ── COLUMNS ───────────────────────────────────────────────

ALTER TABLE nest_members
  ADD COLUMN IF NOT EXISTS member_type  text NOT NULL DEFAULT 'adult',
  ADD COLUMN IF NOT EXISTS role         text NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS paused_until timestamptz;

ALTER TABLE nests
  ADD COLUMN IF NOT EXISTS code_expires_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_member_type_values') THEN
    ALTER TABLE nest_members ADD CONSTRAINT nm_member_type_values
      CHECK (member_type IN ('adult', 'child'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_role_values') THEN
    ALTER TABLE nest_members ADD CONSTRAINT nm_role_values
      CHECK (role IN ('owner', 'member'));
  END IF;

  -- Widen the code-format check from exactly 6 to 6–16 so the new
  -- 12-char codes are storable and both lengths validate during grace.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nests_code_fmt') THEN
    ALTER TABLE nests DROP CONSTRAINT nests_code_fmt;
  END IF;
  ALTER TABLE nests ADD CONSTRAINT nests_code_fmt CHECK (code ~ '^[A-Z0-9]{6,16}$');
END$$;


-- ── CODE GENERATOR ────────────────────────────────────────
-- 12 chars from a 31-symbol unambiguous alphabet (no 0/O/1/I/L). The
-- modulo of a uniform random byte introduces a negligible bias (256 =
-- 8·31 + 8, so eight symbols are ~9/256 vs ~8/256) — immaterial for a
-- family invite code with a ~2^59 keyspace. Internal helper: not
-- granted to clients; only the DEFINER RPCs (running as owner) call it.
CREATE OR REPLACE FUNCTION _familynest_gen_code()
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
REVOKE ALL ON FUNCTION _familynest_gen_code() FROM PUBLIC;


-- ── JOIN-ATTEMPT LOG (rate limiting) ──────────────────────
-- One row per join_nest_by_code call. Only the DEFINER RPC writes/reads
-- it, so RLS is enabled with NO policies → every direct client access is
-- denied by default; the function (running as owner) bypasses RLS.
CREATE TABLE IF NOT EXISTS nest_join_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_join_attempts_user_time
  ON nest_join_attempts(user_id, attempted_at DESC);
ALTER TABLE nest_join_attempts ENABLE ROW LEVEL SECURITY;


-- ── PROTECTED-COLUMN GUARD ────────────────────────────────
-- RLS can't restrict individual columns, and the existing
-- "Users can update own member row" policy lets a member write ANY
-- column of their own row — including role / member_type / paused_until.
-- Without a guard a child could self-promote to adult, grant themselves
-- owner, or set paused_until directly (bypassing the child check). This
-- BEFORE UPDATE trigger rejects changes to those three columns unless a
-- transaction-local flag is set, and only the DEFINER RPCs set it. A
-- direct PostgREST UPDATE can't set the flag, so it can still move
-- lat/lng/battery/status/notify_on_checkin/fcm_token/online but never
-- the protected trio.
CREATE OR REPLACE FUNCTION _familynest_guard_member_cols()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.role         IS DISTINCT FROM OLD.role
      OR NEW.member_type  IS DISTINCT FROM OLD.member_type
      OR NEW.paused_until IS DISTINCT FROM OLD.paused_until)
     AND coalesce(current_setting('familynest.priv', true), '') <> 'on' THEN
    RAISE EXCEPTION 'protected_column';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_member_cols ON nest_members;
CREATE TRIGGER trg_guard_member_cols
  BEFORE UPDATE ON nest_members
  FOR EACH ROW EXECUTE FUNCTION _familynest_guard_member_cols();


-- ── BACKFILL ──────────────────────────────────────────────
-- 1) Owner = the member whose user_id matches nests.created_by. Everyone
--    else stays 'member'. member_type defaults 'adult' for all existing
--    members (an owner can reclassify from the app afterwards).
UPDATE nest_members m
   SET role = 'owner'
  FROM nests n
 WHERE m.nest_id = n.id
   AND m.user_id = n.created_by
   AND m.role <> 'owner';

-- 2) Regenerate existing codes to the new format + 30-day grace expiry.
--    Only touch nests that still carry a legacy code (<= 8 chars) or have
--    no expiry yet, so re-running this migration doesn't churn codes that
--    were already rotated to the new scheme.
DO $$
DECLARE
  r record;
  v_code text;
  v_attempts int;
BEGIN
  FOR r IN SELECT id FROM nests WHERE length(code) <= 8 OR code_expires_at IS NULL LOOP
    v_attempts := 0;
    LOOP
      v_code := _familynest_gen_code();
      BEGIN
        UPDATE nests
           SET code = v_code,
               code_expires_at = now() + interval '30 days'
         WHERE id = r.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        v_attempts := v_attempts + 1;
        IF v_attempts >= 10 THEN
          RAISE EXCEPTION 'code_regeneration_failed for nest %', r.id;
        END IF;
      END;
    END LOOP;
  END LOOP;
END$$;


-- ── RLS POLICY CHANGES ────────────────────────────────────
-- Drop the direct-INSERT bypasses. create_nest / join_nest_by_code are
-- SECURITY DEFINER and are the ONLY legitimate ways to create a nest or
-- a membership; a direct client INSERT would skip the join code, the
-- rate limiter, and let the caller pick their own role. The app never
-- inserts these rows directly (verified: it calls the RPCs).
DROP POLICY IF EXISTS "Authenticated users can create nests" ON nests;
DROP POLICY IF EXISTS "Users can join a nest as themselves" ON nest_members;

-- Tighten own-row DELETE so a CHILD cannot self-remove. (Deterrent, not
-- a guarantee — see the caveat at the top.) Owners kick via remove_member.
DROP POLICY IF EXISTS "Users can delete own member row" ON nest_members;
CREATE POLICY "Adults can delete own member row"
  ON nest_members FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND member_type <> 'child');


-- ── RPCs ──────────────────────────────────────────────────

-- create_nest: same signature; now issues a 12-char code with a 72h
-- expiry and stamps the creator as adult + owner.
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

  LOOP
    v_code := _familynest_gen_code();
    BEGIN
      INSERT INTO nests (code, name, created_by, code_expires_at)
      VALUES (v_code, p_family_name, v_uid, now() + interval '72 hours')
      RETURNING * INTO v_nest;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempts := v_attempts + 1;
      IF v_attempts >= 10 THEN
        RAISE EXCEPTION 'code_generation_failed';
      END IF;
    END;
  END LOOP;

  -- Creator is the founding adult + owner.
  INSERT INTO nest_members (nest_id, user_id, name, avatar, role, member_type)
  VALUES (v_nest.id, v_uid, p_display_name, p_avatar, 'owner', 'adult')
  RETURNING * INTO v_member;

  RETURN QUERY SELECT v_member.id, v_nest.id, v_nest.code, v_nest.name;
END;
$$;
REVOKE ALL ON FUNCTION create_nest(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_nest(text, text, text) TO authenticated;


-- join_nest_by_code: rate-limited join with a single opaque outcome.
--
-- Now RETURNS a `status` column instead of RAISE-ing for the
-- invalid_code / too_many_attempts cases. Why: the attempt log must
-- persist to count future tries, but a RAISE aborts the transaction and
-- rolls the just-inserted log row back (each PostgREST call is one
-- transaction) — so a brute-forcer's failed guesses would vanish and the
-- limiter would never trip. Returning a normal row COMMITS the log. The
-- client maps a non-'ok' status to the same opaque copy, so the security
-- intent (wrong/expired/not-found indistinguishable, throttled) is
-- preserved AND actually enforced. Genuine input errors (auth, display
-- name, avatar) still RAISE — they're checked before any log write.
--
-- Signature changed (added status), so DROP first — CREATE OR REPLACE
-- can't change a function's return type.
DROP FUNCTION IF EXISTS join_nest_by_code(text, text, text);
CREATE OR REPLACE FUNCTION join_nest_by_code(
  p_code text,
  p_display_name text,
  p_avatar text
)
RETURNS TABLE (status text, member_id uuid, nest_id uuid, nest_code text, nest_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_nest nests%ROWTYPE;
  v_member nest_members%ROWTYPE;
  v_recent int;
  v_code text := upper(trim(coalesce(p_code, '')));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- The joiner's OWN form fields fail with distinct, actionable errors and
  -- don't burn a rate-limit attempt (checked before any log write).
  IF length(trim(p_display_name)) = 0 OR length(p_display_name) > 40 THEN
    RAISE EXCEPTION 'invalid_display_name';
  END IF;
  IF length(p_avatar) < 1 OR length(p_avatar) > 8 THEN
    RAISE EXCEPTION 'invalid_avatar';
  END IF;

  -- Log the attempt FIRST, then rate-check — a malformed/wrong code still
  -- counts. >10 in the last hour (this one included) → throttled. RETURN
  -- (don't RAISE) so the log commits.
  INSERT INTO nest_join_attempts (user_id) VALUES (v_uid);
  SELECT count(*) INTO v_recent
    FROM nest_join_attempts
   WHERE user_id = v_uid
     AND attempted_at > now() - interval '1 hour';
  IF v_recent > 10 THEN
    RETURN QUERY SELECT 'too_many_attempts'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- Collapse {bad format, not found, expired} into ONE opaque outcome so
  -- the caller can't tell them apart — no enumeration oracle.
  IF v_code !~ '^[A-Z0-9]{6,16}$' THEN
    RETURN QUERY SELECT 'invalid_code'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;
  SELECT * INTO v_nest FROM nests WHERE code = v_code;
  IF NOT FOUND OR (v_nest.code_expires_at IS NOT NULL AND v_nest.code_expires_at < now()) THEN
    RETURN QUERY SELECT 'invalid_code'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- Already a member? Return the existing row.
  SELECT * INTO v_member FROM nest_members
    WHERE nest_members.nest_id = v_nest.id
      AND nest_members.user_id = v_uid;
  IF FOUND THEN
    RETURN QUERY SELECT 'ok'::text, v_member.id, v_nest.id, v_nest.code, v_nest.name;
    RETURN;
  END IF;

  -- Joiners are ordinary adult members; an owner reclassifies afterwards.
  INSERT INTO nest_members (nest_id, user_id, name, avatar, role, member_type)
  VALUES (v_nest.id, v_uid, p_display_name, p_avatar, 'member', 'adult')
  RETURNING * INTO v_member;

  RETURN QUERY SELECT 'ok'::text, v_member.id, v_nest.id, v_nest.code, v_nest.name;
END;
$$;
REVOKE ALL ON FUNCTION join_nest_by_code(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_nest_by_code(text, text, text) TO authenticated;


-- rotate_nest_code: owner-only. Regenerate + reset the 72h expiry. Also
-- the "my code expired" recovery path. Returns the fresh code + expiry.
CREATE OR REPLACE FUNCTION rotate_nest_code(p_nest_id uuid)
RETURNS TABLE (nest_code text, code_expires_at timestamptz)
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
    SELECT 1 FROM nest_members
     WHERE nest_id = p_nest_id AND user_id = v_uid AND role = 'owner'
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  LOOP
    v_code := _familynest_gen_code();
    BEGIN
      UPDATE nests
         SET code = v_code, code_expires_at = v_expires
       WHERE id = p_nest_id;
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
REVOKE ALL ON FUNCTION rotate_nest_code(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotate_nest_code(uuid) TO authenticated;


-- remove_member: owner-only kick. location_history.member_id and
-- checkins.member_id both cascade ON DELETE, so deleting the member row
-- already removes their breadcrumbs + check-ins; we also delete the
-- history explicitly first, so the privacy intent is visible in code and
-- survives any future change to the FK. An owner can't remove themselves
-- here (they'd orphan ownership) — that's the leave/delete-own-row path.
CREATE OR REPLACE FUNCTION remove_member(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_nest_id uuid;
  v_target_uid uuid;
  v_is_owner boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT nest_id, user_id INTO v_nest_id, v_target_uid
    FROM nest_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  IF v_target_uid = v_uid THEN
    RAISE EXCEPTION 'cannot_remove_self';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM nest_members
     WHERE nest_id = v_nest_id AND user_id = v_uid AND role = 'owner'
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  DELETE FROM location_history WHERE member_id = p_member_id;
  DELETE FROM nest_members WHERE id = p_member_id;
END;
$$;
REVOKE ALL ON FUNCTION remove_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION remove_member(uuid) TO authenticated;


-- set_member_role: owner-only (an owner is always an adult, so this also
-- satisfies "only adults change roles"). Guards against demoting the
-- last owner, which would strand the nest with no admin.
CREATE OR REPLACE FUNCTION set_member_role(p_member_id uuid, p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_nest_id uuid;
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

  SELECT nest_id, role INTO v_nest_id, v_cur_role
    FROM nest_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM nest_members
     WHERE nest_id = v_nest_id AND user_id = v_uid AND role = 'owner'
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  -- Demoting the sole owner would leave the nest adminless.
  IF v_cur_role = 'owner' AND p_role = 'member' THEN
    SELECT count(*) INTO v_owner_count
      FROM nest_members WHERE nest_id = v_nest_id AND role = 'owner';
    IF v_owner_count <= 1 THEN
      RAISE EXCEPTION 'last_owner';
    END IF;
  END IF;

  PERFORM set_config('familynest.priv', 'on', true);
  UPDATE nest_members SET role = p_role WHERE id = p_member_id;
  PERFORM set_config('familynest.priv', 'off', true);  -- close the window
END;
$$;
REVOKE ALL ON FUNCTION set_member_role(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_member_role(uuid, text) TO authenticated;


-- set_member_type: any ADULT in the nest may reclassify a member as
-- adult/child. An owner must stay an adult (a child owner is incoherent),
-- so demoting an owner to child is refused.
CREATE OR REPLACE FUNCTION set_member_type(p_member_id uuid, p_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_nest_id uuid;
  v_cur_role text;
  v_is_adult boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_type NOT IN ('adult', 'child') THEN
    RAISE EXCEPTION 'invalid_type';
  END IF;

  SELECT nest_id, role INTO v_nest_id, v_cur_role
    FROM nest_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM nest_members
     WHERE nest_id = v_nest_id AND user_id = v_uid AND member_type = 'adult'
  ) INTO v_is_adult;
  IF NOT v_is_adult THEN
    RAISE EXCEPTION 'not_adult';
  END IF;

  IF v_cur_role = 'owner' AND p_type = 'child' THEN
    RAISE EXCEPTION 'owner_must_be_adult';
  END IF;

  PERFORM set_config('familynest.priv', 'on', true);
  UPDATE nest_members SET member_type = p_type WHERE id = p_member_id;
  PERFORM set_config('familynest.priv', 'off', true);  -- close the window
END;
$$;
REVOKE ALL ON FUNCTION set_member_type(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_member_type(uuid, text) TO authenticated;


-- pause_member: an adult TIME-BOXES a pause of their OWN tracking. Not an
-- open-ended switch — p_until must be in the future and within 24h, so it
-- always auto-resumes (the common failure is going dark and forgetting).
-- Children are refused here (server-side deterrent; the child still
-- controls their device — see the caveat at the top).
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
    FROM nest_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  -- Self-service only, and only adults.
  IF v_owner_uid <> v_uid THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF v_type = 'child' THEN
    RAISE EXCEPTION 'child_cannot_pause';
  END IF;

  IF p_until IS NULL OR p_until <= now() OR p_until > now() + interval '24 hours' THEN
    RAISE EXCEPTION 'invalid_pause';
  END IF;

  PERFORM set_config('familynest.priv', 'on', true);
  UPDATE nest_members SET paused_until = p_until WHERE id = p_member_id;
  PERFORM set_config('familynest.priv', 'off', true);  -- close the window
END;
$$;
REVOKE ALL ON FUNCTION pause_member(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pause_member(uuid, timestamptz) TO authenticated;


-- resume_member: clear an adult's own pause early (auto-resume otherwise
-- happens when paused_until passes). Self-service only.
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

  SELECT user_id INTO v_owner_uid FROM nest_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  IF v_owner_uid <> v_uid THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  PERFORM set_config('familynest.priv', 'on', true);
  UPDATE nest_members SET paused_until = NULL WHERE id = p_member_id;
  PERFORM set_config('familynest.priv', 'off', true);  -- close the window
END;
$$;
REVOKE ALL ON FUNCTION resume_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resume_member(uuid) TO authenticated;


-- ── RETENTION ─────────────────────────────────────────────
-- Extend the v7 pg_cron pattern to also prune stale join-attempt rows
-- (>1 day). Scheduled only if pg_cron is enabled; upserts by job name.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'familynest-prune-join-attempts',
      '30 3 * * *',
      $job$DELETE FROM nest_join_attempts WHERE attempted_at < now() - interval '1 day'$job$
    );
  ELSE
    RAISE NOTICE 'pg_cron not enabled — skipping join-attempts prune. Enable the extension and re-run.';
  END IF;
END$$;

-- ── DONE ──────────────────────────────────────────────────
