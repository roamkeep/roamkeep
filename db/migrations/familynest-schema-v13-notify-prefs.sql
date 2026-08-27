-- v13 — per-person, per-place notification preferences + place sync
--
-- Runs against an EXISTING live database. Idempotent and non-destructive;
-- safe to re-run. Purely additive — nothing is renamed, dropped or
-- signature-changed, so an app on 4.7.0 keeps working unchanged after it
-- is applied (expand → migrate → contract; see the project guide).
--
-- Sets schema_version = 13. REQUIRES v12 to have been applied first.
--
-- ── What it adds ────────────────────────────────────────────────
--
--   1. checkins.place_id      — which saved place a check-in was for.
--   2. keep_notify_prefs      — "don't tell ME about PERSON at PLACE".
--   3. checkin_recipients()   — who to wake for one check-in (service role).
--   4. my_checkin_feed        — which check-ins *I* should be told about.
--   5. roamkeep_notify_places — webhook trigger for keep_places changes.
--
-- ── Why place_id, when checkins.place already exists ────────────
--
-- checkins.place is a DISPLAY STRING, composed as icon || ' ' || name at
-- write time (app.js and GeofenceReceiver.java both build it that way).
-- Matching a preference against it would mean string comparison that a
-- rename silently breaks. Nullable, and NOT backfilled: historical rows
-- and manual/sos check-ins have NULL, and NULL is never muted.
--
-- ── Why TWO filter objects ──────────────────────────────────────
--
-- The two consumers ask opposite questions about the same rule:
--
--   * The Edge Function asks "given this check-in, who should be woken?"
--     — one row in, many members out.
--   * A device asks "given me, which recent check-ins should I raise?"
--     — one member in, many rows out.
--
-- Stating the rule once in SQL and exposing it from both directions keeps
-- them from drifting. It also means the DEVICE filters server-side, which
-- is the important part: the push wake-up is content-free and untargeted,
-- so any wake (an SOS, or an unmuted event about someone else) makes the
-- device fetch everything newer than its watermark. Filtering only in the
-- Edge Function would leak muted notifications through unrelated wakes.
--
-- Doing it as a VIEW rather than a cached copy on the device is
-- deliberate: the project guide's longest section is about PrefsStore
-- copies of keep_places drifting from the database invisibly. A mute set
-- mirrored into SharedPreferences would be a fourth instance of exactly
-- that bug.

begin;

-- ── 1. checkins.place_id, and where it happened ─────────────────
alter table checkins
  add column if not exists place_id uuid references keep_places(id) on delete set null;

-- Where the member was when this was written. Added for SOS: the alert
-- in Recent Activity has to give whoever reads it a position they can
-- navigate to, and reading keep_members.lat/lng at render time would
-- answer a different question — "where are they NOW" — so a week-old SOS
-- would show today's position. Quietly wrong in the one place being
-- wrong matters most.
--
-- Nullable and never backfilled: rows written before this, and any
-- client that does not send it, simply have no position. Every reader
-- must treat absence as normal rather than as an error.
alter table checkins
  add column if not exists lat double precision,
  add column if not exists lng double precision;

-- "This place's check-ins" — used by the recipient function's NOT EXISTS
-- and by anything that later wants a per-place history.
create index if not exists idx_checkins_place on checkins(place_id)
  where place_id is not null;


-- ── 2. keep_notify_prefs ────────────────────────────────────────
--
-- EXCEPTION ROWS ONLY. A row means "mute"; no row means "notify". So the
-- table is empty after this migration and every family's behaviour is
-- exactly what it was — the feature costs nothing until someone uses it.
--
-- The three cascades are the whole garbage-collection story: delete a
-- place, or remove a member, and the preferences that referenced them
-- disappear with them. No cleanup job, and no way to accumulate rows
-- pointing at things that no longer exist.
create table if not exists keep_notify_prefs (
  id                uuid primary key default gen_random_uuid(),
  keep_id           uuid not null references keeps(id)        on delete cascade,
  -- The VIEWER — whose preference this is.
  member_id         uuid not null references keep_members(id) on delete cascade,
  -- The person they don't want to hear about at this place.
  subject_member_id uuid not null references keep_members(id) on delete cascade,
  place_id          uuid not null references keep_places(id)  on delete cascade,
  created_at        timestamptz not null default now(),
  unique (member_id, subject_member_id, place_id)
);

-- The fan-out hot path: "does anyone mute this subject at this place?"
create index if not exists idx_notify_prefs_fanout
  on keep_notify_prefs(keep_id, subject_member_id, place_id);

alter table keep_notify_prefs enable row level security;

-- Scoped to OWN rows, unlike the keep-wide read policies on every other
-- table here. One member must not be able to read another's mute list —
-- who you have quietly stopped hearing about is nobody else's business.
drop policy if exists "Members read own notify prefs" on keep_notify_prefs;
create policy "Members read own notify prefs"
  on keep_notify_prefs for select to authenticated
  using (
    keep_id in (select private_user_keep_ids())
    and member_id in (select id from keep_members where user_id = auth.uid())
  );

drop policy if exists "Members write own notify prefs" on keep_notify_prefs;
create policy "Members write own notify prefs"
  on keep_notify_prefs for insert to authenticated
  with check (
    keep_id in (select private_user_keep_ids())
    and member_id in (select id from keep_members where user_id = auth.uid())
    -- The subject and the place must be in the same keep, or a row could
    -- be written referencing another family's ids.
    and subject_member_id in (select id from keep_members where keep_id = keep_notify_prefs.keep_id)
    and place_id in (select id from keep_places where keep_id = keep_notify_prefs.keep_id)
  );

