-- ============================================================
-- FamilyNest v4 Migration — Saved places + geofence support
--
-- Run this ONCE after v3 is already applied. Safe to re-run.
--
-- What this does:
--   1. Adds nest_places table (shared Home / School / Work pins
--      with a radius each, scoped to a nest).
--   2. Adds nest_members.last_place_id so clients know which
--      place a member is currently inside (for UI + dedup).
--   3. Extends checkins.type CHECK to allow 'left' (the mirror
--      of 'arrived' fired when a user exits a place).
--   4. Enables Supabase realtime on nest_places so place
--      additions/edits propagate to every signed-in device.
-- ============================================================

-- ── 1. nest_places table + RLS ────────────────────────────

CREATE TABLE IF NOT EXISTS nest_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nest_id uuid NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
  name text NOT NULL,
  icon text NOT NULL DEFAULT '📍',
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  radius_m integer NOT NULL DEFAULT 100,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nest_places_nest_id ON nest_places(nest_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'np_name_len') THEN
    ALTER TABLE nest_places ADD CONSTRAINT np_name_len
      CHECK (length(name) BETWEEN 1 AND 40);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'np_icon_len') THEN
    ALTER TABLE nest_places ADD CONSTRAINT np_icon_len
      CHECK (length(icon) BETWEEN 1 AND 8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'np_latlng_range') THEN
    ALTER TABLE nest_places ADD CONSTRAINT np_latlng_range
      CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'np_radius_range') THEN
    ALTER TABLE nest_places ADD CONSTRAINT np_radius_range
      CHECK (radius_m BETWEEN 25 AND 2000);
  END IF;
END$$;

ALTER TABLE nest_places ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read places" ON nest_places;
CREATE POLICY "Members can read places"
  ON nest_places FOR SELECT TO authenticated
  USING (
    nest_id IN (SELECT nest_id FROM nest_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Members can insert places" ON nest_places;
CREATE POLICY "Members can insert places"
  ON nest_places FOR INSERT TO authenticated
  WITH CHECK (
    nest_id IN (SELECT nest_id FROM nest_members WHERE user_id = auth.uid())
    AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS "Members can update places" ON nest_places;
CREATE POLICY "Members can update places"
  ON nest_places FOR UPDATE TO authenticated
  USING (
    nest_id IN (SELECT nest_id FROM nest_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Members can delete places" ON nest_places;
CREATE POLICY "Members can delete places"
  ON nest_places FOR DELETE TO authenticated
  USING (
    nest_id IN (SELECT nest_id FROM nest_members WHERE user_id = auth.uid())
  );

-- ── GRANTS ────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nest_places TO authenticated;

-- ── 2. nest_members.last_place_id ─────────────────────────

ALTER TABLE nest_members
  ADD COLUMN IF NOT EXISTS last_place_id uuid
    REFERENCES nest_places(id) ON DELETE SET NULL;

-- ── 3. Extend checkins.type CHECK to allow 'left' ─────────

ALTER TABLE checkins DROP CONSTRAINT IF EXISTS ck_type_values;
ALTER TABLE checkins ADD CONSTRAINT ck_type_values
  CHECK (type IN ('manual', 'arrived', 'sos', 'left'));

-- ── 4. Realtime publication for nest_places ───────────────
-- Supabase Realtime only streams tables added to the
-- supabase_realtime publication.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'nest_places'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE nest_places;
  END IF;
END$$;

-- ── DONE ──────────────────────────────────────────────────
