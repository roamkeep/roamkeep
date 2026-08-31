-- v14 — pin the columns RLS cannot, authenticate the webhooks, move push tokens
--
-- Runs against an EXISTING live database. Idempotent and safe to re-run.
-- Sets schema_version = 14. REQUIRES v13.
--
-- NOT purely additive: it drops keep_members.fcm_token (see §5). Read that
-- section before running this on a database whose clients you do not control.
-- On this deployment the clients are three known projects in closed testing,
-- which is the only reason the contract step is folded in here rather than
-- deferred by months.
--
-- ── What it closes ──────────────────────────────────────────────
--
--   1. keep_members.keep_id / .user_id were writable through the own-row
--      UPDATE policy, whose WITH CHECK constrains user_id and nothing else.
--      A member could call create_keep (which seats them as role='owner')
--      and then move that owner row into any keep whose uuid they knew,
--      skipping the invite code, the 72h expiry, the join rate limiter and
--      remove_member in a single PATCH.
--
--   2. keep_places.created_by / .keep_id were writable the same way, so a
--      member could rewrite who created a place, or move it between keeps.
--
--   3. The checkins INSERT policy checked only keep_id, so any member could
--      file a check-in as somebody else — including type='sos', which is
--      exempt from every mute and wakes every phone in the family.
--
--   4. Both Edge Functions are deployed --no-verify-jwt and the triggers sent
--      no credential, so anyone who knew the project ref could invoke them.
--
--   5. Every member could read every other member's FCM token, because RLS
--      cannot restrict columns and the keep_members SELECT policy is
--      keep-wide.
--
-- ── Why RLS alone cannot do 1 and 2 ─────────────────────────────
--
-- An UPDATE policy's WITH CHECK expression only ever sees the NEW row, so it
-- cannot say "this column must equal what it was". There is no correlation
-- with OLD available inside a policy. Pinning created_by to auth.uid()
-- instead would be worse: it would force whoever edits a place to become its
-- creator, which is the exact rewrite being prevented. Hence triggers.

begin;


-- ── 1. Widen the member-column guard (F2) ───────────────────────
--
-- Same trigger, two more columns. CREATE OR REPLACE keeps the function's
-- OID, so trg_guard_member_cols continues to point at it and needs no
-- recreation.
--
-- The DEFINER RPCs that legitimately move role / member_type / paused_until
-- set roamkeep.priv and are unaffected. create_keep and join_keep_by_code
-- INSERT rather than UPDATE, so they never reach this trigger at all.

create or replace function _roamkeep_guard_member_cols()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if (new.role         is distinct from old.role
      or new.member_type  is distinct from old.member_type
      or new.paused_until is distinct from old.paused_until
      or new.keep_id      is distinct from old.keep_id
      or new.user_id      is distinct from old.user_id)
     and coalesce(current_setting('roamkeep.priv', true), '') <> 'on' then
    raise exception 'protected_column';
  end if;
  return new;
end;
$fn$;


-- ── 2. Guard the place columns (F11) ────────────────────────────
--
-- created_by exists for attribution, and keep_id decides which family a
-- place belongs to. Neither is something an edit should be able to move.
-- Any member may still edit any place in their keep — name, icon, radius,
-- position — which is the family model and is unchanged.
--
-- Raises rather than silently restoring, matching the member guard. That is
-- safe because updatePlace() in app.js builds a narrow patch of
-- name/icon/radius/lat/lng and never sends either column, so no legitimate
-- client path can trip it. No roamkeep.priv escape hatch: unlike the member
-- columns, no DEFINER RPC has any business moving these.

create or replace function _roamkeep_guard_place_cols()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if new.created_by is distinct from old.created_by
     or new.keep_id is distinct from old.keep_id then
    raise exception 'protected_column';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_guard_place_cols on keep_places;
create trigger trg_guard_place_cols
  before update on keep_places
  for each row execute function _roamkeep_guard_place_cols();


-- ── 3. Bind a check-in to the member filing it (F4) ─────────────
--
-- Mirrors what the location_history INSERT policy has always done. Both
-- writers already send only their own member_id — app.js and
-- GeofenceReceiver.java — so nothing legitimate changes.

drop policy if exists "Keep members can insert checkins" on checkins;
create policy "Keep members can insert checkins"
  on checkins for insert to authenticated
  with check (
    keep_id in (select private_user_keep_ids())
    and member_id in (select id from keep_members where user_id = auth.uid())
  );


-- ── 4. A webhook secret the database issues itself (F5) ─────────
--
-- NOT in roamkeep_meta: that table is deliberately readable by anon so the
-- version check can run before sign-in, and the anon key is in every setup
-- link. A secret there would be world-readable.
--
-- RLS on with NO policies — default deny for anon and authenticated, the
-- same pattern keep_join_attempts uses. Only the SECURITY DEFINER trigger
-- functions read it, as the owner, and the Edge Functions read it with the
-- service-role key they already hold.
--
-- Self-seeding, so there is nothing for an owner to generate, copy or set.
-- An owner who never touches a dashboard still gets an authenticated webhook.

