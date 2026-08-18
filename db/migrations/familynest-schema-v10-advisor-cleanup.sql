-- v10 — Supabase advisor cleanup (SECURITY hardening, no schema/behaviour change)
--
-- Runs against an EXISTING live database. Idempotent and non-destructive;
-- safe to run more than once and safe on any project regardless of how it was
-- provisioned. Nothing here changes an RPC signature, so no client bump.
--
-- Three findings, from comparing the owner's project against a clean
-- CLI-provisioned test project:
--
--  1. `get_my_nest_ids()` — an orphaned pre-v9 ("nest") helper that only
--     exists in the owner's project. It is not in db/schema.sql, is
--     referenced by nothing, and the clean test project never had it. Drop.
--     (No-op on any project that never carried the orphan.)
--
--  2. `_roamkeep_guard_member_cols()` — the only function in the schema whose
--     search_path was never pinned (0011). Pin it, matching every other
--     function. It is the trigger that blocks unauthorised role/member_type/
--     paused_until changes, so it is security-relevant even as SECURITY INVOKER.
--
--  3. The SECURITY DEFINER RPCs report as `anon`-executable (0028). NOT drift:
--     Supabase's default privileges grant EXECUTE on every new public function
--     to anon, authenticated AND service_role explicitly, so `REVOKE ... FROM
--     PUBLIC` (all db/schema.sql ever did) leaves the explicit `anon` grant
--     intact — confirmed by has_function_privilege('anon', ...) staying true
--     after a PUBLIC revoke. Revoke from `anon` by name. Not exploitable — each
--     gates on auth.uid(), which anon lacks — but it clears 0028. The
--     `authenticated` half (0029) is by design and left as-is.
--
-- Also revokes the CLI's webhook trigger function from PUBLIC where present
-- (see cli/src/steps.js — patched to do this at creation going forward), so an
-- already-provisioned family is cleaned up by this same script.
--
-- Verify with db/tests/v10-verify.sql after applying (pure-catalog PASS/FAIL
-- grid; also the regression guard for RPCs added later).

begin;

-- 1. Drop the orphaned pre-v9 helper (no-op where absent).
drop function if exists public.get_my_nest_ids();

-- 2. Pin the guard trigger's search_path.
alter function public._roamkeep_guard_member_cols() set search_path = public;

-- 3. Set the intended execute grants on the SECURITY DEFINER surface:
--    no anon (revoked by name — see above), authenticated only.
do $$
declare
  fn text;
  fns text[] := array[
    'private_user_keep_ids()',
    'create_keep(text, text, text)',
    'join_keep_by_code(text, text, text)',
    'rotate_keep_code(uuid)',
    'remove_member(uuid)',
    'set_member_role(uuid, text)',
    'set_member_type(uuid, text)',
    'pause_member(uuid, timestamptz)',
    'resume_member(uuid)'
  ];
begin
  foreach fn in array fns loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end$$;

-- Trigger-only function: must never be RPC-callable at all. Revoke every client
-- role (clears both 0028 and 0029). Guarded because projects wired via the
-- dashboard webhook (not the CLI) do not have it.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'roamkeep_notify_checkin'
  ) then
    revoke all on function public.roamkeep_notify_checkin() from public, anon, authenticated;
  end if;
end$$;

commit;
