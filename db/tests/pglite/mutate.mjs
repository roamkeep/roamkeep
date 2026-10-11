// npm run test:db:mutate — do the verify scripts actually catch anything?
//
// A verify script that has only ever passed proves nothing; one written
// against the schema it checks can share its blind spots. Each mutation
// below weakens exactly one v17 or v18 rule in an in-memory copy of
// db/schema.sql, and the named verify steps must then FAIL. A mutation
// nobody catches is a rule nothing tests.
//
// When a pattern stops matching, the rule's text moved: update the pattern.
// Don't delete the mutation — that is how a rule quietly loses its test.
// The one exception is a rule deliberately retired, which says so below.
// A rule with two independent defences (the 5-guess burn: the attempt count
// AND the cleared hash) needs both weakened, or the other one hides it.
//
// Steps are named as each script names them: v17-verify's plainly ('2b'),
// v18-verify's and v19-verify's with their prefix ('v18:2b', 'v19:1a'),
// because they all number from 1.

import { read, prep, project, addUser } from './supabase.mjs'

const SCHEMA = read('db/schema.sql').replace(/\r\n/g, '\n')
const VERIFY = [['db/tests/v17-verify.sql', ''], ['db/tests/v18-verify.sql', 'v18:'], ['db/tests/v19-verify.sql', 'v19:']]

