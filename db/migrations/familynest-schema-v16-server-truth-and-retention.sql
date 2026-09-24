-- v16 — the server decides what a client used to be trusted with
--
-- Runs against an EXISTING live database. Idempotent and safe to re-run.
-- Sets schema_version = 16. REQUIRES v15.
--
-- Every function body below is copied verbatim from db/schema.sql, which
-- remains the canonical file: an owner may equally just re-paste that.
--
-- ── What it closes ──────────────────────────────────────────────
--
--   1. set_project_url accepted any supabase.co URL from any owner of any
--      keep, and create_keep makes anyone an owner — so a stranger holding a
--      shared setup link could redirect every webhook (check-ins with SOS
--      coordinates, place rows, and the webhook secret) to their own project
--      while project_url was still NULL, permanently. It now accepts only
--      the project's own URL, read from the caller's signed JWT issuer.
--
--   2. Devices paged push notifications by checkins.created_at, which the
--      writing device supplies. A late row (a queued crossing) was skipped;
--      one future-dated row silenced every alert in the keep, SOS included.
--      New server-set inserted_at to page by; created_at is clamped to at
--      most 5 minutes ahead; existing future-dated rows are repaired.
--
--   3. checkins.member_name / member_avatar were free text: a member could
--      file "🆘 Mum sent an SOS" as themselves. Now taken from the member row.
--
--   4. keep_member_push, checkins and location_history INSERT checked
--      member_id and keep_id separately. They must now be ONE membership.
--      One Keep per account from here on (create/join refuse a second).
--
--   5. Showing the invite code only to owners was UI-only. get_invite() is
--      the owner-only read; 4.9.0 stops selecting keeps.code. (Expand only —
--      the column stays readable until pre-4.9.0 apps are gone.)
--
--   6. Place 101 disarmed every geofence on every device (Play Services'
--      100-fence limit is all-or-nothing). Capped at 90 per keep.
--
--   7. Owner-count checks raced: two owners acting at once could leave a
--      keep with none. Ownership changes now take the keep's row lock.
--
--   8. Retention. Check-ins were never deleted, and the 7-day promise for
--      breadcrumbs held only with pg_cron. prune_keep_history() lets any
--      member's app enforce 7 days for the whole keep; pg_cron gains a
--      check-in sweep. (Owner decision 2026-09-23: check-ins keep 7 days.)
--
--   9. The check-in webhook trigger written by the setup wizard sends no
--      x-roamkeep-webhook header, so since v14 notify-checkin has answered
--      403 to every check-in on any project the wizard provisioned or
--      upgraded. Replaced with the secret-sending version when project_url
--      is set.
--
-- ── Client compatibility ────────────────────────────────────────
--
-- ADDITIVE for every installed app: nothing an older client sends or
-- selects is renamed or removed. Older apps simply keep paging by
-- created_at, keep reading keeps.code, and have their check-in names
-- corrected server-side. NEEDS_SCHEMA in app.js stays at 13 — 4.9.0 gates
-- each v16 feature on schema_version >= 16 and falls back without it.
--
-- One behaviour change an older app can meet: an account that already
-- belongs to a Keep can no longer create or join another. No app build has
-- ever offered that, so only a hand-crafted request is affected.

begin;


-- ── §1 checkins.inserted_at — repair future dates, backfill, then NOT NULL ───

-- v16. checkins.inserted_at: when the SERVER received the row, set by
-- _roamkeep_checkin_normalise. Devices page their notifications by it,
-- because created_at is whatever time the writing device reported.
--
-- Order matters. First pull any FUTURE-dated created_at back to now: a
-- device pages its notifications by the newest timestamp it has seen, so
-- one row dated tomorrow (a phone with its clock set ahead, or a member
-- writing to the API directly) pinned every device's watermark there and
-- silenced every notification in the keep, SOS included, until then. The
-- insert trigger below stops new ones; this repairs any already stored.
-- Then backfill inserted_at for historical rows from their (now sane)
-- created_at, and only then make the column NOT NULL.
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS inserted_at timestamptz;
UPDATE checkins SET created_at = now()
 WHERE created_at > now() + interval '5 minutes';