drop policy if exists "Members delete own notify prefs" on keep_notify_prefs;
create policy "Members delete own notify prefs"
  on keep_notify_prefs for delete to authenticated
  using (
    keep_id in (select private_user_keep_ids())
    and member_id in (select id from keep_members where user_id = auth.uid())
  );


-- ── 3. Recipients for one check-in (Edge Function) ──────────────
--
-- The mute rule, stated once. SOS deliberately ignores all of it — a
-- muted family member still gets the emergency — and so does a check-in
-- with no place_id (manual, or a row written before this migration).
create or replace function checkin_recipients(p_checkin uuid)
returns table (member_id uuid, fcm_token text)
language sql
security definer
set search_path = public
stable
as $$
  select m.id, m.fcm_token
  from checkins c
  join keep_members m on m.keep_id = c.keep_id
  where c.id = p_checkin
    and m.id <> c.member_id
    and m.fcm_token is not null
    and (
      c.type = 'sos'
      or (
        m.notify_on_checkin
        and (
          c.place_id is null
          or not exists (
            select 1 from keep_notify_prefs p
            where p.member_id = m.id
              and p.subject_member_id = c.member_id
              and p.place_id = c.place_id
          )
        )
      )
    )
$$;

-- Service role only. The explicit anon/authenticated revoke is NOT
-- redundant with `from public`: Supabase's default privileges grant
-- EXECUTE on every new public function to those roles BY NAME, so
-- revoking PUBLIC alone leaves it callable at /rest/v1/rpc/. That is the
-- v10 lesson, and it applies to every function added from here on.
revoke all on function public.checkin_recipients(uuid) from public, anon, authenticated;
grant execute on function public.checkin_recipients(uuid) to service_role;


-- ── 4. My own check-in feed (the device) ────────────────────────
--
-- security_invoker so the caller's JWT and RLS apply — the device reads
-- it over the credentials it already holds in PrefsStore, and needs no
-- local copy of anyone's preferences.
--
-- Requires PG15+. Supabase is well past that; a self-hoster on PG14 would
-- need this as a SECURITY DEFINER function filtering on auth.uid()
-- instead, reachable over GET /rest/v1/rpc/ so the device's existing
-- fetch path still works.
drop view if exists my_checkin_feed;
create view my_checkin_feed
with (security_invoker = true) as
  select c.id, c.keep_id, c.member_name, c.member_avatar,
         c.type, c.place, c.place_id, c.created_at
  from checkins c
  join keep_members me
    on me.keep_id = c.keep_id
   and me.user_id = auth.uid()
  where c.member_id <> me.id
    and (
      c.type = 'sos'
      or (
        me.notify_on_checkin
        and (
          c.place_id is null
          or not exists (
            select 1 from keep_notify_prefs p
            where p.member_id = me.id
              and p.subject_member_id = c.member_id
              and p.place_id = c.place_id
          )
        )
      )
    );

grant select on my_checkin_feed to authenticated;


-- ── 5. keep_places → notify-places webhook ──────────────────────
--
-- Same shape as roamkeep_notify_checkin: pg_net directly rather than
-- supabase_functions.http_request, because that helper's schema only
-- exists once someone has used the dashboard's Webhooks UI — depending on
-- it would mean depending on the manual step this replaces.
--
-- Fires on INSERT, UPDATE and DELETE. A DELETE has no NEW, and old_record
-- carries keep_id only because keep_places is REPLICA IDENTITY FULL.
--
-- Reads the project URL from roamkeep_meta (v12) and silently does
-- nothing while it is NULL, so a partly configured database degrades to
-- "no place sync" rather than erroring on every place edit.
create extension if not exists pg_net;

create or replace function public.roamkeep_notify_places()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, net
as $fn$
declare
  v_url text;
  v_row jsonb;
  v_old jsonb;
  -- AFTER triggers ignore the return value, but it still has to be a
  -- valid record — and COALESCE(NEW, OLD) is not, since both are plpgsql
  -- `record` and COALESCE needs a resolvable common type. Pick one up
  -- front and return it from every path.
  v_ret record;
begin
  if tg_op = 'DELETE' then v_ret := old; else v_ret := new; end if;

  select project_url into v_url from roamkeep_meta;
  if v_url is null then
    return v_ret;
  end if;

  if tg_op = 'DELETE' then
    v_row := null;
    v_old := to_jsonb(old);
  else
    v_row := to_jsonb(new);
    v_old := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  end if;

  perform net.http_post(
    url     := v_url || '/functions/v1/notify-places',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object(
                 'type',       tg_op,
                 'table',      'keep_places',
                 'schema',     'public',
                 'record',     v_row,
                 'old_record', v_old
               ),
    timeout_milliseconds := 5000
  );
  return v_ret;
exception when others then
  -- Sync is best-effort. A webhook problem must never stop someone
  -- adding or deleting a place.
  return v_ret;
end;
$fn$;

revoke all on function public.roamkeep_notify_places() from public, anon, authenticated;

drop trigger if exists on_place_notify on public.keep_places;
create trigger on_place_notify
  after insert or update or delete on public.keep_places
  for each row
  execute function public.roamkeep_notify_places();


-- ── 6. Realtime ─────────────────────────────────────────────────
-- So a second device belonging to the same person picks up a preference
-- change without a manual refresh.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'keep_notify_prefs'
  ) then
    alter publication supabase_realtime add table keep_notify_prefs;
  end if;
end$$;


-- ── 7. Stamp the version ────────────────────────────────────────
-- LAST statement. A half-applied migration leaves the old number, so the
-- client correctly refuses rather than assuming it got what it asked for.
insert into roamkeep_meta (id, schema_version) values (true, 13)
  on conflict (id) do update
    set schema_version = greatest(roamkeep_meta.schema_version, 13),
        updated_at = now();

commit;
