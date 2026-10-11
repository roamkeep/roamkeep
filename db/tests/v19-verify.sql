-- ============================================================
-- Roamkeep v19 — verification script (run on STAGING, never a family)
--
-- Proves what schema v19 changes:
--
--   1  Declining a request deletes the account made to send it and changes
--      the join code, as removing someone does. An account still in another
--      Keep keeps its sign-in. Only an approved owner can decline.
--
-- Each rule has a mutation in db/tests/pglite/mutate.mjs that weakens it and
-- expects the step named here to FAIL.
--
-- Results go to a _v19_results table returned by the final SELECT, because
-- the Supabase SQL Editor does NOT display RAISE NOTICE output. Every row
-- should read PASS.
--
-- SETUP: apply db/schema.sql (v19) to the staging project, then paste this
-- WHOLE file into Dashboard → SQL Editor → Run. No accounts to create first:
-- it makes its own (v19o, v19adult, v19pend, v19dual, v19pend2, v19waitowner
-- @test.local) and its own two Keeps ('V19 Test Family', 'V19 Other Family')
-- directly, as the database owner, and deletes all of them first and again
-- at the end. Sign-ups are held open while it runs (the sign-up gate is a
-- trigger on auth.users) and put back the way they were. Safe to re-run.
--
-- Its join requests wake the test Keep's owner through notify-places. That
-- owner is a throwaway account with no phone, so nothing reaches a device.
-- ============================================================

DROP TABLE IF EXISTS _v19_results;
CREATE TABLE _v19_results (id serial primary key, step text, status text, detail text);

CREATE OR REPLACE FUNCTION _v19_act_as(p uuid, p_role text DEFAULT 'authenticated') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', p_role)::text, true);
END $$;