UPDATE checkins SET inserted_at = LEAST(coalesce(created_at, now()), now())
 WHERE inserted_at IS NULL;
ALTER TABLE checkins
  ALTER COLUMN inserted_at SET DEFAULT now(),
  ALTER COLUMN inserted_at SET NOT NULL;


-- ── §2 indexes ──────────────────────────────────────────────────────

-- v16: a woken device asks "this keep's check-ins received since X".
CREATE INDEX IF NOT EXISTS idx_checkins_keep_inserted
  ON checkins(keep_id, inserted_at DESC);

-- v16: the activity feed ("this keep's newest check-ins") and the 7-day
-- retention sweep. idx_checkins_member_time leads with member_id after
-- keep_id, so it cannot serve a keep-wide ordering.
CREATE INDEX IF NOT EXISTS idx_checkins_keep_created
  ON checkins(keep_id, created_at DESC);

-- v16: private_user_keep_ids() — inside almost every RLS check — looks
-- memberships up by user_id, and the only index leads with keep_id.
CREATE INDEX IF NOT EXISTS idx_keep_members_user
  ON keep_members(user_id);


-- ── §3 keep_member_push — pair-bound policy, and heal mis-pointed rows ───

-- KEEP_MEMBER_PUSH — own row only, and deliberately no keep-wide SELECT.
-- That asymmetry with every other table in this file IS the fix: a push
-- token is not something the rest of the family has any business reading.
--
-- v16 binds (member_id, keep_id) as a PAIR to one of the caller's own
-- memberships. Checking member_id alone let a row carry any keep_id, and
-- keep_push_recipients() selects by keep_id — so a member who knew another
-- keep's uuid could point their token at it and be woken whenever that
-- family's places changed. The same pairing is applied to the checkins and
-- location_history INSERT policies below.
DROP POLICY IF EXISTS "Members manage own push row" ON keep_member_push;
CREATE POLICY "Members manage own push row"
  ON keep_member_push FOR ALL TO authenticated
  USING      ((member_id, keep_id) IN (SELECT id, keep_id FROM keep_members WHERE user_id = auth.uid()))
  WITH CHECK ((member_id, keep_id) IN (SELECT id, keep_id FROM keep_members WHERE user_id = auth.uid()));

-- Heal any row already pointed at the wrong keep, so its owner can still
-- update it under the pairing above. Runs as the schema owner.
UPDATE keep_member_push p
   SET keep_id = m.keep_id, updated_at = now()
  FROM keep_members m
 WHERE m.id = p.member_id AND p.keep_id IS DISTINCT FROM m.keep_id;


-- ── §4 checkins INSERT policy — pair-bound ──────────────────────────

-- v16: member_id and keep_id must be ONE membership of the caller's, not
-- merely each belong to them — see the note on keep_member_push above.
DROP POLICY IF EXISTS "Keep members can insert checkins" ON checkins;
CREATE POLICY "Keep members can insert checkins"
  ON checkins FOR INSERT TO authenticated
  WITH CHECK (
    (member_id, keep_id) IN (SELECT id, keep_id FROM keep_members WHERE user_id = auth.uid())
  );


-- ── §5 location_history INSERT policy — pair-bound ──────────────────

-- v16: pair-bound, as for checkins.
DROP POLICY IF EXISTS "Members can insert own history" ON location_history;
CREATE POLICY "Members can insert own history"
  ON location_history FOR INSERT TO authenticated
  WITH CHECK (
    (member_id, keep_id) IN (SELECT id, keep_id FROM keep_members WHERE user_id = auth.uid())
  );


-- ── §6 check-in normalisation + place cap triggers ──────────────────

