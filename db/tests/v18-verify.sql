-- ============================================================
-- Roamkeep v18 — verification script (run on STAGING, never a family)
--
-- Proves what schema v18 changes. Each rule came out of the October 2026
-- independent review, and each has a mutation in db/tests/pglite/mutate.mjs
-- that weakens it and expects the step named here to FAIL.
--
--   1  Leaving deletes you. Remove, Leave and a completed child request
--      delete the sign-in too, except for an account still in another Keep;
--      deleting your own account checks every membership, not the oldest.
--   2  A reset code is checked again when it is used, and burnt if the
--      family changed under it.
--   3  A member waiting for approval writes nothing through the functions
--      either, and an owner still waiting administers nothing.
--   4  A child cannot be made an owner; becoming a child ends a pause;
--      demoting an owner who is still waiting is not "the last owner".
--   5  Hardening: pg_temp last on every SECURITY DEFINER function, no
--      TRUNCATE for clients, the member guard covers id and created_at,
--      notification settings bound to one membership.
--
-- Results go to a _v18_results table returned by the final SELECT, because
-- the Supabase SQL Editor does NOT display RAISE NOTICE output. Every row
-- should read PASS.
--
-- SETUP (once, before running):
--   1. Apply db/schema.sql (v18) to the staging project.
--   2. Create TWO auth accounts (app sign-up or Auth dashboard):
--        v18owner@test.local   v18member@test.local
--      They are the script's alone. Never use them in the app to create or
--      join a Keep. (If one is in a Keep, the script stops at once with a
--      "0 setup" row naming it.)
--   3. Paste this WHOLE file into Dashboard → SQL Editor → Run.
--
-- v18member@test.local's password is NOT changed: every redemption below
-- must be refused, and 2a checks that it was.
--
-- It makes its own two Keeps directly, as the database owner ('V18 Test
-- Family', 'V18 Other Family'), and its own throwaway accounts (v18gone,
-- v18leaver, v18kid, v18dual, v18pend, v18co, v18lone @test.local),
-- deleting all of them first and again at the end. Sign-ups are held open
-- while it runs (the sign-up gate is a trigger on auth.users) and put back
-- the way they were. Safe to re-run.
--
-- A pending member is added (3), which wakes the test Keep's owners through
-- notify-places: a phone signed in as v18owner may get "wants to join".
-- Nothing else reaches a device. The steps that write a check-in roll
-- themselves back.
-- ============================================================

DROP TABLE IF EXISTS _v18_results;
CREATE TABLE _v18_results (id serial primary key, step text, status text, detail text);

CREATE OR REPLACE FUNCTION _v18_act_as(p uuid, p_role text DEFAULT 'authenticated') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', p_role)::text, true);
END $$;

