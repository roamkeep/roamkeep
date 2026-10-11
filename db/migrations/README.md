# Database versions

There are no migration files to run. Every way an owner updates runs
[`../schema.sql`](../schema.sql) itself: the app's **Settings → Family
server → Update**, the wizard's `--upgrade`, and pasting the file into the
Supabase SQL editor. It is idempotent, so the same file sets up a fresh
project and updates an existing one. A second copy of a thousand lines of
function bodies would only be a place for the two to drift, which is the
failure `webhookSql()` exists to prevent for one function.

## Schema versions and app compatibility

The database publishes its own version (`roamkeep_schema_version()`), and
`schema.sql` sets it **as its last statement**, so an update that stops
partway reports the old number rather than claiming a state it did not
reach.

| schema_version | Released with | What it changes |
|---|---|---|
| 17 | 4.11.0 | Owner approval of joins, the in-app switch for new accounts, password reset without email, and account deletion. The app shows them once the server is on 17. Checked by `../tests/v17-verify.sql` |
| 18 | 4.11.1 | Leaving, removal and a completed child deletion request delete the sign-in too; reset codes are checked again when used; a pending member is refused by every function, not only by the policies. All server-side, so it protects every app version. Checked by `../tests/v18-verify.sql` |
| 19 | 4.11.2 | An owner's Decline deletes the account made to ask and changes the join code. Checked by `../tests/v19-verify.sql` |

What each version adds is listed in [`../../CHANGELOG.md`](../../CHANGELOG.md).

**On 17,** existing members stay approved (`keep_members.approved` defaults
to true), existing Keeps start with approval off, and new accounts stay open
unless the dashboard switch was already off, in which case the update hands
it to the app, still closed.

**On 18,** one behaviour changes for every app version at once: removing a
member, leaving, and completing a child's deletion request delete the
person's sign-in too, not only their membership. Bringing someone back
means inviting them again with sign-ups open, which the invite share already
offers.

`roamkeep_schema_version()` returns a **number, not a verdict**. That is
deliberate and should stay that way: a database that answered
"compatible: yes/no" would bake one client's policy into every family's
server, and changing that policy later would become an update for all of
them. Returning the number lets each build decide for itself, and lets a
future build decide *per feature* with no server change.
