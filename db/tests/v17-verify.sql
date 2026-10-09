-- ============================================================
-- Roamkeep v17 — verification script (run on STAGING, never a family)
--
-- Proves the invariants schema v17 adds: owner approval of joins, the
-- email-free password reset, sign-up control, and account deletion.
-- Results go to a _v17_results table returned by the final SELECT, because
-- the Supabase SQL Editor does NOT display RAISE NOTICE output. Every row
-- should read PASS.
--
-- SETUP (once, before running):
--   1. Apply db/schema.sql (v17) to the staging project.
--   2. Create TWO auth accounts (app sign-up or Auth dashboard):
--        v17owner@test.local   v17member@test.local
--      They are the script's alone. Never use them in the app to create or
--      join a Keep — one Keep per account, so the script could not make its
--      own. Make the staging family with other accounts. (If one is in a
--      Keep, the script stops at once with a "0 setup" row naming it.)
--   3. Paste this WHOLE file into Dashboard → SQL Editor → Run.
--
-- ⚠ It CHANGES v17member@test.local's password (step 2 redeems a reset
-- code) to:  V17-New-Pass-1   — a scratch account, but know it.
--
-- It makes its own two Keeps directly, as the database owner, rather than
-- through create_keep: a server allows one family (1l), and staging
-- already has one.
--
-- Safe to re-run: it deletes its own Keeps ('V17 Test Family', and 'V17
-- Older Family', which it backdates so the oldest-keep rule always has an
-- older keep than the test's own) and its throwaway accounts
-- (v17gone@test.local, v17seed@test.local, v17child@test.local) first and
-- again at the end, and
-- puts the sign-up setting back the way it found it. Sign-ups are switched
-- as the owner of the project's oldest keep, the one account allowed to.
--
-- Three join requests and a child's deletion request wake the test keep's
-- owner through notify-places, so a phone signed in as v17owner may get
-- "wants to join" or "asked to delete their account". Nothing else
-- reaches a device: the steps that must fail roll themselves back if they
-- don't, so no stray SOS or account is left behind.
--
-- How it works: RPCs read auth.uid() from request.jwt.claims, which
-- _v17_act_as() sets. RLS applies only to non-superusers, so the steps that
-- test what a CLIENT can see or write switch to the `authenticated` (or
-- `anon`) role for one statement and back.
-- ============================================================

DROP TABLE IF EXISTS _v17_results;
CREATE TABLE _v17_results (id serial primary key, step text, status text, detail text);

CREATE OR REPLACE FUNCTION _v17_act_as(p uuid, p_role text DEFAULT 'authenticated') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', p_role)::text, true);
END $$;

CREATE OR REPLACE FUNCTION _v17_r(p_step text, p_ok boolean, p_detail text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO _v17_results(step, status, detail)
  VALUES (p_step, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, coalesce(p_detail, ''));
$$;

-- A Keep with its founding owner, made the way create_keep makes one but
-- directly: create_keep refuses a second family on a server (1l tests that).
-- require_approval is left to its column default, as create_keep leaves it.
CREATE OR REPLACE FUNCTION _v17_make_keep(p_owner uuid, p_name text, p_display text, p_avatar text)
RETURNS TABLE (keep_id uuid, keep_code text, member_id uuid)
LANGUAGE plpgsql AS $$
DECLARE
  v_keep keeps%ROWTYPE;
  v_mid uuid;
BEGIN
  INSERT INTO keeps (code, name, created_by, code_expires_at)
    VALUES (_roamkeep_gen_code(), p_name, p_owner, now() + interval '72 hours')
    RETURNING * INTO v_keep;
  INSERT INTO keep_members (keep_id, user_id, name, avatar, role, member_type)
    VALUES (v_keep.id, p_owner, p_display, p_avatar, 'owner', 'adult')
    RETURNING id INTO v_mid;
  RETURN QUERY SELECT v_keep.id, v_keep.code, v_mid;
END $$;

DO $$
DECLARE
  uid_o uuid; uid_m uuid; uid_d uuid; uid_g uuid; uid_s uuid; uid_c uuid; v_c_mid uuid; v_seed uuid;
  v_keep uuid; v_code text; v_o_mid uuid; v_m_mid uuid; v_d_mid uuid; v_place uuid;
  v_status text; v_txt text; v_n int; v_b boolean; v_i int;
  v_prev_closed boolean; v_prev_until timestamptz;
  v_ck uuid; v_ck_b boolean; v_p1 int; v_p2 int; v_p3 int; v_p4 int; v_p5 int; v_p6 int; v_p7 int; v_p8 int;
BEGIN
  SELECT id INTO uid_o FROM auth.users WHERE email = 'v17owner@test.local';
  SELECT id INTO uid_m FROM auth.users WHERE email = 'v17member@test.local';
  IF uid_o IS NULL OR uid_m IS NULL THEN
    PERFORM _v17_r('0 setup', false, 'Create v17owner@test.local and v17member@test.local first (see header).');
    RETURN;
  END IF;

  -- Checked before anything is touched. One Keep per account: a test account
  -- already in a Keep would make every step below act on the wrong family.
  SELECT string_agg(format('%s is in "%s"', u.email, k.name), '; ') INTO v_txt
    FROM keep_members m
    JOIN keeps k      ON k.id = m.keep_id
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.user_id IN (uid_o, uid_m)
     AND k.name NOT IN ('V17 Test Family', 'V17 Older Family');
  IF v_txt IS NOT NULL THEN
    PERFORM _v17_r('0 setup', false,
      v_txt || ' — the test accounts must not be in any Keep. Make the staging family with other accounts (see header).');
    RETURN;
  END IF;

  SELECT signups_closed, signups_open_until INTO v_prev_closed, v_prev_until FROM roamkeep_meta;
  UPDATE roamkeep_meta SET signups_closed = false, signups_open_until = NULL WHERE id;
  DELETE FROM keeps WHERE name IN ('V17 Test Family', 'V17 Older Family');
  DELETE FROM auth.users WHERE email IN ('v17gone@test.local', 'v17seed@test.local', 'v17child@test.local');
  DELETE FROM keep_join_attempts WHERE user_id IN (uid_o, uid_m);
  DELETE FROM password_reset_codes WHERE user_id IN (uid_o, uid_m);

  -- A family older than the test's own, so set_signups' oldest-keep rule
  -- always has someone else to belong to (3b). Backdated, because the whole
  -- script is one transaction and now() does not move inside it.
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          confirmation_token, recovery_token, email_change_token_new, email_change,
                          created_at, updated_at)
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'v17seed@test.local', extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
            '', '', '', '', now(), now())
    RETURNING id INTO uid_s;
  SELECT k.keep_id INTO v_seed FROM _v17_make_keep(uid_s, 'V17 Older Family', 'Sam', '🧑') k;

  -- The child for the deletion steps (4f-4l). Made now, while sign-ups are
  -- held open: the sign-up gate is a trigger on auth.users, and by section 4
  -- the gate steps may have left them closed.
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          confirmation_token, recovery_token, email_change_token_new, email_change,
                          created_at, updated_at)
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'v17child@test.local', extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
            '', '', '', '', now(), now())
    RETURNING id INTO uid_c;

  UPDATE keeps SET created_at = now() - interval '1 minute' WHERE id = v_seed;

  -- ── 1) Owner approval ─────────────────────────────────────────
  SELECT k.keep_id, k.keep_code, k.member_id INTO v_keep, v_code, v_o_mid
    FROM _v17_make_keep(uid_o, 'V17 Test Family', 'Olivia', '👩') k;
  SELECT require_approval INTO v_b FROM keeps WHERE id = v_keep;
  PERFORM _v17_r('1a a new Keep starts with approval OFF (safe for older owner apps)', v_b = false, v_b::text);

  -- One family per server: an account with no Keep cannot start a second
  -- family beside the ones here. uid_m has not joined yet. Rolls itself
  -- back if it gets through, so no stray Keep is left behind.
  PERFORM _v17_act_as(uid_m);
  BEGIN
    PERFORM create_keep('V17 Second Family', 'Max', '👦');
    RAISE EXCEPTION 'v17_unexpected_success';
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('1l create_keep refuses a second family on this server', SQLERRM LIKE '%family_exists%', SQLERRM);
  END;

  PERFORM _v17_act_as(uid_o);
  PERFORM set_require_approval(v_keep, true);

  PERFORM _v17_act_as(uid_m);
  SELECT j.status, j.member_id INTO v_status, v_m_mid FROM join_keep_by_code(v_code, 'Max', '👦') j;
  PERFORM _v17_r('1b join with approval on returns pending', v_status = 'pending', v_status);

  BEGIN
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM keep_members;
    RESET ROLE;
    PERFORM _v17_r('1c a pending member reads no member rows, not even their own', v_n = 0, v_n || ' rows');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM _v17_r('1c a pending member reads no member rows, not even their own', false, SQLERRM);
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO checkins (keep_id, member_id, member_name, member_avatar, place, type)
      VALUES (v_keep, v_m_mid, 'Max', '👦', '🆘 SOS', 'sos');
    RAISE EXCEPTION 'v17_unexpected_success';   -- rolls the row back: no real SOS wake
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM _v17_r('1d a pending member cannot file a check-in (SOS included)',
      SQLERRM LIKE '%row-level security%', SQLERRM);
  END;

  SELECT m.approved INTO v_b FROM my_membership() m;
  PERFORM _v17_r('1e my_membership tells a pending member their status', v_b = false, coalesce(v_b::text, 'no row'));

  BEGIN
    PERFORM approve_member(v_m_mid);
    RAISE EXCEPTION 'v17_unexpected_success';
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('1f a pending member cannot approve themselves', SQLERRM LIKE '%not_owner%', SQLERRM);
  END;

  -- No WHERE clause, so no SELECT policy is consulted: only the UPDATE
  -- policy stands between a pending member and their own row (review R2).
  BEGIN
    SET LOCAL ROLE authenticated;
    UPDATE keep_members SET status = 'v17 pending edit';
    RESET ROLE;
    SELECT count(*) INTO v_n FROM keep_members WHERE id = v_m_mid AND status = 'v17 pending edit';
    RAISE EXCEPTION 'v17_rollback';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    v_txt := SQLERRM;
  END;
  PERFORM _v17_r('1m a pending member cannot change their own row', v_txt = 'v17_rollback' AND v_n = 0,
    v_txt || ' · ' || coalesce(v_n, -1) || ' row(s) changed');

  -- The guard itself, tested as the table owner so RLS is out of the way:
  -- a client PATCH could not even see the row, so would prove nothing.
  BEGIN
    UPDATE keep_members SET approved = true WHERE id = v_m_mid;
    RAISE EXCEPTION 'v17_unexpected_success';
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('1g approved changes only through approve_member (guard trigger)',
      SQLERRM LIKE '%protected_column%', SQLERRM);
  END;

  -- Push fan-out. One block that rolls itself back, so the made-up tokens
  -- never reach a real webhook and the approval inside it is undone.
  BEGIN
    INSERT INTO keep_member_push (member_id, keep_id, fcm_token) VALUES
      (v_o_mid, v_keep, 'v17-test-token-owner'), (v_m_mid, v_keep, 'v17-test-token-member');
    INSERT INTO checkins (keep_id, member_id, member_name, member_avatar, place, type)
      VALUES (v_keep, v_o_mid, 'Olivia', '👩', 'v17 test', 'manual') RETURNING id INTO v_ck;
    SELECT count(*) INTO v_p1 FROM keep_push_recipients(v_keep) r WHERE r.member_id = v_m_mid;
    SELECT count(*) INTO v_p2 FROM checkin_recipients(v_ck) r WHERE r.member_id = v_m_mid;
    SELECT count(*) INTO v_p3 FROM keep_owner_push_recipients(v_keep) r WHERE r.member_id = v_o_mid;
    PERFORM _v17_act_as(uid_m);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_p7 FROM my_checkin_feed;
    RESET ROLE;
    PERFORM _v17_act_as(uid_o);
    PERFORM approve_member(v_m_mid);
    SELECT count(*) INTO v_p4 FROM keep_push_recipients(v_keep) r WHERE r.member_id = v_m_mid;
    SELECT count(*) INTO v_p5 FROM checkin_recipients(v_ck) r WHERE r.member_id = v_m_mid;
    SELECT count(*) INTO v_p6 FROM keep_owner_push_recipients(v_keep);
    PERFORM _v17_act_as(uid_m);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_p8 FROM my_checkin_feed;
    RESET ROLE;
    RAISE EXCEPTION 'v17_rollback';
  EXCEPTION WHEN OTHERS THEN
    v_txt := SQLERRM;
  END;
  PERFORM _v17_r('1j a pending member gets no wake-ups and an empty feed; once approved, the same as everyone',
    v_txt = 'v17_rollback' AND v_p1 = 0 AND v_p2 = 0 AND v_p7 = 0 AND v_p4 = 1 AND v_p5 = 1 AND v_p8 = 1,
    format('%s · pending: sync %s, check-in %s, feed %s · approved: sync %s, check-in %s, feed %s',
           v_txt, v_p1, v_p2, v_p7, v_p4, v_p5, v_p8));
  PERFORM _v17_r('1k join requests wake approved owners only',
    v_txt = 'v17_rollback' AND v_p3 = 1 AND v_p6 = 1,
    format('owner woken %s · recipients once a member is approved %s', v_p3, v_p6));

  PERFORM _v17_act_as(uid_o);
  PERFORM approve_member(v_m_mid);
  PERFORM _v17_act_as(uid_m);
  BEGIN
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM keep_members;
    RESET ROLE;
    PERFORM _v17_r('1h once approved, the member sees the family', v_n = 2, v_n || ' rows');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM _v17_r('1h once approved, the member sees the family', false, SQLERRM);
  END;

  PERFORM _v17_act_as(uid_o);
  BEGIN
    PERFORM decline_member(v_m_mid);
    RAISE EXCEPTION 'v17_unexpected_success';
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('1i decline_member refuses an approved member', SQLERRM LIKE '%not_pending%', SQLERRM);
  END;

  -- Removing a member rotates the join code, so the copy their phone keeps
  -- no longer works, with approval off (the case it lets straight back in).
  -- The code is aged first (one hour left) so the renewal is visible: now()
  -- does not move inside the script. Rolled back, so Max stays for the rest.
  --
  -- The old code is tried by v17child, who is in no Keep yet, not by Max:
  -- from v18 a removal deletes the removed person's account, so Max no
  -- longer exists to try it. Anyone holding the old code is the same case.
  v_txt := NULL; v_status := NULL; v_b := NULL;
  BEGIN
    PERFORM _v17_act_as(uid_o);
    UPDATE keeps SET code_expires_at = now() + interval '1 hour', require_approval = false WHERE id = v_keep;
    SELECT code INTO v_txt FROM keeps WHERE id = v_keep;
    PERFORM remove_member(v_m_mid);
    SELECT code IS DISTINCT FROM v_txt, code_expires_at = now() + interval '72 hours'
      INTO v_b, v_ck_b FROM keeps WHERE id = v_keep;
    PERFORM _v17_act_as(uid_c);
    SELECT j.status INTO v_status FROM join_keep_by_code(v_txt, 'Max', '👦') j;
    RAISE EXCEPTION 'v17_rollback';
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('1n removing a member rotates the join code, so their copy stops working',
      SQLERRM = 'v17_rollback' AND coalesce(v_b, false) AND coalesce(v_ck_b, false) AND v_status = 'invalid_code',
      format('code changed %s · 72h renewed %s · old code: %s%s', v_b, v_ck_b, v_status,
             CASE WHEN SQLERRM = 'v17_rollback' THEN '' ELSE ' · ' || SQLERRM END));
  END;

  -- ── 2) Password reset ─────────────────────────────────────────
  PERFORM _v17_act_as(uid_m);
  BEGIN
    PERFORM issue_password_reset(v_o_mid);
    PERFORM _v17_r('2a a non-owner cannot issue a reset code', false, 'issued');
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('2a a non-owner cannot issue a reset code', SQLERRM LIKE '%not_owner%', SQLERRM);
  END;

  PERFORM _v17_act_as(uid_o);
  PERFORM set_member_role(v_m_mid, 'owner');
  BEGIN
    PERFORM issue_password_reset(v_m_mid);
    PERFORM _v17_r('2b an owner cannot issue a code for a CO-OWNER', false, 'issued');
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('2b an owner cannot issue a code for a CO-OWNER', SQLERRM LIKE '%cannot_reset_owner%', SQLERRM);
  END;
  PERFORM set_member_role(v_m_mid, 'member');

  v_code := issue_password_reset(v_m_mid);
  PERFORM _v17_r('2c the code reads XXXXX-XXXXX', v_code ~ '^[0-9A-Z]{5}-[0-9A-Z]{5}$', v_code);

  FOR v_i IN 1..5 LOOP
    v_status := redeem_password_reset('v17member@test.local', 'WRONG-CODE' || v_i, 'Whatever-123');
  END LOOP;
  v_status := redeem_password_reset('v17member@test.local', v_code, 'V17-New-Pass-1');
  PERFORM _v17_r('2d five wrong guesses burn the code (the right one then fails)', v_status = 'invalid', v_status);

  v_code := issue_password_reset(v_m_mid);
  v_status := redeem_password_reset('nobody@test.local', v_code, 'V17-New-Pass-1');
  PERFORM _v17_r('2e an unknown email answers the same "invalid"', v_status = 'invalid', v_status);
  v_status := redeem_password_reset('V17Member@test.local', v_code, 'short');
  PERFORM _v17_r('2f a short password is refused after the code matches', v_status = 'weak_password', v_status);

  -- Redeemed as ANON (signed out), typed loosely: lower case, spaces.
  PERFORM _v17_act_as(NULL, 'anon');
  BEGIN
    SET LOCAL ROLE anon;
    v_status := redeem_password_reset(' v17member@test.local ', lower(replace(v_code, '-', ' ')), 'V17-New-Pass-1');
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    v_status := 'error: ' || SQLERRM;
  END;
  SELECT encrypted_password = extensions.crypt('V17-New-Pass-1', encrypted_password) INTO v_b
    FROM auth.users WHERE id = uid_m;
  PERFORM _v17_r('2g redeemed signed-out, loosely typed; the new password is set',
    v_status = 'ok' AND v_b, v_status || ' / password matches: ' || coalesce(v_b::text, 'null'));

  PERFORM _v17_act_as(uid_m);
  BEGIN
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM password_reset_codes WHERE redeemed_at IS NOT NULL AND issued_by = uid_o;
    RESET ROLE;
    PERFORM _v17_r('2h the member can see the reset happened and who issued it', v_n = 1, v_n || ' rows');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM _v17_r('2h the member can see the reset happened and who issued it', false, SQLERRM);
  END;

  PERFORM _v17_act_as(uid_o);
  BEGIN
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM password_reset_codes;
    RESET ROLE;
    PERFORM _v17_r('2i nobody else can read a member''s reset row', v_n = 0, v_n || ' rows');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM _v17_r('2i nobody else can read a member''s reset row', false, SQLERRM);
  END;

  -- The member reads the notice but never the hash (review R3).
  PERFORM _v17_act_as(uid_m);
  BEGIN
    SET LOCAL ROLE authenticated;
    SELECT count(code_hash) INTO v_n FROM password_reset_codes;
    RESET ROLE;
    PERFORM _v17_r('2j a member cannot read their reset code''s hash', false, 'read ' || v_n);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM _v17_r('2j a member cannot read their reset code''s hash', SQLERRM LIKE '%permission denied%', SQLERRM);
  END;

  -- A reset by code blocks deleting the account for a day (review R1). Rolls
  -- itself back if the deletion gets through.
  --
  -- Retired in v18 (owner decision 2026-10-09): removing a member deletes
  -- them there, so the block protected nothing, and the deletion now has to
  -- go through. v18-verify tests the rule that replaced it.
  SELECT schema_version >= 18 INTO v_b FROM roamkeep_meta;
  BEGIN
    PERFORM delete_my_account();
    RAISE EXCEPTION 'v17_unexpected_success';
  EXCEPTION WHEN OTHERS THEN
    IF v_b THEN
      PERFORM _v17_r('2k (retired in v18) deletion right after a reset by code is allowed',
        SQLERRM = 'v17_unexpected_success', SQLERRM);
    ELSE
      PERFORM _v17_r('2k no account deletion within a day of a reset by code', SQLERRM LIKE '%recent_reset%', SQLERRM);
    END IF;
  END;

  -- A reset notice wakes the member's own phones and nobody else's (R1).
  BEGIN
    INSERT INTO keep_member_push (member_id, keep_id, fcm_token) VALUES
      (v_o_mid, v_keep, 'v17-test-token-owner'), (v_m_mid, v_keep, 'v17-test-token-member')
      ON CONFLICT (member_id) DO UPDATE SET fcm_token = EXCLUDED.fcm_token;
    SELECT count(*) INTO v_p1 FROM reset_notice_recipients(uid_m) r WHERE r.member_id = v_m_mid;
    SELECT count(*) INTO v_p2 FROM reset_notice_recipients(uid_m);
    RAISE EXCEPTION 'v17_rollback';
  EXCEPTION WHEN OTHERS THEN
    v_txt := SQLERRM;
  END;
  PERFORM _v17_r('2l a reset notice wakes the member''s own phones only',
    v_txt = 'v17_rollback' AND v_p1 = 1 AND v_p2 = 1, format('%s · member %s of %s', v_txt, v_p1, v_p2));

  -- ── 3) Sign-up control ────────────────────────────────────────
  -- Authority is an owner of the project's OLDEST keep: the script's own
  -- backdated 'V17 Older Family', or a real family older still. Either way
  -- not v17owner, who is exactly the case worth testing: an owner of a
  -- NEWER keep.
  SELECT m.user_id INTO uid_g
    FROM keep_members m
   WHERE m.role = 'owner' AND m.approved
     AND m.keep_id = (SELECT k.id FROM keeps k ORDER BY k.created_at, k.id LIMIT 1)
   ORDER BY m.created_at LIMIT 1;

  PERFORM _v17_act_as(uid_m);
  BEGIN
    PERFORM set_signups(true, NULL);
    RAISE EXCEPTION 'v17_unexpected_success';
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('3a a non-owner cannot close sign-ups', SQLERRM LIKE '%not_owner%', SQLERRM);
  END;

  IF uid_g IS DISTINCT FROM uid_o THEN
    PERFORM _v17_act_as(uid_o);
    BEGIN
      PERFORM set_signups(true, NULL);
      RAISE EXCEPTION 'v17_unexpected_success';
    EXCEPTION WHEN OTHERS THEN
      PERFORM _v17_r('3b an owner of a newer keep cannot close sign-ups', SQLERRM LIKE '%not_owner%', SQLERRM);
    END;
  ELSE
    PERFORM _v17_r('3b an owner of a newer keep cannot close sign-ups', false,
      'the test keep came out oldest — the backdated V17 Older Family did not take');
  END IF;

  IF uid_g IS NULL THEN
    PERFORM _v17_r('3c-3e sign-up gate', false, 'the oldest keep has no approved owner to act as');
  ELSE
    PERFORM _v17_act_as(uid_g);
    BEGIN
      PERFORM set_signups(true, now() + interval '31 days');
      PERFORM _v17_r('3c an opening window over 30 days is refused', false, 'accepted');
    EXCEPTION WHEN OTHERS THEN
      PERFORM _v17_r('3c an opening window over 30 days is refused', SQLERRM LIKE '%invalid_window%', SQLERRM);
    END;

    -- Must fail. If it doesn't, the deliberate raise rolls the account back.
    PERFORM set_signups(true, NULL);
    BEGIN
      INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                              confirmation_token, recovery_token, email_change_token_new, email_change,
                              created_at, updated_at)
        VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                'v17gone@test.local', extensions.crypt('x', extensions.gen_salt('bf')),
                '', '', '', '', now(), now());
      RAISE EXCEPTION 'v17_unexpected_success';
    EXCEPTION WHEN OTHERS THEN
      PERFORM _v17_r('3d closed: a new account is refused', SQLERRM LIKE '%signups_closed%', SQLERRM);
    END;

    PERFORM set_signups(true, now() + interval '1 hour');
    BEGIN
      INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                              confirmation_token, recovery_token, email_change_token_new, email_change,
                              created_at, updated_at)
        VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                'v17gone@test.local', extensions.crypt('x', extensions.gen_salt('bf')),
                '', '', '', '', now(), now())
        RETURNING id INTO uid_d;
      PERFORM _v17_r('3e closed but inside an open window: a new account is allowed', true, '');
    EXCEPTION WHEN OTHERS THEN
      PERFORM _v17_r('3e closed but inside an open window: a new account is allowed', false, SQLERRM);
    END;
  END IF;

  -- ── 4) Decline, then account deletion ─────────────────────────
  -- v17gone (made in 3e) asks to join, is declined, asks again, is approved,
  -- adds a place and deletes their account.
  IF uid_d IS NOT NULL THEN
    PERFORM _v17_act_as(uid_d);
    SELECT j.status, j.member_id INTO v_status, v_d_mid
      FROM join_keep_by_code((SELECT code FROM keeps WHERE id = v_keep), 'Gone', '🫥') j;

    PERFORM _v17_act_as(uid_m);
    BEGIN
      PERFORM approve_member(v_d_mid);
      RAISE EXCEPTION 'v17_unexpected_success';
    EXCEPTION WHEN OTHERS THEN
      PERFORM _v17_r('4a an approved member who is not an owner cannot approve', SQLERRM LIKE '%not_owner%', SQLERRM);
    END;

    PERFORM _v17_act_as(uid_o);
    BEGIN
      PERFORM decline_member(v_d_mid);
    EXCEPTION WHEN OTHERS THEN
      NULL;   -- judged below by what is left
    END;
    SELECT count(*) INTO v_n FROM keep_members WHERE user_id = uid_d;
    PERFORM _v17_act_as(uid_d);
    SELECT j.status, j.member_id INTO v_status, v_d_mid
      FROM join_keep_by_code((SELECT code FROM keeps WHERE id = v_keep), 'Gone', '🫥') j;
    PERFORM _v17_r('4b decline removes the request; the person can ask again',
      v_n = 0 AND v_status = 'pending', format('rows after decline %s, second ask: %s', v_n, v_status));

    PERFORM _v17_act_as(uid_o);
    PERFORM approve_member(v_d_mid);
    INSERT INTO keep_places (keep_id, name, icon, lat, lng, radius_m, created_by)
      VALUES (v_keep, 'Shops', '🛒', -33.8, 151.2, 100, uid_d) RETURNING id INTO v_place;

    PERFORM _v17_act_as(uid_m);
    BEGIN
      SET LOCAL ROLE authenticated;
      UPDATE keep_places SET created_by = NULL WHERE id = v_place;
      RESET ROLE;
      v_txt := 'no error';
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      v_txt := SQLERRM;
    END;
    SELECT created_by = uid_d INTO v_b FROM keep_places WHERE id = v_place;
    PERFORM _v17_r('4c a member cannot blank a place''s creator', coalesce(v_b, false), v_txt);

    PERFORM _v17_act_as(uid_d);
    BEGIN
      PERFORM delete_my_account();
      SELECT count(*) INTO v_n FROM auth.users WHERE id = uid_d;
      SELECT created_by IS NULL INTO v_b FROM keep_places WHERE id = v_place;
      PERFORM _v17_r('4d delete_my_account removes the account; their place stays, creator cleared',
        v_n = 0 AND coalesce(v_b, false),
        format('account rows %s, place kept with NULL creator: %s', v_n, coalesce(v_b::text, 'place gone')));
    EXCEPTION WHEN OTHERS THEN
      PERFORM _v17_r('4d delete_my_account removes the account; their place stays, creator cleared', false, SQLERRM);
    END;
  ELSE
    PERFORM _v17_r('4 decline and account deletion', false, 'skipped — the 3e account was not created');
  END IF;

  -- Must fail. If it doesn't, the deliberate raise puts the account back.
  PERFORM _v17_act_as(uid_o);
  BEGIN
    PERFORM delete_my_account();
    RAISE EXCEPTION 'v17_unexpected_success';
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('4e the last owner of a keep with others cannot delete their account',
      SQLERRM LIKE '%last_owner%', SQLERRM);
  END;

  -- ── Children and account deletion ─────────────────────────────
  -- A child cannot leave or delete their own account: they ask, and an owner
  -- deletes it. The throwaway child (made at the start) joins the test keep
  -- directly.
  INSERT INTO keep_members (keep_id, user_id, name, avatar, role, member_type)
    VALUES (v_keep, uid_c, 'Kid', '🧒', 'member', 'child') RETURNING id INTO v_c_mid;

  PERFORM _v17_act_as(uid_c);
  BEGIN
    PERFORM delete_my_account();
    RAISE EXCEPTION 'v17_unexpected_success';   -- puts the account back
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('4f a child cannot delete their own account', SQLERRM LIKE '%child_cannot_delete%', SQLERRM);
  END;

  PERFORM request_account_deletion(true);
  SELECT deletion_requested_at IS NOT NULL INTO v_b FROM keep_members WHERE id = v_c_mid;
  PERFORM _v17_r('4g a child can ask the owners to delete their account', coalesce(v_b, false),
    coalesce(v_b::text, 'no row'));

  -- The guard, as the table owner: only request_account_deletion moves it.
  BEGIN
    UPDATE keep_members SET deletion_requested_at = NULL WHERE id = v_c_mid;
    RAISE EXCEPTION 'v17_unexpected_success';
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('4h a deletion request changes only through request_account_deletion (guard)',
      SQLERRM LIKE '%protected_column%', SQLERRM);
  END;

  PERFORM _v17_act_as(uid_m);
  BEGIN
    PERFORM request_account_deletion(true);
    RAISE EXCEPTION 'v17_unexpected_success';
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('4i an adult cannot ask; they delete their own account', SQLERRM LIKE '%not_child%', SQLERRM);
  END;

  BEGIN
    PERFORM delete_child_account(v_c_mid);
    RAISE EXCEPTION 'v17_unexpected_success';   -- puts the child back
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('4j a member who is not an owner cannot delete a child''s account',
      SQLERRM LIKE '%not_owner%', SQLERRM);
  END;

  PERFORM _v17_act_as(uid_o);
  BEGIN
    PERFORM delete_child_account(v_m_mid);
    RAISE EXCEPTION 'v17_unexpected_success';   -- puts the adult back
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('4k an owner cannot delete an adult''s account', SQLERRM LIKE '%not_child%', SQLERRM);
  END;

  INSERT INTO location_history (keep_id, member_id, lat, lng) VALUES (v_keep, v_c_mid, -33.8, 151.2);
  BEGIN
    PERFORM delete_child_account(v_c_mid);
    SELECT count(*) INTO v_n FROM auth.users WHERE id = uid_c;
    SELECT count(*) INTO v_i FROM location_history WHERE member_id = v_c_mid;
    PERFORM _v17_r('4l an owner deletes a child''s account, history and all',
      v_n = 0 AND v_i = 0, format('account rows %s, history rows %s', v_n, v_i));
  EXCEPTION WHEN OTHERS THEN
    PERFORM _v17_r('4l an owner deletes a child''s account, history and all', false, SQLERRM);
  END;

  -- ── Clean up ──────────────────────────────────────────────────
  DELETE FROM keeps WHERE id IN (v_keep, v_seed);
  DELETE FROM auth.users WHERE email IN ('v17gone@test.local', 'v17seed@test.local', 'v17child@test.local');
  DELETE FROM keep_join_attempts WHERE user_id IN (uid_o, uid_m);
  DELETE FROM password_reset_codes WHERE user_id IN (uid_o, uid_m);
  UPDATE roamkeep_meta SET signups_closed = coalesce(v_prev_closed, false),
                           signups_open_until = v_prev_until WHERE id;