-- v16: a check-in is written by the member's own device, and until now the
-- database believed whatever it said. Four fields are now the server's to
-- decide, whatever the client sent:
--
--   inserted_at   — receipt time, forced to now(). Devices page their push
--                   notifications by it. They used to page by created_at,
--                   so a check-in that arrived late (a crossing queued
--                   through a Wi-Fi→cellular handoff) was skipped by any
--                   phone that had already moved past its timestamp.
--   created_at    — the event time, kept, but never more than 5 minutes in
--                   the future. One row dated tomorrow pinned every
--                   device's watermark to tomorrow and silenced every alert
--                   in the keep, SOS included.
--   member_name / — taken from the member's row. RLS binds member_id to the
--   member_avatar   caller but these were free text, so a member could file
--                   "🆘 Mum sent an SOS" as themselves.
--   place_id      — cleared if it names a place in another keep.
--
-- BEFORE INSERT, so the AFTER INSERT webhook and RLS's WITH CHECK both see
-- the corrected row. Not SECURITY DEFINER: the caller can already read its
-- own member row and its own keep's places, which is all this needs.
CREATE OR REPLACE FUNCTION _roamkeep_checkin_normalise()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_name   text;
  v_avatar text;
BEGIN
  NEW.inserted_at := now();
  NEW.created_at  := LEAST(coalesce(NEW.created_at, now()), now() + interval '5 minutes');

  SELECT m.name, m.avatar INTO v_name, v_avatar
    FROM keep_members m WHERE m.id = NEW.member_id;
  IF FOUND THEN
    NEW.member_name   := v_name;
    NEW.member_avatar := v_avatar;
  END IF;

  IF NEW.place_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM keep_places pl
        WHERE pl.id = NEW.place_id AND pl.keep_id = NEW.keep_id) THEN
    NEW.place_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkin_normalise ON checkins;
CREATE TRIGGER trg_checkin_normalise
  BEFORE INSERT ON checkins
  FOR EACH ROW EXECUTE FUNCTION _roamkeep_checkin_normalise();

-- v16: at most 90 places per keep. Play Services allows an app 100
-- geofences and addGeofences is all-or-nothing, so place 101 — which any
-- member could add — disarmed EVERY place on EVERY device at the next
-- re-arm, with nothing but a journal line to say so. 90 leaves headroom.
CREATE OR REPLACE FUNCTION _roamkeep_place_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (SELECT count(*) FROM keep_places WHERE keep_id = NEW.keep_id) >= 90 THEN
    RAISE EXCEPTION 'too_many_places';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_place_cap ON keep_places;
CREATE TRIGGER trg_place_cap
  BEFORE INSERT ON keep_places
  FOR EACH ROW EXECUTE FUNCTION _roamkeep_place_cap();