// [name, [[from, to, 'last'?], ...], steps that must fail]. 'last' replaces
// the final occurrence — set_signups shares a clause with set_project_url,
// which comes first. Applied by slicing, so "$$" in a replacement is literal.
const MUTATIONS = [
  ['pending members see the keep', [['WHERE user_id = auth.uid() AND approved $$', 'WHERE user_id = auth.uid() $$']], ['1c', '1d']],
  ['guard ignores approved', [['      OR NEW.approved     IS DISTINCT FROM OLD.approved\n', '']], ['1g']],
  ['joins skip approval', [["'member', 'adult', NOT v_keep.require_approval)", "'member', 'adult', true)"]], ['1b']],
  // Anchored on approve_member's own "already in" return: from v19
  // decline_member has the same lock-then-owner-check lines.
  ['anyone may approve', [["    RAISE EXCEPTION 'not_owner';\n  END IF;\n\n  SELECT approved INTO v_approved FROM keep_members WHERE id = p_member_id;\n  IF v_approved THEN\n    RETURN;",
                           "    NULL;\n  END IF;\n\n  SELECT approved INTO v_approved FROM keep_members WHERE id = p_member_id;\n  IF v_approved THEN\n    RETURN;"]], ['1f', '4a']],
  ['decline removes approved members', [["  IF v_approved THEN\n    RAISE EXCEPTION 'not_pending';",
                                         "  IF false THEN\n    RAISE EXCEPTION 'not_pending';"]], ['1i']],
  ['sync wakes reach pending members', [['JOIN keep_members m ON m.id = p.member_id AND m.approved   -- v17',
                                         'JOIN keep_members m ON m.id = p.member_id']], ['1j']],
  ['check-in pushes reach pending members', [['    AND m.approved                                  -- v17: never wake a pending member', '']], ['1j']],
  ['join wakes reach every member', [["     AND m.role = 'owner'\n     AND m.approved\n     AND p.fcm_token IS NOT NULL",
                                      '     AND p.fcm_token IS NOT NULL']], ['1k']],
  ['owners can reset owners', [["IF v_target.role = 'owner' THEN", 'IF false THEN']], ['2b']],
  ['no burn after 5', [['CASE WHEN attempts + 1 >= 5 THEN NULL', 'CASE WHEN attempts + 1 >= 500 THEN NULL'],
                       ['OR v_row.attempts >= 5 THEN', 'THEN']], ['2d']],
  ['signed-out members cannot redeem', [
    ['REVOKE ALL ON FUNCTION redeem_password_reset(text, text, text) FROM PUBLIC;',
     'REVOKE ALL ON FUNCTION redeem_password_reset(text, text, text) FROM PUBLIC, anon;'],
    ['GRANT EXECUTE ON FUNCTION redeem_password_reset(text, text, text) TO anon, authenticated;',
     'GRANT EXECUTE ON FUNCTION redeem_password_reset(text, text, text) TO authenticated;']], ['2g', '11']],
  ['reset rows readable by all', [['USING (user_id = auth.uid());', 'USING (true);', 'last']], ['2i']],
  ['any owner holds the sign-up switch', [['AND m.keep_id = (SELECT k.id FROM keeps k ORDER BY k.created_at, k.id LIMIT 1)', '', 'last']], ['3b']],
  ['no long-window check', [["OR p_open_until > now() + interval '30 days')", ')']], ['3c']],
  ['gate never closes', [["    RAISE EXCEPTION 'signups_closed';", '    NULL;']], ['3d']],
  ['gate ignores the open window', [['AND (v_until IS NULL OR v_until <= now())', '']], ['3e']],
  ['created_by unprotected', [['IF NEW.created_by IS DISTINCT FROM OLD.created_by\n     AND NOT',
                               'IF false AND NEW.created_by IS DISTINCT FROM OLD.created_by\n     AND NOT']], ['4c']],
  ['place guard blocks account deletion', [['AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.created_by)) THEN', 'AND false) THEN']], ['4d']],
  ['last owner may delete their account', [['      IF v_owners <= 1 AND v_others > 0 THEN', '      IF false THEN']], ['4e']],
  ['join wake fires for every join', [['  WHEN (NOT NEW.approved)\n  EXECUTE FUNCTION public.roamkeep_notify_join();',
                                       '  EXECUTE FUNCTION public.roamkeep_notify_join();']], ['13']],
  ['a second family may start on a server', [["  IF EXISTS (SELECT 1 FROM keeps) THEN\n    RAISE EXCEPTION 'family_exists';",
                                              "  IF false THEN\n    RAISE EXCEPTION 'family_exists';"]], ['1l']],
  ['children may delete their own account', [["    IF v_member.member_type = 'child' THEN\n      RAISE EXCEPTION 'child_cannot_delete';",
                                              "    IF false THEN\n      RAISE EXCEPTION 'child_cannot_delete';"]], ['4f']],
  ['guard ignores deletion requests', [['      OR NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at)', '      )']], ['4h']],
  ['adults may ask for deletion', [["  IF v_member.member_type <> 'child' THEN\n    RAISE EXCEPTION 'not_child';",
                                    "  IF false THEN\n    RAISE EXCEPTION 'not_child';"]], ['4i']],
  // Two defences since v18: delete_child_account ends by rotating the code,
  // and rotate_keep_code checks for an owner of its own. Both weakened.
  ['any member may delete a child', [['  IF NOT EXISTS (\n    SELECT 1 FROM keep_members o\n',
                                      '  IF false AND NOT EXISTS (\n    SELECT 1 FROM keep_members o\n'],
                                     ["  IF NOT v_is_owner THEN\n    RAISE EXCEPTION 'not_owner';\n  END IF;\n\n  LOOP", '\n  LOOP']], ['4j']],
  ['owners may delete adults', [["  IF v_target.member_type <> 'child' THEN\n    RAISE EXCEPTION 'not_child';",
                                 "  IF false THEN\n    RAISE EXCEPTION 'not_child';"]], ['4k']],
  ['deletion wake fires on every update', [['  WHEN (OLD.deletion_requested_at IS NULL AND NEW.deletion_requested_at IS NOT NULL)\n', '']], ['14']],
  // v17 self-review fixes (2026-10-06): each rule, weakened, must be caught.
  ['pending members may edit their own row', [['  USING      (user_id = auth.uid() AND keep_id IN (SELECT private_user_keep_ids()))\n  WITH CHECK (user_id = auth.uid() AND keep_id IN (SELECT private_user_keep_ids()));',
                                               '  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());']], ['1m']],
  ['reset hashes readable by their member', [['REVOKE ALL ON password_reset_codes FROM anon, authenticated;\n', '']], ['2j']],
  // 'account deletable right after a reset' (2k) was retired with its rule in
  // v18 (owner decision 2026-10-09): removing a member now deletes them, so
  // the day-long block protected nothing. 2k now checks the opposite.
  ['reset notices reach the whole keep', [['   WHERE m.user_id = p_user\n', '   WHERE true\n']], ['2l']],
  ['reset codes wake nobody', [['CREATE TRIGGER on_reset_notice\n  AFTER INSERT OR UPDATE OF issued_at, redeemed_at ON public.password_reset_codes\n  FOR EACH ROW\n  EXECUTE FUNCTION public.roamkeep_notify_reset();',
                                '']], ['9', '15']],
  ['helpers callable by clients', [['REVOKE ALL ON FUNCTION _roamkeep_gen_code() FROM PUBLIC, anon, authenticated;',
                                     'REVOKE ALL ON FUNCTION _roamkeep_gen_code() FROM PUBLIC;']], ['12', '16']],
  // rc9: removal rotates the code (a removed member could rejoin with theirs).
  ['removal keeps the join code', [['  PERFORM rotate_keep_code(v_keep_id);\n', '']], ['1n']],

  // ── v18 (2026-10 independent review) ──────────────────────────────
  // Leaving deletes you.
  ['leaving keeps the sign-in', [['  IF NOT EXISTS (SELECT 1 FROM keep_members WHERE user_id = v_uid) THEN\n    DELETE FROM auth.users WHERE id = v_uid;',
                                  '  IF false THEN\n    DELETE FROM auth.users WHERE id = v_uid;']], ['v18:1a', 'v18:1b', 'v18:1c']],
  ['removal deletes an account still in another keep', [['  IF NOT EXISTS (SELECT 1 FROM keep_members WHERE user_id = v_uid) THEN\n    DELETE FROM auth.users',
                                                         '  IF true THEN\n    DELETE FROM auth.users']], ['v18:1d']],
  ['child deletion keeps the join code', [['  PERFORM rotate_keep_code(v_target.keep_id);\n', '']], ['v18:1c']],
  ['self-deletion checks the oldest membership only', [['    SELECT * FROM keep_members WHERE user_id = v_uid ORDER BY keep_id\n',
                                                        '    SELECT * FROM keep_members WHERE user_id = v_uid ORDER BY created_at LIMIT 1\n']], ['v18:1f']],
  // A reset code is checked again when it is used.
  ['redemption ignores the target becoming an owner', [["                    AND t.approved AND t.role <> 'owner')", '                    )']], ['v18:2a']],
  ['redemption ignores the target leaving the keep', [['WHERE t.user_id = v_uid AND t.keep_id = v_row.keep_id', 'WHERE t.user_id = v_uid']], ['v18:2c']],
  ['redemption ignores the issuer losing ownership', [["                       AND i.approved AND i.role = 'owner')", '                       )']], ['v18:2b']],
  ['a refused redemption leaves the code live', [["    UPDATE password_reset_codes SET code_hash = NULL WHERE user_id = v_uid;\n    RETURN 'invalid';", "    RETURN 'invalid';"]], ['v18:2d']],
  // Pending members write nothing, and a pending owner administers nothing.
  ['pending members may edit their profile', [['  ELSIF NOT v_target_approved THEN', '  ELSIF false THEN']], ['v18:3a']],
  ['pending members may pause', [["  IF NOT v_approved THEN\n    RAISE EXCEPTION 'member_pending';\n  END IF;\n  IF v_type = 'child' THEN",
                                  "  IF v_type = 'child' THEN"]], ['v18:3b']],
  ['pending members may resume', [["    RAISE EXCEPTION 'member_pending';   -- v18, as pause_member", '    NULL;']], ['v18:3c']],
  ['pending members may prune the family\'s check-ins', [['   WHERE m.user_id = v_uid AND m.approved\n     AND c.keep_id', '   WHERE m.user_id = v_uid\n     AND c.keep_id']], ['v18:3d']],
  ['pending members may prune the family\'s history', [['   WHERE m.user_id = v_uid AND m.approved\n     AND lh.keep_id', '   WHERE m.user_id = v_uid\n     AND lh.keep_id']], ['v18:3d']],
  ['pending members may be made owners', [["    IF NOT v_cur_approved THEN\n      RAISE EXCEPTION 'member_pending';", "    IF false THEN\n      RAISE EXCEPTION 'member_pending';"]], ['v18:3e']],
  ['a pending owner may rotate the code', [["     WHERE keep_id = p_keep_id AND user_id = v_uid AND role = 'owner' AND approved\n  ) INTO v_is_owner;",
                                            "     WHERE keep_id = p_keep_id AND user_id = v_uid AND role = 'owner'\n  ) INTO v_is_owner;"]], ['v18:3f']],
  ['a pending owner may rename the keep', [["     WHERE keep_id = p_keep_id AND user_id = v_uid AND role = 'owner' AND approved\n  ) INTO v_is_owner;",
                                            "     WHERE keep_id = p_keep_id AND user_id = v_uid AND role = 'owner'\n  ) INTO v_is_owner;", 'last']], ['v18:3f']],
  ['a pending owner may read the invite', [["m.role = 'owner' AND m.approved\n  ) THEN\n    RAISE EXCEPTION 'not_owner';\n  END IF;\n  RETURN QUERY SELECT k.code",
                                            "m.role = 'owner'\n  ) THEN\n    RAISE EXCEPTION 'not_owner';\n  END IF;\n  RETURN QUERY SELECT k.code"]], ['v18:3f']],
  // Two defences, as for the child deletion above: remove_member's own check
  // and the one in the rotate_keep_code it ends with.
  ['a pending owner may remove members', [["     WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner' AND approved\n  ) INTO v_is_owner;",
                                           "     WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner'\n  ) INTO v_is_owner;"],
                                          ["     WHERE keep_id = p_keep_id AND user_id = v_uid AND role = 'owner' AND approved\n  ) INTO v_is_owner;",
                                           "     WHERE keep_id = p_keep_id AND user_id = v_uid AND role = 'owner'\n  ) INTO v_is_owner;"]], ['v18:3f']],
  ['a pending owner may change roles', [["AND approved\n  ) INTO v_is_owner;\n  IF NOT v_is_owner THEN\n    RAISE EXCEPTION 'not_owner';\n  END IF;\n\n  IF p_role = 'owner'",
                                         "\n  ) INTO v_is_owner;\n  IF NOT v_is_owner THEN\n    RAISE EXCEPTION 'not_owner';\n  END IF;\n\n  IF p_role = 'owner'"]], ['v18:3f']],
  ['a pending owner may mark children', [["     WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner' AND approved\n  ) INTO v_is_owner;",
                                          "     WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner'\n  ) INTO v_is_owner;", 'last']], ['v18:3f']],
  // Role combinations.
  ['a child may be made an owner', [["    IF v_cur_type = 'child' THEN\n      RAISE EXCEPTION 'child_cannot_be_owner';", "    IF false THEN\n      RAISE EXCEPTION 'child_cannot_be_owner';"]], ['v18:4a']],
  ['a pause survives becoming a child', [["paused_until = CASE WHEN p_type = 'child' THEN NULL ELSE paused_until END", 'paused_until = paused_until']], ['v18:4b']],
  ['a pending owner counts as the last owner', [["  IF v_cur_role = 'owner' AND v_cur_approved AND p_role = 'member' THEN",
                                                 "  IF v_cur_role = 'owner' AND p_role = 'member' THEN"]], ['v18:4c']],
  // Hardening.
  ['membership helper searches pg_temp first', [['SET search_path = public, pg_temp\nSTABLE\nAS $$ SELECT keep_id FROM keep_members WHERE user_id = auth.uid() AND approved $$;',
                                                  'SET search_path = public\nSTABLE\nAS $$ SELECT keep_id FROM keep_members WHERE user_id = auth.uid() AND approved $$;']], ['v18:5a']],
  ['clients may truncate', [['REVOKE TRUNCATE, REFERENCES, TRIGGER\n', 'GRANT TRUNCATE, REFERENCES, TRIGGER\n'],
                            ['  FROM anon, authenticated;\n-- Nothing on the client side', '  TO anon, authenticated;\n-- Nothing on the client side']], ['v18:5b']],
  ['guard ignores the row id', [['      OR NEW.id           IS DISTINCT FROM OLD.id\n', '']], ['v18:5c']],
  ['guard ignores created_at', [['      OR NEW.created_at   IS DISTINCT FROM OLD.created_at\n', '']], ['v18:5c']],
  ['notification settings not pair-bound', [['    AND (member_id, keep_id) IN (SELECT id, keep_id FROM keep_members WHERE user_id = auth.uid())\n    -- Subject',
                                              '    AND member_id IN (SELECT id FROM keep_members WHERE user_id = auth.uid())\n    -- Subject']], ['v18:5d']],
  // v19: Decline deletes the account and changes the code. Anchored on the
  // lines only decline_member has.
  ['decline keeps the account', [["    RAISE EXCEPTION 'not_pending';\n  END IF;\n  PERFORM _roamkeep_delete_member(p_member_id);",
                                  "    RAISE EXCEPTION 'not_pending';\n  END IF;\n  DELETE FROM keep_members WHERE id = p_member_id;"]], ['v19:1a']],
  ['decline keeps the code', [["  PERFORM _roamkeep_delete_member(p_member_id);\n  PERFORM rotate_keep_code(v_keep_id);\nEND;\n$$;\nREVOKE ALL ON FUNCTION decline_member",
                               "  PERFORM _roamkeep_delete_member(p_member_id);\nEND;\n$$;\nREVOKE ALL ON FUNCTION decline_member"]], ['v19:1b']],
  // Two defences: decline_member's own owner check, and rotate_keep_code's,
  // which it calls last and which refuses anyone but an approved owner, so
  // the whole decline rolls back. Both must go, or the second hides the first.
  ['anyone may decline', [["    RAISE EXCEPTION 'not_owner';\n  END IF;\n  SELECT approved INTO v_approved FROM keep_members WHERE id = p_member_id;\n  IF NOT FOUND THEN",
                           "    NULL;\n  END IF;\n  SELECT approved INTO v_approved FROM keep_members WHERE id = p_member_id;\n  IF NOT FOUND THEN"],
                           ["  PERFORM _roamkeep_delete_member(p_member_id);\n  PERFORM rotate_keep_code(v_keep_id);\nEND;\n$$;\nREVOKE ALL ON FUNCTION decline_member",
                            "  PERFORM _roamkeep_delete_member(p_member_id);\nEND;\n$$;\nREVOKE ALL ON FUNCTION decline_member"]], ['v19:1d', 'v19:1e']],
  ['an owner still waiting may decline', [["role = 'owner' AND approved\n  ) THEN\n    RAISE EXCEPTION 'not_owner';\n  END IF;\n  SELECT approved INTO v_approved FROM keep_members WHERE id = p_member_id;\n  IF NOT FOUND THEN",
                                           "role = 'owner'\n  ) THEN\n    RAISE EXCEPTION 'not_owner';\n  END IF;\n  SELECT approved INTO v_approved FROM keep_members WHERE id = p_member_id;\n  IF NOT FOUND THEN"],
                           ["  PERFORM _roamkeep_delete_member(p_member_id);\n  PERFORM rotate_keep_code(v_keep_id);\nEND;\n$$;\nREVOKE ALL ON FUNCTION decline_member",
                            "  PERFORM _roamkeep_delete_member(p_member_id);\nEND;\n$$;\nREVOKE ALL ON FUNCTION decline_member"]], ['v19:1e']],
]

