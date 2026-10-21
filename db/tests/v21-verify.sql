-- ============================================================
-- Roamkeep v21: verification script (run on STAGING, never a family)
--
-- Proves what schema v21 changes:
--
--   1  Every role can reach what it uses, because the schema now grants it.
--      Until 30 October 2026 Supabase granted every new table to the API
--      roles by itself; from then on it grants nothing, so a server set up
--      afterwards refused every request the app made. Checked two ways: the
--      grants themselves (1a), and the app's own reads and writes run as a
--      member (1b), signed out (1c) and as the Edge Functions (1d).
--
-- It passes on a server made before 30 October (which kept Supabase's wider
-- grants) and on one made after, which has only what schema.sql grants. On
-- a server made after that date from an older app, 1a to 1d fail, and
-- Settings → Family server → Check and repair puts them right.
--
-- Each rule has a mutation in db/tests/pglite/mutate.mjs that weakens it and
-- expects the step named here to FAIL.
--
-- Results go to a _v21_results table returned by the final SELECT, because
-- the Supabase SQL Editor does NOT display RAISE NOTICE output. Every row
-- should read PASS.
--
-- SETUP: apply db/schema.sql (v21) to the staging project, then paste this
-- WHOLE file into Dashboard → SQL Editor → Run. It makes its own accounts
-- (v21o, v21a @test.local) and its own Keep ('V21 Test Family') directly, as
-- the database owner, and deletes them first and again at the end. Sign-ups
-- are held open while it runs and put back the way they were. Safe to re-run.
--
-- Everything it writes is rolled back before the script ends, so no webhook
-- request leaves and no phone is woken.
-- ============================================================

DROP TABLE IF EXISTS _v21_results;
CREATE TABLE _v21_results (id serial primary key, step text, status text, detail text);

CREATE OR REPLACE FUNCTION _v21_r(p_step text, p_ok boolean, p_detail text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO _v21_results(step, status, detail)
  VALUES (p_step, CASE WHEN coalesce(p_ok, false) THEN 'PASS' ELSE 'FAIL' END, coalesce(p_detail, ''));
$$;

CREATE OR REPLACE FUNCTION _v21_user(p_email text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v uuid;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          confirmation_token, recovery_token, email_change_token_new, email_change,
                          created_at, updated_at)
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            p_email, extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
            '', '', '', '', now(), now())
    RETURNING id INTO v;
  RETURN v;
END $$;

