-- ============================================================
-- FamilyNest v6 Migration — Location history (breadcrumb trail)
--
-- Run this ONCE after v5 is already applied. Safe to re-run.
--
-- What this does:
--   1. Adds location_history — a lightweight per-member position trail
--      so the app can draw "where was X over the last 24h" on the map.
--      Written by the client roughly every couple of minutes (throttled
--      by the active tracking mode), NOT on every GPS fix.
--   2. RLS: members read history for any nest they belong to; members
--      insert only their own rows.
--   3. Adds the table to the realtime publication so a member's trail
--      updates live on other devices.
--
-- Retention: trimmed to ~24h. The client opportunistically deletes its
-- own rows older than 24h when it writes. For belt-and-suspenders
-- server-side enforcement you can additionally schedule a daily prune
-- with pg_cron (commented at the bottom).
-- ============================================================

CREATE TABLE IF NOT EXISTS location_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nest_id     uuid NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES nest_members(id) ON DELETE CASCADE,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- Hot path: "this member's points, newest first, within a time window".
CREATE INDEX IF NOT EXISTS idx_lochist_member_time
  ON location_history(nest_id, member_id, recorded_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lh_latlng_range') THEN
    ALTER TABLE location_history ADD CONSTRAINT lh_latlng_range
      CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180);
  END IF;
END$$;

ALTER TABLE location_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read history" ON location_history;
CREATE POLICY "Members can read history"
  ON location_history FOR SELECT TO authenticated
  USING (nest_id IN (SELECT nest_id FROM nest_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Members can insert own history" ON location_history;
CREATE POLICY "Members can insert own history"
  ON location_history FOR INSERT TO authenticated
  WITH CHECK (
    nest_id IN (SELECT nest_id FROM nest_members WHERE user_id = auth.uid())
    AND member_id IN (SELECT id FROM nest_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Members can delete own history" ON location_history;
CREATE POLICY "Members can delete own history"
  ON location_history FOR DELETE TO authenticated
  USING (member_id IN (SELECT id FROM nest_members WHERE user_id = auth.uid()));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND tablename = 'location_history') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE location_history;
  END IF;
END$$;

-- ── Optional: server-side retention via pg_cron ───────────
-- The client prunes its own >24h rows on write, which is enough in
-- practice. If you want a guaranteed daily sweep regardless of client
-- behaviour, enable pg_cron (Dashboard → Database → Extensions) and run:
--
--   SELECT cron.schedule(
--     'familynest-prune-location-history',
--     '0 3 * * *',
--     $$DELETE FROM location_history WHERE recorded_at < now() - interval '24 hours'$$
--   );

-- ── DONE ──────────────────────────────────────────────────
