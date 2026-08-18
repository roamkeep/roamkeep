-- ============================================================
-- Roamkeep v8 — verification script (run on a SCRATCH project)
--
-- Proves the security-critical invariants of the roles + invite-
-- hardening migration. Results are written to a _v8_results table and
-- returned by a final SELECT, because the Supabase SQL Editor does NOT
-- display RAISE NOTICE output — you'd see nothing. Read the grid the
-- last SELECT returns: every row is PASS or FAIL.
--
-- SETUP (once, before running):
--   1. Apply db/schema.sql (or the v8 migration on top of v7) to the
--      scratch project.
--   2. Create THREE auth accounts (app sign-up or Auth dashboard) with
--      these emails so they exist in auth.users:
--        v8owner@test.local   v8member@test.local   v8child@test.local
--   3. Paste this WHOLE file into Dashboard → SQL Editor → Run.
--   4. Read the returned grid (step / status / detail). All should PASS.
--
-- Safe to re-run: it clears its own prior test data first, and the test
-- keep is deleted at the end (CASCADE removes its members/history/
-- check-ins). Test data is namespaced under the keep name 'V8 Test
-- Family' and the v8*@test.local users.
--
-- How it works: the SECURITY DEFINER RPCs read auth.uid() from
-- request.jwt.claims, so _v8_act_as(uid) makes auth.uid() return the
-- user we want for the next call. We stay a superuser on purpose — the
-- RPCs' OWN authorization checks and the protected-column TRIGGER
-- (triggers fire for everyone) are what the runtime checks exercise; the
-- pure-RLS invariants (which a superuser bypasses) are proven instead by
-- inspecting the policy catalog, which needs no role switch.
-- ============================================================

DROP TABLE IF EXISTS _v8_results;
CREATE TABLE _v8_results (id serial primary key, step text, status text, detail text);

CREATE OR REPLACE FUNCTION _v8_act_as(p uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p)::text, true);
END $$;


-- ── Runtime checks: RPC authorization + protected-column trigger ────
DO $$
DECLARE
  uid_owner uuid; uid_member uuid; uid_child uuid;
  v_keep_id uuid; v_code text; v_new_code text; v_expires timestamptz;
  v_owner_mid uuid; v_member_mid uuid; v_child_mid uuid;
  i int; ok boolean; v_status text;
