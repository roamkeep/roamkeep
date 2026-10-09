-- ============================================================
-- Roamkeep — consolidated schema (canonical)
--
-- This single file recreates the entire database from scratch and is
-- the source of truth for the schema. It folds together every numbered
-- migration in db/migrations/ (v2 → v5).
--
-- Properties:
--   • Idempotent. CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
--     DROP POLICY IF EXISTS + CREATE, CREATE OR REPLACE FUNCTION. Safe to
--     run against a brand-new project (creates everything) AND against the
--     live project (no-ops).
--   • Non-destructive, with ONE deliberate exception since v14: it moves
--     keep_members.fcm_token into keep_member_push and then drops the
--     column. The data is copied first, so nothing is lost — but a client
--     older than 4.8.3 can no longer register a new push token after this
--     runs. See the "RETIRE keep_members.fcm_token" section for why the
--     step cannot live only in the migration file.
--   • Run it in: Supabase Dashboard → SQL Editor → New query → Run.
--
-- After running, in the Dashboard:
--   Authentication → Settings → "Enable email confirmations" → OFF
--   (lets family members sign up and use the app immediately).
--
-- The numbered files in db/migrations/ remain the historical record and
-- the per-delta path for upgrading a database that's on an older version.
-- For a fresh setup you only need THIS file.
-- ============================================================


-- pgcrypto provides gen_random_bytes for the invite-code generator. On
-- Supabase it lives in the `extensions` schema; IF NOT EXISTS is a no-op
-- there. The generator sets search_path to include `extensions` so the
-- unqualified call resolves wherever pgcrypto is installed.
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ── TABLES ────────────────────────────────────────────────
-- Order matters for foreign keys: keeps → keep_members → checkins →
-- keep_places, then keep_members.last_place_id is added once
-- keep_places exists.