CREATE OR REPLACE FUNCTION _v19_r(p_step text, p_ok boolean, p_detail text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO _v19_results(step, status, detail)
  VALUES (p_step, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, coalesce(p_detail, ''));
$$;

CREATE OR REPLACE FUNCTION _v19_user(p_email text) RETURNS uuid
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

-- A membership made directly, as the database owner: join_keep_by_code
-- refuses an account that is already in a Keep (one Keep per account, v16),
-- and 1c needs exactly that account.
CREATE OR REPLACE FUNCTION _v19_member(p_keep uuid, p_user uuid, p_name text, p_role text, p_approved boolean)
RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO keep_members (keep_id, user_id, name, avatar, role, member_type, approved)
    VALUES (p_keep, p_user, p_name, '🙂', p_role, 'adult', p_approved)
  RETURNING id;
$$;

DO $$
DECLARE
  uid_o uuid; uid_a uuid; uid_p uuid; uid_d uuid; uid_q uuid; uid_w uuid;
  v_keep uuid; v_other uuid;
  p_mid uuid; d_mid uuid; q_mid uuid;
  v_code text; v_status text; v_txt text;
  v_n int; v_i int; v_r int; v_b boolean;
  v_prev_closed boolean; v_prev_until timestamptz;
  v_throwaway text[] := ARRAY['v19o@test.local', 'v19adult@test.local', 'v19pend@test.local',
                              'v19dual@test.local', 'v19pend2@test.local', 'v19waitowner@test.local'];
BEGIN
  SELECT signups_closed, signups_open_until INTO v_prev_closed, v_prev_until FROM roamkeep_meta;
  UPDATE roamkeep_meta SET signups_closed = false, signups_open_until = NULL WHERE id;
  DELETE FROM keeps WHERE name IN ('V19 Test Family', 'V19 Other Family');
  DELETE FROM auth.users WHERE email = ANY (v_throwaway);

  uid_o := _v19_user('v19o@test.local');
  uid_a := _v19_user('v19adult@test.local');
  uid_p := _v19_user('v19pend@test.local');
  uid_d := _v19_user('v19dual@test.local');
  uid_q := _v19_user('v19pend2@test.local');
  uid_w := _v19_user('v19waitowner@test.local');

  -- The test family: an owner and an adult, with approval on. Made directly:
  -- create_keep refuses a second family on a server, and staging has one.
  INSERT INTO keeps (code, name, created_by, code_expires_at, require_approval)
    VALUES (_roamkeep_gen_code(), 'V19 Test Family', uid_o, now() + interval '72 hours', true)
    RETURNING id INTO v_keep;
  PERFORM _v19_member(v_keep, uid_o, 'Owner', 'owner', true);
  PERFORM _v19_member(v_keep, uid_a, 'Adult', 'member', true);

  -- Another family, which v19dual already belongs to (a server from before
  -- v17 can hold two).
  INSERT INTO keeps (code, name, created_by, code_expires_at)
    VALUES (_roamkeep_gen_code(), 'V19 Other Family', uid_d, now() + interval '72 hours')
    RETURNING id INTO v_other;
  PERFORM _v19_member(v_other, uid_d, 'Dual', 'owner', true);

  -- ── 1) Declining deletes the account and changes the code ─────
  -- v19pend asks through the function, as the app does.
  PERFORM _v19_act_as(uid_p);
  SELECT j.status, j.member_id INTO v_status, p_mid
    FROM join_keep_by_code((SELECT code FROM keeps WHERE id = v_keep), 'Pend', '🙂') j;
  SELECT code INTO v_code FROM keeps WHERE id = v_keep;

  PERFORM _v19_act_as(uid_o);
  BEGIN
    PERFORM decline_member(p_mid);
    v_txt := 'declined';
  EXCEPTION WHEN OTHERS THEN
    v_txt := SQLERRM;
  END;
  SELECT count(*) INTO v_n FROM keep_members WHERE id = p_mid;
  SELECT count(*) INTO v_i FROM auth.users WHERE id = uid_p;
  PERFORM _v19_r('1a declining deletes the request and the account made to send it',
    v_status = 'pending' AND v_n = 0 AND v_i = 0,
    format('join: %s · %s · request rows %s · account rows %s', v_status, v_txt, v_n, v_i));

  SELECT code IS DISTINCT FROM v_code INTO v_b FROM keeps WHERE id = v_keep;
  PERFORM _v19_r('1b declining changes the join code, so the invite they used stops working',
    coalesce(v_b, false), coalesce(v_b::text, 'no keep'));

  -- An account still in another Keep keeps its sign-in and that membership.
  d_mid := _v19_member(v_keep, uid_d, 'Dual', 'member', false);
  PERFORM _v19_act_as(uid_o);
  BEGIN
    PERFORM decline_member(d_mid);
    v_txt := 'declined';
  EXCEPTION WHEN OTHERS THEN
    v_txt := SQLERRM;
  END;
  SELECT count(*) INTO v_n FROM auth.users WHERE id = uid_d;
  SELECT count(*) INTO v_i FROM keep_members WHERE user_id = uid_d AND keep_id = v_other;
  SELECT count(*) INTO v_r FROM keep_members WHERE id = d_mid;
  PERFORM _v19_r('1c declining someone still in another Keep keeps their sign-in and that membership',
    v_txt = 'declined' AND v_n = 1 AND v_i = 1 AND v_r = 0,
    format('%s · account rows %s · other membership %s · request rows %s', v_txt, v_n, v_i, v_r));

  -- Only an approved owner declines. Each attempt that wrongly succeeds is
  -- rolled back by the deliberate raise, so nothing is left deleted.
  q_mid := _v19_member(v_keep, uid_q, 'Pend2', 'member', false);
  PERFORM _v19_act_as(uid_a);
  BEGIN
    PERFORM decline_member(q_mid);
    RAISE EXCEPTION 'v19_unexpected_success';
  EXCEPTION WHEN OTHERS THEN
    v_txt := SQLERRM;
  END;
  PERFORM _v19_r('1d a member who is not an owner cannot decline',
    v_txt LIKE '%not_owner%', v_txt);

  PERFORM _v19_member(v_keep, uid_w, 'WaitOwner', 'owner', false);
  PERFORM _v19_act_as(uid_w);
  BEGIN
    PERFORM decline_member(q_mid);
    RAISE EXCEPTION 'v19_unexpected_success';
  EXCEPTION WHEN OTHERS THEN
    v_txt := SQLERRM;
  END;
  SELECT count(*) INTO v_n FROM auth.users WHERE id = uid_q;
  PERFORM _v19_r('1e an owner still waiting for approval cannot decline, and nothing was deleted',
    v_txt LIKE '%not_owner%' AND v_n = 1, format('%s · account rows %s', v_txt, v_n));

  -- ── Clean up ──────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM keeps WHERE id IN (v_keep, v_other);
  DELETE FROM auth.users WHERE email = ANY (v_throwaway);
  UPDATE roamkeep_meta SET signups_closed = coalesce(v_prev_closed, false),
                           signups_open_until = v_prev_until WHERE id;
END $$;

INSERT INTO _v19_results(step, status, detail)
SELECT '2 schema_version is 19', CASE WHEN schema_version >= 19 THEN 'PASS' ELSE 'FAIL' END, schema_version::text
  FROM roamkeep_meta;

DROP FUNCTION IF EXISTS _v19_act_as(uuid, text);
DROP FUNCTION IF EXISTS _v19_r(text, boolean, text);
DROP FUNCTION IF EXISTS _v19_user(text);
DROP FUNCTION IF EXISTS _v19_member(uuid, uuid, text, text, boolean);

SELECT step, status, detail FROM _v19_results ORDER BY id;