create table if not exists roamkeep_secrets (
  id             boolean primary key default true check (id),
  webhook_secret text not null,
  created_at     timestamptz not null default now()
);
alter table roamkeep_secrets enable row level security;

insert into roamkeep_secrets (id, webhook_secret)
values (true, encode(gen_random_bytes(32), 'hex'))
on conflict (id) do nothing;


-- keep_places → notify-places. Always the roamkeep_meta-reading version, so
-- this is an unconditional replace.
create or replace function public.roamkeep_notify_places()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, net
as $fn$
declare
  v_url text;
  v_secret text;
  v_row jsonb;
  v_old jsonb;
  v_ret record;
begin
  if tg_op = 'DELETE' then v_ret := old; else v_ret := new; end if;

  select project_url into v_url from roamkeep_meta;
  if v_url is null then
    return v_ret;
  end if;
  select webhook_secret into v_secret from roamkeep_secrets;

  if tg_op = 'DELETE' then
    v_row := null;
    v_old := to_jsonb(old);
  else
    v_row := to_jsonb(new);
    v_old := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  end if;

  perform net.http_post(
    url     := v_url || '/functions/v1/notify-places',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-roamkeep-webhook', coalesce(v_secret, '')
               ),
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
  return v_ret;
end;
$fn$;

revoke all on function public.roamkeep_notify_places() from public, anon, authenticated;


-- checkins → notify-checkin. CONDITIONAL, and this is the load-bearing part.
--
-- db/schema.sql refuses to replace this function if it already exists,
-- because a copy created by the setup wizard has the project URL baked into
-- its body and works; replacing it with a roamkeep_meta-reading version
-- would kill that family's push for as long as project_url stayed NULL.
--
-- The same hazard applies here, so replace only when project_url is set —
-- at which point the meta-reading version is known to work. A database that
-- has not set it keeps its working trigger and simply does not gain the
-- header; the Edge Function's check is written to stay open in that case, so
-- the two degrade together rather than locking each other out.
do $do$
begin
  if (select project_url from roamkeep_meta) is not null then
    execute $body$
      create or replace function public.roamkeep_notify_checkin()
        returns trigger
        language plpgsql
        security definer
        set search_path = public, net
      as $fn$
      declare
        v_url text;
        v_secret text;
      begin
        select project_url into v_url from roamkeep_meta;
        if v_url is null then return new; end if;
        select webhook_secret into v_secret from roamkeep_secrets;
        perform net.http_post(
          url     := v_url || '/functions/v1/notify-checkin',
          headers := jsonb_build_object(
                       'Content-Type', 'application/json',
                       'x-roamkeep-webhook', coalesce(v_secret, '')
                     ),
          body    := jsonb_build_object(
                       'type', 'INSERT', 'table', 'checkins', 'schema', 'public',
                       'record', to_jsonb(new), 'old_record', null),
          timeout_milliseconds := 5000
        );
        return new;
      exception when others then
        return new;
      end;
      $fn$;
    $body$;
    execute 'revoke all on function public.roamkeep_notify_checkin() from public, anon, authenticated';
    execute 'drop trigger if exists on_checkin_notify on public.checkins';
    execute 'create trigger on_checkin_notify after insert on public.checkins '
         || 'for each row execute function public.roamkeep_notify_checkin()';
  else
    raise notice 'roamkeep_meta.project_url is NULL — leaving roamkeep_notify_checkin alone. Set it (the owner''s app does this automatically) and re-run this migration to add the webhook secret.';
  end if;
end
$do$;


-- ── 5. Push tokens out of the keep-wide row (F7) ────────────────
--
-- keep_members is readable across the whole keep and RLS cannot restrict
-- columns, so every member could read every relative's FCM registration
-- token. On its own that is inert; combined with an unauthenticated relay it
-- is the ability to wake or drain a specific person's phone at will.
--
-- This is a CONTRACT step — it drops a column. It is safe here only because
-- the backfill below copies every live token first, so a device still on the
-- previous app build keeps receiving push on the token it already
-- registered; what it loses is the ability to register a NEW one. With three
-- known deployments in closed testing that window is acceptable and bounded.
-- It would not be after public release.

create table if not exists keep_member_push (
  member_id  uuid primary key references keep_members(id) on delete cascade,
  keep_id    uuid not null references keeps(id) on delete cascade,
  fcm_token  text,
  updated_at timestamptz not null default now()
);
alter table keep_member_push enable row level security;

create index if not exists idx_member_push_keep
  on keep_member_push(keep_id) where fcm_token is not null;

-- Own row only. Deliberately no keep-wide SELECT — that is the whole point.
-- Both Edge Functions run as service_role and bypass RLS, so neither needs a
-- policy here.
drop policy if exists "Members manage own push row" on keep_member_push;
create policy "Members manage own push row"
  on keep_member_push for all to authenticated
  using      (member_id in (select id from keep_members where user_id = auth.uid()))
  with check (member_id in (select id from keep_members where user_id = auth.uid()));