END $$;

-- ── Catalog checks (objects, not the number) ────────────────────
INSERT INTO _v17_results(step, status, detail)
SELECT '5 schema_version is 17', CASE WHEN schema_version >= 17 THEN 'PASS' ELSE 'FAIL' END, schema_version::text
  FROM roamkeep_meta;

INSERT INTO _v17_results(step, status, detail)
SELECT '6 the five new columns exist',
       CASE WHEN count(*) = 5 THEN 'PASS' ELSE 'FAIL' END, string_agg(table_name || '.' || column_name, ', ')
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND (table_name, column_name) IN (('keep_members', 'approved'), ('keeps', 'require_approval'),
                                     ('roamkeep_meta', 'signups_closed'), ('roamkeep_meta', 'signups_open_until'),
                                     ('keep_members', 'deletion_requested_at'));

INSERT INTO _v17_results(step, status, detail)
SELECT '7 password_reset_codes exists with RLS on',
       CASE WHEN bool_and(c.relrowsecurity) THEN 'PASS' ELSE 'FAIL' END, coalesce(string_agg(c.relname, ''), 'missing')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'password_reset_codes';

INSERT INTO _v17_results(step, status, detail)
SELECT '8 keep_places.created_by is nullable (account deletion depends on it)',
       CASE WHEN is_nullable = 'YES' THEN 'PASS' ELSE 'FAIL' END, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'keep_places' AND column_name = 'created_by';

