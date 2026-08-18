-- ============================================================
-- FamilyNest SECURE Schema v2 — Run this to fix RLS issues
-- Supabase → SQL Editor → New Query → Run
-- ============================================================

-- Drop and recreate cleanly
DROP TABLE IF EXISTS checkins CASCADE;
DROP TABLE IF EXISTS nest_members CASCADE;
DROP TABLE IF EXISTS nests CASCADE;
DROP FUNCTION IF EXISTS is_nest_member(UUID);

-- ── TABLES ────────────────────────────────────────────────

CREATE TABLE nests (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE nest_members (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nest_id    UUID REFERENCES nests(id) ON DELETE CASCADE NOT NULL,
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name       TEXT NOT NULL,
  avatar     TEXT NOT NULL,
  lat        DOUBLE PRECISION,
  lng        DOUBLE PRECISION,
  battery    INTEGER DEFAULT 100,
  status     TEXT DEFAULT '📍 Location sharing on',
  sos        BOOLEAN DEFAULT FALSE,
  online     BOOLEAN DEFAULT TRUE,
  last_seen  TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(nest_id, user_id)
);

CREATE TABLE checkins (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nest_id       UUID REFERENCES nests(id) ON DELETE CASCADE NOT NULL,
  member_id     UUID REFERENCES nest_members(id) ON DELETE CASCADE NOT NULL,
  member_name   TEXT NOT NULL,
  member_avatar TEXT NOT NULL,
  place         TEXT NOT NULL,
  type          TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── RLS ───────────────────────────────────────────────────

ALTER TABLE nests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE nest_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkins     ENABLE ROW LEVEL SECURITY;

-- NESTS: any signed-in user can read (needed to look up a code to join)
CREATE POLICY "Authenticated users can read nests"
  ON nests FOR SELECT TO authenticated USING (true);

-- NESTS: signed-in user can create a nest
CREATE POLICY "Authenticated users can create nests"
  ON nests FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

-- NEST_MEMBERS: you can see all members in any nest you belong to
CREATE POLICY "Members can read their nest"
  ON nest_members FOR SELECT TO authenticated
  USING (
    nest_id IN (
      SELECT nest_id FROM nest_members WHERE user_id = auth.uid()
    )
  );

-- NEST_MEMBERS: you can insert yourself (user_id must equal your auth id)
CREATE POLICY "Users can join a nest as themselves"
  ON nest_members FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- NEST_MEMBERS: you can only update your own row
CREATE POLICY "Users can update own member row"
  ON nest_members FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- NEST_MEMBERS: you can only delete your own row
CREATE POLICY "Users can delete own member row"
  ON nest_members FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- CHECKINS: only nest members can read check-ins
CREATE POLICY "Nest members can read checkins"
  ON checkins FOR SELECT TO authenticated
  USING (
    nest_id IN (
      SELECT nest_id FROM nest_members WHERE user_id = auth.uid()
    )
  );

-- CHECKINS: only nest members can insert check-ins
CREATE POLICY "Nest members can insert checkins"
  ON checkins FOR INSERT TO authenticated
  WITH CHECK (
    nest_id IN (
      SELECT nest_id FROM nest_members WHERE user_id = auth.uid()
    )
  );

-- ── GRANTS ────────────────────────────────────────────────
-- Required for PostgREST / supabase-js Data API access.
-- New Supabase projects (post-May 30 2026) no longer grant
-- public-schema tables by default — explicit grants are needed.
GRANT SELECT, INSERT ON public.nests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nest_members TO authenticated;
GRANT SELECT, INSERT ON public.checkins TO authenticated;

-- ── REALTIME ──────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE nest_members;
ALTER PUBLICATION supabase_realtime ADD TABLE checkins;

-- ── DONE ─────────────────────────────────────────────────
-- Now go to: Supabase Dashboard → Authentication → Settings
-- Set "Enable email confirmations" → OFF
-- This lets users sign up and use the app immediately.
