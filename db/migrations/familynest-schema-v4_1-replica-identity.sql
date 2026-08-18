-- ============================================================
-- FamilyNest v4.1 Migration — Realtime DELETE payloads
--
-- Run this ONCE after v4 has been applied. Safe to re-run.
--
-- Why:
--   The v4 client subscribes to nest_places realtime events with
--   a `nest_id=eq.<nestId>` filter. Postgres' default replica
--   identity (DEFAULT) only ships the primary key in the OLD
--   row of DELETE WAL records, so nest_id arrives as NULL and
--   the filter rejects the event — the client never learns the
--   row was deleted and the UI stays stale until reload.
--
--   Setting REPLICA IDENTITY FULL makes Postgres include every
--   column of the deleted row in WAL, so Supabase realtime can
--   evaluate the filter and forward the DELETE.
-- ============================================================

ALTER TABLE nest_places REPLICA IDENTITY FULL;

-- ── Verify (optional) ─────────────────────────────────────
-- Expect 'f' (full):
--   SELECT relreplident FROM pg_class WHERE relname = 'nest_places';