CREATE OR REPLACE FUNCTION _v18_r(p_step text, p_ok boolean, p_detail text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO _v18_results(step, status, detail)
  VALUES (p_step, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, coalesce(p_detail, ''));
$$;

CREATE OR REPLACE FUNCTION _v18_user(p_email text) RETURNS uuid
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

-- A Keep with its founding owner, made directly: create_keep refuses a
-- second family on a server, and staging already has one.
CREATE OR REPLACE FUNCTION _v18_make_keep(p_owner uuid, p_name text, p_member_created timestamptz)
RETURNS TABLE (keep_id uuid, member_id uuid)
LANGUAGE plpgsql AS $$
DECLARE
  v_keep uuid;
  v_mid uuid;
BEGIN
  INSERT INTO keeps (code, name, created_by, code_expires_at)
    VALUES (_roamkeep_gen_code(), p_name, p_owner, now() + interval '72 hours')
    RETURNING id INTO v_keep;
  INSERT INTO keep_members (keep_id, user_id, name, avatar, role, member_type, created_at)
    VALUES (v_keep, p_owner, 'Owner', '👩', 'owner', 'adult', p_member_created)
    RETURNING id INTO v_mid;
  RETURN QUERY SELECT v_keep, v_mid;
END $$;

-- A membership made directly, as join_keep_by_code would make it.
CREATE OR REPLACE FUNCTION _v18_join(p_keep uuid, p_user uuid, p_name text, p_type text,
                                     p_approved boolean, p_created timestamptz)
RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO keep_members (keep_id, user_id, name, avatar, role, member_type, approved, created_at)
    VALUES (p_keep, p_user, p_name, '🙂', 'member', p_type, p_approved, p_created)
  RETURNING id;
$$;

DO $$
DECLARE
  uid_o uuid; uid_m uuid; uid_g uuid; uid_l uuid; uid_k uuid; uid_d uuid; uid_p uuid; uid_c uuid; uid_n uuid;
  v_keep uuid; v_other uuid; v_place uuid;
  o_mid uuid; m_mid uuid; g_mid uuid; l_mid uuid; k_mid uuid; d_mid uuid; d_mid2 uuid;
  p_mid uuid; c_mid uuid; n_mid uuid; n_mid2 uuid;
  v_code text; v_old_code text; v_status text; v_txt text; v_pw text;
  v_n int; v_i int; v_b boolean; v_b2 boolean;
  v_prev_closed boolean; v_prev_until timestamptz;
  v_throwaway text[] := ARRAY['v18gone@test.local', 'v18leaver@test.local', 'v18kid@test.local',
                              'v18dual@test.local', 'v18pend@test.local', 'v18co@test.local',
                              'v18lone@test.local'];
BEGIN
  SELECT id INTO uid_o FROM auth.users WHERE email = 'v18owner@test.local';
  SELECT id INTO uid_m FROM auth.users WHERE email = 'v18member@test.local';
  IF uid_o IS NULL OR uid_m IS NULL THEN
    PERFORM _v18_r('0 setup', false, 'Create v18owner@test.local and v18member@test.local first (see header).');
    RETURN;
  END IF;

  SELECT string_agg(format('%s is in "%s"', u.email, k.name), '; ') INTO v_txt
    FROM keep_members m
    JOIN keeps k      ON k.id = m.keep_id
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.user_id IN (uid_o, uid_m)
     AND k.name NOT IN ('V18 Test Family', 'V18 Other Family');
  IF v_txt IS NOT NULL THEN
    PERFORM _v18_r('0 setup', false,
      v_txt || ' — the test accounts must not be in any Keep. Make the staging family with other accounts (see header).');
    RETURN;
  END IF;

  SELECT signups_closed, signups_open_until INTO v_prev_closed, v_prev_until FROM roamkeep_meta;
  UPDATE roamkeep_meta SET signups_closed = false, signups_open_until = NULL WHERE id;
  DELETE FROM keeps WHERE name IN ('V18 Test Family', 'V18 Other Family');
  DELETE FROM auth.users WHERE email = ANY (v_throwaway);
  DELETE FROM password_reset_codes WHERE user_id IN (uid_o, uid_m);

  uid_g := _v18_user('v18gone@test.local');
  uid_l := _v18_user('v18leaver@test.local');
  uid_k := _v18_user('v18kid@test.local');
  uid_d := _v18_user('v18dual@test.local');
  uid_p := _v18_user('v18pend@test.local');
  uid_c := _v18_user('v18co@test.local');
  uid_n := _v18_user('v18lone@test.local');

  -- The test family. v18lone's membership here is backdated so it is their
  -- OLDEST: the one delete_my_account used to look at alone (1f).
  SELECT k.keep_id, k.member_id INTO v_keep, o_mid
    FROM _v18_make_keep(uid_o, 'V18 Test Family', now() - interval '2 hours') k;
  m_mid := _v18_join(v_keep, uid_m, 'Max', 'adult', true, now() - interval '2 hours');
  g_mid := _v18_join(v_keep, uid_g, 'Gone', 'adult', true, now() - interval '2 hours');
  l_mid := _v18_join(v_keep, uid_l, 'Leaver', 'adult', true, now() - interval '2 hours');
  k_mid := _v18_join(v_keep, uid_k, 'Kid', 'child', true, now() - interval '2 hours');
  d_mid := _v18_join(v_keep, uid_d, 'Dual', 'adult', true, now() - interval '2 hours');
  c_mid := _v18_join(v_keep, uid_c, 'Co', 'adult', true, now() - interval '2 hours');
  n_mid := _v18_join(v_keep, uid_n, 'Lone', 'adult', true, now() - interval '1 hour');

  -- A second family on the same server, as only a server from before v16
  -- can have: v18lone is its sole owner and v18dual is in both.
  SELECT k.keep_id, k.member_id INTO v_other, n_mid2 FROM _v18_make_keep(uid_n, 'V18 Other Family', now()) k;
  d_mid2 := _v18_join(v_other, uid_d, 'Dual', 'adult', true, now());
  INSERT INTO keep_places (keep_id, name, lat, lng, created_by)
    VALUES (v_other, 'Elsewhere', -33.9, 151.1, uid_n) RETURNING id INTO v_place;

  -- ── 5c) The member guard covers id and created_at ──────────────
  -- As the table owner, so RLS is out of the way and only the guard answers.
  v_txt := '';
  BEGIN
    UPDATE keep_members SET id = gen_random_uuid() WHERE id = m_mid;
    v_txt := v_txt || 'id changed; ';
    RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%protected_column%' AND SQLERRM <> 'v18_rollback' THEN v_txt := v_txt || SQLERRM || '; '; END IF;
  END;
  BEGIN
    UPDATE keep_members SET created_at = now() - interval '1 year' WHERE id = m_mid;
    v_txt := v_txt || 'created_at changed; ';
    RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%protected_column%' AND SQLERRM <> 'v18_rollback' THEN v_txt := v_txt || SQLERRM || '; '; END IF;
  END;
  PERFORM _v18_r('5c a member row''s id and created_at change through nothing (guard)', v_txt = '', v_txt);

  -- ── 5d) Notification settings belong to one membership ─────────
  -- v18dual names their membership in the test family, but the other
  -- family's Keep, member and place. Rolled back if it gets in.
  PERFORM _v18_act_as(uid_d);
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO keep_notify_prefs (keep_id, member_id, subject_member_id, place_id)
      VALUES (v_other, d_mid, n_mid2, v_place);
    RESET ROLE;
    v_txt := 'inserted';
    RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    IF SQLERRM <> 'v18_rollback' THEN v_txt := SQLERRM; END IF;
  END;
  PERFORM _v18_r('5d a notification setting cannot pair one family''s member with another''s keep',
    v_txt LIKE '%row-level security%', v_txt);

  -- ── 4) Role combinations ───────────────────────────────────────
  PERFORM _v18_act_as(uid_o);
  BEGIN
    PERFORM set_member_role(k_mid, 'owner');
    v_txt := 'promoted';
    RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'v18_rollback' THEN v_txt := SQLERRM; END IF;
  END;
  PERFORM _v18_r('4a a child cannot be made an owner', v_txt LIKE '%child_cannot_be_owner%', v_txt);

  PERFORM _v18_act_as(uid_m);
  PERFORM pause_member(m_mid, now() + interval '1 hour');
  PERFORM _v18_act_as(uid_o);
  PERFORM set_member_type(m_mid, 'child');
  SELECT paused_until IS NULL INTO v_b FROM keep_members WHERE id = m_mid;
  PERFORM set_member_type(m_mid, 'adult');
  PERFORM _v18_r('4b marking a paused adult as a child ends the pause', coalesce(v_b, false),
    CASE WHEN v_b THEN 'cleared' ELSE 'still paused' END);

  -- ── 2) A reset code is checked again when it is used ───────────
  SELECT encrypted_password INTO v_pw FROM auth.users WHERE id = uid_m;

  -- 2a: made for a member, used after they were made an owner.
  PERFORM _v18_act_as(uid_o);
  v_code := issue_password_reset(m_mid);
  PERFORM set_member_role(m_mid, 'owner');
  PERFORM _v18_act_as(NULL, 'anon');
  v_status := redeem_password_reset('v18member@test.local', v_code, 'V18-Changed-1');
  SELECT encrypted_password = v_pw INTO v_b FROM auth.users WHERE id = uid_m;
  PERFORM _v18_r('2a a code made for a member does not work once they are an owner',
    v_status = 'invalid' AND coalesce(v_b, false),
    v_status || ' · password unchanged: ' || coalesce(v_b::text, 'null'));

  -- 2d: a refused redemption burns the code. Put back the way it was, the
  -- same code still does not work.
  SELECT code_hash IS NULL INTO v_b FROM password_reset_codes WHERE user_id = uid_m;
  PERFORM _v18_act_as(uid_o);
  PERFORM set_member_role(m_mid, 'member');
  PERFORM _v18_act_as(NULL, 'anon');
  v_status := redeem_password_reset('v18member@test.local', v_code, 'V18-Changed-1');
  PERFORM _v18_r('2d a code refused at redemption is burnt, and stays burnt',
    coalesce(v_b, false) AND v_status = 'invalid',
    'hash cleared: ' || coalesce(v_b::text, 'no row') || ' · retried: ' || v_status);

  -- 2b: made by an owner who is no longer one when it is used.
  PERFORM _v18_act_as(uid_o);
  PERFORM set_member_role(c_mid, 'owner');
  PERFORM _v18_act_as(uid_c);
  v_code := issue_password_reset(m_mid);
  PERFORM _v18_act_as(uid_o);
  PERFORM set_member_role(c_mid, 'member');
  PERFORM _v18_act_as(NULL, 'anon');
  v_status := redeem_password_reset('v18member@test.local', v_code, 'V18-Changed-1');
  SELECT encrypted_password = v_pw INTO v_b FROM auth.users WHERE id = uid_m;
  PERFORM _v18_r('2b a code does not work once whoever made it is no longer an owner',
    v_status = 'invalid' AND coalesce(v_b, false),
    v_status || ' · password unchanged: ' || coalesce(v_b::text, 'null'));

  -- ── 1d + 2c) Removed from one family, still in another ─────────
  -- v18dual is in both. A code made in the test family, then a removal from
  -- it: the account stays (it is still the other family's member), the
  -- other membership with it, and the code no longer works.
  PERFORM _v18_act_as(uid_o);
  v_code := issue_password_reset(d_mid);
  PERFORM remove_member(d_mid);
  SELECT count(*) INTO v_n FROM auth.users WHERE id = uid_d;
  SELECT count(*) INTO v_i FROM keep_members WHERE id = d_mid2;
  PERFORM _v18_r('1d removing someone still in another Keep keeps their sign-in and that membership',
    v_n = 1 AND v_i = 1, format('account rows %s, other membership %s', v_n, v_i));
  PERFORM _v18_act_as(NULL, 'anon');
  v_status := redeem_password_reset('v18dual@test.local', v_code, 'V18-Changed-1');
  PERFORM _v18_r('2c a code does not work once its member has left the Keep it was made in',
    v_status = 'invalid', v_status);

  -- ── 3) A member waiting for approval ───────────────────────────
  -- Inserted pending, as join_keep_by_code does with approval on.
  p_mid := _v18_join(v_keep, uid_p, 'Pending', 'adult', false, now());

  PERFORM _v18_act_as(uid_p);
  BEGIN
    PERFORM update_member_profile(p_mid, 'Renamed', '😈');
    v_txt := 'edited';
    RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'v18_rollback' THEN v_txt := SQLERRM; END IF;
  END;
  PERFORM _v18_r('3a a pending member cannot edit their own profile', v_txt LIKE '%member_pending%', v_txt);

  BEGIN
    PERFORM pause_member(p_mid, now() + interval '1 hour');
    v_txt := 'paused';
    RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'v18_rollback' THEN v_txt := SQLERRM; END IF;
  END;
  PERFORM _v18_r('3b a pending member cannot pause', v_txt LIKE '%member_pending%', v_txt);

  BEGIN
    PERFORM resume_member(p_mid);
    v_txt := 'resumed';
    RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'v18_rollback' THEN v_txt := SQLERRM; END IF;
  END;
  PERFORM _v18_r('3c a pending member cannot resume', v_txt LIKE '%member_pending%', v_txt);

  -- An expired check-in and breadcrumb, then the pending member runs the
  -- family's prune. Rolled back either way, so no webhook leaves for it.
  v_txt := NULL; v_n := NULL; v_i := NULL;
  BEGIN
    INSERT INTO checkins (keep_id, member_id, member_name, member_avatar, place, type, created_at)
      VALUES (v_keep, o_mid, 'Owner', '👩', 'v18 old', 'manual', now() - interval '8 days');
    INSERT INTO location_history (keep_id, member_id, lat, lng, recorded_at)
      VALUES (v_keep, o_mid, -33.8, 151.2, now() - interval '8 days');
    SELECT p.checkins_deleted + p.history_deleted INTO v_n FROM prune_keep_history() p;
    SELECT (SELECT count(*) FROM checkins WHERE keep_id = v_keep AND place = 'v18 old')
         + (SELECT count(*) FROM location_history WHERE member_id = o_mid AND recorded_at < now() - interval '7 days')
      INTO v_i;
    RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'v18_rollback' THEN v_txt := SQLERRM; END IF;
  END;
  PERFORM _v18_r('3d a pending member''s prune deletes nothing of the family''s',
    v_txt IS NULL AND v_n = 0 AND v_i = 2,
    coalesce(v_txt, format('deleted %s, still there %s of 2', v_n, v_i)));

  PERFORM _v18_act_as(uid_o);
  BEGIN
    PERFORM set_member_role(p_mid, 'owner');
    v_txt := 'promoted';
    RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'v18_rollback' THEN v_txt := SQLERRM; END IF;
  END;
  PERFORM _v18_r('3e a pending member cannot be made an owner', v_txt LIKE '%member_pending%', v_txt);

  -- 3f: an owner still waiting for approval, as a server could hold from
  -- before v18. Every owner function must answer not_owner. Each call rolls
  -- itself back, so one that gets through changes nothing for the rest.
  PERFORM set_config('roamkeep.priv', 'on', true);
  UPDATE keep_members SET role = 'owner' WHERE id = p_mid;
  PERFORM set_config('roamkeep.priv', 'off', true);
  PERFORM _v18_act_as(uid_p);
  v_txt := '';
  BEGIN PERFORM rotate_keep_code(v_keep); v_txt := v_txt || 'rotate_keep_code '; RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%not_owner%' AND SQLERRM <> 'v18_rollback' THEN v_txt := v_txt || SQLERRM || ' '; END IF; END;
  BEGIN PERFORM get_invite(v_keep); v_txt := v_txt || 'get_invite '; RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%not_owner%' AND SQLERRM <> 'v18_rollback' THEN v_txt := v_txt || SQLERRM || ' '; END IF; END;
  BEGIN PERFORM rename_keep(v_keep, 'Taken over'); v_txt := v_txt || 'rename_keep '; RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%not_owner%' AND SQLERRM <> 'v18_rollback' THEN v_txt := v_txt || SQLERRM || ' '; END IF; END;
  BEGIN PERFORM remove_member(m_mid); v_txt := v_txt || 'remove_member '; RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%not_owner%' AND SQLERRM <> 'v18_rollback' THEN v_txt := v_txt || SQLERRM || ' '; END IF; END;
  BEGIN PERFORM set_member_role(m_mid, 'owner'); v_txt := v_txt || 'set_member_role '; RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%not_owner%' AND SQLERRM <> 'v18_rollback' THEN v_txt := v_txt || SQLERRM || ' '; END IF; END;
  BEGIN PERFORM set_member_type(m_mid, 'child'); v_txt := v_txt || 'set_member_type '; RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%not_owner%' AND SQLERRM <> 'v18_rollback' THEN v_txt := v_txt || SQLERRM || ' '; END IF; END;
  PERFORM _v18_r('3f an owner still waiting for approval administers nothing', v_txt = '',
    CASE WHEN v_txt = '' THEN 'all six refused' ELSE 'allowed: ' || v_txt END);

  -- 4c: demoting that owner is not refused as "the last owner": they never
  -- counted as one.
  PERFORM _v18_act_as(uid_o);
  BEGIN
    PERFORM set_member_role(p_mid, 'member');
    v_txt := 'demoted';
  EXCEPTION WHEN OTHERS THEN
    v_txt := SQLERRM;
  END;
  PERFORM _v18_r('4c demoting an owner still waiting for approval is not refused as the last owner',
    v_txt = 'demoted', v_txt);

  -- ── 1f) Deleting your own account checks every membership ──────
  -- v18lone's OLDEST membership is an ordinary one; their newer one is the
  -- sole ownership of the other family, which v18dual is still in. Rolled
  -- back if it gets through.
  PERFORM _v18_act_as(uid_n);
  BEGIN
    PERFORM delete_my_account();
    v_txt := 'deleted';
    RAISE EXCEPTION 'v18_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'v18_rollback' THEN v_txt := SQLERRM; END IF;
  END;
  PERFORM _v18_r('1f deleting your account is refused while you are the last owner of ANY family with others in it',
    v_txt LIKE '%last_owner%', v_txt);

  -- ── 1a-1c) Leaving deletes you ────────────────────────────────
  PERFORM _v18_act_as(uid_o);
  INSERT INTO location_history (keep_id, member_id, lat, lng) VALUES (v_keep, g_mid, -33.8, 151.2);
  SELECT code INTO v_old_code FROM keeps WHERE id = v_keep;
  PERFORM remove_member(g_mid);
  SELECT count(*) INTO v_n FROM auth.users WHERE id = uid_g;
  SELECT count(*) INTO v_i FROM location_history WHERE member_id = g_mid;
  SELECT code IS DISTINCT FROM v_old_code INTO v_b FROM keeps WHERE id = v_keep;
  PERFORM _v18_r('1a an owner removing a member deletes their sign-in, history and all, and rotates the code',
    v_n = 0 AND v_i = 0 AND coalesce(v_b, false),
    format('account rows %s, history rows %s, code changed %s', v_n, v_i, v_b));

  PERFORM _v18_act_as(uid_l);
  PERFORM leave_keep(l_mid);
  SELECT count(*) INTO v_n FROM auth.users WHERE id = uid_l;
  PERFORM _v18_r('1b leaving deletes the leaver''s sign-in', v_n = 0, format('account rows %s', v_n));

  PERFORM _v18_act_as(uid_o);
  SELECT code INTO v_old_code FROM keeps WHERE id = v_keep;
  PERFORM delete_child_account(k_mid);
  SELECT count(*) INTO v_n FROM auth.users WHERE id = uid_k;
  SELECT code IS DISTINCT FROM v_old_code INTO v_b FROM keeps WHERE id = v_keep;
  PERFORM _v18_r('1c completing a child''s deletion deletes their sign-in and rotates the code, as Remove does',
    v_n = 0 AND coalesce(v_b, false), format('account rows %s, code changed %s', v_n, v_b));

  -- ── Clean up ──────────────────────────────────────────────────
  DELETE FROM keeps WHERE id IN (v_keep, v_other);
  DELETE FROM auth.users WHERE email = ANY (v_throwaway);
  DELETE FROM password_reset_codes WHERE user_id IN (uid_o, uid_m);
  UPDATE roamkeep_meta SET signups_closed = coalesce(v_prev_closed, false),
                           signups_open_until = v_prev_until WHERE id;
