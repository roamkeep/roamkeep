-- ============================================================
-- FamilyNest v5 Migration — Push notifications (FCM)
--
-- Run this ONCE after v4 / v4.1 are already applied. Safe to re-run.
--
-- What this does:
--   1. Adds nest_members.fcm_token — the per-device Firebase
--      Cloud Messaging registration token. Populated by the
--      Capacitor push-notifications plugin on app launch.
--   2. Adds nest_members.notify_on_checkin — per-recipient
--      mute switch. Default TRUE; users can toggle it off in
--      the app settings if they find arrived/left pushes too
--      noisy.
--   3. Adds a partial index on (nest_id) WHERE fcm_token IS
--      NOT NULL. The notify-checkin edge function fans out on
--      every checkins INSERT by selecting "all members of the
--      same nest with a token, except the actor"; this is the
--      hot path.
--
-- No new RLS policies are needed:
--   - The token is written by the member themselves via the
--     existing "Members can update own row" policy.
--   - The edge function reads via the service-role key, which
--     bypasses RLS entirely.
-- ============================================================

ALTER TABLE nest_members
  ADD COLUMN IF NOT EXISTS fcm_token text,
  ADD COLUMN IF NOT EXISTS notify_on_checkin boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_nest_members_nest_token
  ON nest_members(nest_id) WHERE fcm_token IS NOT NULL;

-- ── DONE ──────────────────────────────────────────────────
