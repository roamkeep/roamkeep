# Database migrations (historical)

These are the numbered SQL migrations as they were applied, in order, to
the live Supabase project over the life of the app. They're kept as the
historical record and as the per-delta upgrade path for a database
that's already on an older version.

| File | What it does |
|---|---|
| `familynest-schema-secure-v2.sql` | Base tables (`nests`, `nest_members`, `checkins`) + RLS + realtime. **Destructive** — drops and recreates. |
| `familynest-schema-v3-migration.sql` | Tightens the `nests` SELECT policy, adds CHECK constraints, adds the `create_nest` / `join_nest_by_code` SECURITY DEFINER RPCs. |
| `familynest-schema-v4-places.sql` | `nest_places` table + RLS, `nest_members.last_place_id`, extends `checkins.type` with `'left'`, adds `nest_places` to realtime. |
| `familynest-schema-v4_1-replica-identity.sql` | `REPLICA IDENTITY FULL` on `nest_places` so realtime DELETE events carry `nest_id`. |
| `familynest-schema-v5-push.sql` | `nest_members.fcm_token` + `notify_on_checkin` + partial index for the push fan-out. |
| `familynest-schema-v6-location-history.sql` | `location_history` table (per-member breadcrumb trail, ~24h) + RLS + realtime. |
| `familynest-schema-v7-history-timeline.sql` | `location_history.speed` column, retention 24h → 7 days (pg_cron sweep), `checkins` member+time index for the history timeline. |
| `familynest-schema-v8-roles-and-invite-security.sql` | `member_type`/`role`/`paused_until`, crypto invite codes + 72h expiry, join-attempt rate limiting, owner-only rotate/kick/role RPCs. |
| `familynest-schema-v8_1-fix-rls-recursion.sql` | Breaks the membership-policy recursion introduced by v8. |
| `familynest-schema-v8_2-owner-only-member-type.sql` | Restricts `set_member_type` to the Keep owner. |
| `familynest-schema-v9-keeps-rename.sql` | **Breaking.** Renames `nest*` → `keep*` throughout — tables, `nest_id` columns, functions, indexes, cron job. Must be followed immediately by `../schema.sql`, and every client must be on 4.5.0+. |

## For a fresh project, don't run these

Run [`../schema.sql`](../schema.sql) instead — it's the consolidated,
idempotent, non-destructive equivalent of all of the above in one file.
Apply these numbered files only when stepping an existing database from
one version to the next.

**Names before v9:** everything up to and including v8_2 says `nests`,
`nest_members`, `nest_places`, `nest_id`. That is not a typo — it is what
was actually applied. v9 is the rename, and `../schema.sql` has said
`keep*` since.