-- Backfill BEFORE the drop. Guarded so a re-run after the column is gone
-- does not fail.
do $do$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'keep_members'
       and column_name  = 'fcm_token'
  ) then
    execute $body$
      insert into keep_member_push (member_id, keep_id, fcm_token)
      select id, keep_id, fcm_token
        from keep_members
       where fcm_token is not null
      on conflict (member_id) do update
        set fcm_token = excluded.fcm_token,
            updated_at = now()
    $body$;
  end if;
end
$do$;

-- Recipients for one check-in, now reading the side table. Same signature,
-- same mute rule — only the source of the token changes.
create or replace function checkin_recipients(p_checkin uuid)
returns table (member_id uuid, fcm_token text)
language sql
security definer
set search_path = public
stable
as $fn$
  select m.id, p.fcm_token
  from checkins c
  join keep_members m     on m.keep_id = c.keep_id
  join keep_member_push p on p.member_id = m.id
  where c.id = p_checkin
    and m.id <> c.member_id
    and p.fcm_token is not null
    and (
      c.type = 'sos'
      or (
        m.notify_on_checkin
        and (
          c.place_id is null
          or not exists (
            select 1 from keep_notify_prefs k
            where k.member_id = m.id
              and k.subject_member_id = c.member_id
              and k.place_id = c.place_id
          )
        )
      )
    )
$fn$;

revoke all on function public.checkin_recipients(uuid) from public, anon, authenticated;
grant execute on function public.checkin_recipients(uuid) to service_role;

-- Recipients for a place change: everyone in the keep with a token,
-- including whoever made the change, and ignoring notify_on_checkin — this
-- is a data sync, not a notification, and muting alerts must not leave a
-- phone holding stale geofences.
--
-- Exists because notify-places used to select keep_members.fcm_token
-- directly, which stops being possible below.
create or replace function keep_push_recipients(p_keep uuid)
returns table (member_id uuid, fcm_token text)
language sql
security definer
set search_path = public
stable
as $fn$
  select p.member_id, p.fcm_token
    from keep_member_push p
   where p.keep_id = p_keep
     and p.fcm_token is not null
$fn$;

revoke all on function public.keep_push_recipients(uuid) from public, anon, authenticated;
grant execute on function public.keep_push_recipients(uuid) to service_role;

-- And now the column goes. The partial index over it goes with it.
drop index if exists idx_keep_members_keep_token;
alter table keep_members drop column if exists fcm_token;


-- ── 6. Leaving a Keep (F14 — a published claim that was not true) ──
--
-- landing/privacy has always said "Leaving a Keep removes your membership
-- and your location history". Nothing in the app could do it: there was no
-- action, no button, and no client code path that deleted a member row.
-- Signing out only sets online=false. The only member deletion anywhere was
-- remove_member(), the owner kicking somebody else, which explicitly
-- refuses cannot_remove_self.
--
-- The RLS policy "Adults can delete own member row" made it *possible* in
-- principle, and that is exactly the wrong shape for this: it cannot
-- express "unless you are the last owner", and a bare DELETE grant is a
-- capability the client never otherwise needs. So it goes, and the rule
-- lives in a DEFINER RPC instead — the same move v8 made when it dropped
-- the direct-INSERT policies in favour of create_keep / join_keep_by_code.
--
-- Three rules, all enforced here rather than trusted from the caller:
--   • a child cannot leave (the v8 deterrent, unchanged);
--   • the last owner cannot leave, because that would strand the keep, its
--     places and everyone still in it with nobody able to administer them.
--     Their exit is deleting the Supabase project, which the privacy page
--     already describes;
--   • you can only leave as yourself.

drop policy if exists "Adults can delete own member row" on keep_members;

create or replace function leave_keep(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_member keep_members%rowtype;
  v_owner_count int;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_member from keep_members where id = p_member_id;
  if not found then
    raise exception 'member_not_found';
  end if;
  if v_member.user_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  if v_member.member_type = 'child' then
    raise exception 'child_cannot_leave';
  end if;

  if v_member.role = 'owner' then
    select count(*) into v_owner_count
      from keep_members
     where keep_id = v_member.keep_id and role = 'owner';
    if v_owner_count <= 1 then
      raise exception 'last_owner';
    end if;
  end if;

  -- Explicit, though location_history cascades off the member row anyway:
  -- this is the line that makes the privacy claim true, and it should be
  -- visible here rather than depending on a foreign key someone might
  -- later change. checkins, keep_member_push and keep_notify_prefs go with
  -- the row by cascade.
  delete from location_history where member_id = v_member.id;
  delete from keep_members where id = v_member.id;
end;
$fn$;

revoke all on function leave_keep(uuid) from public, anon;
grant execute on function leave_keep(uuid) to authenticated;


-- ── 7. Stamp the version ────────────────────────────────────────
-- LAST statement. A half-applied migration leaves the old number, so the
-- client correctly refuses rather than assuming it got what it asked for.

insert into roamkeep_meta (id, schema_version) values (true, 14)
  on conflict (id) do update
    set schema_version = greatest(roamkeep_meta.schema_version, 14),
        updated_at = now();

commit;