INSERT INTO _v17_results(step, status, detail)
SELECT '9 triggers present (sign-up gate on auth.users, join request, deletion request, reset notice)',
       CASE WHEN count(*) = 4 THEN 'PASS' ELSE 'FAIL' END, string_agg(tgname, ', ')
  FROM pg_trigger WHERE tgname IN ('roamkeep_signup_gate', 'on_join_request', 'on_deletion_request',
                                   'on_reset_notice')
   AND NOT tgisinternal;

INSERT INTO _v17_results(step, status, detail)
SELECT '10 new client RPCs: authenticated yes, anon no',
       CASE WHEN count(*) = 9 AND bool_and(has_function_privilege('authenticated', p.oid, 'execute'))
             AND NOT bool_or(has_function_privilege('anon', p.oid, 'execute')) THEN 'PASS' ELSE 'FAIL' END,
       string_agg(p.proname, ', ')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('my_membership', 'set_require_approval', 'approve_member', 'decline_member',
                     'set_signups', 'delete_my_account', 'issue_password_reset',
                     'request_account_deletion', 'delete_child_account');

INSERT INTO _v17_results(step, status, detail)
SELECT '11 redeem_password_reset is callable signed out (anon)',
       CASE WHEN has_function_privilege('anon', p.oid, 'execute') THEN 'PASS' ELSE 'FAIL' END, p.proname
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'redeem_password_reset';