BEGIN
  SELECT id INTO uid_owner  FROM auth.users WHERE email = 'v8owner@test.local';
  SELECT id INTO uid_member FROM auth.users WHERE email = 'v8member@test.local';
  SELECT id INTO uid_child  FROM auth.users WHERE email = 'v8child@test.local';
  IF uid_owner IS NULL OR uid_member IS NULL OR uid_child IS NULL THEN
    INSERT INTO _v8_results(step,status,detail) VALUES
      ('0 setup', 'FAIL', 'Create the three v8*@test.local accounts first (see header).');
    RETURN;
  END IF;

  -- Clear any leftovers from a previous run so this is repeatable.
  DELETE FROM keeps WHERE name = 'V8 Test Family';
  DELETE FROM keep_join_attempts WHERE user_id IN (uid_owner, uid_member, uid_child);

  -- 1) create_keep → 12-char code; creator owner+adult.
  PERFORM _v8_act_as(uid_owner);
  SELECT keep_id, keep_code INTO v_keep_id, v_code FROM create_keep('V8 Test Family', 'Owner', '👩');
  SELECT id INTO v_owner_mid FROM keep_members WHERE keep_id = v_keep_id AND user_id = uid_owner;
  INSERT INTO _v8_results(step,status,detail) VALUES
    ('1 code is 12 chars', CASE WHEN length(v_code)=12 THEN 'PASS' ELSE 'FAIL' END, v_code);
  INSERT INTO _v8_results(step,status,detail) VALUES
    ('2 creator owner+adult',
     CASE WHEN (SELECT role='owner' AND member_type='adult' FROM keep_members WHERE id=v_owner_mid) THEN 'PASS' ELSE 'FAIL' END, '');

  -- 3) 10 wrong-code attempts allowed; 4) 11th → too_many_attempts.
  -- join_keep_by_code now RETURNS a status (it can't RAISE, or the attempt
  -- log would roll back), so read the status rather than catching an error.
  PERFORM _v8_act_as(uid_member);
  ok := true;
  FOR i IN 1..10 LOOP
    SELECT status INTO v_status FROM join_keep_by_code('ZZZZZZ', 'Nope', '🧑');
    IF v_status = 'too_many_attempts' THEN ok := false; END IF;
  END LOOP;
  INSERT INTO _v8_results(step,status,detail) VALUES
    ('3 first 10 attempts allowed', CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, '');
  SELECT status INTO v_status FROM join_keep_by_code('ZZZZZZ', 'Nope', '🧑');
  INSERT INTO _v8_results(step,status,detail) VALUES
    ('4 11th attempt blocked', CASE WHEN v_status='too_many_attempts' THEN 'PASS' ELSE 'FAIL' END, v_status);
  DELETE FROM keep_join_attempts WHERE user_id = uid_member;

  -- 5) Expired code → SAME opaque 'invalid_code' as bad/not-found.
  UPDATE keeps SET code_expires_at = now() - interval '1 minute' WHERE id = v_keep_id;
  PERFORM _v8_act_as(uid_member);
  SELECT status INTO v_status FROM join_keep_by_code(v_code, 'Member', '👨');
  INSERT INTO _v8_results(step,status,detail) VALUES
    ('5 expired==invalid_code', CASE WHEN v_status='invalid_code' THEN 'PASS' ELSE 'FAIL' END, v_status);
  DELETE FROM keep_join_attempts WHERE user_id = uid_member;
  -- restore a valid (future) expiry so the join in step 7 can succeed
  UPDATE keeps SET code_expires_at = now() + interval '72 hours' WHERE id = v_keep_id;

  -- 6) Owner rotates → new future-dated code; 7) member joins with it.
  PERFORM _v8_act_as(uid_owner);
  SELECT keep_code, code_expires_at INTO v_new_code, v_expires FROM rotate_keep_code(v_keep_id);
  INSERT INTO _v8_results(step,status,detail) VALUES
    ('6 rotate → fresh code+expiry',
     CASE WHEN length(v_new_code)=12 AND v_expires>now() AND v_new_code<>v_code THEN 'PASS' ELSE 'FAIL' END, v_new_code);
  PERFORM _v8_act_as(uid_member);
  SELECT status, member_id INTO v_status, v_member_mid FROM join_keep_by_code(v_new_code, 'Member', '👨');
  INSERT INTO _v8_results(step,status,detail) VALUES
    ('7 member joins rotated code', CASE WHEN v_status='ok' AND v_member_mid IS NOT NULL THEN 'PASS' ELSE 'FAIL' END, v_status);
  DELETE FROM keep_join_attempts WHERE user_id = uid_member;

  -- 8) Non-owner cannot rotate.
  PERFORM _v8_act_as(uid_member);
  BEGIN
    PERFORM rotate_keep_code(v_keep_id);
    INSERT INTO _v8_results(step,status,detail) VALUES ('8 non-owner rotate blocked','FAIL','allowed');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _v8_results(step,status,detail) VALUES
      ('8 non-owner rotate blocked', CASE WHEN SQLERRM LIKE '%not_owner%' THEN 'PASS' ELSE 'FAIL' END, SQLERRM);
  END;

  -- 9) Child joins; owner marks child; 10) child self-pause rejected.
  PERFORM _v8_act_as(uid_child);
  SELECT member_id INTO v_child_mid FROM join_keep_by_code(v_new_code, 'Kiddo', '🧒');  -- status 'ok'
  DELETE FROM keep_join_attempts WHERE user_id = uid_child;
  PERFORM _v8_act_as(uid_owner);
  PERFORM set_member_type(v_child_mid, 'child');
  INSERT INTO _v8_results(step,status,detail) VALUES
    ('9 member marked child',
     CASE WHEN (SELECT member_type='child' FROM keep_members WHERE id=v_child_mid) THEN 'PASS' ELSE 'FAIL' END, '');
  PERFORM _v8_act_as(uid_child);
  BEGIN
    PERFORM pause_member(v_child_mid, now() + interval '1 hour');
    INSERT INTO _v8_results(step,status,detail) VALUES ('10 child self-pause rejected','FAIL','allowed');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _v8_results(step,status,detail) VALUES
      ('10 child self-pause rejected', CASE WHEN SQLERRM LIKE '%child_cannot_pause%' THEN 'PASS' ELSE 'FAIL' END, SQLERRM);
  END;

  -- 11) Adult self-pause set; 12) >24h rejected; 13) resume clears it.
  PERFORM _v8_act_as(uid_member);
  PERFORM pause_member(v_member_mid, now() + interval '2 hours');
  INSERT INTO _v8_results(step,status,detail) VALUES
    ('11 adult 2h pause set',
     CASE WHEN (SELECT paused_until>now() FROM keep_members WHERE id=v_member_mid) THEN 'PASS' ELSE 'FAIL' END, '');
  BEGIN
    PERFORM pause_member(v_member_mid, now() + interval '48 hours');
    INSERT INTO _v8_results(step,status,detail) VALUES ('12 >24h pause rejected','FAIL','allowed');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _v8_results(step,status,detail) VALUES
      ('12 >24h pause rejected', CASE WHEN SQLERRM LIKE '%invalid_pause%' THEN 'PASS' ELSE 'FAIL' END, SQLERRM);
  END;
  PERFORM resume_member(v_member_mid);
  INSERT INTO _v8_results(step,status,detail) VALUES
    ('13 resume clears pause',
     CASE WHEN (SELECT paused_until IS NULL FROM keep_members WHERE id=v_member_mid) THEN 'PASS' ELSE 'FAIL' END, '');

  -- 14) Protected-column TRIGGER blocks a direct self-promote (fires even
  --     for a superuser — this is the trigger, not RLS).
  PERFORM _v8_act_as(uid_member);
  BEGIN
    UPDATE keep_members SET role = 'owner' WHERE id = v_member_mid;
    INSERT INTO _v8_results(step,status,detail) VALUES
      ('14 self-promote blocked',
       CASE WHEN (SELECT role='member' FROM keep_members WHERE id=v_member_mid) THEN 'PASS' ELSE 'FAIL' END, 'no error but role unchanged');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _v8_results(step,status,detail) VALUES
      ('14 self-promote blocked', CASE WHEN SQLERRM LIKE '%protected_column%' THEN 'PASS' ELSE 'FAIL' END, SQLERRM);
  END;

  -- 15/16) Owner kick removes the member AND their location_history.
  INSERT INTO location_history (keep_id, member_id, lat, lng) VALUES (v_keep_id, v_member_mid, 1, 1);
  PERFORM _v8_act_as(uid_owner);
  PERFORM remove_member(v_member_mid);
  INSERT INTO _v8_results(step,status,detail) VALUES
    ('15 kicked member row gone',
     CASE WHEN NOT EXISTS(SELECT 1 FROM keep_members WHERE id=v_member_mid) THEN 'PASS' ELSE 'FAIL' END, '');
  INSERT INTO _v8_results(step,status,detail) VALUES
    ('16 kicked member history gone',
     CASE WHEN NOT EXISTS(SELECT 1 FROM location_history WHERE member_id=v_member_mid) THEN 'PASS' ELSE 'FAIL' END, '');
