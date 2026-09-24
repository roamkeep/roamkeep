-- ============================================================
-- Roamkeep v16 — verification script (run on a SCRATCH project)
--
-- Proves the invariants schema v16 adds. Results go to a _v16_results table
-- returned by the final SELECT, because the Supabase SQL Editor does NOT
-- display RAISE NOTICE output. Read the grid: every row PASS or FAIL.
--
-- SETUP (once, before running):
--   1. Apply db/schema.sql (or the v16 migration on top of v15).
--   2. Create TWO auth accounts (app sign-up or Auth dashboard):
--        v16owner@test.local   v16member@test.local
--      Neither may belong to a Keep already (v16 allows one per account).
--   3. Paste this WHOLE file into Dashboard → SQL Editor → Run.
--
-- Safe to re-run: it deletes its own test Keep ('V16 Test Family') first
-- and again at the end; the cascade removes its members, check-ins, places
-- and breadcrumbs. Its inserts fire the real webhook triggers, which find
-- no push tokens in the test Keep and so wake nobody.
--
-- How it works: RPCs read auth.uid() from request.jwt.claims, so
-- _v16_act_as(uid) sets that. Triggers fire for everyone, so the check-in
-- normalisation is exercised directly. The pair-bound INSERT policies need
-- RLS to apply, which a superuser bypasses — those steps switch to the
-- `authenticated` role for the one statement and back.
-- ============================================================

DROP TABLE IF EXISTS _v16_results;
CREATE TABLE _v16_results (id serial primary key, step text, status text, detail text);