-- ── §7 set_project_url — only this project's own URL ────────────────

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
--
-- v16: the value must be THIS project's own URL, not merely a
-- supabase.co-shaped one. Before, any owner of ANY keep could set it — and
-- create_keep makes anyone an owner, so a stranger holding a shared setup
-- link could sign up, create an empty keep and point project_url at their
-- own project while it was still NULL (a paste-upgraded family, before the
-- owner's next app open). Both webhook triggers would then have POSTed
-- every check-in, SOS coordinates included, every place row and the
-- webhook secret to them; and write-once meant the real owner's app could
-- never put it back.
--
-- The caller's JWT settles it. A token this database accepts was signed by
-- this project's own auth server, whose issuer IS the project URL
-- (https://<ref>.supabase.co/auth/v1), so a caller can only ever store the
-- truth. Where the issuer has some other shape (self-hosted), fall back to
-- requiring an owner of the OLDEST keep — the founding family's, which a
-- latecomer's keep can never be.
CREATE OR REPLACE FUNCTION set_project_url(p_url text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_owner boolean;
  v_iss text := coalesce(auth.jwt() ->> 'iss', '');
BEGIN
  IF p_url IS NULL OR p_url !~ '^https://[a-z0-9]+\.supabase\.co$' THEN
    RETURN false;
  END IF;

  IF v_iss ~ '^https://[a-z0-9]+\.supabase\.co/auth/v1$' THEN
    IF p_url <> regexp_replace(v_iss, '/auth/v1$', '') THEN
      RETURN false;
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM keep_members
      WHERE user_id = auth.uid() AND role = 'owner'
    ) INTO v_is_owner;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM keep_members m
      WHERE m.user_id = auth.uid() AND m.role = 'owner'
        AND m.keep_id = (SELECT k.id FROM keeps k ORDER BY k.created_at, k.id LIMIT 1)
    ) INTO v_is_owner;
  END IF;

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


-- ── §8 my_checkin_feed — append inserted_at ─────────────────────────

DROP VIEW IF EXISTS my_checkin_feed;
CREATE VIEW my_checkin_feed
WITH (security_invoker = true) AS
  SELECT c.id, c.keep_id, c.member_name, c.member_avatar,
         c.type, c.place, c.place_id, c.created_at, c.inserted_at
  FROM checkins c
  JOIN keep_members me
    ON me.keep_id = c.keep_id
   AND me.user_id = auth.uid()
  WHERE c.member_id <> me.id
    AND (
      c.type = 'sos'
      OR (
        me.notify_on_checkin
        AND (
          c.place_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM keep_notify_prefs p
            WHERE p.member_id = me.id
              AND p.subject_member_id = c.member_id
              AND p.place_id = c.place_id
          )
        )
      )
    );

GRANT SELECT ON my_checkin_feed TO authenticated;


-- ── §9 repair a check-in trigger that does not send the webhook secret ───

DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'roamkeep_notify_checkin';

  IF v_src IS NULL
     OR (v_src NOT LIKE '%x-roamkeep-webhook%'
         AND (SELECT project_url FROM roamkeep_meta) IS NOT NULL) THEN
    EXECUTE $body$
      CREATE OR REPLACE FUNCTION public.roamkeep_notify_checkin()
        RETURNS trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = public, net
      AS $fn$
      DECLARE
        v_url text;
        v_secret text;
      BEGIN
        SELECT project_url INTO v_url FROM roamkeep_meta;
        IF v_url IS NULL THEN RETURN NEW; END IF;
        SELECT webhook_secret INTO v_secret FROM roamkeep_secrets;
        PERFORM net.http_post(
          url     := v_url || '/functions/v1/notify-checkin',
          headers := jsonb_build_object(
                       'Content-Type', 'application/json',
                       'x-roamkeep-webhook', coalesce(v_secret, '')
                     ),
          body    := jsonb_build_object(
                       'type', 'INSERT', 'table', 'checkins', 'schema', 'public',
                       'record', to_jsonb(NEW), 'old_record', NULL),
          timeout_milliseconds := 5000
        );
        RETURN NEW;
      EXCEPTION WHEN OTHERS THEN
        RETURN NEW;
      END;
      $fn$;
    $body$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.roamkeep_notify_checkin() FROM public, anon, authenticated';
    EXECUTE 'DROP TRIGGER IF EXISTS on_checkin_notify ON public.checkins';
    EXECUTE 'CREATE TRIGGER on_checkin_notify AFTER INSERT ON public.checkins '
         || 'FOR EACH ROW EXECUTE FUNCTION public.roamkeep_notify_checkin()';
  END IF;
END$$;


-- ── §10 create_keep — one Keep per account ──────────────────────────

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

  -- v16: one Keep per account. The app only ever offers create/join to an
  -- account with no membership, and every client resolves "my keep" by
  -- user_id — with two memberships it picked one arbitrarily per launch.
  -- A second membership was also the only way to write rows pairing one
  -- membership's member_id with another's keep_id. Leave first
  -- (leave_keep) to move to a different Keep.
  IF EXISTS (SELECT 1 FROM keep_members km WHERE km.user_id = v_uid) THEN
    RAISE EXCEPTION 'already_member';
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