function mutate(src, pairs) {
  for (const [from, to, where] of pairs) {
    const i = where === 'last' ? src.lastIndexOf(from) : src.indexOf(from)
    if (i < 0) return null
    src = src.slice(0, i) + to + src.slice(i + from.length)
  }
  return src
}

let missed = 0
for (const [name, pairs, expect] of MUTATIONS) {
  const schema = mutate(SCHEMA, pairs)
  if (!schema) { missed++; console.log(`STALE   ${name}: pattern not found in db/schema.sql`); continue }
  const db = await project()
  try {
    await db.exec(prep(schema))
    const failed = []
    for (const [file, prefix] of VERIFY) {
      const n = file.match(/v(\d+)-verify/)[1]
      await addUser(db, `v${n}owner@test.local`)
      await addUser(db, `v${n}member@test.local`)
      const res = await db.exec(read(file))
      for (const r of res[res.length - 1].rows) {
        if (r.status === 'FAIL') failed.push(prefix + r.step.split(' ')[0])
      }
    }
    const caught = expect.every((e) => failed.includes(e))
    if (!caught) missed++
    console.log(`${caught ? 'caught' : 'MISSED'}  ${name} → failed ${failed.join(', ') || 'nothing'} (needs ${expect.join(', ')})`)
  } catch (e) {
    // An abort hides every other result on staging, so it is not a clean catch.
    missed++
    console.log(`ABORT   ${name} → the script died: ${e.message.split('\n')[0]}`)
  }
  await db.close()
}
console.log(missed ? `\n${missed} of ${MUTATIONS.length} not caught cleanly` : `\nall ${MUTATIONS.length} caught`)
process.exitCode = missed ? 1 : 0