CREATE TABLE IF NOT EXISTS keeps (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  -- Invite codes expire (72h by default, set by create_keep/rotate).
  code_expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS keep_members (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  keep_id           UUID REFERENCES keeps(id) ON DELETE CASCADE NOT NULL,
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name              TEXT NOT NULL,
  avatar            TEXT NOT NULL,
  lat               DOUBLE PRECISION,
  lng               DOUBLE PRECISION,
  battery           INTEGER DEFAULT 100,
  status            TEXT DEFAULT '📍 Location sharing on',
  sos               BOOLEAN DEFAULT FALSE,
  online            BOOLEAN DEFAULT TRUE,
  last_seen         TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  -- Added by later migrations; inlined here for fresh installs.
  -- (fcm_token lived here until v14 — it is now keep_member_push, because
  -- this table is readable across the whole keep and RLS cannot restrict
  -- columns, so a token here was a token every relative could read.)
  notify_on_checkin BOOLEAN NOT NULL DEFAULT TRUE,
  -- v8: two orthogonal axes + a time-boxed self-pause.
  --   member_type — life-stage / tracking policy (adult may pause &
  --                 reclassify; child may not self-pause/self-remove)
  --   role        — admin power (owner may rotate code, kick, manage)
  --   paused_until— NULL = active; else the future instant tracking
  --                 auto-resumes (adults only, ≤24h out)
  member_type       TEXT NOT NULL DEFAULT 'adult',
  role              TEXT NOT NULL DEFAULT 'member',
  paused_until      TIMESTAMPTZ,
  UNIQUE(keep_id, user_id)
);

-- v8: rate-limit log for join_keep_by_code. Only the DEFINER RPC
-- touches it — RLS is enabled with no policies (default deny), the
-- function bypasses RLS as its owner.
CREATE TABLE IF NOT EXISTS keep_join_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checkins (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  keep_id       UUID REFERENCES keeps(id) ON DELETE CASCADE NOT NULL,
  member_id     UUID REFERENCES keep_members(id) ON DELETE CASCADE NOT NULL,
  member_name   TEXT NOT NULL,
  member_avatar TEXT NOT NULL,
  place         TEXT NOT NULL,
  type          TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  -- v16: when the SERVER received the row. created_at is the event time
  -- the device reports (a geofence crossing can land minutes later), so it
  -- is neither monotonic nor trustworthy; this is what devices page
  -- through. Forced by _roamkeep_checkin_normalise — a client cannot set it.
  inserted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS keep_places (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keep_id    uuid NOT NULL REFERENCES keeps(id) ON DELETE CASCADE,
  name       text NOT NULL,
  icon       text NOT NULL DEFAULT '📍',
  lat        double precision NOT NULL,
  lng        double precision NOT NULL,
  radius_m   integer NOT NULL DEFAULT 100,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-member breadcrumb trail. Written ~every couple of minutes (the
-- client throttles by tracking mode), trimmed to 7 days. Drives the
-- map trail and the per-day history timeline. speed is the GPS-reported
-- speed in m/s (nullable — the timeline uses it to tell walks from
-- drives, falling back to distance/time when absent).
--
-- accuracy (v15) is the fix's own horizontal error radius in metres, as
-- the OS reported it. Nullable, and nothing reads it yet: it exists so
-- that a wrong row can be told apart from a merely imprecise one after
-- the fact. Every drift defence on the write path keys on accuracy, so
-- when a stationary phone records a journey anyway there are exactly two
-- explanations — the fix was imprecise and cleared the thresholds, or it
-- claimed to be precise and was wrong — and without this column they are
-- indistinguishable in the stored data. That ambiguity has blocked the
-- same diagnosis four times.
CREATE TABLE IF NOT EXISTS location_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keep_id     uuid NOT NULL REFERENCES keeps(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES keep_members(id) ON DELETE CASCADE,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  speed       double precision,
  accuracy    double precision,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- Schema version marker + compatibility metadata (v12).
--
-- Exactly one row, enforced by the primary key: `id boolean PRIMARY KEY
-- DEFAULT true CHECK (id)` admits only the value true, so a second INSERT
-- conflicts rather than creating a silently divergent second row.
--
-- roamkeep_schema_version() below returns a NUMBER, never a verdict — a
-- database that answered "compatible: yes/no" would bake the client
-- policy of the day into every family's server, and changing that policy
-- later would become a migration for all of them. Returning `12` lets
-- each build decide for itself, per feature. Don't add a boolean here.
--
-- project_url is the project's own https://<ref>.supabase.co. The webhook
-- trigger functions need it to reach their Edge Functions, and this file
-- cannot know it when pasted into a SQL editor — it is set by the
-- provisioning wizard, by set_project_url() on the owner's next app open,
-- or by hand. The triggers no-op while it is NULL.
CREATE TABLE IF NOT EXISTS roamkeep_meta (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  schema_version integer NOT NULL,
  min_app_build  integer NOT NULL DEFAULT 0,   -- advisory only, never a hard block
  project_url    text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Per-person, per-place notification preferences (v13).
--
-- EXCEPTION ROWS ONLY: a row means "don't tell me", no row means "tell
-- me". So an empty table is exactly today's behaviour, and the feature
-- costs a family nothing until somebody uses it.
--
-- The three cascades are the whole garbage-collection story — delete a
-- place or remove a member and the preferences referencing them go too.
-- No cleanup job, and no way to accumulate rows pointing at nothing.
-- Per-member push token (v14).
--
-- Split out of keep_members because that table is readable across the whole
-- keep and RLS cannot restrict columns, so `select fcm_token from
-- keep_members` handed any member every relative's registration token. Here
-- the policy is own-row only. Both Edge Functions run as service_role and
-- bypass RLS, so neither needs a policy.
CREATE TABLE IF NOT EXISTS keep_member_push (
  member_id  uuid PRIMARY KEY REFERENCES keep_members(id) ON DELETE CASCADE,
  keep_id    uuid NOT NULL REFERENCES keeps(id) ON DELETE CASCADE,
  fcm_token  text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The webhook secret the database issues itself (v14).
--
-- Deliberately NOT in roamkeep_meta: that table is readable by anon so the
-- version check can run before sign-in, and the anon key is in every setup
-- link — a secret there would be world-readable. RLS on with NO policies,
-- the keep_join_attempts pattern: only the SECURITY DEFINER trigger
-- functions read it, and the Edge Functions read it with the service-role
-- key they already hold. Self-seeding, so no owner ever has to set it.
CREATE TABLE IF NOT EXISTS roamkeep_secrets (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  webhook_secret text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Seeded once, never overwritten — re-running this file must not rotate a
-- secret the triggers are already sending.
INSERT INTO roamkeep_secrets (id, webhook_secret)
VALUES (true, encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS keep_notify_prefs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keep_id           uuid NOT NULL REFERENCES keeps(id)        ON DELETE CASCADE,
  member_id         uuid NOT NULL REFERENCES keep_members(id) ON DELETE CASCADE,  -- the viewer
  subject_member_id uuid NOT NULL REFERENCES keep_members(id) ON DELETE CASCADE,
  place_id          uuid NOT NULL REFERENCES keep_places(id)  ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, subject_member_id, place_id)
);

-- Patch columns onto databases that predate the migration that added
-- them (no-op on a fresh install where they're already inline above).

-- v13. checkins.place is a DISPLAY STRING (icon || ' ' || name), so
-- matching a preference against it would be string comparison that a
-- rename silently breaks. Added here rather than inline above because
-- keep_places is created after checkins. Nullable and never backfilled:
-- historical rows and manual/sos check-ins are NULL, and NULL is never
-- muted.
ALTER TABLE checkins
  ADD COLUMN IF NOT EXISTS place_id uuid REFERENCES keep_places(id) ON DELETE SET NULL;

-- v13. Where the member was when the row was written. Added for SOS:
-- reading keep_members.lat/lng at render time answers "where are they
-- NOW", so a week-old SOS in the activity log would show today's
-- position — wrong in the one place being wrong matters most. Nullable
-- and never backfilled; absence is normal, not an error.
ALTER TABLE checkins
  ADD COLUMN IF NOT EXISTS lat double precision,
  ADD COLUMN IF NOT EXISTS lng double precision;

-- v16. checkins.inserted_at: when the SERVER received the row, set by
-- _roamkeep_checkin_normalise. Devices page their notifications by it,
-- because created_at is whatever time the writing device reported.
--
-- Order matters. First pull any FUTURE-dated created_at back to now: a
-- device pages its notifications by the newest timestamp it has seen, so
-- one row dated tomorrow (a phone with its clock set ahead, or a member
-- writing to the API directly) pinned every device's watermark there and
-- silenced every notification in the keep, SOS included, until then. The
-- insert trigger below stops new ones; this repairs any already stored.
-- Then backfill inserted_at for historical rows from their (now sane)
-- created_at, and only then make the column NOT NULL.
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS inserted_at timestamptz;
UPDATE checkins SET created_at = now()
 WHERE created_at > now() + interval '5 minutes';
UPDATE checkins SET inserted_at = LEAST(coalesce(created_at, now()), now())
 WHERE inserted_at IS NULL;
ALTER TABLE checkins
  ALTER COLUMN inserted_at SET DEFAULT now(),
  ALTER COLUMN inserted_at SET NOT NULL;

ALTER TABLE keep_members
  ADD COLUMN IF NOT EXISTS notify_on_checkin boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_place_id uuid
    REFERENCES keep_places(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS member_type  text NOT NULL DEFAULT 'adult',
  ADD COLUMN IF NOT EXISTS role         text NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS paused_until timestamptz;

ALTER TABLE keeps
  ADD COLUMN IF NOT EXISTS code_expires_at timestamptz;

ALTER TABLE location_history
  ADD COLUMN IF NOT EXISTS speed double precision,
  ADD COLUMN IF NOT EXISTS accuracy double precision;

-- ── v17: ACCOUNTS — approval, sign-up control, password reset, deletion ──
--
-- Everything here is EXPAND-only: a v16 family behaves exactly as before
-- until an owner on a 4.11.0 app turns something on. One deliberate
-- tightening: create_keep refuses a second family on a server that already
-- has one (family_exists, see create_keep). No app's normal path makes a
-- second Keep, so the only callers it stops are the ones it is meant to.

-- Owner approval of new members. NOT the existing `status` column, which is
-- display text ("📍 Location sharing on"). DEFAULT true, so every existing
-- member is approved by the act of adding the column, and a join is pending
-- only when its keep has require_approval on.
ALTER TABLE keep_members
  ADD COLUMN IF NOT EXISTS approved boolean NOT NULL DEFAULT true;

-- Off by default, and create_keep leaves it off: an owner still on an app
-- older than 4.11.0 has no approval screen, so a keep created from one must
-- never strand its joiners as pending. A 4.11.0 app turns it on.
ALTER TABLE keeps
  ADD COLUMN IF NOT EXISTS require_approval boolean NOT NULL DEFAULT false;

-- A child's request to have their account deleted. Children cannot leave a
-- Keep or delete their own account; they ask (request_account_deletion) and
-- an owner deletes it (delete_child_account). NULL: no request. Moves only
-- through request_account_deletion (the member guard refuses anything else).
ALTER TABLE keep_members
  ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;

-- Sign-up control, read by the BEFORE INSERT trigger on auth.users below.
-- Project-level, because sign-up is: a project has one auth server. Closed
-- with no window = nobody new; closed with a future window = open until
-- then; not closed = open (the default, so nothing changes until an owner
-- acts). roamkeep_meta is anon-readable, so whether sign-ups are open is
-- visible to anyone holding the anon key — who could equally just try.
ALTER TABLE roamkeep_meta
  ADD COLUMN IF NOT EXISTS signups_closed     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS signups_open_until timestamptz;

-- Account deletion needs this. created_by was NOT NULL with ON DELETE SET
-- NULL — a contradiction that made deleting ANY user who had ever created a
-- place fail, from the app or the Supabase dashboard alike. Places belong to
-- the family, not to whoever added them, so they outlive their creator.
ALTER TABLE keep_places ALTER COLUMN created_by DROP NOT NULL;

-- Owner-issued password reset codes. Families have no email: Supabase's
-- built-in mail reaches only the project's own team members, two messages
-- an hour, so an emailed reset link cannot work without every owner setting
-- up SMTP. Instead an owner issues a one-time code and the member redeems it
-- in the app (issue_password_reset / redeem_password_reset below).
--
-- One row per account, replaced on each issue. Kept after redemption, with
-- the hash cleared, so the member can see that a reset happened and who
-- issued it — an owner able to reset someone's password silently would be a
-- quiet way into their account.
CREATE TABLE IF NOT EXISTS password_reset_codes (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  keep_id     uuid NOT NULL REFERENCES keeps(id) ON DELETE CASCADE,
  code_hash   text,                  -- sha256 hex of the normalised code; NULL once used
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  issued_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz
);


-- ── INDEXES ───────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_keep_places_keep_id ON keep_places(keep_id);

-- The push fan-out hot path. Lives on keep_member_push since v14; the old
-- idx_keep_members_keep_token went with the column it indexed.
CREATE INDEX IF NOT EXISTS idx_member_push_keep
  ON keep_member_push(keep_id) WHERE fcm_token IS NOT NULL;

-- "This member's points, newest first, within a time window" — the
-- query the breadcrumb trail runs.
CREATE INDEX IF NOT EXISTS idx_lochist_member_time
  ON location_history(keep_id, member_id, recorded_at DESC);

-- Timeline hot path: "this member's check-ins for one day, in order".
CREATE INDEX IF NOT EXISTS idx_checkins_member_time
  ON checkins(keep_id, member_id, created_at DESC);

-- v8: "this user's join attempts in the last hour" — the rate limiter.
CREATE INDEX IF NOT EXISTS idx_join_attempts_user_time
  ON keep_join_attempts(user_id, attempted_at DESC);

-- v13: "which place was this check-in for" — the per-place mute join.
CREATE INDEX IF NOT EXISTS idx_checkins_place
  ON checkins(place_id) WHERE place_id IS NOT NULL;

-- v13: the fan-out hot path — "does anyone mute this subject here?"
CREATE INDEX IF NOT EXISTS idx_notify_prefs_fanout
  ON keep_notify_prefs(keep_id, subject_member_id, place_id);

-- v16: a woken device asks "this keep's check-ins received since X".
CREATE INDEX IF NOT EXISTS idx_checkins_keep_inserted
  ON checkins(keep_id, inserted_at DESC);

-- v16: the activity feed ("this keep's newest check-ins") and the 7-day
-- retention sweep. idx_checkins_member_time leads with member_id after
-- keep_id, so it cannot serve a keep-wide ordering.
CREATE INDEX IF NOT EXISTS idx_checkins_keep_created
  ON checkins(keep_id, created_at DESC);

-- v16: private_user_keep_ids() — inside almost every RLS check — looks
-- memberships up by user_id, and the only index leads with keep_id.
CREATE INDEX IF NOT EXISTS idx_keep_members_user
  ON keep_members(user_id);


-- ── REPLICA IDENTITY ──────────────────────────────────────
-- Postgres default replica identity ships only the PK in DELETE WAL
-- records, so keep_id arrives NULL and the client's keep_id filter
-- rejects the realtime DELETE. FULL includes every column.

ALTER TABLE keep_places REPLICA IDENTITY FULL;


-- ── CHECK CONSTRAINTS ─────────────────────────────────────
-- Input-size limits; defence against a member stuffing giant values.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'keeps_name_len') THEN
    ALTER TABLE keeps ADD CONSTRAINT keeps_name_len CHECK (length(name) BETWEEN 1 AND 40);
  END IF;
  -- v8 widened this from exactly 6 to 6–16 chars: new codes are 12
  -- (31-symbol alphabet), and both lengths must validate during the
  -- grace window. Drop any prior definition so re-running converges.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'keeps_code_fmt') THEN
    ALTER TABLE keeps DROP CONSTRAINT keeps_code_fmt;
  END IF;
  ALTER TABLE keeps ADD CONSTRAINT keeps_code_fmt CHECK (code ~ '^[A-Z0-9]{6,16}$');

  -- v8: member_type / role value domains.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_member_type_values') THEN
    ALTER TABLE keep_members ADD CONSTRAINT nm_member_type_values
      CHECK (member_type IN ('adult', 'child'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_role_values') THEN
    ALTER TABLE keep_members ADD CONSTRAINT nm_role_values
      CHECK (role IN ('owner', 'member'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_name_len') THEN
    ALTER TABLE keep_members ADD CONSTRAINT nm_name_len CHECK (length(name) BETWEEN 1 AND 40);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_avatar_len') THEN
    ALTER TABLE keep_members ADD CONSTRAINT nm_avatar_len CHECK (length(avatar) BETWEEN 1 AND 8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_status_len') THEN
    ALTER TABLE keep_members ADD CONSTRAINT nm_status_len CHECK (length(status) <= 80);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_battery_range') THEN
    ALTER TABLE keep_members ADD CONSTRAINT nm_battery_range CHECK (battery BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nm_latlng_range') THEN
    ALTER TABLE keep_members ADD CONSTRAINT nm_latlng_range CHECK (
      (lat IS NULL AND lng IS NULL) OR
      (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180)
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_name_len') THEN
    ALTER TABLE checkins ADD CONSTRAINT ck_name_len CHECK (length(member_name) BETWEEN 1 AND 40);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_avatar_len') THEN
    ALTER TABLE checkins ADD CONSTRAINT ck_avatar_len CHECK (length(member_avatar) BETWEEN 1 AND 8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_place_len') THEN
    ALTER TABLE checkins ADD CONSTRAINT ck_place_len CHECK (length(place) BETWEEN 1 AND 120);
  END IF;

  -- checkins.type: 'left' was added in v4 on top of v3's three values.
  -- Drop any prior definition so re-running converges on the full set.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_type_values') THEN
    ALTER TABLE checkins DROP CONSTRAINT ck_type_values;
  END IF;
  ALTER TABLE checkins ADD CONSTRAINT ck_type_values
    CHECK (type IN ('manual', 'arrived', 'sos', 'left'));

  -- keep_places constraints.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'np_name_len') THEN
    ALTER TABLE keep_places ADD CONSTRAINT np_name_len CHECK (length(name) BETWEEN 1 AND 40);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'np_icon_len') THEN
    ALTER TABLE keep_places ADD CONSTRAINT np_icon_len CHECK (length(icon) BETWEEN 1 AND 8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'np_latlng_range') THEN
    ALTER TABLE keep_places ADD CONSTRAINT np_latlng_range
      CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'np_radius_range') THEN
    ALTER TABLE keep_places ADD CONSTRAINT np_radius_range CHECK (radius_m BETWEEN 25 AND 2000);
  END IF;

  -- location_history.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lh_latlng_range') THEN
    ALTER TABLE location_history ADD CONSTRAINT lh_latlng_range
      CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lh_speed_range') THEN
    ALTER TABLE location_history ADD CONSTRAINT lh_speed_range
      CHECK (speed IS NULL OR (speed >= 0 AND speed < 150));
  END IF;
END$$;


-- ── MEMBERSHIP HELPER (avoids RLS recursion) ──────────────
-- A policy on keep_members that subqueries keep_members recurses
-- ("infinite recursion detected in policy for relation keep_members").
-- This SECURITY DEFINER function reads keep_members as its owner, so the
-- read does NOT re-enter RLS — no recursion. Scoped to auth.uid(), so it
-- leaks nothing. Every "is the caller a member of this keep" check routes
-- through it. Defined before the policies that reference it.
--
-- v17: APPROVED memberships only. A member awaiting an owner's approval is
-- in keep_members but sees and writes nothing: every keep-wide policy below
-- goes through this function, and the policies that look up the caller's
-- own row directly (checkins, location_history, keep_member_push INSERT)
-- find nothing either, because the keep_members SELECT policy is itself
-- built on this function — a pending member cannot even see their own row.
-- That is deliberate. A self-row read policy would let those INSERT
-- policies match, and a pending member could file a check-in — an SOS
-- included — into a family that has not let them in. They read their own
-- status through my_membership() instead.
--
-- CREATE OR REPLACE keeps the OID the policies reference, so they pick up
-- the change without being recreated.
--
-- v18: every function in this file ends its search_path with pg_temp. Left
-- out, pg_temp is searched FIRST for tables, so a session able to create a
-- temporary table named keep_members could feed this function its own rows
-- and read any family. The API cannot run CREATE TEMP TABLE, so this was
-- never reachable through the anon key, but the Postgres manual's rule for
-- SECURITY DEFINER is pg_temp last, and it costs nothing.
CREATE OR REPLACE FUNCTION private_user_keep_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$ SELECT keep_id FROM keep_members WHERE user_id = auth.uid() AND approved $$;
REVOKE ALL ON FUNCTION private_user_keep_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private_user_keep_ids() TO authenticated;


-- ── ROW LEVEL SECURITY ────────────────────────────────────

ALTER TABLE keeps              ENABLE ROW LEVEL SECURITY;
ALTER TABLE keep_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkins           ENABLE ROW LEVEL SECURITY;
ALTER TABLE keep_places        ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_history   ENABLE ROW LEVEL SECURITY;
-- No policies on keep_join_attempts → default deny for clients; only the
-- DEFINER join RPC (running as owner) reads/writes it.
ALTER TABLE keep_join_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE roamkeep_meta      ENABLE ROW LEVEL SECURITY;
ALTER TABLE keep_notify_prefs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE keep_member_push   ENABLE ROW LEVEL SECURITY;
-- No policies on roamkeep_secrets either → default deny. Same reasoning as
-- keep_join_attempts: only the DEFINER trigger functions and the Edge
-- Functions' service-role key ever read it.
ALTER TABLE roamkeep_secrets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_codes ENABLE ROW LEVEL SECURITY;

-- PASSWORD_RESET_CODES (v17) — a member may read the row about their OWN
-- account, and nothing else: that is how the app tells them a reset was
-- issued, by whom and when. All writes go through the DEFINER functions.
-- The row's code_hash is visible to them too; it is their own code.
DROP POLICY IF EXISTS "Users read own reset notice" ON password_reset_codes;
CREATE POLICY "Users read own reset notice"
  ON password_reset_codes FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ...but not its code_hash (v17 self-review R3). RLS picks rows, never
-- columns, and Supabase's default privileges grant every client role the
-- whole table, so the hash of a live code was readable by its member, or by
-- anyone holding one of their sessions, such as a lost phone. Nothing reads
-- it: the app asks for issued_by, issued_at, expires_at and redeemed_at.
-- Writes go through the DEFINER functions, so clients need no write grant.
REVOKE ALL ON password_reset_codes FROM anon, authenticated;
GRANT SELECT (user_id, keep_id, issued_by, issued_at, expires_at, attempts, redeemed_at)
  ON password_reset_codes TO authenticated;

-- KEEP_MEMBER_PUSH — own row only, and deliberately no keep-wide SELECT.
-- That asymmetry with every other table in this file IS the fix: a push
-- token is not something the rest of the family has any business reading.
--
-- v16 binds (member_id, keep_id) as a PAIR to one of the caller's own
-- memberships. Checking member_id alone let a row carry any keep_id, and
-- keep_push_recipients() selects by keep_id — so a member who knew another
-- keep's uuid could point their token at it and be woken whenever that
-- family's places changed. The same pairing is applied to the checkins and
-- location_history INSERT policies below.
DROP POLICY IF EXISTS "Members manage own push row" ON keep_member_push;
CREATE POLICY "Members manage own push row"
  ON keep_member_push FOR ALL TO authenticated
  USING      ((member_id, keep_id) IN (SELECT id, keep_id FROM keep_members WHERE user_id = auth.uid()))
  WITH CHECK ((member_id, keep_id) IN (SELECT id, keep_id FROM keep_members WHERE user_id = auth.uid()));

-- Heal any row already pointed at the wrong keep, so its owner can still
-- update it under the pairing above. Runs as the schema owner.
UPDATE keep_member_push p
   SET keep_id = m.keep_id, updated_at = now()
  FROM keep_members m
 WHERE m.id = p.member_id AND p.keep_id IS DISTINCT FROM m.keep_id;

-- KEEP_NOTIFY_PREFS — scoped to OWN rows, unlike the keep-wide read
-- policies everywhere else in this file. Who you have quietly stopped
-- hearing about is nobody else's business, including other members of
-- your own Keep.
--
-- v18: (member_id, keep_id) as a PAIR, like the three tables above and
-- below. Checked separately, someone in two Keeps (possible only on a server
-- from before v16) could file a row with one Keep's member id and the
-- other's keep_id.
DROP POLICY IF EXISTS "Members read own notify prefs" ON keep_notify_prefs;
CREATE POLICY "Members read own notify prefs"
  ON keep_notify_prefs FOR SELECT TO authenticated
  USING (
    keep_id IN (SELECT private_user_keep_ids())
    AND (member_id, keep_id) IN (SELECT id, keep_id FROM keep_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Members write own notify prefs" ON keep_notify_prefs;
CREATE POLICY "Members write own notify prefs"
  ON keep_notify_prefs FOR INSERT TO authenticated
  WITH CHECK (
    keep_id IN (SELECT private_user_keep_ids())
    AND (member_id, keep_id) IN (SELECT id, keep_id FROM keep_members WHERE user_id = auth.uid())
    -- Subject and place must belong to the SAME keep, or a member could
    -- write a row referencing another family's ids.
    AND subject_member_id IN (SELECT id FROM keep_members WHERE keep_id = keep_notify_prefs.keep_id)
    AND place_id IN (SELECT id FROM keep_places WHERE keep_id = keep_notify_prefs.keep_id)
  );

DROP POLICY IF EXISTS "Members delete own notify prefs" ON keep_notify_prefs;
CREATE POLICY "Members delete own notify prefs"
  ON keep_notify_prefs FOR DELETE TO authenticated
  USING (
    keep_id IN (SELECT private_user_keep_ids())
    AND (member_id, keep_id) IN (SELECT id, keep_id FROM keep_members WHERE user_id = auth.uid())
  );

-- ROAMKEEP_META — readable by everyone including anon, because the
-- version check runs at connect time, BEFORE sign-in, and so cannot
-- require a session. Nothing sensitive lives here: it is the schema's own
-- version number. No write policy for anyone — the row is written by the
-- provisioning wizard (service role) or by set_project_url() below.
DROP POLICY IF EXISTS "Anyone can read schema metadata" ON roamkeep_meta;
CREATE POLICY "Anyone can read schema metadata"
  ON roamkeep_meta FOR SELECT TO anon, authenticated
  USING (true);

-- KEEPS — members-only read (prevents keep-code enumeration). Creation
-- goes exclusively through create_keep (SECURITY DEFINER). v8 DROPPED the
-- direct-INSERT policy: a client never needs it, and it let a caller
-- write a keep row bypassing the RPC.
DROP POLICY IF EXISTS "Authenticated users can read keeps" ON keeps;
DROP POLICY IF EXISTS "Members can read their keep" ON keeps;
CREATE POLICY "Members can read their keep"
  ON keeps FOR SELECT TO authenticated
  USING (id IN (SELECT private_user_keep_ids()));

DROP POLICY IF EXISTS "Authenticated users can create keeps" ON keeps;

-- KEEP_MEMBERS. v8 DROPPED the direct-INSERT policy too: joins go only
-- through join_keep_by_code (SECURITY DEFINER), which enforces the code,
-- the rate limit, and a fixed 'member' role. A direct INSERT would skip
-- all three (and let the caller self-assign 'owner').
DROP POLICY IF EXISTS "Members can read their keep" ON keep_members;
CREATE POLICY "Members can read their keep"
  ON keep_members FOR SELECT TO authenticated
  USING (keep_id IN (SELECT private_user_keep_ids()));

DROP POLICY IF EXISTS "Users can join a keep as themselves" ON keep_members;

-- Own-row UPDATE stays, but a BEFORE UPDATE trigger (below) forbids
-- changing role/member_type/paused_until unless the change comes through a
-- DEFINER RPC, and forbids changing keep_id/user_id at all. So a member can
-- still move their own lat/lng/battery/status/notify/online, but not
-- privilege, pause, or which family they are in.
--
-- The WITH CHECK below pins user_id and cannot do more: a policy's WITH
-- CHECK only ever sees the NEW row, so it has no way to say "keep_id must
-- equal what it was". That is why the guard is a trigger.
--
-- v17 (self-review R2): and only in a keep that has approved them. A
-- pending member cannot see their own row, but an UPDATE with no WHERE
-- needs no SELECT policy, so an unfiltered PATCH still reached it.
DROP POLICY IF EXISTS "Users can update own member row" ON keep_members;
CREATE POLICY "Users can update own member row"
  ON keep_members FOR UPDATE TO authenticated
  USING      (user_id = auth.uid() AND keep_id IN (SELECT private_user_keep_ids()))
  WITH CHECK (user_id = auth.uid() AND keep_id IN (SELECT private_user_keep_ids()));

-- No DELETE policy on keep_members. v8 allowed adults to delete their own
-- row; v14 dropped that, because the rule it has to express — "unless you
-- are the last owner" — is not something a policy can say, and a bare
-- DELETE grant is a capability the client never otherwise needs. Leaving
-- goes through leave_keep() and kicking through remove_member(), both
-- SECURITY DEFINER. Same move v8 made for the INSERT policies.
DROP POLICY IF EXISTS "Users can delete own member row" ON keep_members;
DROP POLICY IF EXISTS "Adults can delete own member row" ON keep_members;

-- CHECKINS
DROP POLICY IF EXISTS "Keep members can read checkins" ON checkins;
CREATE POLICY "Keep members can read checkins"
  ON checkins FOR SELECT TO authenticated
  USING (keep_id IN (SELECT private_user_keep_ids()));

-- v14 binds member_id to the caller. Without it any member could file a
-- check-in as somebody else — including type='sos', which is exempt from
-- every mute and wakes every phone in the family. Mirrors what the
-- location_history INSERT policy below has always done; both writers
-- (app.js, GeofenceReceiver.java) already send only their own member_id.
--
-- v16: member_id and keep_id must be ONE membership of the caller's, not
-- merely each belong to them — see the note on keep_member_push above.
DROP POLICY IF EXISTS "Keep members can insert checkins" ON checkins;
CREATE POLICY "Keep members can insert checkins"
  ON checkins FOR INSERT TO authenticated
  WITH CHECK (
    (member_id, keep_id) IN (SELECT id, keep_id FROM keep_members WHERE user_id = auth.uid())
  );

-- KEEP_PLACES
DROP POLICY IF EXISTS "Members can read places" ON keep_places;
CREATE POLICY "Members can read places"
  ON keep_places FOR SELECT TO authenticated
  USING (keep_id IN (SELECT private_user_keep_ids()));

DROP POLICY IF EXISTS "Members can insert places" ON keep_places;
CREATE POLICY "Members can insert places"
  ON keep_places FOR INSERT TO authenticated
  WITH CHECK (
    keep_id IN (SELECT private_user_keep_ids())
    AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS "Members can update places" ON keep_places;
CREATE POLICY "Members can update places"
  ON keep_places FOR UPDATE TO authenticated
  USING (keep_id IN (SELECT private_user_keep_ids()));

DROP POLICY IF EXISTS "Members can delete places" ON keep_places;
CREATE POLICY "Members can delete places"
  ON keep_places FOR DELETE TO authenticated
  USING (keep_id IN (SELECT private_user_keep_ids()));

-- LOCATION_HISTORY — read across the keep, write/delete only your own.
DROP POLICY IF EXISTS "Members can read history" ON location_history;
CREATE POLICY "Members can read history"
  ON location_history FOR SELECT TO authenticated
  USING (keep_id IN (SELECT private_user_keep_ids()));

-- v16: pair-bound, as for checkins.
DROP POLICY IF EXISTS "Members can insert own history" ON location_history;
CREATE POLICY "Members can insert own history"
  ON location_history FOR INSERT TO authenticated
  WITH CHECK (
    (member_id, keep_id) IN (SELECT id, keep_id FROM keep_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Members can delete own history" ON location_history;
CREATE POLICY "Members can delete own history"
  ON location_history FOR DELETE TO authenticated
  USING (member_id IN (SELECT id FROM keep_members WHERE user_id = auth.uid()));

-- v18: the table privileges RLS does not govern. Supabase's default
-- privileges grant every client role ALL on a new table, and RLS filters
-- rows for SELECT, INSERT, UPDATE and DELETE only. TRUNCATE ignores it
-- entirely: a role holding it empties a table whatever the policies say.
-- PostgREST never issues one, so the anon key could not, but nothing a
-- client does needs TRUNCATE, REFERENCES or TRIGGER on any of these.
-- Re-run on every apply, so a table added later is covered too.
REVOKE TRUNCATE, REFERENCES, TRIGGER
  ON keeps, keep_members, checkins, keep_places, location_history, keep_join_attempts,
     roamkeep_meta, keep_notify_prefs, keep_member_push, roamkeep_secrets, password_reset_codes
  FROM anon, authenticated;
-- Nothing on the client side touches these two at all: only the DEFINER
-- functions (as the table owner) and the Edge Functions (service role) do.
REVOKE ALL ON keep_join_attempts, roamkeep_secrets FROM anon, authenticated;


-- ── CODE GENERATOR ────────────────────────────────────────
-- 12 chars from a 31-symbol unambiguous alphabet (no 0/O/1/I/L) via
-- pgcrypto ≈ 2^59 keyspace (replaces the old 6 md5-hex chars). The
-- modulo bias (256 = 8·31 + 8) is immaterial for a family invite code.
-- Internal helper — not granted to clients; the DEFINER RPCs call it.
CREATE OR REPLACE FUNCTION _roamkeep_gen_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- 31 symbols
  v_bytes bytea := gen_random_bytes(12);
  v_code  text := '';
  i int;
BEGIN
  FOR i IN 0..11 LOOP
    v_code := v_code || substr(alphabet, (get_byte(v_bytes, i) % 31) + 1, 1);
  END LOOP;
  RETURN v_code;
END;
$$;
REVOKE ALL ON FUNCTION _roamkeep_gen_code() FROM PUBLIC, anon, authenticated;


-- ── PROTECTED-COLUMN GUARD ────────────────────────────────
-- RLS can't restrict columns, and own-row UPDATE would otherwise let a
-- member rewrite role / member_type / paused_until (self-promote, escape
-- a pause, etc). This BEFORE UPDATE trigger blocks changes to those three
-- unless a transaction-local flag is set — and only the DEFINER RPCs set
-- it (a direct PostgREST call can't), so those columns move only through
-- the authorized RPCs.
CREATE OR REPLACE FUNCTION _roamkeep_guard_member_cols()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (NEW.role         IS DISTINCT FROM OLD.role
      OR NEW.member_type  IS DISTINCT FROM OLD.member_type
      OR NEW.paused_until IS DISTINCT FROM OLD.paused_until
      -- v14: keep_id and user_id too. Without them a member could call
      -- create_keep (which seats them as role='owner') and then move that
      -- owner row into any keep whose uuid they knew — skipping the invite
      -- code, the expiry, the rate limiter and remove_member in one PATCH.
      -- The own-row UPDATE policy cannot stop it: its WITH CHECK only ever
      -- sees the NEW row, so it can pin user_id to auth.uid() but cannot
      -- say "keep_id must equal what it was".
      OR NEW.keep_id      IS DISTINCT FROM OLD.keep_id
      OR NEW.user_id      IS DISTINCT FROM OLD.user_id
      -- v17: approval moves only through approve_member(). Without this a
      -- pending member could PATCH themselves in — if they could see their
      -- own row, which they cannot; the guard holds regardless.
      OR NEW.approved     IS DISTINCT FROM OLD.approved
      -- v18: the row's identity. Nothing changes either legitimately. The
      -- id is what every other row points at, and created_at decides which
      -- membership my_membership, delete_my_account and
      -- request_account_deletion act on for an account in two Keeps (only
      -- possible on a server from before v16), so neither is the member's
      -- to move.
      OR NEW.id           IS DISTINCT FROM OLD.id
      OR NEW.created_at   IS DISTINCT FROM OLD.created_at
      -- v17: a child's deletion request moves only through
      -- request_account_deletion(), which wakes the owners. A direct PATCH
      -- would skip the "children only" rule.
      OR NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at)
     AND coalesce(current_setting('roamkeep.priv', true), '') <> 'on' THEN
    RAISE EXCEPTION 'protected_column';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_member_cols ON keep_members;
CREATE TRIGGER trg_guard_member_cols
  BEFORE UPDATE ON keep_members
  FOR EACH ROW EXECUTE FUNCTION _roamkeep_guard_member_cols();
-- Trigger functions need no EXECUTE grant to fire; this only takes them off
-- the API (v17 self-review R5).
REVOKE ALL ON FUNCTION _roamkeep_guard_member_cols() FROM PUBLIC, anon, authenticated;

-- v14: the same problem on keep_places. created_by exists for attribution
-- and keep_id decides which family a place belongs to; an edit should move
-- neither. Any member may still edit any place in their keep — name, icon,
-- radius, position — which is the family model and is unchanged.
--
-- Raises rather than silently restoring, matching the member guard. Safe
-- because updatePlace() in app.js sends a narrow patch and never includes
-- either column. No roamkeep.priv escape hatch: unlike the member columns,
-- no DEFINER RPC has any business moving these.
--
-- v17: with ONE exception — created_by may become NULL when its user no
-- longer exists. That is the ON DELETE SET NULL action firing when an
-- account is deleted, and referential actions run as UPDATEs, so they come
-- through this trigger; refusing them made account deletion impossible.
-- SECURITY DEFINER so the existence check can read auth.users. A member
-- PATCHing created_by to NULL is still refused: their target still exists.
CREATE OR REPLACE FUNCTION _roamkeep_guard_place_cols()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.keep_id IS DISTINCT FROM OLD.keep_id THEN
    RAISE EXCEPTION 'protected_column';
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by
     AND NOT (NEW.created_by IS NULL
              AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.created_by)) THEN
    RAISE EXCEPTION 'protected_column';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION _roamkeep_guard_place_cols() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_place_cols ON keep_places;
CREATE TRIGGER trg_guard_place_cols
  BEFORE UPDATE ON keep_places
  FOR EACH ROW EXECUTE FUNCTION _roamkeep_guard_place_cols();

-- v16: a check-in is written by the member's own device, and until now the
-- database believed whatever it said. Four fields are now the server's to
-- decide, whatever the client sent:
--
--   inserted_at   — receipt time, forced to now(). Devices page their push
--                   notifications by it. They used to page by created_at,
--                   so a check-in that arrived late (a crossing queued
--                   through a Wi-Fi→cellular handoff) was skipped by any
--                   phone that had already moved past its timestamp.
--   created_at    — the event time, kept, but never more than 5 minutes in
--                   the future. One row dated tomorrow pinned every
--                   device's watermark to tomorrow and silenced every alert
--                   in the keep, SOS included.
--   member_name / — taken from the member's row. RLS binds member_id to the
--   member_avatar   caller but these were free text, so a member could file
--                   "🆘 Mum sent an SOS" as themselves.
--   place_id      — cleared if it names a place in another keep.
--
-- BEFORE INSERT, so the AFTER INSERT webhook and RLS's WITH CHECK both see
-- the corrected row. Not SECURITY DEFINER: the caller can already read its
-- own member row and its own keep's places, which is all this needs.
CREATE OR REPLACE FUNCTION _roamkeep_checkin_normalise()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name   text;
  v_avatar text;
BEGIN
  NEW.inserted_at := now();
  NEW.created_at  := LEAST(coalesce(NEW.created_at, now()), now() + interval '5 minutes');

  SELECT m.name, m.avatar INTO v_name, v_avatar
    FROM keep_members m WHERE m.id = NEW.member_id;
  IF FOUND THEN
    NEW.member_name   := v_name;
    NEW.member_avatar := v_avatar;
  END IF;

  IF NEW.place_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM keep_places pl
        WHERE pl.id = NEW.place_id AND pl.keep_id = NEW.keep_id) THEN
    NEW.place_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkin_normalise ON checkins;
CREATE TRIGGER trg_checkin_normalise
  BEFORE INSERT ON checkins
  FOR EACH ROW EXECUTE FUNCTION _roamkeep_checkin_normalise();
REVOKE ALL ON FUNCTION _roamkeep_checkin_normalise() FROM PUBLIC, anon, authenticated;

-- v16: at most 90 places per keep. Play Services allows an app 100
-- geofences and addGeofences is all-or-nothing, so place 101 — which any
-- member could add — disarmed EVERY place on EVERY device at the next
-- re-arm, with nothing but a journal line to say so. 90 leaves headroom.
CREATE OR REPLACE FUNCTION _roamkeep_place_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (SELECT count(*) FROM keep_places WHERE keep_id = NEW.keep_id) >= 90 THEN
    RAISE EXCEPTION 'too_many_places';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_place_cap ON keep_places;
CREATE TRIGGER trg_place_cap
  BEFORE INSERT ON keep_places
  FOR EACH ROW EXECUTE FUNCTION _roamkeep_place_cap();
REVOKE ALL ON FUNCTION _roamkeep_place_cap() FROM PUBLIC, anon, authenticated;


-- ── SECURITY DEFINER RPCs ─────────────────────────────────
-- create/join are atomic — they bypass row visibility during the race
-- between inserting the keep and checking membership. v8 adds role/type
-- management, the time-boxed pause, code rotation, and the owner kick.

-- v12: the compatibility check. Returns the version NUMBER so the client
-- decides what to do with it — see the roamkeep_meta comment above.
CREATE OR REPLACE FUNCTION roamkeep_schema_version()
RETURNS TABLE (schema_version integer, min_app_build integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT m.schema_version, m.min_app_build FROM roamkeep_meta m
$$;

-- Deliberately anon-callable, unlike every other function in this file:
-- the check runs before sign-in. Stated explicitly so it reads as a
-- decision rather than as something the v10 advisor cleanup missed.
REVOKE ALL ON FUNCTION public.roamkeep_schema_version() FROM public;
GRANT EXECUTE ON FUNCTION public.roamkeep_schema_version() TO anon, authenticated;

-- v12: let the owner's app tell the database its own URL, so a family who
-- upgraded by pasting this file into the SQL editor still gets working
-- webhooks without a manual step.
--
-- Two constraints, both load-bearing:
--   * Owner only, checked against keep_members.role rather than trusted
--     from the caller.
--   * The value must look like a Supabase project URL. The database POSTs
--     to whatever is stored here, so an unconstrained client-writable
--     endpoint would be an SSRF hole. The regex lives HERE, in the
--     client-callable path, and deliberately NOT as a CHECK on the column
--     — a self-hoster on a custom domain must still be able to set one by
--     direct SQL from the dashboard.
--
-- Write-once: it never overwrites a value already present, so the
-- wizard's value always wins over a client's.
--
-- v16: the value must be THIS project's own URL, not merely a
-- supabase.co-shaped one. Before, any owner of ANY keep could set it — and
-- create_keep makes anyone an owner, so a stranger holding a shared setup
-- link could sign up, create an empty keep and point project_url at their
-- own project while it was still NULL (a paste-upgraded family, before the
-- owner's next app open). Both webhook triggers would then have POSTed
-- every check-in, SOS coordinates included, every place row and the
-- webhook secret to them; and write-once meant the real owner's app could
-- never put it back.
--
-- The caller's JWT settles it. A token this database accepts was signed by
-- this project's own auth server, whose issuer IS the project URL
-- (https://<ref>.supabase.co/auth/v1), so a caller can only ever store the
-- truth. Where the issuer has some other shape (self-hosted), fall back to
-- requiring an owner of the OLDEST keep — the founding family's, which a
-- latecomer's keep can never be.
CREATE OR REPLACE FUNCTION set_project_url(p_url text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_owner boolean;
  v_iss text := coalesce(auth.jwt() ->> 'iss', '');
BEGIN
  IF p_url IS NULL OR p_url !~ '^https://[a-z0-9]+\.supabase\.co$' THEN
    RETURN false;
  END IF;

  IF v_iss ~ '^https://[a-z0-9]+\.supabase\.co/auth/v1$' THEN
    IF p_url <> regexp_replace(v_iss, '/auth/v1$', '') THEN
      RETURN false;
    END IF;
    -- v18: an APPROVED owner, here and in every owner check below. Approval
    -- arrived in v17 but only the functions written for it asked; the older
    -- ones took role = 'owner' alone, so a pending member an owner had
    -- promoted could administer the family before being let in.
    SELECT EXISTS (
      SELECT 1 FROM keep_members
      WHERE user_id = auth.uid() AND role = 'owner' AND approved
    ) INTO v_is_owner;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM keep_members m
      WHERE m.user_id = auth.uid() AND m.role = 'owner' AND m.approved
        AND m.keep_id = (SELECT k.id FROM keeps k ORDER BY k.created_at, k.id LIMIT 1)
    ) INTO v_is_owner;
  END IF;

  IF NOT v_is_owner THEN
    RETURN false;
  END IF;

  UPDATE roamkeep_meta
     SET project_url = p_url, updated_at = now()
   WHERE project_url IS NULL;

  RETURN FOUND;
END$$;

REVOKE ALL ON FUNCTION public.set_project_url(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_project_url(text) TO authenticated;


-- ── v13: THE MUTE RULE, STATED ONCE, READ TWO WAYS ────────
--
-- The two consumers ask opposite questions about the same rule:
--   * The Edge Function: "given this check-in, who should be woken?"
--     — one row in, many members out.
--   * A device: "given me, which recent check-ins should I raise?"
--     — one member in, many rows out.
--
-- Both are written out below so neither can drift from the other. SOS
-- ignores every mute, and a check-in with no place_id (manual, or written
-- before v13) is never muted either.

CREATE OR REPLACE FUNCTION checkin_recipients(p_checkin uuid)
RETURNS TABLE (member_id uuid, fcm_token text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT m.id, p.fcm_token
  FROM checkins c
  JOIN keep_members m     ON m.keep_id = c.keep_id
  JOIN keep_member_push p ON p.member_id = m.id   -- v14: token lives here now
  WHERE c.id = p_checkin
    AND m.id <> c.member_id
    AND m.approved                                  -- v17: never wake a pending member
    AND p.fcm_token IS NOT NULL
    AND (
      c.type = 'sos'
      OR (
        m.notify_on_checkin
        AND (
          c.place_id IS NULL
          -- `k`, not `p`: since v14 the outer query binds `p` to
          -- keep_member_push, and an inner `p` here would shadow it. Legal,
          -- but it would read as if the two were the same table.
          OR NOT EXISTS (
            SELECT 1 FROM keep_notify_prefs k
            WHERE k.member_id = m.id
              AND k.subject_member_id = c.member_id
              AND k.place_id = c.place_id
          )
        )
      )
    )
$$;

REVOKE ALL ON FUNCTION public.checkin_recipients(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_recipients(uuid) TO service_role;

-- The other direction of the same question, for place sync (v14). Everyone
-- in the keep with a token, including whoever made the change, and ignoring
-- notify_on_checkin — this is a data sync, not a notification, and muting
-- alerts must not leave a phone holding stale geofences.
--
-- Exists because notify-places used to SELECT keep_members.fcm_token
-- directly, which stopped being possible when the column moved.
CREATE OR REPLACE FUNCTION keep_push_recipients(p_keep uuid)
RETURNS TABLE (member_id uuid, fcm_token text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT p.member_id, p.fcm_token
    FROM keep_member_push p
    JOIN keep_members m ON m.id = p.member_id AND m.approved   -- v17
   WHERE p.keep_id = p_keep
     AND p.fcm_token IS NOT NULL
$$;

REVOKE ALL ON FUNCTION public.keep_push_recipients(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.keep_push_recipients(uuid) TO service_role;

-- v17: the owners of a keep, for "<name> wants to join". notify-places
-- routes a keep_members payload here rather than to keep_push_recipients —
-- a join request is the owners' business, not the whole family's.
CREATE OR REPLACE FUNCTION keep_owner_push_recipients(p_keep uuid)
RETURNS TABLE (member_id uuid, fcm_token text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT p.member_id, p.fcm_token
    FROM keep_member_push p
    JOIN keep_members m ON m.id = p.member_id
   WHERE m.keep_id = p_keep
     AND m.role = 'owner'
     AND m.approved
     AND p.fcm_token IS NOT NULL
$$;

REVOKE ALL ON FUNCTION public.keep_owner_push_recipients(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.keep_owner_push_recipients(uuid) TO service_role;

-- v17 (self-review R1): the phones of the account a reset code was made for
-- or used on. An owner can reset any member who is not an owner, adults
-- included; the member hears about it at once, not at their next launch.
CREATE OR REPLACE FUNCTION reset_notice_recipients(p_user uuid)
RETURNS TABLE (member_id uuid, fcm_token text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT p.member_id, p.fcm_token
    FROM keep_member_push p
    JOIN keep_members m ON m.id = p.member_id
   WHERE m.user_id = p_user
     AND m.approved
     AND p.fcm_token IS NOT NULL
$$;

REVOKE ALL ON FUNCTION public.reset_notice_recipients(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_notice_recipients(uuid) TO service_role;


-- ── v14: RETIRE keep_members.fcm_token ────────────────────────
--
-- THE ONE DESTRUCTIVE STEP IN THIS FILE, and the reason the header no
-- longer claims to be non-destructive without qualification.
--
-- It has to be here rather than only in the migration, because most owners
-- upgrade by re-pasting this file. If re-pasting created keep_member_push
-- and repointed checkin_recipients() at it but left the old column in
-- place, the new table would be empty, the recipient query would return
-- nobody, and that family's push would go quiet with nothing to explain it.
--
-- Order matters and is already satisfied above: both recipient functions
-- read the new table before the old column disappears. The backfill is
-- guarded so a second run — when the column is already gone — is a no-op
-- rather than an error.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'keep_members'
       AND column_name  = 'fcm_token'
  ) THEN
    EXECUTE $body$
      INSERT INTO keep_member_push (member_id, keep_id, fcm_token)
      SELECT id, keep_id, fcm_token
        FROM keep_members
       WHERE fcm_token IS NOT NULL
      ON CONFLICT (member_id) DO UPDATE
        SET fcm_token = excluded.fcm_token,
            updated_at = now()
    $body$;
  END IF;
END$$;

DROP INDEX IF EXISTS idx_keep_members_keep_token;
ALTER TABLE keep_members DROP COLUMN IF EXISTS fcm_token;

-- The device's view of its own feed. security_invoker so the caller's JWT
-- and RLS apply — which is what lets a phone filter server-side and hold
-- NO local copy of anyone's preferences. A mute set mirrored into
-- SharedPreferences would be a fourth instance of the native-state
-- divergence bug documented in the project guide; this is the way
-- around it.
--
-- Requires PG15+ (Supabase is well past it). A self-hoster on PG14 would
-- need this as a SECURITY DEFINER function filtering on auth.uid(),
-- reachable over GET /rest/v1/rpc/ so the device's fetch path still works.
--
-- v16 appends inserted_at — the server receipt time devices page by (see
-- _roamkeep_checkin_normalise). Appended LAST, so a client selecting the
-- older column list is unaffected.
DROP VIEW IF EXISTS my_checkin_feed;
CREATE VIEW my_checkin_feed
WITH (security_invoker = true) AS
  SELECT c.id, c.keep_id, c.member_name, c.member_avatar,
         c.type, c.place, c.place_id, c.created_at, c.inserted_at
  FROM checkins c
  JOIN keep_members me
    ON me.keep_id = c.keep_id
   AND me.user_id = auth.uid()
   AND me.approved                    -- v17; RLS already hides a pending row
  WHERE c.member_id <> me.id
    AND (
      c.type = 'sos'
      OR (
        me.notify_on_checkin
        AND (
          c.place_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM keep_notify_prefs p
            WHERE p.member_id = me.id
              AND p.subject_member_id = c.member_id
              AND p.place_id = c.place_id
          )
        )
      )
    );

GRANT SELECT ON my_checkin_feed TO authenticated;


-- ── v13: WEBHOOK TRIGGERS ─────────────────────────────────
--
-- These live here, not only in the setup wizard, because most owners
-- upgrade by re-pasting THIS FILE into the SQL editor. A trigger that
-- only the wizard creates is a trigger half the deployments never get —
-- which for place sync would mean the feature silently never working.
--
-- pg_net directly rather than supabase_functions.http_request: that
-- helper's schema only exists once someone has used the dashboard's
-- Webhooks UI, so depending on it would mean depending on the manual step
-- this replaces.
--
-- Both read the project URL from roamkeep_meta and do nothing while it is
-- NULL, so a partly configured database degrades to "no push" instead of
-- erroring on every write.

CREATE EXTENSION IF NOT EXISTS pg_net;

-- keep_places → notify-places. INSERT, UPDATE and DELETE: a device needs
-- to re-arm for a new place, re-arm for a moved or renamed one, and prune
-- a deleted one. DELETE carries keep_id in old_record only because
-- keep_places is REPLICA IDENTITY FULL (above).
CREATE OR REPLACE FUNCTION public.roamkeep_notify_places()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, net, pg_temp
AS $fn$
DECLARE
  v_url text;
  v_secret text;
  v_row jsonb;
  v_old jsonb;
  -- AFTER triggers ignore the return value, but it must still be a valid
  -- record — and COALESCE(NEW, OLD) is not one, since both are plpgsql
  -- `record` and COALESCE needs a resolvable common type.
  v_ret record;
BEGIN
  IF TG_OP = 'DELETE' THEN v_ret := OLD; ELSE v_ret := NEW; END IF;

  SELECT project_url INTO v_url FROM roamkeep_meta;
  IF v_url IS NULL THEN
    RETURN v_ret;
  END IF;
  SELECT webhook_secret INTO v_secret FROM roamkeep_secrets;

  IF TG_OP = 'DELETE' THEN
    v_row := NULL;
    v_old := to_jsonb(OLD);
  ELSE
    v_row := to_jsonb(NEW);
    v_old := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
  END IF;

  PERFORM net.http_post(
    url     := v_url || '/functions/v1/notify-places',
    -- v14: the shared secret proves the payload came from this database.
    -- Both functions are deployed --no-verify-jwt (a Database Webhook has
    -- no user JWT to present), so without this anyone who knew the project
    -- ref could invoke them — and the ref is in every setup link.
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-roamkeep-webhook', coalesce(v_secret, '')
               ),
    body    := jsonb_build_object(
                 'type',       TG_OP,
                 'table',      'keep_places',
                 'schema',     'public',
                 'record',     v_row,
                 'old_record', v_old
               ),
    timeout_milliseconds := 5000
  );
  RETURN v_ret;
EXCEPTION WHEN OTHERS THEN
  -- Sync is best-effort. A webhook problem must never stop someone
  -- adding or deleting a place.
  RETURN v_ret;
END;
$fn$;

-- Trigger-only: never RPC-callable. Supabase's default privileges grant
-- EXECUTE to anon and authenticated BY NAME, so revoking PUBLIC alone
-- leaves it exposed at /rest/v1/rpc/ (advisor 0028/0029). See the v10
-- migration — this is the same trap, and it applies to every new function.
REVOKE ALL ON FUNCTION public.roamkeep_notify_places() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS on_place_notify ON public.keep_places;
CREATE TRIGGER on_place_notify
  AFTER INSERT OR UPDATE OR DELETE ON public.keep_places
  FOR EACH ROW
  EXECUTE FUNCTION public.roamkeep_notify_places();

-- v17: a join awaiting approval → notify-places, which routes a
-- keep_members payload to the keep's OWNERS only (keep_owner_push_recipients)
-- with the same content-free wake as everything else. Their device then
-- reads the pending member from its own database and writes "<name> wants
-- to join" itself. A child's request to have their account deleted uses
-- this function too (on_deletion_request, below): one wake for anything
-- that waits on an owner.
--
-- Reusing notify-places rather than adding a third function matters for
-- owners who upgrade by pasting this file and never redeploy functions: an
-- older notify-places, which does not know this table, wakes the whole keep
-- for a harmless empty sync — where a missing new function would 404.
--
-- The body carries only what routing needs. No name: the device reads it.
CREATE OR REPLACE FUNCTION public.roamkeep_notify_join()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, net, pg_temp
AS $fn$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  SELECT project_url INTO v_url FROM roamkeep_meta;
  IF v_url IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT webhook_secret INTO v_secret FROM roamkeep_secrets;
  PERFORM net.http_post(
    url     := v_url || '/functions/v1/notify-places',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-roamkeep-webhook', coalesce(v_secret, '')
               ),
    body    := jsonb_build_object(
                 'type',       'INSERT',
                 'table',      'keep_members',
                 'schema',     'public',
                 'record',     jsonb_build_object('id', NEW.id, 'keep_id', NEW.keep_id),
                 'old_record', NULL
               ),
    timeout_milliseconds := 5000
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Best-effort, like every wake. A webhook problem must never stop a join.
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.roamkeep_notify_join() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS on_join_request ON public.keep_members;
CREATE TRIGGER on_join_request
  AFTER INSERT ON public.keep_members
  FOR EACH ROW
  WHEN (NOT NEW.approved)
  EXECUTE FUNCTION public.roamkeep_notify_join();

-- v17: a child asking for their account to be deleted wakes the owners the
-- same way, with the same body (the row's id and keep_id), and their device
-- reads who asked from its own database. Only when a request is made: a
-- request taken back, or asked again while it stands, wakes nobody.
DROP TRIGGER IF EXISTS on_deletion_request ON public.keep_members;
CREATE TRIGGER on_deletion_request
  AFTER UPDATE OF deletion_requested_at ON public.keep_members
  FOR EACH ROW
  WHEN (OLD.deletion_requested_at IS NULL AND NEW.deletion_requested_at IS NOT NULL)
  EXECUTE FUNCTION public.roamkeep_notify_join();

-- v17 (self-review R1): a reset code made for an account, or used on it,
-- wakes that account's own phones at once (reset_notice_recipients), and
-- each composes "a reset code was made for your account" or "your password
-- was changed" from its own row. An owner can reset an adult's password; the
-- adult is never the last to know.
--
-- Fires on a code being made (INSERT, or a re-issue: UPDATE OF issued_at)
-- and on its use (UPDATE OF redeemed_at). A wrong guess updates only
-- attempts and code_hash, so it wakes nobody. Through notify-places, like
-- the join wake: an older copy that does not know this table wakes the
-- whole keep for a harmless sync, and the member's phone still checks.
CREATE OR REPLACE FUNCTION public.roamkeep_notify_reset()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, net, pg_temp
AS $fn$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  SELECT project_url INTO v_url FROM roamkeep_meta;
  IF v_url IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT webhook_secret INTO v_secret FROM roamkeep_secrets;
  PERFORM net.http_post(
    url     := v_url || '/functions/v1/notify-places',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-roamkeep-webhook', coalesce(v_secret, '')
               ),
    body    := jsonb_build_object(
                 'type',       TG_OP,
                 'table',      'password_reset_codes',
                 'schema',     'public',
                 'record',     jsonb_build_object('id', NEW.user_id, 'keep_id', NEW.keep_id,
                                                  'user_id', NEW.user_id),
                 'old_record', NULL
               ),
    timeout_milliseconds := 5000
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;   -- best-effort; a webhook problem must never stop a reset
END;
$fn$;

REVOKE ALL ON FUNCTION public.roamkeep_notify_reset() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS on_reset_notice ON public.password_reset_codes;
CREATE TRIGGER on_reset_notice
  AFTER INSERT OR UPDATE OF issued_at, redeemed_at ON public.password_reset_codes
  FOR EACH ROW
  EXECUTE FUNCTION public.roamkeep_notify_reset();

-- checkins → notify-checkin. Created when it does not exist, and REPLACED
-- when an existing copy does not send the webhook secret — but only once
-- project_url is set.
--
-- The guard used to be "only if it does not exist", to protect a live
-- family's copy written by the setup wizard with the project URL baked into
-- its body. Since v14 that protected copy is itself the bug: it sends no
-- x-roamkeep-webhook header, the secret-checking notify-checkin answers 403,
-- and every check-in and SOS push is rejected in silence (pg_net is async
-- and the trigger swallows errors). Before v16 the wizard also re-wrote it
-- that way on every provision and --upgrade, so a re-paste of this file —
-- the usual upgrade path — never repaired it.
--
-- The project_url condition keeps the original safety property: never swap
-- a copy that can reach its function for the roamkeep_meta-reading one
-- while that one would no-op.
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'roamkeep_notify_checkin';

  IF v_src IS NULL
     OR (v_src NOT LIKE '%x-roamkeep-webhook%'
         AND (SELECT project_url FROM roamkeep_meta) IS NOT NULL) THEN
    EXECUTE $body$
      CREATE OR REPLACE FUNCTION public.roamkeep_notify_checkin()
        RETURNS trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = public, net, pg_temp
      AS $fn$
      DECLARE
        v_url text;
        v_secret text;
      BEGIN
        SELECT project_url INTO v_url FROM roamkeep_meta;
        IF v_url IS NULL THEN RETURN NEW; END IF;
        SELECT webhook_secret INTO v_secret FROM roamkeep_secrets;
        PERFORM net.http_post(
          url     := v_url || '/functions/v1/notify-checkin',
          headers := jsonb_build_object(
                       'Content-Type', 'application/json',
                       'x-roamkeep-webhook', coalesce(v_secret, '')
                     ),
          body    := jsonb_build_object(
                       'type', 'INSERT', 'table', 'checkins', 'schema', 'public',
                       'record', to_jsonb(NEW), 'old_record', NULL),
          timeout_milliseconds := 5000
        );
        RETURN NEW;
      EXCEPTION WHEN OTHERS THEN
        RETURN NEW;
      END;
      $fn$;
    $body$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.roamkeep_notify_checkin() FROM public, anon, authenticated';
    EXECUTE 'DROP TRIGGER IF EXISTS on_checkin_notify ON public.checkins';
    EXECUTE 'CREATE TRIGGER on_checkin_notify AFTER INSERT ON public.checkins '
         || 'FOR EACH ROW EXECUTE FUNCTION public.roamkeep_notify_checkin()';
  END IF;
END$$;

-- v18: the parts of the above that are safe to apply to ANY installed copy,
-- whichever body it has, applied every time. Before, they ran only when the
-- body was replaced, so re-pasting this file to repair a project left a
-- deleted check-in trigger deleted (no check-in or SOS push at all) and a
-- loosened grant loosened. The body guard above is unchanged: a working
-- copy with its URL written in is still never swapped for one that would
-- no-op. ALTER ... SET search_path adds pg_temp without replacing the body.
DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.roamkeep_notify_checkin() FROM public, anon, authenticated';
  EXECUTE 'ALTER FUNCTION public.roamkeep_notify_checkin() SET search_path = public, net, pg_temp';
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'on_checkin_notify'
                    AND tgrelid = 'public.checkins'::regclass) THEN
    EXECUTE 'CREATE TRIGGER on_checkin_notify AFTER INSERT ON public.checkins '
         || 'FOR EACH ROW EXECUTE FUNCTION public.roamkeep_notify_checkin()';
  END IF;
END$$;

CREATE OR REPLACE FUNCTION create_keep(
  p_family_name text,
  p_display_name text,
  p_avatar text
)
RETURNS TABLE (member_id uuid, keep_id uuid, keep_code text, keep_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep keeps%ROWTYPE;
  v_member keep_members%ROWTYPE;
  v_code text;
  v_attempts int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF length(trim(p_family_name)) = 0 OR length(p_family_name) > 40 THEN
    RAISE EXCEPTION 'invalid_family_name';
  END IF;
  IF length(trim(p_display_name)) = 0 OR length(p_display_name) > 40 THEN
    RAISE EXCEPTION 'invalid_display_name';
  END IF;
  IF length(p_avatar) < 1 OR length(p_avatar) > 8 THEN
    RAISE EXCEPTION 'invalid_avatar';
  END IF;

  -- v16: one Keep per account. The app only ever offers create/join to an
  -- account with no membership, and every client resolves "my keep" by
  -- user_id — with two memberships it picked one arbitrarily per launch.
  -- A second membership was also the only way to write rows pairing one
  -- membership's member_id with another's keep_id. Leave first
  -- (leave_keep) to move to a different Keep.
  IF EXISTS (SELECT 1 FROM keep_members km WHERE km.user_id = v_uid) THEN
    RAISE EXCEPTION 'already_member';
  END IF;

  -- v17: one family per server. A family's Supabase project is theirs, and
  -- a second Keep on it is somebody using their database (and their
  -- free-plan quota) from outside the family, where no owner can see it: a
  -- member they removed, or anyone who signed up while sign-ups were open.
  -- The app shows an invited device Join only, but the API is open to any
  -- client, so the rule lives here. The lock makes "no Keep yet" and the
  -- insert below one step, so two first owners on a fresh server cannot
  -- both get through. A server that already holds more than one Keep keeps
  -- them; the oldest-keep rules (set_signups, set_project_url) still decide
  -- who speaks for it.
  PERFORM pg_advisory_xact_lock(hashtext('roamkeep.create_keep'));
  IF EXISTS (SELECT 1 FROM keeps) THEN
    RAISE EXCEPTION 'family_exists';
  END IF;

  LOOP
    v_code := _roamkeep_gen_code();
    BEGIN
      INSERT INTO keeps (code, name, created_by, code_expires_at)
      VALUES (v_code, p_family_name, v_uid, now() + interval '72 hours')
      RETURNING * INTO v_keep;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempts := v_attempts + 1;
      IF v_attempts >= 10 THEN
        RAISE EXCEPTION 'code_generation_failed';
      END IF;
    END;
  END LOOP;

  -- Creator is the founding adult + owner.
  INSERT INTO keep_members (keep_id, user_id, name, avatar, role, member_type)
  VALUES (v_keep.id, v_uid, p_display_name, p_avatar, 'owner', 'adult')
  RETURNING * INTO v_member;

  RETURN QUERY SELECT v_member.id, v_keep.id, v_keep.code, v_keep.name;
END;
$$;

REVOKE ALL ON FUNCTION create_keep(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_keep(text, text, text) TO authenticated;

-- join_keep_by_code RETURNS a `status` (not RAISE) for the invalid_code /
-- too_many_attempts cases: the attempt log must persist to count future
-- tries, but a RAISE aborts the transaction and rolls the just-inserted
-- log row back (each PostgREST call is one transaction) — so failed
-- guesses would vanish and the limiter would never trip. Returning a row
-- COMMITS the log. The client maps a non-'ok' status to the same opaque
-- copy, so the oracle stays closed AND the throttle actually works.
-- Signature changed → DROP first (CREATE OR REPLACE can't change it).
DROP FUNCTION IF EXISTS join_keep_by_code(text, text, text);
CREATE OR REPLACE FUNCTION join_keep_by_code(
  p_code text,
  p_display_name text,
  p_avatar text
)
RETURNS TABLE (status text, member_id uuid, keep_id uuid, keep_code text, keep_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep keeps%ROWTYPE;
  v_member keep_members%ROWTYPE;
  v_recent int;
  v_code text := upper(trim(coalesce(p_code, '')));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- The joiner's OWN form fields fail with distinct errors and don't burn
  -- a rate-limit attempt (checked before any log write).
  IF length(trim(p_display_name)) = 0 OR length(p_display_name) > 40 THEN
    RAISE EXCEPTION 'invalid_display_name';
  END IF;
  IF length(p_avatar) < 1 OR length(p_avatar) > 8 THEN
    RAISE EXCEPTION 'invalid_avatar';
  END IF;

  -- Log FIRST, then rate-check, so malformed/wrong codes still count.
  -- >10 in the last hour (this one included) → throttled. RETURN (don't
  -- RAISE) so the log commits.
  INSERT INTO keep_join_attempts (user_id) VALUES (v_uid);
  SELECT count(*) INTO v_recent
    FROM keep_join_attempts
   WHERE user_id = v_uid
     AND attempted_at > now() - interval '1 hour';
  IF v_recent > 10 THEN
    RETURN QUERY SELECT 'too_many_attempts'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- Collapse {bad format, not found, expired} into ONE opaque outcome.
  IF v_code !~ '^[A-Z0-9]{6,16}$' THEN
    RETURN QUERY SELECT 'invalid_code'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;
  SELECT * INTO v_keep FROM keeps WHERE code = v_code;
  IF NOT FOUND OR (v_keep.code_expires_at IS NOT NULL AND v_keep.code_expires_at < now()) THEN
    RETURN QUERY SELECT 'invalid_code'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- Already a member? Return the existing row — still 'pending' if an owner
  -- has not approved it yet (v17).
  SELECT * INTO v_member FROM keep_members
    WHERE keep_members.keep_id = v_keep.id
      AND keep_members.user_id = v_uid;
  IF FOUND THEN
    RETURN QUERY SELECT (CASE WHEN v_member.approved THEN 'ok' ELSE 'pending' END)::text,
                        v_member.id, v_keep.id, v_keep.code, v_keep.name;
    RETURN;
  END IF;

  -- v16: one Keep per account — see create_keep. A status, not a RAISE,
  -- so the attempt logged above still commits.
  IF EXISTS (SELECT 1 FROM keep_members km WHERE km.user_id = v_uid) THEN
    RETURN QUERY SELECT 'already_member'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- v17: a keep that requires approval admits the joiner as PENDING. They
  -- see and write nothing (private_user_keep_ids) until an owner approves,
  -- and the on_join_request trigger wakes the owners. The new 'pending'
  -- status is what a 4.11.0 app waits on; an older app treats any non-'ok'
  -- status as a failed join, which is safe — it finds the membership once
  -- approved, at its next launch.
  INSERT INTO keep_members (keep_id, user_id, name, avatar, role, member_type, approved)
  VALUES (v_keep.id, v_uid, p_display_name, p_avatar, 'member', 'adult', NOT v_keep.require_approval)
  RETURNING * INTO v_member;

  RETURN QUERY SELECT (CASE WHEN v_member.approved THEN 'ok' ELSE 'pending' END)::text,
                      v_member.id, v_keep.id, v_keep.code, v_keep.name;
END;
$$;

REVOKE ALL ON FUNCTION join_keep_by_code(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION join_keep_by_code(text, text, text) TO authenticated;

-- rotate_keep_code: owner-only. Regenerate + reset the 72h expiry; also
-- the "my code expired" recovery path. Returns the fresh code + expiry.
CREATE OR REPLACE FUNCTION rotate_keep_code(p_keep_id uuid)
RETURNS TABLE (keep_code text, code_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_owner boolean;
  v_code text;
  v_expires timestamptz := now() + interval '72 hours';
  v_attempts int := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = p_keep_id AND user_id = v_uid AND role = 'owner' AND approved
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  LOOP
    v_code := _roamkeep_gen_code();
    BEGIN
      UPDATE keeps SET code = v_code, code_expires_at = v_expires
       WHERE id = p_keep_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempts := v_attempts + 1;
      IF v_attempts >= 10 THEN
        RAISE EXCEPTION 'code_generation_failed';
      END IF;
    END;
  END LOOP;

  RETURN QUERY SELECT v_code, v_expires;
END;
$$;
REVOKE ALL ON FUNCTION rotate_keep_code(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rotate_keep_code(uuid) TO authenticated;

-- get_invite (v16): owner-only read of the current join code + expiry.
--
-- Showing the code only to owners was enforced by the UI and nothing else:
-- the keeps SELECT policy is keep-wide and RLS cannot hide a column, so any
-- member — a child included — could read the live code (on the PWA, from
-- DevTools' view of the launch query) and bring in someone the owners had
-- not approved. 4.9.0 stops selecting keeps.code outright and asks here.
--
-- EXPAND step only. The column is still readable, because older apps select
-- keeps(code) at launch and would fail to start without it. The CONTRACT —
-- revoking column SELECT on keeps.code / code_expires_at from
-- authenticated — waits until no pre-4.9.0 app is left.
CREATE OR REPLACE FUNCTION get_invite(p_keep_id uuid)
RETURNS TABLE (keep_code text, code_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM keep_members m
     WHERE m.keep_id = p_keep_id AND m.user_id = auth.uid() AND m.role = 'owner' AND m.approved
  ) THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  RETURN QUERY SELECT k.code, k.code_expires_at FROM keeps k WHERE k.id = p_keep_id;
END;
$$;
REVOKE ALL ON FUNCTION get_invite(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_invite(uuid) TO authenticated;

-- v18: LEAVING DELETES YOU. However someone leaves a family (they leave, an
-- owner removes them, or an owner completes a child's request), everything
-- about them goes, their sign-in included. Before v18 a removal left the
-- sign-in behind: an email address and a password hash with no family,
-- which on a one-family server can do nothing but join again. Deleting it
-- also retires the rules that existed only to protect that leftover
-- account: an owner could already wipe an adult's data by removing them, so
-- "an owner may not delete an adult's account" and the day-long block on
-- deletion after a password reset protected nothing.
--
-- One function so the three callers cannot drift. The callers check who may
-- do it; this only does it. History explicitly, as everywhere, so the
-- privacy promise does not rest on a foreign key; the membership, and from
-- it check-ins, the push row and preferences by cascade; then the account,
-- unless it is still in another Keep (possible only on a server from before
-- v16), where deleting it would take that membership too.
CREATE OR REPLACE FUNCTION _roamkeep_delete_member(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
BEGIN
  SELECT user_id INTO v_uid FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  DELETE FROM location_history WHERE member_id = p_member_id;
  DELETE FROM keep_members WHERE id = p_member_id;
  IF NOT EXISTS (SELECT 1 FROM keep_members WHERE user_id = v_uid) THEN
    DELETE FROM auth.users WHERE id = v_uid;
  END IF;
END;
$$;
-- Internal: the DEFINER functions call it, clients never do.
REVOKE ALL ON FUNCTION _roamkeep_delete_member(uuid) FROM PUBLIC, anon, authenticated;

-- remove_member: owner-only kick. Owner can't remove self (that's the leave
-- path). v18: the person is deleted, sign-in and all (see above).
--
-- v17: it also rotates the join code. The removed person's phone keeps the
-- invite it joined with (so it can offer Join again), and on a keep without
-- approval that code let them straight back in for the rest of its 72
-- hours. Invites sent to others and not yet used stop working too; the
-- owner shares again.
CREATE OR REPLACE FUNCTION remove_member(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep_id uuid;
  v_target_uid uuid;
  v_is_owner boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT keep_id, user_id INTO v_keep_id, v_target_uid
    FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  IF v_target_uid = v_uid THEN
    RAISE EXCEPTION 'cannot_remove_self';
  END IF;

  -- v16: serialise ownership changes per keep. Without it two owners
  -- removing each other at the same moment both passed the owner check and
  -- the keep was left with none. See leave_keep.
  PERFORM 1 FROM keeps WHERE id = v_keep_id FOR UPDATE;

  SELECT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner' AND approved
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  PERFORM _roamkeep_delete_member(p_member_id);
  PERFORM rotate_keep_code(v_keep_id);
END;
$$;
REVOKE ALL ON FUNCTION remove_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION remove_member(uuid) TO authenticated;

-- leave_keep: a member removes THEMSELVES, and their history with them.
--
-- Exists since v14 because landing/privacy promised this and nothing in the
-- app could do it — there was no action, no button, and no code path that
-- deleted a member row. Signing out only set online=false.
--
-- Three rules, enforced here rather than trusted from the caller: a child
-- cannot leave (the v8 deterrent); the last owner cannot leave, because
-- that strands the keep, its places and everyone still in it with nobody
-- able to administer them — their exit is deleting the Supabase project;
-- and you can only leave as yourself.
--
-- v18: leaving deletes you, sign-in included (see _roamkeep_delete_member),
-- which makes it delete_my_account by another name for everyone but the
-- sole member of a Keep: they are the last owner here, and delete_my_account
-- takes their whole family with them. A pending member may still leave:
-- that is how they withdraw a request.
CREATE OR REPLACE FUNCTION leave_keep(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_member keep_members%ROWTYPE;
  v_owner_count int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT * INTO v_member FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  IF v_member.user_id <> v_uid THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  IF v_member.member_type = 'child' THEN
    RAISE EXCEPTION 'child_cannot_leave';
  END IF;

  -- v16: take the keep's row lock before counting owners. Every function
  -- that can reduce the owner count (this, set_member_role, remove_member)
  -- takes it first, so two of them can no longer each see "two owners" and
  -- together leave none. Under READ COMMITTED the count below is read
  -- after the lock is granted, so it sees the other transaction's commit.
  PERFORM 1 FROM keeps WHERE id = v_member.keep_id FOR UPDATE;
  SELECT * INTO v_member FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  IF v_member.role = 'owner' AND v_member.approved THEN
    SELECT count(*) INTO v_owner_count
      FROM keep_members
     WHERE keep_id = v_member.keep_id AND role = 'owner' AND approved;
    IF v_owner_count <= 1 THEN
      RAISE EXCEPTION 'last_owner';
    END IF;
  END IF;

  PERFORM _roamkeep_delete_member(v_member.id);
END;
$$;
REVOKE ALL ON FUNCTION leave_keep(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION leave_keep(uuid) TO authenticated;

-- set_member_role: owner-only (owner ⊆ adults, so "only adults change
-- roles" holds). Refuses to demote the last owner.
--
-- v18: and refuses to make an owner of a child or of a member still waiting
-- for approval. set_member_type already kept an owner from becoming a
-- child; nothing stopped the other order, and a child owner could then
-- demote the real owners and delete their own account, leaving the family
-- with nobody to run it. A pending owner could administer a family that
-- had not let them in.
CREATE OR REPLACE FUNCTION set_member_role(p_member_id uuid, p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep_id uuid;
  v_cur_role text;
  v_cur_type text;
  v_cur_approved boolean;
  v_is_owner boolean;
  v_owner_count int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_role NOT IN ('owner', 'member') THEN
    RAISE EXCEPTION 'invalid_role';
  END IF;

  SELECT keep_id INTO v_keep_id
    FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  -- v16: lock first, then read the role the decision rests on — see
  -- leave_keep. Two owners demoting each other at once each saw two owners.
  PERFORM 1 FROM keeps WHERE id = v_keep_id FOR UPDATE;
  SELECT role, member_type, approved INTO v_cur_role, v_cur_type, v_cur_approved
    FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner' AND approved
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  IF p_role = 'owner' AND v_cur_role <> 'owner' THEN
    IF v_cur_type = 'child' THEN
      RAISE EXCEPTION 'child_cannot_be_owner';
    END IF;
    IF NOT v_cur_approved THEN
      RAISE EXCEPTION 'member_pending';
    END IF;
  END IF;

  -- Only an approved owner counts, and only demoting one can strand the
  -- family: demoting an owner still pending (from before v18) never does.
  IF v_cur_role = 'owner' AND v_cur_approved AND p_role = 'member' THEN
    SELECT count(*) INTO v_owner_count
      FROM keep_members WHERE keep_id = v_keep_id AND role = 'owner' AND approved;
    IF v_owner_count <= 1 THEN
      RAISE EXCEPTION 'last_owner';
    END IF;
  END IF;

  PERFORM set_config('roamkeep.priv', 'on', true);
  UPDATE keep_members SET role = p_role WHERE id = p_member_id;
  PERFORM set_config('roamkeep.priv', 'off', true);  -- close the window
END;
$$;
REVOKE ALL ON FUNCTION set_member_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_member_role(uuid, text) TO authenticated;

-- set_member_type: OWNER-only reclassifies a member adult/child (same
-- admin bar as set_member_role — owners manage the family; this closes
-- the path where any adult could demote another adult to child). An owner
-- must stay an adult (child owner is incoherent).
CREATE OR REPLACE FUNCTION set_member_type(p_member_id uuid, p_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep_id uuid;
  v_cur_role text;
  v_is_owner boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_type NOT IN ('adult', 'child') THEN
    RAISE EXCEPTION 'invalid_type';
  END IF;

  SELECT keep_id, role INTO v_keep_id, v_cur_role
    FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner' AND approved
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  IF v_cur_role = 'owner' AND p_type = 'child' THEN
    RAISE EXCEPTION 'owner_must_be_adult';
  END IF;

  -- v18: becoming a child ends any pause set as an adult. Children may not
  -- pause, and a pause outliving the change kept one going for up to a day.
  PERFORM set_config('roamkeep.priv', 'on', true);
  UPDATE keep_members
     SET member_type  = p_type,
         paused_until = CASE WHEN p_type = 'child' THEN NULL ELSE paused_until END
   WHERE id = p_member_id;
  PERFORM set_config('roamkeep.priv', 'off', true);  -- close the window
END;
$$;
REVOKE ALL ON FUNCTION set_member_type(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_member_type(uuid, text) TO authenticated;

-- pause_member: an adult TIME-BOXES a pause of their OWN tracking
-- (p_until in the future, ≤24h out — always auto-resumes). Children are
-- refused (server-side deterrent; the child still controls the device).
CREATE OR REPLACE FUNCTION pause_member(p_member_id uuid, p_until timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner_uid uuid;
  v_type text;
  v_approved boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT user_id, member_type, approved INTO v_owner_uid, v_type, v_approved
    FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  IF v_owner_uid <> v_uid THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  -- v18: a member still waiting for approval writes nothing (see
  -- private_user_keep_ids), and that includes through this function.
  IF NOT v_approved THEN
    RAISE EXCEPTION 'member_pending';
  END IF;
  IF v_type = 'child' THEN
    RAISE EXCEPTION 'child_cannot_pause';
  END IF;
  IF p_until IS NULL OR p_until <= now() OR p_until > now() + interval '24 hours' THEN
    RAISE EXCEPTION 'invalid_pause';
  END IF;

  PERFORM set_config('roamkeep.priv', 'on', true);
  UPDATE keep_members SET paused_until = p_until WHERE id = p_member_id;
  PERFORM set_config('roamkeep.priv', 'off', true);  -- close the window
END;
$$;
REVOKE ALL ON FUNCTION pause_member(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pause_member(uuid, timestamptz) TO authenticated;

-- resume_member: clear an adult's own pause early (self-service only).
CREATE OR REPLACE FUNCTION resume_member(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner_uid uuid;
  v_approved boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT user_id, approved INTO v_owner_uid, v_approved FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  IF v_owner_uid <> v_uid THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF NOT v_approved THEN
    RAISE EXCEPTION 'member_pending';   -- v18, as pause_member
  END IF;

  PERFORM set_config('roamkeep.priv', 'on', true);
  UPDATE keep_members SET paused_until = NULL WHERE id = p_member_id;
  PERFORM set_config('roamkeep.priv', 'off', true);  -- close the window
END;
$$;
REVOKE ALL ON FUNCTION resume_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION resume_member(uuid) TO authenticated;

-- rename_keep: owner-only. Change the family name shown at the top of the
-- map. `keeps` has no UPDATE RLS policy (creation/rotation are the only
-- keep writes), so this DEFINER path is the only way to rename. Same
-- length rule as create_keep / the keeps_name_len constraint.
CREATE OR REPLACE FUNCTION rename_keep(p_keep_id uuid, p_name text)
RETURNS TABLE (keep_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_owner boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF length(trim(coalesce(p_name, ''))) = 0 OR length(p_name) > 40 THEN
    RAISE EXCEPTION 'invalid_family_name';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = p_keep_id AND user_id = v_uid AND role = 'owner' AND approved
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  UPDATE keeps SET name = trim(p_name) WHERE id = p_keep_id;
  RETURN QUERY SELECT trim(p_name);
END;
$$;
REVOKE ALL ON FUNCTION rename_keep(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rename_keep(uuid, text) TO authenticated;

-- update_member_profile: edit a member's display name + avatar. Allowed
-- for the member themselves OR an owner of that keep (owners set up a
-- child, fix a typo). name/avatar are NOT guard-protected columns, so no
-- roamkeep.priv flag is needed; this DEFINER path exists because the
-- owner-edits-another-member case is cross-row (RLS "update own row"
-- forbids it) and to give one validated path for both cases. Same length
-- rules as create_keep / the nm_name_len / nm_avatar_len constraints.
CREATE OR REPLACE FUNCTION update_member_profile(
  p_member_id uuid,
  p_name text,
  p_avatar text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep_id uuid;
  v_target_uid uuid;
  v_target_approved boolean;
  v_is_owner boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF length(trim(coalesce(p_name, ''))) = 0 OR length(p_name) > 40 THEN
    RAISE EXCEPTION 'invalid_display_name';
  END IF;
  IF length(coalesce(p_avatar, '')) < 1 OR length(p_avatar) > 8 THEN
    RAISE EXCEPTION 'invalid_avatar';
  END IF;

  SELECT keep_id, user_id, approved INTO v_keep_id, v_target_uid, v_target_approved
    FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  IF v_target_uid <> v_uid THEN
    SELECT EXISTS (
      SELECT 1 FROM keep_members
       WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner' AND approved
    ) INTO v_is_owner;
    IF NOT v_is_owner THEN
      RAISE EXCEPTION 'not_authorized';
    END IF;
  ELSIF NOT v_target_approved THEN
    -- v18: editing your own profile is a write, and a member still waiting
    -- for approval makes none. The name they joined with is what the owners
    -- are deciding on.
    RAISE EXCEPTION 'member_pending';
  END IF;

  UPDATE keep_members
     SET name = trim(p_name), avatar = p_avatar
   WHERE id = p_member_id;
END;
$$;
REVOKE ALL ON FUNCTION update_member_profile(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION update_member_profile(uuid, text, text) TO authenticated;

-- prune_keep_history (v16): delete what the retention promise says is
-- already gone — breadcrumbs AND check-ins older than 7 days — for the
-- caller's own keep, every member's rows.
--
-- landing/privacy promises location history is "automatically deleted after
-- 7 days". That held only where pg_cron is enabled (optional; the wizard
-- called its absence harmless). Otherwise the only pruning was each member
-- deleting their OWN rows on app launch, so a phone tracking headlessly for
-- weeks without the app being opened kept everything. Any member's app now
-- calls this at launch, which keeps the promise for the whole keep as long
-- as someone opens the app. pg_cron (below) remains the guarantee.
--
-- Check-ins were kept forever — every arrival and departure with its time,
-- and every SOS position. The owner decided (2026-09-23) they follow the
-- same 7 days.
--
-- SECURITY DEFINER because checkins has no DELETE policy (immutable to
-- clients) and a member may only delete their own breadcrumbs. Safe to
-- expose: it can only remove rows the policy already says are expired.
CREATE OR REPLACE FUNCTION prune_keep_history()
RETURNS TABLE (history_deleted integer, checkins_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_h integer;
  v_c integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- v18: approved members only, like every other write (m.approved).
  DELETE FROM location_history lh
   USING keep_members m
   WHERE m.user_id = v_uid AND m.approved
     AND lh.keep_id = m.keep_id
     AND lh.recorded_at < now() - interval '7 days';
  GET DIAGNOSTICS v_h = ROW_COUNT;

  DELETE FROM checkins c
   USING keep_members m
   WHERE m.user_id = v_uid AND m.approved
     AND c.keep_id = m.keep_id
     AND c.created_at < now() - interval '7 days';
  GET DIAGNOSTICS v_c = ROW_COUNT;

  RETURN QUERY SELECT v_h, v_c;
END;
$$;
REVOKE ALL ON FUNCTION prune_keep_history() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION prune_keep_history() TO authenticated;


-- ── v17: ACCOUNT RPCs ─────────────────────────────────────

-- my_membership: the caller's own membership, approved or not. The one way a
-- PENDING member can learn their status: private_user_keep_ids() hides their
-- row from every policy, including their own read of it (see the note
-- there), so the app asks here while it waits on the approval screen.
CREATE OR REPLACE FUNCTION my_membership()
RETURNS TABLE (member_id uuid, keep_id uuid, keep_name text, approved boolean, joined_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT m.id, m.keep_id, k.name, m.approved, m.created_at
    FROM keep_members m
    JOIN keeps k ON k.id = m.keep_id
   WHERE m.user_id = auth.uid()
   ORDER BY m.created_at
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION my_membership() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_membership() TO authenticated;

-- set_require_approval: an owner turns joining-by-approval on or off for
-- their keep. A 4.11.0 app turns it on straight after create_keep, and for
-- an existing keep in Settings; create_keep itself leaves it off (see the
-- column note).
CREATE OR REPLACE FUNCTION set_require_approval(p_keep_id uuid, p_on boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_on IS NULL THEN
    RAISE EXCEPTION 'invalid_value';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = p_keep_id AND user_id = v_uid AND role = 'owner' AND approved
  ) THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  UPDATE keeps SET require_approval = p_on WHERE id = p_keep_id;
END;
$$;
REVOKE ALL ON FUNCTION set_require_approval(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_require_approval(uuid, boolean) TO authenticated;

-- approve_member / decline_member: an owner settles a pending join. Approval
-- is the only way `approved` changes (the member guard refuses anything
-- else), and decline removes the pending row — the person can ask again
-- with a fresh invite. Neither touches an already-approved member:
-- removing one is remove_member's job, with its own rules.
CREATE OR REPLACE FUNCTION approve_member(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep_id uuid;
  v_approved boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  SELECT keep_id INTO v_keep_id FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  PERFORM 1 FROM keeps WHERE id = v_keep_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner' AND approved
  ) THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  SELECT approved INTO v_approved FROM keep_members WHERE id = p_member_id;
  IF v_approved THEN
    RETURN;   -- already in; approving twice is not an error
  END IF;

  PERFORM set_config('roamkeep.priv', 'on', true);
  UPDATE keep_members SET approved = true WHERE id = p_member_id;
  PERFORM set_config('roamkeep.priv', 'off', true);  -- close the window
END;
$$;
REVOKE ALL ON FUNCTION approve_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION approve_member(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION decline_member(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep_id uuid;
  v_approved boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  SELECT keep_id, approved INTO v_keep_id, v_approved FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner' AND approved
  ) THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  IF v_approved THEN
    RAISE EXCEPTION 'not_pending';
  END IF;
  DELETE FROM keep_members WHERE id = p_member_id;
END;
$$;
REVOKE ALL ON FUNCTION decline_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION decline_member(uuid) TO authenticated;

-- set_signups: open or close new accounts on this project, from the app —
-- so no owner ever has to find "Allow new users to sign up" in the Supabase
-- dashboard, and a time-boxed opening closes itself if they forget.
--
--   (false, NULL)    open
--   (true,  NULL)    closed
--   (true,  <time>)  closed, but open until <time> (at most 30 days out)
--
-- Authority is an owner of the OLDEST keep: sign-up is project-wide, and a
-- stranger who signed up while it was open and made a keep of their own
-- must not be able to hold the door. The same rule set_project_url falls
-- back on.
CREATE OR REPLACE FUNCTION set_signups(p_closed boolean, p_open_until timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_closed IS NULL THEN
    RAISE EXCEPTION 'invalid_value';
  END IF;
  IF p_open_until IS NOT NULL
     AND (p_open_until <= now() OR p_open_until > now() + interval '30 days') THEN
    RAISE EXCEPTION 'invalid_window';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM keep_members m
     WHERE m.user_id = v_uid AND m.role = 'owner' AND m.approved
       AND m.keep_id = (SELECT k.id FROM keeps k ORDER BY k.created_at, k.id LIMIT 1)
  ) THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  UPDATE roamkeep_meta
     SET signups_closed     = p_closed,
         signups_open_until = CASE WHEN p_closed THEN p_open_until ELSE NULL END,
         updated_at         = now()
   WHERE id;   -- the single row; explicit so no safe-update guard objects
END;
$$;
REVOKE ALL ON FUNCTION set_signups(boolean, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_signups(boolean, timestamptz) TO authenticated;

-- The sign-up gate itself: a BEFORE INSERT trigger on auth.users, proved on
-- a fresh project by the 2026-10-01 launch spike. Sign-IN is not an insert,
-- so existing members keep signing in — including after a reinstall, which
-- is why the dashboard's CAPTCHA was never the right tool for this.
--
-- GoTrue has answered 500 with {"code":"P0001","message":"signups_closed"},
-- but not always: in the rc9 device test the same refusal arrived as its
-- generic "Database error saving new user". So the app does not rely on the
-- text. After a failed sign-up it reads signups_closed from roamkeep_meta,
-- which anon can read, and needs no extra RPC open to anon either way.
--
-- In this file, not only in a wizard, for the usual reason: most owners
-- upgrade by re-pasting it. NB the dashboard's own "Allow new users to sign
-- up" switch still applies on top: if it is off, GoTrue refuses before this
-- runs, whatever set_signups says.
CREATE OR REPLACE FUNCTION public._roamkeep_signup_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_closed boolean;
  v_until  timestamptz;
BEGIN
  SELECT m.signups_closed, m.signups_open_until
    INTO v_closed, v_until
    FROM public.roamkeep_meta m;
  IF coalesce(v_closed, false) AND (v_until IS NULL OR v_until <= now()) THEN
    RAISE EXCEPTION 'signups_closed';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public._roamkeep_signup_gate() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS roamkeep_signup_gate ON auth.users;
CREATE TRIGGER roamkeep_signup_gate
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public._roamkeep_signup_gate();

-- delete_my_account: the caller deletes their own account — the sign-in
-- itself, not only their membership. Google Play requires it of any app that
-- lets people create accounts, and the person is owed it regardless.
--
-- A CHILD may not, as they may not leave: they ask instead
-- (request_account_deletion) and an owner deletes the account
-- (delete_child_account). That request is the child's in-app path to
-- deletion, which Play requires of every account an app creates; the owner,
-- who answers for a child's account, completes it. A child who is no longer
-- in any Keep has nobody to ask, and may delete it themselves.
--
-- The last owner of a keep that still has other members may not delete
-- theirs either (that would strand them), and must first make someone
-- else an owner. A keep with nobody else in it goes with its owner.
--
-- Everything else cascades from auth.users: the membership, and from it
-- check-ins, the push row and notification preferences; keeps.created_by
-- and keep_places.created_by become NULL (see the place guard). History is
-- deleted explicitly, as in leave_keep, so the privacy promise does not
-- rest on a foreign key.
CREATE OR REPLACE FUNCTION delete_my_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_member keep_members%ROWTYPE;
  v_owners int;
  v_others int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- v18: no longer refused for a day after a password reset by code (v17,
  -- self-review R1). Since v18 an owner removing a member deletes them too,
  -- so the block protected nothing an owner could not already do, and a
  -- second code cleared it anyway (it read the redemption off the code row,
  -- which a new code resets). The member is still told at once when a code
  -- is made and when it is used.
  --
  -- v18: every membership, not only the oldest. An account in two Keeps
  -- (possible only on a server from before v16) could delete itself while
  -- the last owner of the second one, leaving that family with nobody to
  -- run it. Locked in keep order, so two deletions cannot deadlock.
  FOR v_member IN
    SELECT * FROM keep_members WHERE user_id = v_uid ORDER BY keep_id
  LOOP
    IF v_member.member_type = 'child' THEN
      RAISE EXCEPTION 'child_cannot_delete';
    END IF;
    -- Same lock as every other owner-count change (see leave_keep).
    PERFORM 1 FROM keeps WHERE id = v_member.keep_id FOR UPDATE;
    SELECT count(*) INTO v_others
      FROM keep_members WHERE keep_id = v_member.keep_id AND id <> v_member.id;
    IF v_member.role = 'owner' AND v_member.approved THEN
      SELECT count(*) INTO v_owners
        FROM keep_members WHERE keep_id = v_member.keep_id AND role = 'owner' AND approved;
      IF v_owners <= 1 AND v_others > 0 THEN
        RAISE EXCEPTION 'last_owner';
      END IF;
    END IF;
    DELETE FROM location_history WHERE member_id = v_member.id;
    IF v_others = 0 THEN
      -- The family is just them; its keep, places and history go too.
      DELETE FROM keeps WHERE id = v_member.keep_id;
    END IF;
  END LOOP;

  DELETE FROM auth.users WHERE id = v_uid;
END;
$$;
REVOKE ALL ON FUNCTION delete_my_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_my_account() TO authenticated;

-- issue_password_reset: an owner creates a one-time code for a member who
-- has forgotten their password. 10 characters of Crockford base32 (~50 bits),
-- valid 15 minutes, five wrong guesses and it burns. Returned once, as
-- XXXXX-XXXXX for reading aloud; only its SHA-256 is stored.
--
-- Never for another OWNER. A code goes to whoever issues it, so an owner
-- able to issue one for a co-owner could redeem it with that owner's email
-- and take over the most powerful account in the keep. An owner who forgets
-- their password recovers through the Supabase project itself — in the app,
-- with their Supabase access token — which is the real root of trust.
-- And never for yourself: signed in, you use Change password.
CREATE OR REPLACE FUNCTION issue_password_reset(p_member_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_target keep_members%ROWTYPE;
  v_bytes bytea;
  v_code text := '';
  c_alpha CONSTANT text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   -- 32 symbols: 256 % 32 = 0, unbiased
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  SELECT * INTO v_target FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = v_target.keep_id AND user_id = v_uid AND role = 'owner' AND approved
  ) THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  IF v_target.user_id = v_uid THEN
    RAISE EXCEPTION 'cannot_reset_self';
  END IF;
  IF v_target.role = 'owner' THEN
    RAISE EXCEPTION 'cannot_reset_owner';
  END IF;
  IF NOT v_target.approved THEN
    RAISE EXCEPTION 'member_pending';
  END IF;

  v_bytes := gen_random_bytes(10);
  FOR i IN 0..9 LOOP
    v_code := v_code || substr(c_alpha, (get_byte(v_bytes, i) % 32) + 1, 1);
  END LOOP;

  INSERT INTO password_reset_codes
    (user_id, keep_id, code_hash, expires_at, attempts, issued_by, issued_at, redeemed_at)
  VALUES
    (v_target.user_id, v_target.keep_id, encode(digest(v_code, 'sha256'), 'hex'),
     now() + interval '15 minutes', 0, v_uid, now(), NULL)
  ON CONFLICT (user_id) DO UPDATE
    SET keep_id     = EXCLUDED.keep_id,
        code_hash   = EXCLUDED.code_hash,
        expires_at  = EXCLUDED.expires_at,
        attempts    = 0,
        issued_by   = EXCLUDED.issued_by,
        issued_at   = EXCLUDED.issued_at,
        redeemed_at = NULL;

  RETURN substr(v_code, 1, 5) || '-' || substr(v_code, 6, 5);
END;
$$;
REVOKE ALL ON FUNCTION issue_password_reset(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION issue_password_reset(uuid) TO authenticated;

-- redeem_password_reset: the member, signed OUT, sets a new password with
-- their email and the owner's code. Anon-callable by necessity — the one
-- function in this file besides roamkeep_schema_version() that is.
--
-- Every failure but one answers the same 'invalid': unknown email, no code,
-- expired, burned or wrong — so it can neither confirm an account exists nor
-- that a code was issued. RETURNs rather than RAISEs on a wrong guess, so the
-- attempt count it increments is COMMITTED (a RAISE would roll it back and
-- the burn would never trip — the join limiter's lesson). 'weak_password'
-- is the exception, and comes only after the code has matched.
--
-- Writes auth.users.encrypted_password with pgcrypto's bcrypt, which GoTrue
-- verifies — proved by the 2026-10-01 launch spike: a DEFINER function may
-- update it, the new password signs in, the old one is refused.
CREATE OR REPLACE FUNCTION redeem_password_reset(p_email text, p_code text, p_new_password text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_row password_reset_codes%ROWTYPE;
  v_code text;
BEGIN
  -- Normalise as typed: any case, spaces or the dash, and the letters people
  -- mistake for digits read as the digits (Crockford).
  v_code := translate(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'OIL', '011');

  SELECT u.id INTO v_uid
    FROM auth.users u
   WHERE lower(u.email) = lower(trim(coalesce(p_email, '')))
   LIMIT 1;
  IF v_uid IS NULL THEN
    RETURN 'invalid';
  END IF;

  SELECT * INTO v_row FROM password_reset_codes WHERE user_id = v_uid FOR UPDATE;
  IF NOT FOUND OR v_row.code_hash IS NULL OR v_row.expires_at <= now() OR v_row.attempts >= 5 THEN
    RETURN 'invalid';
  END IF;

  IF encode(digest(v_code, 'sha256'), 'hex') <> v_row.code_hash THEN
    UPDATE password_reset_codes
       SET attempts  = attempts + 1,
           code_hash = CASE WHEN attempts + 1 >= 5 THEN NULL ELSE code_hash END
     WHERE user_id = v_uid;
    RETURN 'invalid';
  END IF;

  -- v18: the rules issue_password_reset checked are checked AGAIN now, when
  -- the code is used, because the family can change in the 15 minutes
  -- between. Checked only at issue, a code made for a member still worked
  -- after they were made an owner, and after they were removed from the
  -- family, when nobody was left to tell them (their phones are woken
  -- through their membership, which had gone). The target must still be an
  -- approved member of the Keep the code was made in, and not an owner; the
  -- one who made it must still be an approved owner there. Otherwise the
  -- code is burnt, with the same 'invalid' as every other failure.
  IF NOT EXISTS (SELECT 1 FROM keep_members t
                  WHERE t.user_id = v_uid AND t.keep_id = v_row.keep_id
                    AND t.approved AND t.role <> 'owner')
     OR NOT EXISTS (SELECT 1 FROM keep_members i
                     WHERE i.user_id = v_row.issued_by AND i.keep_id = v_row.keep_id
                       AND i.approved AND i.role = 'owner') THEN
    UPDATE password_reset_codes SET code_hash = NULL WHERE user_id = v_uid;
    RETURN 'invalid';
  END IF;

  IF length(coalesce(p_new_password, '')) < 8 THEN
    RETURN 'weak_password';
  END IF;

  UPDATE auth.users
     SET encrypted_password = crypt(p_new_password, gen_salt('bf', 10)),
         updated_at = now()
   WHERE id = v_uid;
  UPDATE password_reset_codes
     SET code_hash = NULL, redeemed_at = now()
   WHERE user_id = v_uid;
  RETURN 'ok';
END;
$$;
REVOKE ALL ON FUNCTION redeem_password_reset(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redeem_password_reset(text, text, text) TO anon, authenticated;

-- request_account_deletion: a child asks the owners of their Keep to delete
-- their account (p_on true), or takes the request back (false). Children
-- only: an adult deletes their own (delete_my_account). Asking wakes the
-- owners through on_deletion_request; asking again while a request stands
-- keeps its original time and wakes nobody.
CREATE OR REPLACE FUNCTION request_account_deletion(p_on boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_member keep_members%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_on IS NULL THEN
    RAISE EXCEPTION 'invalid_value';
  END IF;
  SELECT * INTO v_member FROM keep_members
   WHERE user_id = v_uid AND approved ORDER BY created_at LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  IF v_member.member_type <> 'child' THEN
    RAISE EXCEPTION 'not_child';
  END IF;

  PERFORM set_config('roamkeep.priv', 'on', true);
  UPDATE keep_members
     SET deletion_requested_at = CASE WHEN p_on THEN coalesce(deletion_requested_at, now()) END
   WHERE id = v_member.id;
  PERFORM set_config('roamkeep.priv', 'off', true);  -- close the window
END;
$$;
REVOKE ALL ON FUNCTION request_account_deletion(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_account_deletion(boolean) TO authenticated;

-- delete_child_account: an owner deletes a CHILD member's account, the
-- sign-in itself, as delete_my_account would. It completes a child's
-- request, and an owner may also do it unasked: a child's account is the
-- family's to manage. Never an adult's. An adult's account is theirs alone;
-- remove_member is the owner's part there. Refused when the account is in
-- another Keep too (possible only from before v16), so no owner reaches
-- into a second family.
--
-- v18: since remove_member deletes the account too, this is remove_member
-- for children, kept for the 4.11.0 app's "Delete account" button. Its
-- children-only rule stays, because that is what that app promises.
CREATE OR REPLACE FUNCTION delete_child_account(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_target keep_members%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  SELECT * INTO v_target FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  -- The keep's row lock, as every other change to who is in a keep takes.
  PERFORM 1 FROM keeps WHERE id = v_target.keep_id FOR UPDATE;
  SELECT * INTO v_target FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  -- Owners of the child's own keep only.
  IF NOT EXISTS (
    SELECT 1 FROM keep_members o
     WHERE o.keep_id = v_target.keep_id AND o.user_id = v_uid AND o.role = 'owner' AND o.approved
  ) THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  IF v_target.member_type <> 'child' THEN
    RAISE EXCEPTION 'not_child';
  END IF;
  IF EXISTS (SELECT 1 FROM keep_members x
              WHERE x.user_id = v_target.user_id AND x.keep_id <> v_target.keep_id) THEN
    RAISE EXCEPTION 'member_elsewhere';
  END IF;

  -- v18: the same deletion as remove_member and leave_keep, and the same
  -- rotation as remove_member: the child's phone keeps the invite it
  -- joined with.
  PERFORM _roamkeep_delete_member(v_target.id);
  PERFORM rotate_keep_code(v_target.keep_id);
END;
$$;
REVOKE ALL ON FUNCTION delete_child_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_child_account(uuid) TO authenticated;


-- ── REALTIME PUBLICATION ──────────────────────────────────
-- Supabase Realtime only streams tables in the supabase_realtime
-- publication. Guarded so re-running doesn't error on already-added.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND tablename = 'keep_members') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE keep_members;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND tablename = 'checkins') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE checkins;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND tablename = 'keep_places') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE keep_places;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND tablename = 'location_history') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE location_history;
  END IF;
  -- v13: so a second device belonging to the same person picks up a
  -- notification-preference change without a manual refresh.
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND tablename = 'keep_notify_prefs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE keep_notify_prefs;
  END IF;
END$$;

-- ── RETENTION ─────────────────────────────────────────────
-- Breadcrumbs and (since v16) check-ins are kept 7 days. Any member's app
-- runs prune_keep_history() at launch; these pg_cron sweeps are the
-- server-side guarantee for a keep where nobody opens the app. Scheduled
-- only if the pg_cron extension is enabled (Dashboard → Database →
-- Extensions); cron.schedule() upserts by job name so re-running is safe.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'roamkeep-prune-location-history',
      '0 3 * * *',
      $job$DELETE FROM location_history WHERE recorded_at < now() - interval '7 days'$job$
    );
    -- v16: check-ins follow the same 7 days (owner decision 2026-09-23).
    PERFORM cron.schedule(
      'roamkeep-prune-checkins',
      '15 3 * * *',
      $job$DELETE FROM checkins WHERE created_at < now() - interval '7 days'$job$
    );
    -- v8: join-attempt log only needs a 1-day window (the rate limiter
    -- looks back 1 hour).
    PERFORM cron.schedule(
      'roamkeep-prune-join-attempts',
      '30 3 * * *',
      $job$DELETE FROM keep_join_attempts WHERE attempted_at < now() - interval '1 day'$job$
    );
  ELSE
    RAISE NOTICE 'pg_cron not enabled — skipping retention jobs. Enable the extension and re-run.';
  END IF;
END$$;

-- ── SCHEMA VERSION STAMP ──────────────────────────────────
-- LAST statement in the file, deliberately. If anything above fails, the
-- version is left untouched, so a half-applied schema reports the OLD
-- version and clients correctly refuse rather than assuming they got what
-- they asked for.
--
-- GREATEST(), not a plain assignment: this file is also re-run as the
-- upgrade path, and it must never walk a database BACKWARDS if someone
-- runs an older checkout of it against a newer database.

INSERT INTO roamkeep_meta (id, schema_version) VALUES (true, 18)
  ON CONFLICT (id) DO UPDATE
    SET schema_version = GREATEST(roamkeep_meta.schema_version, 18),
        updated_at = now();


-- ── DONE ──────────────────────────────────────────────────