-- ── §11 join_keep_by_code — one Keep per account ────────────────────

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

  -- v16: one Keep per account — see create_keep. A status, not a RAISE,
  -- so the attempt logged above still commits.
  IF EXISTS (SELECT 1 FROM keep_members km WHERE km.user_id = v_uid) THEN
    RETURN QUERY SELECT 'already_member'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text;
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


-- ── §12 get_invite — owner-only read of the join code ───────────────

-- get_invite (v16): owner-only read of the current join code + expiry.
--
-- Showing the code only to owners was enforced by the UI and nothing else:
-- the keeps SELECT policy is keep-wide and RLS cannot hide a column, so any
-- member — a child included — could read the live code (on the PWA, from
-- DevTools' view of the launch query) and bring in someone the owners had
-- not approved. 4.9.0 stops selecting keeps.code outright and asks here.
--
-- EXPAND step only. The column is still readable, because older apps select
-- keeps(code) at launch and would fail to start without it. The CONTRACT —
-- revoking column SELECT on keeps.code / code_expires_at from
-- authenticated — waits until no pre-4.9.0 app is left.
CREATE OR REPLACE FUNCTION get_invite(p_keep_id uuid)
RETURNS TABLE (keep_code text, code_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM keep_members m
     WHERE m.keep_id = p_keep_id AND m.user_id = auth.uid() AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  RETURN QUERY SELECT k.code, k.code_expires_at FROM keeps k WHERE k.id = p_keep_id;
END;
$$;
REVOKE ALL ON FUNCTION get_invite(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_invite(uuid) TO authenticated;


-- ── §13 remove_member — keep row lock ───────────────────────────────

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

  -- v16: serialise ownership changes per keep. Without it two owners
  -- removing each other at the same moment both passed the owner check and
  -- the keep was left with none. See leave_keep.
  PERFORM 1 FROM keeps WHERE id = v_keep_id FOR UPDATE;

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


-- ── §14 leave_keep — keep row lock ──────────────────────────────────

CREATE OR REPLACE FUNCTION leave_keep(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_member keep_members%ROWTYPE;
  v_owner_count int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT * INTO v_member FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  IF v_member.user_id <> v_uid THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  IF v_member.member_type = 'child' THEN
    RAISE EXCEPTION 'child_cannot_leave';
  END IF;

  -- v16: take the keep's row lock before counting owners. Every function
  -- that can reduce the owner count (this, set_member_role, remove_member)
  -- takes it first, so two of them can no longer each see "two owners" and
  -- together leave none. Under READ COMMITTED the count below is read
  -- after the lock is granted, so it sees the other transaction's commit.
  PERFORM 1 FROM keeps WHERE id = v_member.keep_id FOR UPDATE;
  SELECT * INTO v_member FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  IF v_member.role = 'owner' THEN
    SELECT count(*) INTO v_owner_count
      FROM keep_members
     WHERE keep_id = v_member.keep_id AND role = 'owner';
    IF v_owner_count <= 1 THEN
      RAISE EXCEPTION 'last_owner';
    END IF;
  END IF;

  -- Explicit, though location_history cascades off the member row anyway:
  -- this is the line that makes the privacy claim true, and it should be
  -- visible here rather than depending on a foreign key someone might later
  -- change. checkins, keep_member_push and keep_notify_prefs go with the
  -- row by cascade.
  DELETE FROM location_history WHERE member_id = v_member.id;
  DELETE FROM keep_members WHERE id = v_member.id;
END;
$$;
REVOKE ALL ON FUNCTION leave_keep(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION leave_keep(uuid) TO authenticated;


-- ── §15 set_member_role — keep row lock ─────────────────────────────

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

  SELECT keep_id INTO v_keep_id
    FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  -- v16: lock first, then read the role the decision rests on — see
  -- leave_keep. Two owners demoting each other at once each saw two owners.
  PERFORM 1 FROM keeps WHERE id = v_keep_id FOR UPDATE;
  SELECT role INTO v_cur_role FROM keep_members WHERE id = p_member_id;
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


-- ── §16 prune_keep_history — the 7-day promise without pg_cron ──────

-- prune_keep_history (v16): delete what the retention promise says is
-- already gone — breadcrumbs AND check-ins older than 7 days — for the
-- caller's own keep, every member's rows.
--
-- landing/privacy promises location history is "automatically deleted after
-- 7 days". That held only where pg_cron is enabled (optional; the wizard
-- called its absence harmless). Otherwise the only pruning was each member
-- deleting their OWN rows on app launch, so a phone tracking headlessly for
-- weeks without the app being opened kept everything. Any member's app now
-- calls this at launch, which keeps the promise for the whole keep as long
-- as someone opens the app. pg_cron (below) remains the guarantee.
--
-- Check-ins were kept forever — every arrival and departure with its time,
-- and every SOS position. The owner decided (2026-09-23) they follow the
-- same 7 days.
--
-- SECURITY DEFINER because checkins has no DELETE policy (immutable to
-- clients) and a member may only delete their own breadcrumbs. Safe to
-- expose: it can only remove rows the policy already says are expired.
CREATE OR REPLACE FUNCTION prune_keep_history()
RETURNS TABLE (history_deleted integer, checkins_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_h integer;
  v_c integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  DELETE FROM location_history lh
   USING keep_members m
   WHERE m.user_id = v_uid
     AND lh.keep_id = m.keep_id
     AND lh.recorded_at < now() - interval '7 days';
  GET DIAGNOSTICS v_h = ROW_COUNT;

  DELETE FROM checkins c
   USING keep_members m
   WHERE m.user_id = v_uid
     AND c.keep_id = m.keep_id
     AND c.created_at < now() - interval '7 days';
  GET DIAGNOSTICS v_c = ROW_COUNT;

  RETURN QUERY SELECT v_h, v_c;
END;
$$;
REVOKE ALL ON FUNCTION prune_keep_history() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION prune_keep_history() TO authenticated;


-- ── §17 retention sweeps (pg_cron, when enabled) ────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'roamkeep-prune-location-history',
      '0 3 * * *',
      $job$DELETE FROM location_history WHERE recorded_at < now() - interval '7 days'$job$
    );
    -- v16: check-ins follow the same 7 days (owner decision 2026-09-23).
    PERFORM cron.schedule(
      'roamkeep-prune-checkins',
      '15 3 * * *',
      $job$DELETE FROM checkins WHERE created_at < now() - interval '7 days'$job$
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


-- ── §18 Stamp the version ───────────────────────────────────────────
-- LAST statement. A half-applied migration leaves the old number, so the
-- client correctly refuses rather than assuming it got what it asked for.

insert into roamkeep_meta (id, schema_version) values (true, 16)
  on conflict (id) do update
    set schema_version = greatest(roamkeep_meta.schema_version, 16),
        updated_at = now();

commit;


-- ── Verify ──────────────────────────────────────────────────────
-- Check the OBJECTS, not just the number — a version that reports 16 while
-- missing what 16 contains is the one failure the marker cannot catch.
-- db/tests/v16-verify.sql proves the behaviour; this is the quick catalog
-- check (expected values on the right):
--
--   select
--     (select count(*) from information_schema.columns
--       where table_name = 'checkins' and column_name = 'inserted_at')     as inserted_at,  -- 1
--     (select count(*) from pg_trigger
--       where tgname in ('trg_checkin_normalise', 'trg_place_cap'))        as triggers,     -- 2
--     (select count(*) from pg_proc
--       where proname in ('get_invite', 'prune_keep_history'))             as rpcs,         -- 2
--     (select prosrc like '%x-roamkeep-webhook%' from pg_proc
--       where proname = 'roamkeep_notify_checkin')                         as push_secret,  -- true once project_url is set
--     (select schema_version from roamkeep_meta)                           as version;      -- 16