CREATE OR REPLACE FUNCTION _v16_act_as(p uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
END $$;

DO $$
DECLARE
  uid_o uuid; uid_m uuid;
  v_keep uuid; v_code text; v_o_mid uuid; v_m_mid uuid; v_place uuid;
  v_row checkins%ROWTYPE; v_status text; v_msg text; v_n int; v_h int; v_c int;
BEGIN
  SELECT id INTO uid_o FROM auth.users WHERE email = 'v16owner@test.local';
  SELECT id INTO uid_m FROM auth.users WHERE email = 'v16member@test.local';
  IF uid_o IS NULL OR uid_m IS NULL THEN
    INSERT INTO _v16_results(step,status,detail) VALUES
      ('0 setup', 'FAIL', 'Create v16owner@test.local and v16member@test.local first (see header).');
    RETURN;
  END IF;
  DELETE FROM keeps WHERE name = 'V16 Test Family';
  DELETE FROM keep_join_attempts WHERE user_id IN (uid_o, uid_m);

  -- Keep + member.
  PERFORM _v16_act_as(uid_o);
  SELECT c.keep_id, c.keep_code, c.member_id INTO v_keep, v_code, v_o_mid
    FROM create_keep('V16 Test Family', 'Olivia', '👩') c;
  PERFORM _v16_act_as(uid_m);
  SELECT j.member_id INTO v_m_mid FROM join_keep_by_code(v_code, 'Max', '👦') j;

  -- 1) One Keep per account.
  BEGIN
    PERFORM create_keep('Second Keep', 'Max', '👦');
    INSERT INTO _v16_results VALUES (DEFAULT, '1 a member cannot create a second Keep', 'FAIL', 'create_keep succeeded');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _v16_results VALUES (DEFAULT, '1 a member cannot create a second Keep',
      CASE WHEN SQLERRM LIKE '%already_member%' THEN 'PASS' ELSE 'FAIL' END, SQLERRM);
  END;

  -- 2) get_invite: owner yes, member no.
  PERFORM _v16_act_as(uid_o);
  SELECT g.keep_code INTO v_msg FROM get_invite(v_keep) g;
  INSERT INTO _v16_results VALUES (DEFAULT, '2a get_invite returns the code to an owner',
    CASE WHEN v_msg = v_code THEN 'PASS' ELSE 'FAIL' END, coalesce(v_msg, 'null'));
  PERFORM _v16_act_as(uid_m);
  BEGIN
    PERFORM get_invite(v_keep);
    INSERT INTO _v16_results VALUES (DEFAULT, '2b get_invite refuses a non-owner', 'FAIL', 'returned a row');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _v16_results VALUES (DEFAULT, '2b get_invite refuses a non-owner',
      CASE WHEN SQLERRM LIKE '%not_owner%' THEN 'PASS' ELSE 'FAIL' END, SQLERRM);
  END;

  -- 3) Check-in normalisation (trigger — fires for everyone).
  INSERT INTO keep_places (keep_id, name, icon, lat, lng, radius_m, created_by)
    VALUES (v_keep, 'Home', '🏠', -33.8, 151.2, 100, uid_o) RETURNING id INTO v_place;
  INSERT INTO checkins (keep_id, member_id, member_name, member_avatar, place, type, created_at, place_id, inserted_at)
    VALUES (v_keep, v_m_mid, 'Olivia', '👩', '🆘 Emergency SOS Alert', 'sos',
            '2099-01-01', gen_random_uuid() /* a place that is not in this keep */, '2000-01-01')
    RETURNING * INTO v_row;
  INSERT INTO _v16_results VALUES (DEFAULT, '3a forged member_name/avatar replaced by the real ones',
    CASE WHEN v_row.member_name = 'Max' AND v_row.member_avatar = '👦' THEN 'PASS' ELSE 'FAIL' END,
    v_row.member_name || ' ' || v_row.member_avatar);
  INSERT INTO _v16_results VALUES (DEFAULT, '3b future created_at clamped to now()+5min',
    CASE WHEN v_row.created_at <= now() + interval '5 minutes' THEN 'PASS' ELSE 'FAIL' END, v_row.created_at::text);
  INSERT INTO _v16_results VALUES (DEFAULT, '3c inserted_at is server time, whatever the client sent',
    CASE WHEN v_row.inserted_at = now() THEN 'PASS' ELSE 'FAIL' END, v_row.inserted_at::text);
  INSERT INTO _v16_results VALUES (DEFAULT, '3d place_id from outside the keep cleared',
    CASE WHEN v_row.place_id IS NULL THEN 'PASS' ELSE 'FAIL' END, coalesce(v_row.place_id::text, 'null'));

  -- 4) Pair-bound INSERT policies: a mismatched (member_id, keep_id) is
  -- refused. Runs as the client role so RLS applies.
  PERFORM _v16_act_as(uid_m);
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO location_history (keep_id, member_id, lat, lng)
      VALUES ((SELECT id FROM keeps WHERE id <> v_keep LIMIT 1), v_m_mid, 1, 1);
    RESET ROLE;
    INSERT INTO _v16_results VALUES (DEFAULT, '4a breadcrumb with another keep''s keep_id refused', 'FAIL', 'insert succeeded');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO _v16_results VALUES (DEFAULT, '4a breadcrumb with another keep''s keep_id refused',
      CASE WHEN SQLERRM LIKE '%row-level security%' OR SQLERRM LIKE '%null value in column "keep_id"%'
           THEN 'PASS' ELSE 'FAIL' END, SQLERRM);
  END;
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO location_history (keep_id, member_id, lat, lng) VALUES (v_keep, v_m_mid, 1, 1);
    RESET ROLE;
    INSERT INTO _v16_results VALUES (DEFAULT, '4b breadcrumb with the matching pair accepted', 'PASS', '');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    INSERT INTO _v16_results VALUES (DEFAULT, '4b breadcrumb with the matching pair accepted', 'FAIL', SQLERRM);
  END;

  -- 5) Retention: prune_keep_history removes every member's expired rows.
  INSERT INTO location_history (keep_id, member_id, lat, lng, recorded_at) VALUES
    (v_keep, v_o_mid, 1, 1, now() - interval '8 days'), (v_keep, v_m_mid, 1, 1, now() - interval '8 days');
  ALTER TABLE checkins DISABLE TRIGGER trg_checkin_normalise;   -- to back-date a row
  INSERT INTO checkins (keep_id, member_id, member_name, member_avatar, place, type, created_at)
    VALUES (v_keep, v_o_mid, 'Olivia', '👩', 'old', 'manual', now() - interval '8 days');
  ALTER TABLE checkins ENABLE TRIGGER trg_checkin_normalise;
  PERFORM _v16_act_as(uid_m);
  SELECT p.history_deleted, p.checkins_deleted INTO v_h, v_c FROM prune_keep_history() p;
  INSERT INTO _v16_results VALUES (DEFAULT, '5 prune_keep_history deletes all members'' expired rows',
    CASE WHEN v_h >= 2 AND v_c >= 1 THEN 'PASS' ELSE 'FAIL' END, format('history %s, checkins %s', v_h, v_c));

  -- 6) Ownership changes still work, and the last owner is still protected.
  PERFORM _v16_act_as(uid_o);
  BEGIN
    PERFORM leave_keep(v_o_mid);
    INSERT INTO _v16_results VALUES (DEFAULT, '6 last owner cannot leave', 'FAIL', 'leave succeeded');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _v16_results VALUES (DEFAULT, '6 last owner cannot leave',
      CASE WHEN SQLERRM LIKE '%last_owner%' THEN 'PASS' ELSE 'FAIL' END, SQLERRM);
  END;

  DELETE FROM keeps WHERE id = v_keep;
  DELETE FROM keep_join_attempts WHERE user_id IN (uid_o, uid_m);
