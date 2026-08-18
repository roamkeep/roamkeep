-- ============================================================
-- Roamkeep v9 — rename "nest" to "keep" throughout the database
--
-- Run this ONCE on a database already at v8_2, then run db/schema.sql
-- immediately afterwards (see ORDER below). Safe to re-run: every step
-- is guarded on the old name still existing.
--
-- WHY NOW: the app was rebranded FamilyNest → Roamkeep and users have
-- said "Keep" since 4.0.0, but the schema still said "nest". That split
-- was deliberate — renaming live tables is a breaking change needing a
-- lockstep client+DB cutover — and it is being closed now, while the
-- author is still the only deployment. After other families provision
-- their own Supabase, this stops being one person's cutover and becomes
-- everybody's migration.
--
-- ⚠ THIS IS A BREAKING CHANGE. Every client MUST be updated in lockstep:
-- an app older than 4.5.0 queries `nest_members` and will fail outright
-- against a migrated database. Migrate the DB and install the new build
-- together.
--
-- ORDER (both steps, same sitting):
--   1. this file            — renames objects, drops stale functions
--   2. db/schema.sql        — recreates every function with correct bodies
--
-- Why it takes two files: a table rename is metadata-only and Postgres
-- rewrites the parsed expressions that depend on it (policies, FK
-- constraints, indexes, publication membership all follow automatically).
-- Function BODIES are stored as text and do NOT follow — after the rename
-- they reference tables that no longer exist. Rather than duplicate a
-- dozen function definitions here and let them drift from schema.sql,
-- this file only does the renames and schema.sql restates the bodies.
-- ============================================================


-- ── 1. TABLES ─────────────────────────────────────────────
-- Metadata-only. RLS policies are stored as parsed trees referencing
-- OIDs, so they follow silently and do NOT need recreating.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='nests') THEN
    ALTER TABLE public.nests              RENAME TO keeps;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='nest_members') THEN
    ALTER TABLE public.nest_members        RENAME TO keep_members;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='nest_places') THEN
    ALTER TABLE public.nest_places         RENAME TO keep_places;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='nest_join_attempts') THEN
    ALTER TABLE public.nest_join_attempts  RENAME TO keep_join_attempts;
  END IF;
END$$;


-- ── 2. COLUMNS ────────────────────────────────────────────
-- nest_id → keep_id on all four tables that carry it.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['keep_members','keep_places','checkins','location_history'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=t AND column_name='nest_id'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I RENAME COLUMN nest_id TO keep_id', t);
    END IF;
  END LOOP;
END$$;


-- ── 3. FUNCTIONS WITH DEPENDENTS — rename, never drop ─────
-- These two are referenced BY OID: private_user_keep_ids by every
-- membership RLS policy, and the guard function by trg_guard_member_cols.
-- Dropping either would fail on the dependency (or, with CASCADE, would
-- silently take the policies with it — which would leave the tables
-- readable by anyone). ALTER FUNCTION ... RENAME preserves the OID, so
-- the dependents follow. schema.sql then CREATE OR REPLACEs the body,
-- which also preserves the OID.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname='private_user_nest_ids') THEN
    ALTER FUNCTION public.private_user_nest_ids() RENAME TO private_user_keep_ids;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname='_familynest_guard_member_cols') THEN
    ALTER FUNCTION public._familynest_guard_member_cols() RENAME TO _roamkeep_guard_member_cols;
  END IF;
END$$;


-- ── 4. FUNCTIONS WITHOUT DEPENDENTS — drop the old names ──
-- Clients call these by name over PostgREST, so nothing in the database
-- depends on them structurally. Dropped here so the old names don't
-- linger with stale bodies; schema.sql creates the new names.
-- Order matters: the callers go before _familynest_gen_code, which they
-- call.

DROP FUNCTION IF EXISTS public.create_nest(text, text, text);
DROP FUNCTION IF EXISTS public.join_nest_by_code(text, text, text);
DROP FUNCTION IF EXISTS public.rotate_nest_code(uuid);
DROP FUNCTION IF EXISTS public._familynest_gen_code();


-- ── 5. INDEXES ────────────────────────────────────────────
-- Cosmetic — an index works fine under its old name — but leaving
-- idx_nest_* behind in a schema that says keep everywhere is exactly the
-- half-renamed state this migration exists to end.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_nest_places_nest_id') THEN
    ALTER INDEX public.idx_nest_places_nest_id     RENAME TO idx_keep_places_keep_id;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_nest_members_nest_token') THEN
    ALTER INDEX public.idx_nest_members_nest_token RENAME TO idx_keep_members_keep_token;
  END IF;
END$$;


-- ── 6. pg_cron JOBS ───────────────────────────────────────
-- cron.schedule() upserts by job NAME, so a renamed job is a NEW job —
-- the old one survives with its old body. The join-attempts body is the
-- one that matters: it says `nest_join_attempts`, a table that no longer
-- exists after section 1, so it fails every night at 03:30 forever.
-- Unschedule the old names here; schema.sql schedules
-- roamkeep-prune-location-history and roamkeep-prune-join-attempts.
--
-- 'familykeep-prune-join-attempts' is in this list because an early v9
-- schema.sql shipped that name by accident (a bulk nest→keep pass caught
-- `familynest-` too). Anyone who ran that build has the stray job; this
-- clears it. Harmless to run when it was never created.

DO $$
DECLARE j text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    FOREACH j IN ARRAY ARRAY[
      'familynest-prune-location-history',
      'familynest-prune-join-attempts',
      'familykeep-prune-join-attempts'
    ] LOOP
      PERFORM cron.unschedule(j) WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = j);
    END LOOP;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'could not unschedule an old cron job (harmless): %', SQLERRM;
END$$;


-- ── 7. VERIFY THE RENAME ──────────────────────────────────
-- Fail loudly here rather than leaving a half-migrated database that
-- looks fine until the app queries it.

DO $$
DECLARE
  n_tables int;
  n_oldcols int;
  n_oldjobs int;
BEGIN
  SELECT count(*) INTO n_tables FROM pg_tables
    WHERE schemaname='public' AND tablename IN ('keeps','keep_members','keep_places','keep_join_attempts');
  IF n_tables <> 4 THEN
    RAISE EXCEPTION 'rename incomplete: expected 4 keep_* tables, found %', n_tables;
  END IF;

  SELECT count(*) INTO n_oldcols FROM information_schema.columns
    WHERE table_schema='public' AND column_name='nest_id';
  IF n_oldcols <> 0 THEN
    RAISE EXCEPTION 'rename incomplete: % column(s) still named nest_id', n_oldcols;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    SELECT count(*) INTO n_oldjobs FROM cron.job
      WHERE jobname LIKE 'familynest-%' OR jobname LIKE 'familykeep-%';
    IF n_oldjobs <> 0 THEN
      RAISE EXCEPTION 'rename incomplete: % stale cron job(s) left; their bodies name tables that no longer exist', n_oldjobs;
    END IF;
  END IF;

  RAISE NOTICE 'v9 rename OK — now run db/schema.sql to restate the function bodies.';
END$$;

-- ── DONE — NOW RUN db/schema.sql ──────────────────────────
-- Until you do, every RPC is broken: their bodies still reference the
-- pre-rename table names.