-- One statement as a client sends it: that role, that user's claims (none
-- for p_uid NULL), in its own subtransaction. 'ok N' with the rows it read
-- or touched, or 'refused: ' and why.
CREATE OR REPLACE FUNCTION _v21_as(p_role text, p_uid uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims',
    CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text
         ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  RETURN 'ok ' || n;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RETURN 'refused: ' || SQLERRM;
END $$;

-- NULL when the statement gave what was wanted, else what it gave. 'refused'
-- wants any refusal; 'none' wants a refusal or no rows, which is what a
-- server made before 30 October answers, its grants fenced by the policies.
CREATE OR REPLACE FUNCTION _v21_want(p_role text, p_uid uuid, p_sql text, p_want text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v text := _v21_as(p_role, p_uid, p_sql);
BEGIN
  IF v = p_want
     OR (p_want = 'refused' AND v LIKE 'refused%')
     OR (p_want = 'none' AND (v = 'ok 0' OR v LIKE 'refused%')) THEN
    RETURN NULL;
  END IF;
  RETURN format('%s (wanted %s, got %s)', left(p_sql, 70), p_want, v);
END $$;

-- 1a: the grants themselves. What the app and the phones' background code
-- do, as the signed-in role; the one table read signed out; and all four on
-- every table for the service role, which the Edge Functions use.
WITH need(r, t, p) AS (
  VALUES ('authenticated', 'keeps', 'SELECT'),
         ('authenticated', 'keep_members', 'SELECT'), ('authenticated', 'keep_members', 'UPDATE'),
         ('authenticated', 'checkins', 'SELECT'), ('authenticated', 'checkins', 'INSERT'),
         ('authenticated', 'keep_places', 'SELECT'), ('authenticated', 'keep_places', 'INSERT'),
         ('authenticated', 'keep_places', 'UPDATE'), ('authenticated', 'keep_places', 'DELETE'),
         ('authenticated', 'location_history', 'SELECT'), ('authenticated', 'location_history', 'INSERT'),
         ('authenticated', 'location_history', 'DELETE'),
         ('authenticated', 'keep_member_push', 'SELECT'), ('authenticated', 'keep_member_push', 'INSERT'),
         ('authenticated', 'keep_member_push', 'UPDATE'),
         ('authenticated', 'keep_notify_prefs', 'SELECT'), ('authenticated', 'keep_notify_prefs', 'INSERT'),
         ('authenticated', 'keep_notify_prefs', 'DELETE'),
         ('authenticated', 'roamkeep_meta', 'SELECT'), ('anon', 'roamkeep_meta', 'SELECT'),
         ('authenticated', 'checkin_notices', 'SELECT'), ('authenticated', 'my_checkin_feed', 'SELECT')
  UNION ALL
  SELECT 'service_role', t, p
    FROM unnest(ARRAY['keeps', 'keep_members', 'checkins', 'keep_places', 'location_history',
                      'keep_join_attempts', 'roamkeep_meta', 'keep_notify_prefs', 'keep_member_push',
                      'roamkeep_secrets', 'password_reset_codes', 'checkin_notices']) t,
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
)
INSERT INTO _v21_results(step, status, detail)
SELECT '1a every role holds the table rights the app, the phones and the Edge Functions use',
       CASE WHEN bool_and(ok) THEN 'PASS' ELSE 'FAIL' END,
       coalesce('missing: ' || string_agg(r || ' ' || p || ' ' || t, ', ') FILTER (WHERE NOT ok),
                count(*) || ' held')
  FROM (SELECT r, t, p, has_table_privilege(r, 'public.' || t, p) AS ok FROM need) x;

DO $$
DECLARE
  uid_o uuid; uid_a uuid;
  o_mid uuid; a_mid uuid;
  v_keep uuid; v_place uuid;
  v_txt text;
  b text[] := '{}'; c text[] := '{}'; d text[] := '{}';
  v_prev_closed boolean; v_prev_until timestamptz;
  v_throwaway text[] := ARRAY['v21o@test.local', 'v21a@test.local'];
BEGIN
  SELECT signups_closed, signups_open_until INTO v_prev_closed, v_prev_until FROM roamkeep_meta;
  UPDATE roamkeep_meta SET signups_closed = false, signups_open_until = NULL WHERE id;
  DELETE FROM keeps WHERE name = 'V21 Test Family';
  DELETE FROM auth.users WHERE email = ANY (v_throwaway);

  uid_o := _v21_user('v21o@test.local');
  uid_a := _v21_user('v21a@test.local');

  -- O owns the Keep, A is an approved member. Made directly: create_keep
  -- refuses a second family on a server.
  INSERT INTO keeps (code, name, created_by, code_expires_at)
    VALUES (_roamkeep_gen_code(), 'V21 Test Family', uid_o, now() + interval '72 hours')
    RETURNING id INTO v_keep;
  INSERT INTO keep_members (keep_id, user_id, name, avatar, role, member_type, approved)
    VALUES (v_keep, uid_o, 'Owner', '🙂', 'owner', 'adult', true) RETURNING id INTO o_mid;
  INSERT INTO keep_members (keep_id, user_id, name, avatar, role, member_type, approved)
    VALUES (v_keep, uid_a, 'A', '🙂', 'member', 'adult', true) RETURNING id INTO a_mid;
  INSERT INTO keep_places (keep_id, name, lat, lng, created_by)
    VALUES (v_keep, 'V21 Place', 1, 2, uid_o) RETURNING id INTO v_place;

  -- Everything that writes, in one block that rolls itself back.
  BEGIN
    -- The owner's check-in, for A's feed, and the owner's push token, for
    -- the Edge Functions to clear.
    INSERT INTO checkins (keep_id, member_id, member_name, member_avatar, place, type)
      VALUES (v_keep, o_mid, 'Owner', '🙂', 'V21 Place', 'manual');
    INSERT INTO keep_member_push (member_id, keep_id, fcm_token) VALUES (o_mid, v_keep, 'v21-token-o');

    -- 1b: A, signed in, does what the app and the phones do. In order: the
    -- place A adds is renamed and then deleted.
    b := ARRAY[
      _v21_want('authenticated', uid_a, 'SELECT 1 FROM keeps', 'ok 1'),
      _v21_want('authenticated', uid_a, 'SELECT 1 FROM keep_members', 'ok 2'),
      _v21_want('authenticated', uid_a, 'UPDATE keep_members SET online = false WHERE user_id = auth.uid()', 'ok 1'),
      _v21_want('authenticated', uid_a, 'SELECT 1 FROM keep_places', 'ok 1'),
      _v21_want('authenticated', uid_a, format(
        'INSERT INTO keep_places (keep_id, name, lat, lng, created_by) VALUES (%L, %L, 3, 4, auth.uid())',
        v_keep, 'V21 New'), 'ok 1'),
      _v21_want('authenticated', uid_a, 'UPDATE keep_places SET name = ''V21 Renamed'' WHERE name = ''V21 New''', 'ok 1'),
      _v21_want('authenticated', uid_a, 'DELETE FROM keep_places WHERE name = ''V21 Renamed''', 'ok 1'),
      _v21_want('authenticated', uid_a, format(
        'INSERT INTO checkins (keep_id, member_id, member_name, member_avatar, place, type) VALUES (%L, %L, %L, %L, %L, %L)',
        v_keep, a_mid, 'A', '🙂', 'V21 Place', 'manual'), 'ok 1'),
      _v21_want('authenticated', uid_a, 'SELECT 1 FROM checkins', 'ok 2'),
      _v21_want('authenticated', uid_a, 'SELECT 1 FROM my_checkin_feed', 'ok 1'),
      _v21_want('authenticated', uid_a, format(
        'INSERT INTO location_history (keep_id, member_id, lat, lng, accuracy) VALUES (%L, %L, 1, 2, 10)',
        v_keep, a_mid), 'ok 1'),
      _v21_want('authenticated', uid_a, 'SELECT 1 FROM location_history', 'ok 1'),
      _v21_want('authenticated', uid_a, format('DELETE FROM location_history WHERE member_id = %L', a_mid), 'ok 1'),
      -- The token upsert both phones' code sends, first as a new row, then
      -- as an update of it; then the clear at sign-out.
      _v21_want('authenticated', uid_a, format(
        'INSERT INTO keep_member_push (member_id, keep_id, fcm_token) VALUES (%L, %L, %L) '
        'ON CONFLICT (member_id) DO UPDATE SET fcm_token = EXCLUDED.fcm_token, updated_at = now()',
        a_mid, v_keep, 'v21-token-a'), 'ok 1'),
      _v21_want('authenticated', uid_a, format(
        'INSERT INTO keep_member_push (member_id, keep_id, fcm_token) VALUES (%L, %L, %L) '
        'ON CONFLICT (member_id) DO UPDATE SET fcm_token = EXCLUDED.fcm_token, updated_at = now()',
        a_mid, v_keep, 'v21-token-a2'), 'ok 1'),
      _v21_want('authenticated', uid_a, format(
        'UPDATE keep_member_push SET fcm_token = NULL WHERE member_id = %L', a_mid), 'ok 1'),
      _v21_want('authenticated', uid_a, format(
        'INSERT INTO keep_notify_prefs (keep_id, member_id, subject_member_id, place_id) VALUES (%L, %L, %L, %L)',
        v_keep, a_mid, o_mid, v_place), 'ok 1'),
      _v21_want('authenticated', uid_a, 'SELECT 1 FROM keep_notify_prefs', 'ok 1'),
      _v21_want('authenticated', uid_a, format('DELETE FROM keep_notify_prefs WHERE member_id = %L', a_mid), 'ok 1'),
      _v21_want('authenticated', uid_a, 'SELECT signups_closed, signups_open_until FROM roamkeep_meta', 'ok 1'),
      _v21_want('authenticated', uid_a,
        'SELECT issued_by, issued_at, expires_at, redeemed_at FROM password_reset_codes', 'ok 0')];

    -- 1c: signed out. The sign-up state and nothing of the family's.
    c := ARRAY[
      _v21_want('anon', NULL, 'SELECT signups_closed, signups_open_until FROM roamkeep_meta', 'ok 1'),
      _v21_want('anon', NULL, 'SELECT 1 FROM keeps', 'none'),
      _v21_want('anon', NULL, 'SELECT 1 FROM keep_members', 'none'),
      _v21_want('anon', NULL, 'SELECT 1 FROM keep_places', 'none'),
      _v21_want('anon', NULL, 'SELECT 1 FROM checkins', 'none'),
      _v21_want('anon', NULL, 'SELECT 1 FROM location_history', 'none'),
      _v21_want('anon', NULL, 'SELECT 1 FROM keep_member_push', 'none'),
      _v21_want('anon', NULL, 'SELECT 1 FROM keep_notify_prefs', 'none'),
      _v21_want('anon', NULL, 'UPDATE keep_members SET online = false', 'none'),
      _v21_want('anon', NULL, format(
        'INSERT INTO checkins (keep_id, member_id, member_name, member_avatar, place, type) VALUES (%L, %L, %L, %L, %L, %L)',
        v_keep, a_mid, 'A', '🙂', 'V21 Place', 'sos'), 'refused')];

    -- 1d: the Edge Functions, with the service role key. They read the
    -- webhook secret and clear a token the relay reported dead.
    d := ARRAY[
      _v21_want('service_role', NULL, 'SELECT 1 FROM roamkeep_secrets WHERE length(webhook_secret) > 0', 'ok 1'),
      _v21_want('service_role', NULL, format(
        'UPDATE keep_member_push SET fcm_token = NULL WHERE member_id = %L AND fcm_token = %L',
        o_mid, 'v21-token-o'), 'ok 1')];

    RAISE EXCEPTION 'v21_rollback';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    v_txt := SQLERRM;
  END;

  b := array_remove(b, NULL); c := array_remove(c, NULL); d := array_remove(d, NULL);
  PERFORM _v21_r('1 the steps ran to the end and were rolled back', v_txt = 'v21_rollback', v_txt);
  PERFORM _v21_r('1b a member signed in can do everything the app and the phones do',
    cardinality(b) = 0, coalesce(array_to_string(b, ' · '), '') || CASE WHEN cardinality(b) = 0 THEN '21 statements as expected' ELSE '' END);
  PERFORM _v21_r('1c signed out, the sign-up state can be read and nothing of the family''s',
    cardinality(c) = 0, coalesce(array_to_string(c, ' · '), '') || CASE WHEN cardinality(c) = 0 THEN '10 statements as expected' ELSE '' END);
  PERFORM _v21_r('1d the Edge Functions can read the webhook secret and clear a dead token',
    cardinality(d) = 0, coalesce(array_to_string(d, ' · '), '') || CASE WHEN cardinality(d) = 0 THEN '2 statements as expected' ELSE '' END);

  -- ── Clean up ──────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM keeps WHERE id = v_keep;
  DELETE FROM auth.users WHERE email = ANY (v_throwaway);
  UPDATE roamkeep_meta SET signups_closed = coalesce(v_prev_closed, false),
                           signups_open_until = v_prev_until WHERE id;
END $$;

INSERT INTO _v21_results(step, status, detail)
SELECT '2 schema_version is 21', CASE WHEN schema_version >= 21 THEN 'PASS' ELSE 'FAIL' END, schema_version::text
  FROM roamkeep_meta;

DROP FUNCTION IF EXISTS _v21_r(text, boolean, text);
DROP FUNCTION IF EXISTS _v21_user(text);
DROP FUNCTION IF EXISTS _v21_want(text, uuid, text, text);
DROP FUNCTION IF EXISTS _v21_as(text, uuid, text);

-- By step, not id: 1a is written first, before the block the others need.
SELECT step, status, detail FROM _v21_results ORDER BY step COLLATE "C";
