-- v12 — schema version marker + compatibility metadata
--
-- Runs against an EXISTING live database. Idempotent and non-destructive;
-- safe to re-run. Purely additive: it creates one table and three
-- functions and touches nothing that already exists, so every currently
-- installed app keeps working unchanged after it is applied.
--
-- Sets schema_version = 12.
--
-- ── Why this exists ─────────────────────────────────────────────
--
-- Every family runs their own Supabase. Until now there has been no way
-- for an app to know whether the database it is pointed at is new enough
-- for the code in the build: verifyBackend() pings /auth/v1/health, which
-- proves the project exists and says nothing about its schema. So a build
-- that needs a column the database lacks does not report that — it fails
-- at whichever of the ~36 call sites happens to need the missing thing.
--
-- Two things make that worse than "the user sees an error":
--
--   * The break is per-MEMBER, not per-family. The owner migrates the
--     database; each member's app updates on Google's schedule. You never
--     get "old app + old DB" cleanly followed by "new app + new DB" — you
--     get a MIX of app versions against one database, for days. Ordering
--     the owner's migration correctly does not save you.
--
--   * The native path fails silently. SupabaseRest writes check-ins and
--     breadcrumbs from Java with no screen; a rejected write is a Log.w.
--     Arrive/leave alerts and trails just stop.
--
-- ── The one design rule ─────────────────────────────────────────
--
-- roamkeep_schema_version() returns a NUMBER, never a verdict.
--
-- A database that answers "compatible: yes/no" bakes the client policy of
-- the day into every family's server, and changing that policy later
-- becomes a migration for all of them. A database that answers `12` lets
-- each build decide for itself — and lets a future build decide PER
-- FEATURE (`if (v >= 13) useNewThing() else fallback()`) with no server
-- change at all. Do not add a boolean here later.

begin;

-- ── roamkeep_meta ───────────────────────────────────────────────
-- Exactly one row, enforced by the primary key: `id boolean PRIMARY KEY
-- DEFAULT true CHECK (id)` admits only the value true, so a second INSERT
-- is a primary-key conflict rather than a silently divergent second row.
create table if not exists roamkeep_meta (
  id             boolean primary key default true check (id),
  schema_version integer not null,
  -- Advisory only. Lets a migration say "builds below N no longer work"
  -- so the client can show an update banner. Deliberately NOT enforced as
  -- a hard block: unlike the schema direction, there is nothing the owner
  -- can do about a member whose Play update has not rolled out yet.
  min_app_build  integer not null default 0,
  -- The project's own https://<ref>.supabase.co. The webhook trigger
  -- functions need it to call their Edge Functions, and this file cannot
  -- know it when pasted into a SQL editor. Set by the provisioning
  -- wizard, by set_project_url() on the owner's next app open, or by
  -- hand. Triggers no-op while it is NULL.
  project_url    text,
  updated_at     timestamptz not null default now()
);

alter table roamkeep_meta enable row level security;

-- Readable by everyone including anon: the version check runs at connect
-- time, before sign-in, so it cannot require a session. There is nothing
-- sensitive here — it is the schema's own version number. Writes are not
-- granted to anyone; the column is set by the wizard (service role) or by
-- set_project_url() below.
drop policy if exists "Anyone can read schema metadata" on roamkeep_meta;
create policy "Anyone can read schema metadata"
  on roamkeep_meta for select to anon, authenticated
  using (true);


-- ── The version check ───────────────────────────────────────────
create or replace function roamkeep_schema_version()
returns table (schema_version integer, min_app_build integer)
language sql
security definer
set search_path = public
stable
as $$
  select m.schema_version, m.min_app_build from roamkeep_meta m
$$;

-- This is one of the few functions that SHOULD be anon-callable — the
-- check runs before sign-in. Stated explicitly so it reads as a decision
-- rather than as an oversight of the v10 advisor cleanup.
revoke all on function public.roamkeep_schema_version() from public;
grant execute on function public.roamkeep_schema_version() to anon, authenticated;


-- ── project_url, set once by the owner ──────────────────────────
--
-- Closes a chicken-and-egg: the webhook triggers need the project's own
-- URL, and an owner who upgraded by pasting schema.sql into the dashboard
-- never told the database what it is. The client knows — it is the URL it
-- connected to — so the owner's next app open can fill it in.
--
-- Two constraints, both load-bearing:
--
--   * Owner only. Checked against keep_members.role, not trusted from the
--     caller.
--   * The value must look like a Supabase project URL. The database POSTs
--     to whatever is stored here, so an unconstrained client-writable
--     endpoint would be an SSRF hole. The regex is applied HERE, in the
--     client-callable path, and deliberately NOT as a CHECK on the column
--     — a self-hoster on a custom domain must still be able to set one by
--     direct SQL from the dashboard.
--
-- Write-once: it will not overwrite a value that is already set, so the
-- wizard's value always wins over a client's.
create or replace function set_project_url(p_url text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_owner boolean;
begin
  if p_url is null or p_url !~ '^https://[a-z0-9]+\.supabase\.co$' then
    return false;
  end if;

  select exists (
    select 1 from keep_members
    where user_id = auth.uid() and role = 'owner'
  ) into v_is_owner;

  if not v_is_owner then
    return false;
  end if;

  update roamkeep_meta
     set project_url = p_url, updated_at = now()
   where project_url is null;

  return found;
end$$;

revoke all on function public.set_project_url(text) from public, anon;
grant execute on function public.set_project_url(text) to authenticated;


-- ── Stamp the version ───────────────────────────────────────────
-- LAST statement, deliberately. If anything above fails the transaction
-- rolls back and the version is untouched, so a half-applied migration
-- reports the OLD version and the client correctly refuses rather than
-- assuming it got what it asked for.
insert into roamkeep_meta (id, schema_version) values (true, 12)
  on conflict (id) do update
    set schema_version = greatest(roamkeep_meta.schema_version, 12),
        updated_at = now();

commit;
