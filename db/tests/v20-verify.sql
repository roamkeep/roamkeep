-- ============================================================
-- Roamkeep v20 — verification script (run on STAGING, never a family)
--
-- Proves what schema v20 changes:
--
--   1  Who is told about a check-in is decided when it is written. Turning
--      a mute off, everything or one person at one place, brings back
--      nothing that happened while it was on. SOS still ignores every mute,
--      a member who was waiting for approval is told nothing from before,
--      and nobody can write, or read anyone else's, record of it.
--   3  pg_net is in the extensions schema, not public, where the app and the
--      wizard used to put it (Supabase's Security Advisor flagged it).
--
-- Each rule has a mutation in db/tests/pglite/mutate.mjs that weakens it and
-- expects the step named here to FAIL.
--
-- Results go to a _v20_results table returned by the final SELECT, because
-- the Supabase SQL Editor does NOT display RAISE NOTICE output. Every row
-- should read PASS.
--
-- SETUP: apply db/schema.sql (v20) to the staging project, then paste this
-- WHOLE file into Dashboard → SQL Editor → Run. No accounts to create first:
-- it makes its own (v20o, v20a, v20b, v20p @test.local) and its own Keep
-- ('V20 Test Family') directly, as the database owner, and deletes all of
-- them first and again at the end. Sign-ups are held open while it runs (the
-- sign-up gate is a trigger on auth.users) and put back the way they were.
-- Safe to re-run.
--
-- Every check-in it writes is rolled back before the script ends, so the
-- webhook's request never leaves and no phone is woken.
-- ============================================================

DROP TABLE IF EXISTS _v20_results;
CREATE TABLE _v20_results (id serial primary key, step text, status text, detail text);

CREATE OR REPLACE FUNCTION _v20_act_as(p uuid, p_role text DEFAULT 'authenticated') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', p_role)::text, true);
END $$;

CREATE OR REPLACE FUNCTION _v20_r(p_step text, p_ok boolean, p_detail text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO _v20_results(step, status, detail)
  VALUES (p_step, CASE WHEN coalesce(p_ok, false) THEN 'PASS' ELSE 'FAIL' END, coalesce(p_detail, ''));
$$;

CREATE OR REPLACE FUNCTION _v20_user(p_email text) RETURNS uuid
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

CREATE OR REPLACE FUNCTION _v20_member(p_keep uuid, p_user uuid, p_name text, p_role text, p_approved boolean)
RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO keep_members (keep_id, user_id, name, avatar, role, member_type, approved)
    VALUES (p_keep, p_user, p_name, '🙂', p_role, 'adult', p_approved)
  RETURNING id;
$$;

-- What the phone would raise: is this check-in in the member's own feed,
-- read as that member, through RLS.
CREATE OR REPLACE FUNCTION _v20_sees(p_uid uuid, p_ck uuid) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v int;
BEGIN
  PERFORM _v20_act_as(p_uid);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v FROM my_checkin_feed WHERE id = p_ck;
  RESET ROLE;
  RETURN v;
END $$;

-- Who the Edge Function would wake for this check-in.
CREATE OR REPLACE FUNCTION _v20_woken(p_ck uuid, p_mid uuid) RETURNS int
LANGUAGE sql AS $$
  SELECT count(*)::int FROM checkin_recipients(p_ck) r WHERE r.member_id = p_mid;
$$;

-- A check-in by B, at p_place (NULL for none).
CREATE OR REPLACE FUNCTION _v20_checkin(p_keep uuid, p_mid uuid, p_place uuid, p_type text) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO checkins (keep_id, member_id, member_name, member_avatar, place, type, place_id)
    VALUES (p_keep, p_mid, 'B', '🙂', 'V20 Place', p_type, p_place)
  RETURNING id;
$$;

DO $$
DECLARE
  uid_o uuid; uid_a uuid; uid_b uuid; uid_p uuid;
  o_mid uuid; a_mid uuid; b_mid uuid; p_mid uuid;
  v_keep uuid; v_place uuid;
  ck1 uuid; ck2 uuid; ck3 uuid; ck4 uuid; ck5 uuid; ck_man uuid; ck_sos uuid;
  v_txt text; v_ins text; v_anon text;
  -- 1a
  a1_rec int; a1_sees int; a1_woken int; o1_rec int; p1_rec int;
  -- 1b, 1c, 1d
  b_rec int; b_sees int; b_woken int; c_sees int; c_woken int; d_sees int;
  -- 1e, 1g
  e_muted int; e_after int; e_next int; g_manual int;
  -- 1f
  f_sees int; f_woken int;
  -- 1h
  h_sees int; h_woken int;
  -- 1i
  i_others int; i_own int;
  -- 1j
  j_left int;
  v_prev_closed boolean; v_prev_until timestamptz;
  v_throwaway text[] := ARRAY['v20o@test.local', 'v20a@test.local', 'v20b@test.local', 'v20p@test.local'];
BEGIN
  SELECT signups_closed, signups_open_until INTO v_prev_closed, v_prev_until FROM roamkeep_meta;
  UPDATE roamkeep_meta SET signups_closed = false, signups_open_until = NULL WHERE id;
  DELETE FROM keeps WHERE name = 'V20 Test Family';
  DELETE FROM auth.users WHERE email = ANY (v_throwaway);

  uid_o := _v20_user('v20o@test.local');
  uid_a := _v20_user('v20a@test.local');
  uid_b := _v20_user('v20b@test.local');
  uid_p := _v20_user('v20p@test.local');

  -- O owns the Keep, A listens, B moves, P is still waiting for approval.
  -- Made directly: create_keep refuses a second family on a server.
  INSERT INTO keeps (code, name, created_by, code_expires_at, require_approval)
    VALUES (_roamkeep_gen_code(), 'V20 Test Family', uid_o, now() + interval '72 hours', true)
    RETURNING id INTO v_keep;
  o_mid := _v20_member(v_keep, uid_o, 'Owner', 'owner', true);
  a_mid := _v20_member(v_keep, uid_a, 'A', 'member', true);
  b_mid := _v20_member(v_keep, uid_b, 'B', 'member', true);
  p_mid := _v20_member(v_keep, uid_p, 'P', 'member', false);
  INSERT INTO keep_places (keep_id, name, lat, lng, created_by)
    VALUES (v_keep, 'V20 Place', 1, 2, uid_o) RETURNING id INTO v_place;

  -- Everything that writes a check-in, in one block that rolls itself back.
  BEGIN
    INSERT INTO keep_member_push (member_id, keep_id, fcm_token) VALUES
      (a_mid, v_keep, 'v20-test-token-a'), (o_mid, v_keep, 'v20-test-token-o'),
      (p_mid, v_keep, 'v20-test-token-p');

    -- 1a: nothing muted.
    ck1 := _v20_checkin(v_keep, b_mid, v_place, 'arrived');
    SELECT count(*) INTO a1_rec FROM checkin_notices WHERE checkin_id = ck1 AND member_id = a_mid;
    SELECT count(*) INTO o1_rec FROM checkin_notices WHERE checkin_id = ck1 AND member_id = o_mid;
    SELECT count(*) INTO p1_rec FROM checkin_notices WHERE checkin_id = ck1 AND member_id = p_mid;
    a1_sees := _v20_sees(uid_a, ck1);
    a1_woken := _v20_woken(ck1, a_mid);

    -- 1b: A turns everything off; B leaves.
    UPDATE keep_members SET notify_on_checkin = false WHERE id = a_mid;
    ck2 := _v20_checkin(v_keep, b_mid, v_place, 'left');
    SELECT count(*) INTO b_rec FROM checkin_notices WHERE checkin_id = ck2 AND member_id = a_mid;
    b_sees := _v20_sees(uid_a, ck2);
    b_woken := _v20_woken(ck2, a_mid);

    -- 1h: an SOS while A has everything off.
    ck_sos := _v20_checkin(v_keep, b_mid, NULL, 'sos');
    h_sees := _v20_sees(uid_a, ck_sos);
    h_woken := _v20_woken(ck_sos, a_mid);

    -- 1c: A turns everything back on. The departure from while it was off
    -- stays out (the reported bug: it came back on the next wake-up).
    UPDATE keep_members SET notify_on_checkin = true WHERE id = a_mid;
    c_sees := _v20_sees(uid_a, ck2);
    c_woken := _v20_woken(ck2, a_mid);

    -- 1d: and the next arrival is told.
    ck3 := _v20_checkin(v_keep, b_mid, v_place, 'arrived');
    d_sees := _v20_sees(uid_a, ck3);

    -- 1e: A mutes B at the place, B leaves, A unmutes B there.
    INSERT INTO keep_notify_prefs (keep_id, member_id, subject_member_id, place_id)
      VALUES (v_keep, a_mid, b_mid, v_place);
    ck4 := _v20_checkin(v_keep, b_mid, v_place, 'left');
    e_muted := _v20_sees(uid_a, ck4);
    -- 1g: a check-in with no place ignores the per-place mute.
    ck_man := _v20_checkin(v_keep, b_mid, NULL, 'manual');
    g_manual := _v20_sees(uid_a, ck_man);
    DELETE FROM keep_notify_prefs WHERE member_id = a_mid;
    e_after := _v20_sees(uid_a, ck4);
    ck5 := _v20_checkin(v_keep, b_mid, v_place, 'arrived');
    e_next := _v20_sees(uid_a, ck5);

    -- 1f: P was waiting when ck1 was written. Approved now, still not told.
    PERFORM _v20_act_as(uid_o);
    PERFORM approve_member(p_mid);
    PERFORM set_config('request.jwt.claims', '', true);
    f_sees := _v20_sees(uid_p, ck1);
    f_woken := _v20_woken(ck1, p_mid);

    -- 1i: clients write no notices and read only their own.
    BEGIN
      PERFORM _v20_act_as(uid_a);
      SET LOCAL ROLE authenticated;
      INSERT INTO checkin_notices (checkin_id, member_id) VALUES (ck2, a_mid);
      RESET ROLE;
      v_ins := 'inserted';
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      v_ins := SQLERRM;
    END;
    PERFORM _v20_act_as(uid_a);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO i_others FROM checkin_notices WHERE member_id <> a_mid;
    SELECT count(*) INTO i_own FROM checkin_notices WHERE member_id = a_mid;
    RESET ROLE;
    BEGIN
      SET LOCAL ROLE anon;
      PERFORM count(*) FROM checkin_notices;
      RESET ROLE;
      v_anon := 'read';
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      v_anon := SQLERRM;
    END;
    PERFORM set_config('request.jwt.claims', '', true);

    -- 1j: retention deletes a check-in's notices with it.
    DELETE FROM checkins WHERE id = ck1;
    SELECT count(*) INTO j_left FROM checkin_notices WHERE checkin_id = ck1;

    RAISE EXCEPTION 'v20_rollback';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    v_txt := SQLERRM;
  END;

  PERFORM _v20_r('1 the check-in steps ran to the end and were rolled back',
    v_txt = 'v20_rollback', v_txt);
  PERFORM _v20_r('1a with nothing muted, a check-in is recorded for, raised on and woken for the others; not for someone waiting',
    a1_rec = 1 AND o1_rec = 1 AND p1_rec = 0 AND a1_sees = 1 AND a1_woken = 1,
    format('A: recorded %s, feed %s, woken %s · owner recorded %s · waiting member recorded %s',
           a1_rec, a1_sees, a1_woken, o1_rec, p1_rec));
  PERFORM _v20_r('1b with everything off, a check-in is not recorded, raised or woken for',
    b_rec = 0 AND b_sees = 0 AND b_woken = 0,
    format('recorded %s, feed %s, woken %s', b_rec, b_sees, b_woken));
  PERFORM _v20_r('1c turning everything back on brings back nothing from while it was off',
    c_sees = 0 AND c_woken = 0, format('feed %s, woken %s', c_sees, c_woken));
  PERFORM _v20_r('1d the next check-in after turning it back on is raised',
    d_sees = 1, format('feed %s', d_sees));
  PERFORM _v20_r('1e unmuting one person at one place brings back nothing from while they were muted; the next one is raised',
    e_muted = 0 AND e_after = 0 AND e_next = 1,
    format('while muted %s, after unmuting %s, next %s', e_muted, e_after, e_next));
  PERFORM _v20_r('1f a member approved later is told nothing written while they waited',
    f_sees = 0 AND f_woken = 0, format('feed %s, woken %s', f_sees, f_woken));
  PERFORM _v20_r('1g a check-in with no place ignores the per-place mute',
    g_manual = 1, format('feed %s', g_manual));
  PERFORM _v20_r('1h an SOS reaches a member with everything off',
    h_sees = 1 AND h_woken = 1, format('feed %s, woken %s', h_sees, h_woken));
  PERFORM _v20_r('1i clients write no notices and read only their own; anon reads none',
    v_ins <> 'inserted' AND i_others = 0 AND i_own > 0 AND v_anon <> 'read',
    format('insert: %s · others visible %s · own visible %s · anon: %s', v_ins, i_others, i_own, v_anon));
  PERFORM _v20_r('1j deleting a check-in deletes its notices',
    j_left = 0, format('left %s', j_left));

  -- ── Clean up ──────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM keeps WHERE id = v_keep;
  DELETE FROM auth.users WHERE email = ANY (v_throwaway);
  UPDATE roamkeep_meta SET signups_closed = coalesce(v_prev_closed, false),
                           signups_open_until = v_prev_until WHERE id;
END $$;

INSERT INTO _v20_results(step, status, detail)
SELECT '2 schema_version is 20', CASE WHEN schema_version >= 20 THEN 'PASS' ELSE 'FAIL' END, schema_version::text
  FROM roamkeep_meta;

-- Only a real project can fail this: PGlite has no pg_net, so it reads "not
-- installed" there and no mutation can prove it. Staging is its test.
INSERT INTO _v20_results(step, status, detail)
SELECT '3 pg_net is not in public (Security Advisor: Extension in Public)',
       CASE WHEN coalesce(max(n.nspname), '') <> 'public' THEN 'PASS' ELSE 'FAIL' END,
       coalesce('in ' || max(n.nspname), 'not installed')
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
 WHERE e.extname = 'pg_net';

DROP FUNCTION IF EXISTS _v20_act_as(uuid, text);
DROP FUNCTION IF EXISTS _v20_r(text, boolean, text);
DROP FUNCTION IF EXISTS _v20_user(text);
DROP FUNCTION IF EXISTS _v20_member(uuid, uuid, text, text, boolean);
DROP FUNCTION IF EXISTS _v20_sees(uuid, uuid);
DROP FUNCTION IF EXISTS _v20_woken(uuid, uuid);
DROP FUNCTION IF EXISTS _v20_checkin(uuid, uuid, uuid, text);

SELECT step, status, detail FROM _v20_results ORDER BY id;
