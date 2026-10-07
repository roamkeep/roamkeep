// npm run test:db:mutate — does v17-verify.sql actually catch anything?
//
// A verify script that has only ever passed proves nothing; one written
// against the schema it checks can share its blind spots. Each mutation
// below weakens exactly one v17 rule in an in-memory copy of db/schema.sql,
// and the named verify steps must then FAIL. A mutation nobody catches is a
// rule nothing tests.
//
// When a pattern stops matching, the rule's text moved: update the pattern.
// Don't delete the mutation — that is how a rule quietly loses its test.
// A rule with two independent defences (the 5-guess burn: the attempt count
// AND the cleared hash) needs both weakened, or the other one hides it.

import { read, prep, project, addUser } from './supabase.mjs'

const SCHEMA = read('db/schema.sql').replace(/\r\n/g, '\n')
const VERIFY = 'db/tests/v17-verify.sql'

// [name, [[from, to, 'last'?], ...], steps that must fail]. 'last' replaces
// the final occurrence — set_signups shares a clause with set_project_url,
// which comes first. Applied by slicing, so "$$" in a replacement is literal.
const MUTATIONS = [
  ['pending members see the keep', [['WHERE user_id = auth.uid() AND approved $$', 'WHERE user_id = auth.uid() $$']], ['1c', '1d']],
  ['guard ignores approved', [['      OR NEW.approved     IS DISTINCT FROM OLD.approved\n', '']], ['1g']],
  ['joins skip approval', [["'member', 'adult', NOT v_keep.require_approval)", "'member', 'adult', true)"]], ['1b']],
  ['anyone may approve', [["  PERFORM 1 FROM keeps WHERE id = v_keep_id FOR UPDATE;\n  IF NOT EXISTS (",
                           "  PERFORM 1 FROM keeps WHERE id = v_keep_id FOR UPDATE;\n  IF false AND NOT EXISTS (", 'last']], ['1f', '4a']],
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
  ['any member may delete a child', [['  IF NOT EXISTS (\n    SELECT 1 FROM keep_members o\n',
                                      '  IF false AND NOT EXISTS (\n    SELECT 1 FROM keep_members o\n']], ['4j']],
  ['owners may delete adults', [["  IF v_target.member_type <> 'child' THEN\n    RAISE EXCEPTION 'not_child';",
                                 "  IF false THEN\n    RAISE EXCEPTION 'not_child';"]], ['4k']],
  ['deletion wake fires on every update', [['  WHEN (OLD.deletion_requested_at IS NULL AND NEW.deletion_requested_at IS NOT NULL)\n', '']], ['14']],
  // v17 self-review fixes (2026-10-06): each rule, weakened, must be caught.
  ['pending members may edit their own row', [['  USING      (user_id = auth.uid() AND keep_id IN (SELECT private_user_keep_ids()))\n  WITH CHECK (user_id = auth.uid() AND keep_id IN (SELECT private_user_keep_ids()));',
                                               '  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());']], ['1m']],
  ['reset hashes readable by their member', [['REVOKE ALL ON password_reset_codes FROM anon, authenticated;\n', '']], ['2j']],
  ['account deletable right after a reset', [["    RAISE EXCEPTION 'recent_reset';", '    NULL;']], ['2k']],
  ['reset notices reach the whole keep', [['   WHERE m.user_id = p_user\n', '   WHERE true\n']], ['2l']],
  ['reset codes wake nobody', [['CREATE TRIGGER on_reset_notice\n  AFTER INSERT OR UPDATE OF issued_at, redeemed_at ON public.password_reset_codes\n  FOR EACH ROW\n  EXECUTE FUNCTION public.roamkeep_notify_reset();',
                                '']], ['9', '15']],
  ['helpers callable by clients', [['REVOKE ALL ON FUNCTION _roamkeep_gen_code() FROM PUBLIC, anon, authenticated;',
                                     'REVOKE ALL ON FUNCTION _roamkeep_gen_code() FROM PUBLIC;']], ['12', '16']],
  // rc9: removal rotates the code (a removed member could rejoin with theirs).
  ['removal keeps the join code', [['  PERFORM rotate_keep_code(v_keep_id);\n', '']], ['1n']],
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
    await addUser(db, 'v17owner@test.local')
    await addUser(db, 'v17member@test.local')
    const res = await db.exec(read(VERIFY))
    const failed = res[res.length - 1].rows.filter((r) => r.status === 'FAIL').map((r) => r.step.split(' ')[0])
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