INSERT INTO _v17_results(step, status, detail)
SELECT '12 trigger-only, internal and service-only functions are not client-callable',
       CASE WHEN count(*) = 10 AND NOT bool_or(has_function_privilege('anon', p.oid, 'execute')
                                          OR has_function_privilege('authenticated', p.oid, 'execute'))
            THEN 'PASS' ELSE 'FAIL' END,
       string_agg(p.proname, ', ')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('_roamkeep_signup_gate', 'roamkeep_notify_join', '_roamkeep_guard_place_cols',
                     'keep_owner_push_recipients', 'reset_notice_recipients', 'roamkeep_notify_reset',
                     '_roamkeep_gen_code', '_roamkeep_guard_member_cols', '_roamkeep_checkin_normalise',
                     '_roamkeep_place_cap');

INSERT INTO _v17_results(step, status, detail)
SELECT '13 join requests wake owners: pending inserts only, secret header, via notify-places',
       CASE WHEN pg_get_triggerdef(t.oid) ILIKE '%WHEN ((NOT new.approved))%'
             AND p.prosrc LIKE '%x-roamkeep-webhook%'
             AND p.prosrc LIKE '%/functions/v1/notify-places%' THEN 'PASS' ELSE 'FAIL' END,
       pg_get_triggerdef(t.oid)
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
 WHERE t.tgname = 'on_join_request';

