-- v15 — record how good each breadcrumb fix claimed to be
--
-- Runs against an EXISTING live database. Idempotent and safe to re-run.
-- Sets schema_version = 15. REQUIRES v14.
--
-- PURELY ADDITIVE. One nullable column, nothing renamed, dropped or
-- signature-changed, so an older app is entirely unaffected: it selects
-- an explicit column list and therefore cannot see the new column, and
-- its inserts simply leave it NULL.
--
-- ── Why ─────────────────────────────────────────────────────────
--
-- Every drift defence on the breadcrumb write path keys on the fix's own
-- horizontal error radius: the 150 m usability ceiling, the stillness
-- reject and the anchor gate (both of which only fire above
-- DRIFT_MIN_ACC_M), and the speed column's SPEED_TRUST_ACC_M filter. A
-- fix that reports a tight error radius is therefore written with no
-- further questions asked — deliberately, so that a real journey never
-- loses its start.
--
-- That leaves exactly two ways a stationary phone can still file a
-- journey: the fixes were imprecise and cleared the thresholds anyway, or
-- they claimed to be precise and were wrong (urban multipath and
-- WiFi-derived positions do this routinely). The two call for opposite
-- responses — retune the thresholds, versus stop trusting reported
-- accuracy at all and find an independent motion signal — and in the
-- stored data they look identical, because the number every one of those
-- gates consulted was never kept.
--
-- Nothing reads this column yet. It is an instrument, not a feature.
--
-- ── Client compatibility ────────────────────────────────────────
--
-- NEEDS_SCHEMA in app.js deliberately stays at 13. This migration is NOT
-- required: a family that never runs it keeps working exactly as before
-- and simply produces no accuracy data. The clients gate the field at the
-- write site instead (S.schemaVersion on the JS path, a mirrored copy in
-- PrefsStore on the native one), and fall back to omitting it if a write
-- is rejected — so no owner is forced to migrate on someone else's
-- schedule.

begin;

-- ── 1. The column ───────────────────────────────────────────────

alter table location_history
  add column if not exists accuracy double precision;

comment on column location_history.accuracy is
  'Horizontal error radius of the fix in metres, as the OS reported it '
  '(68% confidence). NULL when the fix reported none, or when the writing '
  'client predates v15. Diagnostic only — nothing reads it.';


-- ── 2. Stamp the version ────────────────────────────────────────
-- LAST statement. A half-applied migration leaves the old number, so the
-- client correctly refuses rather than assuming it got what it asked for.

insert into roamkeep_meta (id, schema_version) values (true, 15)
  on conflict (id) do update
    set schema_version = greatest(roamkeep_meta.schema_version, 15),
        updated_at = now();

commit;


-- ── Verify ──────────────────────────────────────────────────────
-- Check the OBJECT, not just the number — a version that reports 15 while
-- missing what 15 contains is the one failure the marker cannot catch.
--
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'location_history'
--    order by ordinal_position;
--
-- Expect: id, keep_id, member_id, lat, lng, speed, accuracy, recorded_at.
--
--   select roamkeep_schema_version();   -- expect schema_version = 15