END $$;

-- ── Catalog checks (objects, not the number) ────────────────────
INSERT INTO _v18_results(step, status, detail)
SELECT '5a every SECURITY DEFINER function puts pg_temp last on its search_path',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       coalesce('missing on: ' || string_agg(p.proname, ', ' ORDER BY p.proname), 'all of them')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c
                    WHERE c ~ '^search_path=.*pg_temp$'
                       OR c = 'search_path=""');   -- the sign-up gate: empty, every name qualified

INSERT INTO _v18_results(step, status, detail)
SELECT '5b clients hold no TRUNCATE, REFERENCES or TRIGGER on any table, and nothing on the two server-only ones',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       coalesce(string_agg(r.role || ' ' || x.priv || ' ' || x.tbl, ', '), 'none')
  FROM (VALUES ('anon'), ('authenticated')) r(role),
       (SELECT t.tbl, pr.priv
          FROM (VALUES ('keeps'), ('keep_members'), ('checkins'), ('keep_places'), ('location_history'),
                       ('keep_join_attempts'), ('roamkeep_meta'), ('keep_notify_prefs'), ('keep_member_push'),
                       ('roamkeep_secrets'), ('password_reset_codes')) t(tbl),
               (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) pr(priv)
        UNION ALL
        SELECT t.tbl, pr.priv
          FROM (VALUES ('keep_join_attempts'), ('roamkeep_secrets')) t(tbl),
               (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) pr(priv)) x
 WHERE has_table_privilege(r.role, 'public.' || x.tbl, x.priv);

INSERT INTO _v18_results(step, status, detail)
SELECT '5e the check-in webhook trigger is present, and the shared removal is not client-callable',
       CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_checkin_notify' AND NOT tgisinternal)
             AND NOT has_function_privilege('anon', 'public._roamkeep_delete_member(uuid)', 'execute')
             AND NOT has_function_privilege('authenticated', 'public._roamkeep_delete_member(uuid)', 'execute')
            THEN 'PASS' ELSE 'FAIL' END,
       'on_checkin_notify ' || CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_checkin_notify')
                                    THEN 'present' ELSE 'MISSING' END;

INSERT INTO _v18_results(step, status, detail)
SELECT '6 schema_version is 18', CASE WHEN schema_version >= 18 THEN 'PASS' ELSE 'FAIL' END, schema_version::text
  FROM roamkeep_meta;

DROP FUNCTION _v18_act_as(uuid, text);
DROP FUNCTION _v18_r(text, boolean, text);
DROP FUNCTION _v18_user(text);
DROP FUNCTION _v18_make_keep(uuid, text, timestamptz);
DROP FUNCTION _v18_join(uuid, uuid, text, text, boolean, timestamptz);
SELECT step, status, detail FROM _v18_results ORDER BY id;
