-- ============================================================
-- FamilyNest v8.1 — HOTFIX: nest_members RLS infinite recursion
--
-- Symptom (app fails to launch):
--   "infinite recursion detected in policy for relation nest_members"
--
-- Cause: nest_members' SELECT policy subqueries nest_members itself
--   USING (nest_id IN (SELECT nest_id FROM nest_members WHERE user_id = auth.uid()))
-- Evaluating that policy requires reading nest_members, which re-applies
-- the same policy, which reads nest_members again … Postgres detects the
-- loop and aborts the query. (This policy shape has existed since
-- secure-v2; re-creating it while applying v8 is what made Postgres
-- re-plan and surface the recursion.)
--
-- Fix: look the caller's memberships up through a SECURITY DEFINER
-- function. Because the function runs as its owner, its internal read of
-- nest_members does NOT re-enter RLS — so there's no recursion. It's still
-- scoped to auth.uid(), so it leaks nothing: a member sees only the nests
-- they belong to, exactly as intended.
--
-- Safe to run on live in the SQL Editor; idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION private_user_nest_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$ SELECT nest_id FROM nest_members WHERE user_id = auth.uid() $$;
REVOKE ALL ON FUNCTION private_user_nest_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private_user_nest_ids() TO authenticated;

-- Only nest_members' policy is self-recursive, so that's the one that
-- must change. The other tables' policies (nests, checkins, nest_places,
-- location_history) subquery nest_members from a DIFFERENT table, which
-- isn't self-recursion — but we route them through the same helper too,
-- so they stop re-entering nest_members RLS entirely (also a touch
-- faster: the STABLE function is evaluated once per query).

DROP POLICY IF EXISTS "Members can read their nest" ON nest_members;
CREATE POLICY "Members can read their nest"
  ON nest_members FOR SELECT TO authenticated
  USING (nest_id IN (SELECT private_user_nest_ids()));

DROP POLICY IF EXISTS "Members can read their nest" ON nests;
CREATE POLICY "Members can read their nest"
  ON nests FOR SELECT TO authenticated
  USING (id IN (SELECT private_user_nest_ids()));

DROP POLICY IF EXISTS "Nest members can read checkins" ON checkins;
CREATE POLICY "Nest members can read checkins"
  ON checkins FOR SELECT TO authenticated
  USING (nest_id IN (SELECT private_user_nest_ids()));

DROP POLICY IF EXISTS "Nest members can insert checkins" ON checkins;
CREATE POLICY "Nest members can insert checkins"
  ON checkins FOR INSERT TO authenticated
  WITH CHECK (nest_id IN (SELECT private_user_nest_ids()));

DROP POLICY IF EXISTS "Members can read places" ON nest_places;
CREATE POLICY "Members can read places"
  ON nest_places FOR SELECT TO authenticated
  USING (nest_id IN (SELECT private_user_nest_ids()));

DROP POLICY IF EXISTS "Members can insert places" ON nest_places;
CREATE POLICY "Members can insert places"
  ON nest_places FOR INSERT TO authenticated
  WITH CHECK (
    nest_id IN (SELECT private_user_nest_ids())
    AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS "Members can update places" ON nest_places;
CREATE POLICY "Members can update places"
  ON nest_places FOR UPDATE TO authenticated
  USING (nest_id IN (SELECT private_user_nest_ids()));

DROP POLICY IF EXISTS "Members can delete places" ON nest_places;
CREATE POLICY "Members can delete places"
  ON nest_places FOR DELETE TO authenticated
  USING (nest_id IN (SELECT private_user_nest_ids()));

DROP POLICY IF EXISTS "Members can read history" ON location_history;
CREATE POLICY "Members can read history"
  ON location_history FOR SELECT TO authenticated
  USING (nest_id IN (SELECT private_user_nest_ids()));

-- (location_history INSERT/DELETE already scope by member_id = own rows,
--  and nest_members' own UPDATE/DELETE policies use user_id = auth.uid();
--  none of those self-reference, so they're left as-is.)

-- ── DONE ──────────────────────────────────────────────────