INSERT INTO _v17_results(step, status, detail)
SELECT '14 deletion requests wake owners: on a new request only, through the join wake',
       CASE WHEN pg_get_triggerdef(t.oid) ILIKE '%UPDATE OF deletion_requested_at%'
             AND pg_get_triggerdef(t.oid) ILIKE '%old.deletion_requested_at IS NULL%'
             AND pg_get_triggerdef(t.oid) ILIKE '%new.deletion_requested_at IS NOT NULL%'
             AND p.proname = 'roamkeep_notify_join' THEN 'PASS' ELSE 'FAIL' END,
       coalesce(pg_get_triggerdef(t.oid), 'missing')
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
 WHERE t.tgname = 'on_deletion_request';

INSERT INTO _v17_results(step, status, detail)
SELECT '15 reset codes wake their member: on a code made or used, secret header, via notify-places',
       -- Aggregated, so a missing trigger still writes a FAIL row.
       CASE WHEN coalesce(bool_and(pg_get_triggerdef(t.oid) ILIKE '%AFTER INSERT OR UPDATE OF issued_at, redeemed_at%'
             AND p.prosrc LIKE '%x-roamkeep-webhook%'
             AND p.prosrc LIKE '%/functions/v1/notify-places%'
             AND p.prosrc LIKE '%password_reset_codes%'), false) THEN 'PASS' ELSE 'FAIL' END,
       coalesce(string_agg(pg_get_triggerdef(t.oid), '; '), 'missing')
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
 WHERE t.tgname = 'on_reset_notice';

