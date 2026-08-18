-- ============================================================
-- FamilyNest v7 Migration — History timeline (7-day retention)
--
-- Run this ONCE after v6 is already applied. Safe to re-run.
--
-- What this does:
--   1. Adds location_history.speed (m/s, nullable) — GPS-reported
--      speed captured alongside each breadcrumb. The timeline uses it
--      to classify a trip as a walk or a drive; old rows stay NULL and
--      the client falls back to distance/time for those.
--   2. Extends breadcrumb retention from 24 hours to 7 days so the
--      timeline can show the past week. The client still prunes its
--      own rows on launch (now at the 7-day cutoff); the pg_cron job
--      below is the server-side guarantee for members whose devices
--      never come back online.
--   3. Indexes checkins by member+time — the timeline reads one
--      member's arrived/left pairs for one day, which the existing
--      nest-wide feed index doesn't cover well.
-- ============================================================

ALTER TABLE location_history ADD COLUMN IF NOT EXISTS speed double precision;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lh_speed_range') THEN
    ALTER TABLE location_history ADD CONSTRAINT lh_speed_range
      CHECK (speed IS NULL OR (speed >= 0 AND speed < 150));
  END IF;
END$$;

-- Timeline hot path: "this member's check-ins for one day, in order".
CREATE INDEX IF NOT EXISTS idx_checkins_member_time
  ON checkins(nest_id, member_id, created_at DESC);

-- ── Server-side retention via pg_cron ─────────────────────
-- Scheduled only if the pg_cron extension is enabled (Dashboard →
-- Database → Extensions). cron.schedule() upserts by job name, so
-- re-running this migration just refreshes the same job. If the
-- extension is missing we skip with a NOTICE instead of failing —
-- enable it and re-run this file to get the sweep.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'familynest-prune-location-history',
      '0 3 * * *',
      $job$DELETE FROM location_history WHERE recorded_at < now() - interval '7 days'$job$
    );
  ELSE
    RAISE NOTICE 'pg_cron not enabled — skipping retention job. Enable the extension and re-run.';
  END IF;
END$$;

-- ── DONE ──────────────────────────────────────────────────