END $$;


-- ── Config checks: RLS policies + trigger (catalog inspection) ─────
-- A superuser bypasses RLS at runtime, so these pure-RLS invariants are
-- proven by inspecting the policy catalog instead — no role switch.

INSERT INTO _v8_results(step,status,detail)
SELECT '17 no direct-INSERT policy on keeps',
       CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END,
       coalesce(string_agg(policyname, ', '), '(none)')
FROM pg_policies WHERE schemaname='public' AND tablename='keeps' AND cmd='INSERT';

INSERT INTO _v8_results(step,status,detail)
SELECT '18 no direct-INSERT policy on keep_members',
       CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END,
       coalesce(string_agg(policyname, ', '), '(none)')
FROM pg_policies WHERE schemaname='public' AND tablename='keep_members' AND cmd='INSERT';

INSERT INTO _v8_results(step,status,detail)
SELECT '19 child cannot self-remove (DELETE policy)',
       CASE WHEN bool_or(qual ILIKE '%member_type%') THEN 'PASS' ELSE 'FAIL' END,
       coalesce(string_agg(policyname, ', '), '(none)')
FROM pg_policies WHERE schemaname='public' AND tablename='keep_members' AND cmd='DELETE';

INSERT INTO _v8_results(step,status,detail)
SELECT '20 join_attempts locked down (RLS on, 0 policies)',
       CASE WHEN (SELECT relrowsecurity FROM pg_class WHERE oid='public.keep_join_attempts'::regclass)
             AND (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='keep_join_attempts')=0
            THEN 'PASS' ELSE 'FAIL' END, '';

INSERT INTO _v8_results(step,status,detail)
SELECT '21 protected-column trigger present',
       CASE WHEN count(*)>0 THEN 'PASS' ELSE 'FAIL' END, count(*)::text
FROM pg_trigger WHERE tgname='trg_guard_member_cols';

-- 22) keep_members' SELECT policy must NOT subquery keep_members, or it
-- recurses ("infinite recursion detected in policy for relation
-- keep_members") and every client fails to load. It should route through
-- private_user_keep_ids() instead. This is a CATALOG check: a superuser
-- bypasses RLS, so the recursion itself can't be observed from this
-- script — but a self-referencing qual is the precise cause, so we assert
-- it's gone. (v8.1 hotfix regression guard.)
INSERT INTO _v8_results(step,status,detail)
SELECT '22 keep_members SELECT policy not self-recursive',
       CASE WHEN count(*) FILTER (WHERE qual ILIKE '%keep_members%') = 0 THEN 'PASS' ELSE 'FAIL' END,
       coalesce(string_agg(policyname, ', ') FILTER (WHERE qual ILIKE '%keep_members%'), 'clean (uses helper)')
FROM pg_policies WHERE schemaname='public' AND tablename='keep_members' AND cmd='SELECT';

INSERT INTO _v8_results(step,status,detail)
SELECT '23 membership helper present + owned SECURITY DEFINER',
       CASE WHEN count(*)=1 THEN 'PASS' ELSE 'FAIL' END, count(*)::text
FROM pg_proc WHERE proname='private_user_keep_ids' AND prosecdef;


-- ── Cleanup, then RETURN the results grid (this SELECT is the output) ─
DELETE FROM keeps WHERE name = 'V8 Test Family';
DELETE FROM keep_join_attempts WHERE user_id IN
  (SELECT id FROM auth.users WHERE email IN
    ('v8owner@test.local','v8member@test.local','v8child@test.local'));
DROP FUNCTION IF EXISTS _v8_act_as(uuid);

SELECT step, status, detail FROM _v8_results ORDER BY id;
-- (Optional) tidy the scratch table afterwards:  DROP TABLE _v8_results;