INSERT INTO _v17_results(step, status, detail)
SELECT '16 anon can run exactly two of Roamkeep''s functions: the version and the reset redemption',
       CASE WHEN string_agg(p.proname, ', ' ORDER BY p.proname) = 'redeem_password_reset, roamkeep_schema_version'
            THEN 'PASS' ELSE 'FAIL' END,
       string_agg(p.proname, ', ' ORDER BY p.proname)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'execute')
   AND (p.proname LIKE '%roamkeep%' OR p.proname IN (
        'create_keep', 'join_keep_by_code', 'rotate_keep_code', 'remove_member', 'leave_keep',
        'get_invite', 'prune_keep_history', 'checkin_recipients', 'keep_push_recipients',
        'keep_owner_push_recipients', 'reset_notice_recipients', 'private_user_keep_ids',
        'my_membership', 'set_require_approval', 'approve_member', 'decline_member', 'set_signups',
        'delete_my_account', 'issue_password_reset', 'redeem_password_reset',
        'request_account_deletion', 'delete_child_account', 'set_project_url', 'set_member_role',
        'set_member_type', 'pause_member', 'resume_member', 'rename_keep', 'update_member_profile'));

DROP FUNCTION _v17_act_as(uuid, text);
DROP FUNCTION _v17_r(text, boolean, text);
DROP FUNCTION _v17_make_keep(uuid, text, text, text);
SELECT step, status, detail FROM _v17_results ORDER BY id;