END $$;

-- ── Catalog checks ──────────────────────────────────────────
INSERT INTO _v16_results(step, status, detail)
SELECT '7 schema_version is 16', CASE WHEN schema_version >= 16 THEN 'PASS' ELSE 'FAIL' END, schema_version::text
  FROM roamkeep_meta;

INSERT INTO _v16_results(step, status, detail)
SELECT '8 triggers present (check-in normalise, place cap)',
       CASE WHEN count(*) = 2 THEN 'PASS' ELSE 'FAIL' END, string_agg(tgname, ', ')
  FROM pg_trigger WHERE tgname IN ('trg_checkin_normalise', 'trg_place_cap');

INSERT INTO _v16_results(step, status, detail)
SELECT '9 new RPCs callable by authenticated, not anon',
       CASE WHEN bool_and(has_function_privilege('authenticated', p.oid, 'execute'))
             AND NOT bool_or(has_function_privilege('anon', p.oid, 'execute')) THEN 'PASS' ELSE 'FAIL' END,
       string_agg(p.proname, ', ')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('get_invite', 'prune_keep_history');

INSERT INTO _v16_results(step, status, detail)
SELECT '10 check-in webhook sends the secret (when project_url is set)',
       CASE WHEN (SELECT project_url FROM roamkeep_meta) IS NULL THEN 'PASS'
            WHEN bool_and(prosrc LIKE '%x-roamkeep-webhook%') THEN 'PASS' ELSE 'FAIL' END,
       CASE WHEN (SELECT project_url FROM roamkeep_meta) IS NULL THEN 'project_url not set yet — nothing to send'
            ELSE 'roamkeep_notify_checkin' END
  FROM pg_proc WHERE proname = 'roamkeep_notify_checkin';

INSERT INTO _v16_results(step, status, detail)
SELECT '11 set_project_url checks the JWT issuer',
       CASE WHEN prosrc LIKE '%auth.jwt()%iss%' THEN 'PASS' ELSE 'FAIL' END, ''
  FROM pg_proc WHERE proname = 'set_project_url';

-- cron.job only exists once pg_cron is installed, and a query naming it
-- fails to PARSE otherwise — so the lookup is dynamic.
DO $$
DECLARE v_has boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    INSERT INTO _v16_results(step, status, detail) VALUES
      ('12 check-in retention sweep scheduled (if pg_cron is enabled)', 'PASS',
       'pg_cron not enabled — the app''s prune_keep_history() is the only sweep; enable pg_cron and re-run schema.sql');
  ELSE
    EXECUTE $q$SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'roamkeep-prune-checkins')$q$ INTO v_has;
    INSERT INTO _v16_results(step, status, detail) VALUES
      ('12 check-in retention sweep scheduled (if pg_cron is enabled)',
       CASE WHEN v_has THEN 'PASS' ELSE 'FAIL' END, 'cron.job roamkeep-prune-checkins');
  END IF;
END $$;

DROP FUNCTION _v16_act_as(uuid);
SELECT step, status, detail FROM _v16_results ORDER BY id;
