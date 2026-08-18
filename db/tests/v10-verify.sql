-- ============================================================
-- Roamkeep v10 — advisor-cleanup verification (run on ANY project)
--
-- Proves the execute-grant invariants the v10 cleanup enforces, so a
-- future function added without the right REVOKE can't silently reopen
-- the anon surface (Supabase advisor 0028). Results are written to a
-- _v10_results table and returned by a final SELECT, because the
-- Supabase SQL Editor does NOT display RAISE NOTICE — read the grid the
-- last SELECT returns: every row is PASS or FAIL.
--
-- This is a pure CATALOG script: it inspects has_function_privilege and
-- pg_proc, needs no test accounts and writes no data. Safe to re-run.
--
-- SETUP: apply db/schema.sql (or the v10 migration on an existing DB),
-- then paste this WHOLE file into Dashboard → SQL Editor → Run.
--
-- The surface is split by return type, NOT by a hardcoded name list:
--   * SECURITY DEFINER, non-trigger  = the RPC surface. Callable by
--     `authenticated`, never by `anon`.
--   * SECURITY DEFINER, returns trigger = fires only from its trigger,
--     never as an RPC. Callable by neither client role.
-- Why by name and not PUBLIC: Supabase default privileges grant EXECUTE
-- on every new public function to anon + authenticated explicitly, so a
-- REVOKE that only names PUBLIC leaves anon able to call it.
-- ============================================================

DROP TABLE IF EXISTS _v10_results;
CREATE TABLE _v10_results (id serial primary key, step text, status text, detail text);


-- 1) No SECURITY DEFINER RPC is executable by `anon`.
INSERT INTO _v10_results(step, status, detail)
SELECT '1 no anon EXECUTE on any SECURITY DEFINER RPC',
       CASE WHEN count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'execute')) = 0
            THEN 'PASS' ELSE 'FAIL' END,
       coalesce(
         string_agg(p.oid::regprocedure::text, ', ')
           FILTER (WHERE has_function_privilege('anon', p.oid, 'execute')),
         'clean (' || count(*)::text || ' RPCs checked, none anon-callable)')
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
  AND p.prorettype <> 'pg_catalog.trigger'::regtype;

-- 2) Every SECURITY DEFINER RPC IS executable by `authenticated` (the app
--    still works — this is the flip side of check 1, catching an over-broad
--    revoke that locks out real users).
INSERT INTO _v10_results(step, status, detail)
SELECT '2 authenticated retains EXECUTE on every SECURITY DEFINER RPC',
       CASE WHEN count(*) FILTER (WHERE NOT has_function_privilege('authenticated', p.oid, 'execute')) = 0
            THEN 'PASS' ELSE 'FAIL' END,
       coalesce(
         string_agg(p.oid::regprocedure::text, ', ')
           FILTER (WHERE NOT has_function_privilege('authenticated', p.oid, 'execute')),
         'clean (all ' || count(*)::text || ' RPCs authenticated-callable)')
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
  AND p.prorettype <> 'pg_catalog.trigger'::regtype;

-- 3) SECURITY DEFINER trigger functions expose EXECUTE to no client role.
--    Guarded: a project wired via the dashboard webhook has none — that PASSes.
INSERT INTO _v10_results(step, status, detail)
SELECT '3 no client EXECUTE on any SECURITY DEFINER trigger function',
       CASE WHEN count(*) FILTER (
              WHERE has_function_privilege('anon', p.oid, 'execute')
                 OR has_function_privilege('authenticated', p.oid, 'execute')) = 0
            THEN 'PASS' ELSE 'FAIL' END,
       coalesce(
         string_agg(p.oid::regprocedure::text, ', ')
           FILTER (WHERE has_function_privilege('anon', p.oid, 'execute')
                      OR has_function_privilege('authenticated', p.oid, 'execute')),
         CASE WHEN count(*) = 0 THEN '(none present)'
              ELSE 'clean (' || count(*)::text || ' trigger fn, no client grant)' END)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
  AND p.prorettype = 'pg_catalog.trigger'::regtype;

-- 4) The protected-column guard has its search_path pinned (advisor 0011).
INSERT INTO _v10_results(step, status, detail)
SELECT '4 _roamkeep_guard_member_cols search_path pinned',
       CASE WHEN count(*) FILTER (
              WHERE array_to_string(p.proconfig, ',') ILIKE '%search_path=%') = 1
            THEN 'PASS' ELSE 'FAIL' END,
       coalesce(string_agg(array_to_string(p.proconfig, ','), '; '), '(function missing)')
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = '_roamkeep_guard_member_cols';

-- 5) The orphaned pre-v9 helper is gone.
INSERT INTO _v10_results(step, status, detail)
SELECT '5 orphan get_my_nest_ids removed',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       CASE WHEN count(*) = 0 THEN 'absent' ELSE 'still present' END
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'get_my_nest_ids';


SELECT step, status, detail FROM _v10_results ORDER BY id;
-- (Optional) tidy the scratch table afterwards:  DROP TABLE _v10_results;
