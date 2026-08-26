#!/usr/bin/env node
//
// create-roamkeep-server — stand up a family's own Roamkeep backend.
//
//   cd cli && npm install && npm start
//   npm start -- --project <ref>   # use an existing project
//   npm start -- --from 4          # resume from a step
//   npm start -- --upgrade <ref>   # bring an EXISTING family's database
//                                  # up to the current schema
//
// ⚠ NOT PUBLISHED TO NPM. `npx create-roamkeep-server` does not work and
// never has — the registry returns 404. This file used to print that
// command as its own resume advice, which sent owners to a package that
// does not exist at the exact moment they needed to continue. Do not
// reintroduce it; SELF below prints whatever actually launched the process,
// including the npx form if the package is ever published.
//
// WHY THIS EXISTS
// ---------------
// Roamkeep has no servers. Every family runs their own Supabase, which
// means every family has to perform about a dozen setup actions that were
// previously buried across the dashboard and a README. This does them.
//
// It also closes a genuine chicken-and-egg: the app picks its backend at
// runtime from a setup link, and the only other source of one is an
// existing owner's in-app Invite — so the FIRST device on a brand-new
// project had no way in. The last step here prints that first link.

import path from 'node:path';
import { intro, outro, text, select, confirm, spinner, isCancel, cancel, note, log } from '@clack/prompts';
import color from 'picocolors';
import QRCode from 'qrcode';
import { createClient, waitForProject, ApiError } from './api.js';
import * as steps from './steps.js';
import { buildSetupLink } from './link.js';
import { saveSetupFiles } from './setupfile.js';

const arg = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : null;
};
const FROM = Number(arg('from') || 1);

// `--upgrade <ref>` — the maintenance path for a project that already
// exists. It is a separate mode rather than a flag threaded through the
// provisioning flow because the two want opposite things: provisioning
// creates a project, configures auth and prints a first setup link;
// upgrading must not create anything, must not print a new link (the
// family already has one, and a second one only confuses), and needs to
// report what version it moved the database from and to.
const UPGRADE = arg('upgrade');

/**
 * How to invoke this program again — derived from how it was just invoked.
 *
 * Every "re-run with…" message below uses this. They used to hardcode
 * `npx create-roamkeep-server`, which has never been published: an owner
 * testing the setup path was told to resume with a command that answers
 * 404, at the one moment they had no other instruction to hand.
 *
 * Deriving it means the advice cannot drift from reality, and it stays
 * correct if the package is ever published — run through npx and the npx
 * form is what gets printed back.
 */
const SELF = (() => {
  const entry = process.argv[1] || '';
  // Installed as a bin (npx, or a global install).
  if (/[\\/]\.bin[\\/]/.test(entry)) return 'npx create-roamkeep-server';
  // `npm start` from a clone, which is what docs/OWNER_SETUP.md tells
  // owners to use. Printing the same shape they already typed.
  if (process.env.npm_lifecycle_event === 'start') return 'npm start --';
  // Run directly: node src/index.js, from wherever they happen to be.
  const rel = path.relative(process.cwd(), entry) || 'src/index.js';
  return `node ${rel.split(path.sep).join('/')}`;
})();

function bail(msg) {
  cancel(msg);
  process.exit(1);
}
const stop = (v) => { if (isCancel(v)) bail('Setup cancelled — nothing was left half-done that a re-run cannot fix.'); return v; };

/**
 * Run a step, but never let one failure end the whole setup.
 *
 * `--from N` exists to skip work that is already done. A step marked
 * `always` is exempt, because it does not *do* anything — it *reads*
 * something later output needs, and there is no such thing as having
 * already read it. Skipping one produces a run where every remaining step
 * passes and the wizard still cannot print the setup link, which is how
 * `--from 9` used to finish by asking for yet another run `--from 7`.
 */
async function step(n, label, fn, manualFallback, opts = {}) {
  if (n < FROM && !opts.always) {
    log.info(`${color.dim(`${n}.`)} ${label} ${color.dim('(skipped)')}`);
    return { skipped: true };
  }
  const s = spinner();
  s.start(`${n}. ${label}`);
  try {
    const out = await fn(s);
    s.stop(`${color.green('✓')} ${n}. ${label}`);
    return { ok: true, out };
  } catch (e) {
    s.stop(`${color.yellow('!')} ${n}. ${label} — ${e.message}`);
    if (manualFallback) {
      note(manualFallback, opts.always
        ? 'Do this by hand'
        : `Do this by hand, then re-run with --from ${n + 1}`);
    }
    return { ok: false, error: e };
  }
}

/**
 * Bring an existing family's database up to the current schema.
 *
 * Re-runnable and non-destructive — every step it calls already is, which
 * is what makes this mostly a new entry point rather than new logic.
 *
 * The version report is the point of it. "Applied the schema" tells an
 * owner nothing they can check; "11 → 12" is something they can hold
 * against what their family's app is asking for on its outdated screen.
 */
async function runUpgrade(api, ref) {
  if (!/^[a-z0-9]+$/.test(ref)) {
    bail(`That does not look like a Supabase project ref: ${ref}`);
  }

  note(
    'This brings an existing Roamkeep database up to the schema this\n' +
    'checkout ships. It is additive and non-destructive — no data is\n' +
    'dropped, and it is safe to run more than once.\n\n' +
    'Everyone in the family should update their app as well; the app tells\n' +
    'them when it needs a newer database than they have.',
    'Upgrading a family server',
  );

  const before = await steps.readSchemaVersion(api, ref).catch(() => null);
  log.info(`Project: ${color.cyan(`https://${ref}.supabase.co`)}`);
  log.info(`Current schema version: ${color.bold(before === null ? 'before versions were tracked' : before)}`);

  if (before !== null && before > steps.SCHEMA_VERSION) {
    bail(
      `That database is on schema version ${before}, but this checkout only knows ` +
      `about ${steps.SCHEMA_VERSION}. Pull the latest Roamkeep and try again — ` +
      `running an older schema against a newer database is not something this ` +
      `wizard will do.`);
  }

  await step(1, 'Enabling database extensions', () => steps.enableExtensions(api, ref));

  const applied = await step(2, 'Applying the current schema', () => steps.applySchema(api, ref),
    `Open the SQL editor for ${ref}, paste the contents of db/schema.sql, and run it.`);

  if (!applied.ok) {
    bail('The schema did not apply, so nothing else here would be meaningful. Fix the above and re-run.');
  }

  const verified = await step(3, 'Verifying the schema', () => steps.verifySchema(api, ref));

  await step(4, 'Recording the project URL', () => steps.setProjectUrl(api, ref),
    `Run this in the SQL editor for ${ref}:\n\n` +
    color.cyan(`  update roamkeep_meta set project_url = 'https://${ref}.supabase.co';`) + '\n\n' +
    'Without it the database cannot call its own Edge Function, so push\n' +
    'notifications stay silent.');

  await step(5, 'Re-wiring the check-in webhook', async () => {
    await steps.createWebhook(api, ref);
    await steps.verifyWebhook(api, ref);
  }, 'Dashboard → Database → Webhooks → create one on table "checkins", event Insert,\n' +
     'type "Supabase Edge Functions", function notify-checkin, method POST.');

  const fn = await step(6, 'Checking the notification function', () => steps.checkFunction(api, ref));
  if (!(fn.ok && fn.out === true)) {
    note(
      'The notify-checkin Edge Function is not deployed on this project.\n' +
      'Everything else works without it — you just get no push\n' +
      'notifications. To deploy, from the repo root:\n\n' +
      color.cyan('  npx supabase login') + '\n' +
      color.cyan(`  npx supabase link --project-ref ${ref}`) + '\n' +
      color.cyan('  npx supabase functions deploy notify-checkin --no-verify-jwt'),
      'Optional step still outstanding',
    );
  }

  const after = verified.ok && verified.out ? verified.out.version
    : await steps.readSchemaVersion(api, ref).catch(() => null);

  note(
    `Schema version: ${color.bold(before === null ? 'untracked' : before)} → ${color.bold(after ?? 'unknown')}\n\n` +
    (after === steps.SCHEMA_VERSION
      ? 'Your family server is up to date. Anyone stuck on the "server needs\nupdating" screen can reopen the app now.'
      : 'The version is not what this checkout expects — look at the warnings\nabove before telling the family it is done.'),
    'Result',
  );

  outro(color.green('Done.'));
}

async function main() {
  console.log('');
  intro(color.bgCyan(color.black(' create-roamkeep-server ')));

  if (!UPGRADE) note(
    'Roamkeep runs no servers. Your family gets its own private Supabase\n' +
    'project — your location data lives there, and nobody else (including\n' +
    'the people who wrote Roamkeep) can reach it.\n\n' +
    'This sets that up. It takes about five minutes, most of which is\n' +
    'waiting for the database to start.',
    'What this does',
  );

  // ── 1. Access token ────────────────────────────────────────────
  let token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    note(
      'Sign in at supabase.com, then create a token at:\n' +
      color.cyan('https://supabase.com/dashboard/account/tokens') + '\n\n' +
      'It is only used on this machine, to talk to your own account.',
      'You need a Supabase access token',
    );
    token = stop(await text({
      message: 'Paste your access token',
      validate: (v) => (!v || v.trim().length < 20 ? 'That does not look like a token' : undefined),
    })).trim();
  }

  const api = createClient(token);

  let orgs;
  {
    const s = spinner();
    s.start('Checking the token');
    try {
      orgs = await api.listOrganizations();
      s.stop(`${color.green('✓')} Token works`);
    } catch (e) {
      s.stop(`${color.red('✗')} Token rejected`);
      bail(e instanceof ApiError && e.status === 401
        ? 'That token was not accepted. Create a fresh one and try again.'
        : `Could not reach Supabase: ${e.message}`);
    }
  }
  if (!orgs?.length) bail('That account has no organizations — create one at supabase.com first.');

  // Maintenance mode diverges here: everything below creates or configures
  // a project, and an upgrade must do neither.
  if (UPGRADE) {
    await runUpgrade(api, UPGRADE);
    return;
  }

  // ── 2. Project: new or existing ────────────────────────────────
  let ref = arg('project');
  if (!ref) {
    const projects = await api.listProjects().catch(() => []);
    const choice = stop(await select({
      message: 'Which project should your Keep live in?',
      options: [
        { value: '__new__', label: 'Create a new project', hint: 'recommended' },
        ...projects.map((p) => ({
          value: p.id || p.ref,
          label: p.name,
          hint: `${p.region} · ${p.status}`,
        })),
      ],
    }));

    if (choice === '__new__') {
      const name = stop(await text({
        message: 'Name it',
        placeholder: 'roamkeep',
        defaultValue: 'roamkeep',
      }));
      const org = orgs.length === 1 ? orgs[0].id : stop(await select({
        message: 'Under which organization?',
        options: orgs.map((o) => ({ value: o.id, label: o.name })),
      }));
      const region = stop(await select({
        message: 'Where should the data live?',
        options: [
          { value: 'ap-southeast-2', label: 'Sydney' },
          { value: 'ap-southeast-1', label: 'Singapore' },
          { value: 'us-east-1', label: 'N. Virginia' },
          { value: 'us-west-1', label: 'N. California' },
          { value: 'eu-west-2', label: 'London' },
          { value: 'eu-central-1', label: 'Frankfurt' },
        ],
      }));
      // Never shown, never needed again — the wizard drives everything
      // through the Management API rather than a direct DB connection.
      const dbPass = [...crypto.getRandomValues(new Uint8Array(24))]
        .map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'[b % 56]).join('');

      const s = spinner();
      s.start('Creating the project');
      let created;
      try {
        created = await api.createProject({ name, organization_id: org, region, db_pass: dbPass });
      } catch (e) {
        s.stop(`${color.red('✗')} Could not create the project`);
        bail(e.message);
      }
      ref = created.id || created.ref;
      s.stop(`${color.green('✓')} Project created (${ref})`);

      note(
        `Database password (you will almost certainly never need it, but\n` +
        `nobody else has a copy):\n\n  ${color.dim(dbPass)}`,
        'Save this somewhere',
      );

      const w = spinner();
      w.start('Waiting for the database to start — usually 2-3 minutes');
      try {
        await waitForProject(api, ref, {
          onTick: (status, secs) => w.message(`Waiting for the database — ${status.toLowerCase()} (${secs}s)`),
        });
        w.stop(`${color.green('✓')} Database is up`);
      } catch (e) {
        w.stop(`${color.red('✗')} ${e.message}`);
        bail(`The project exists (${ref}) but did not come up. Check the dashboard, then re-run:\n  ${SELF} --project ${ref} --from 3`);
      }
    } else {
      ref = choice;
      const proceed = stop(await confirm({
        message: `This will apply the Roamkeep schema to ${ref}. It is non-destructive, but it does add tables. Continue?`,
      }));
      if (!proceed) bail('Nothing changed.');
    }
  }

  const projectUrl = `https://${ref}.supabase.co`;
  log.info(`Project: ${color.cyan(projectUrl)}`);

  // ── 3-8. Provisioning ──────────────────────────────────────────
  const results = {};

  results.ext = await step(3, 'Enabling database extensions', () => steps.enableExtensions(api, ref));
  if (results.ext.ok && !results.ext.out.pg_cron) {
    log.warn('pg_cron unavailable — old breadcrumbs will be pruned by the app rather than the server. Harmless.');
  }

  results.schema = await step(4, 'Applying the Roamkeep schema', () => steps.applySchema(api, ref),
    `Open the SQL editor for ${ref}, paste the contents of db/schema.sql, and run it.`);

  // Also enter it when step 4 was skipped, so step() prints "(skipped)"
  // rather than 5 silently vanishing from the list and looking like a
  // numbering bug in a resumed run.
  if (results.schema.ok || results.schema.skipped) {
    await step(5, 'Verifying the schema', () => steps.verifySchema(api, ref));
  }

  results.auth = await step(6, 'Turning off email confirmation', () => steps.configureAuth(api, ref),
    'Dashboard → Authentication → Providers → Email → turn OFF "Confirm email".\n' +
    'Without this, family members get stuck waiting for an email the project cannot send.');

  // The anon key is what the setup link carries. This is a read with no
  // side effects, so it runs on every resume — see `always` in step().
  let anonKey = null;
  await step(7, 'Reading the project API keys', async () => {
    anonKey = await steps.getAnonKey(api, ref);
    return true;
  },
    'Dashboard → Project Settings → API → copy the anon key, then build the\n' +
    'link yourself from the repo root:\n\n' +
    color.cyan(`  node tools/setup-link.js --url ${projectUrl} --key <anon-key>`),
    { always: true });

  // setProjectUrl belongs to this step rather than a step of its own: it
  // is what the trigger needs in order to reach the Edge Function, and a
  // separate number would have renumbered every "--from N" already in the
  // docs and in this file's own resume advice.
  await step(8, 'Wiring the check-in webhook', async () => {
    await steps.setProjectUrl(api, ref);
    await steps.createWebhook(api, ref);
    await steps.verifyWebhook(api, ref);
  }, 'Dashboard → Database → Webhooks → create one on table "checkins", event Insert,\n' +
     'type "Supabase Edge Functions", function notify-checkin, method POST.\n' +
     'Then, in the SQL editor:\n\n' +
     `  update roamkeep_meta set project_url = 'https://${ref}.supabase.co';`);

  // ── 9. Edge function (needs the supabase CLI) ──────────────────
  const fn = await step(9, 'Checking the notification function', () => steps.checkFunction(api, ref));
  const fnDeployed = fn.ok && fn.out === true;

  if (!fnDeployed) {
    note(
      'Arrive/leave notifications need one Edge Function, and deploying it\n' +
      'requires the Supabase CLI (it bundles the code). Run these ' +
      color.bold('from the repo root') + ':\n\n' +
      color.cyan(`  npx supabase login`) + '\n' +
      color.cyan(`  npx supabase link --project-ref ${ref}`) + '\n' +
      color.cyan(`  npx supabase functions deploy notify-checkin --no-verify-jwt`) + '\n\n' +
      color.bold('Check the link took before deploying.') + ' `functions deploy` targets\n' +
      'whichever project is linked, and says nothing if that is the wrong\n' +
      'one — it will happily deploy somewhere else and report success.\n' +
      `The file supabase/.temp/linked-project.json should say ${ref}.\n\n` +
      'Then re-run this to confirm and get your setup QR:\n\n' +
      color.cyan(`  ${SELF} --project ${ref} --from 9`) + '\n\n' +
      'Everything else already works without it — you just will not get\n' +
      'push notifications until it is deployed.',
      'One manual step left',
    );
  } else {
    // Deploying to the WRONG project is the likely failure here, and it
    // is silent: the CLI targets whatever is linked and reports success.
    // Probing the project we just provisioned turns that into a clear
    // message rather than push mysteriously never working.
    await step(10, 'Checking the function answers on THIS project', async () => {
      const r = await steps.probeFunction(ref);
      if (r.status === 404) {
        throw new Error(
          `not found on ${ref} — it was probably deployed to a different project. ` +
          `Re-link to ${ref} and deploy again.`);
      }
      if (!r.ok) throw new Error(`function returned ${r.status}`);
      return r;
    }, `The function is not answering on ${ref}.\n` +
       `Check supabase/.temp/linked-project.json says ${ref}, re-link if not,\n` +
       `then deploy again and re-run with --from 9.`);
  }

  // ── Final: the setup link ──────────────────────────────────────
  // Step 7 runs on every invocation, so an absent key means reading it
  // actually failed — another re-run would not help. Point at the manual
  // route instead of asking for one.
  if (!anonKey) {
    outro('Everything else is set up. The setup link needs the anon key — build it with the command shown above.');
    return;
  }

  const link = buildSetupLink(projectUrl, anonKey);
  console.log('');
  console.log(await QRCode.toString(link, { type: 'terminal', small: true }));

  const saved = await saveSetupFiles(ref, projectUrl, link);

  note(
    `${color.bold('Scan that QR with the Roamkeep app')} (Connect screen → Scan setup\n` +
    `QR code), or paste this link into it:\n\n${link}\n\n` +
    `The first person to connect creates the Keep and becomes its owner.\n` +
    `Everyone else joins from an invite shared inside the app.`,
    'Your family server is ready',
  );

  if (saved.ok) {
    note(
      `${color.bold(saved.txt)}\n` +
      (saved.pngOk ? `${color.bold(saved.png)}\n` : '') +
      `\nSaved in ${saved.dir}\n\n` +
      `The QR above dies with this terminal window, and the link is the only\n` +
      `way onto your server — so keep ${saved.pngOk ? 'these' : 'this'}.` +
      (saved.pngOk
        ? ` Open the .png on a laptop\nto scan it with another phone later.`
        : `\n(The QR image could not be written, but the .txt has the link.)`),
      'Written to disk',
    );
  } else {
    note(
      `Could not write the setup files (${saved.err}).\n\n` +
      `${color.bold('Copy the link above before closing this window')} — it is the only\n` +
      `way onto your server, and this terminal is currently the only place\n` +
      `it exists. You can always read the anon key back from\n` +
      `Dashboard → Project Settings → API.`,
      color.yellow('Save the link yourself'),
    );
  }
  note(
    'This link contains your project address and its public anon key.\n' +
    'The key is public by design — the database is protected by row-level\n' +
    'security, not by hiding it — but anyone with the link can reach your\n' +
    "Keep's sign-up screen. Share it like an address, not a password.",
    'About that link',
  );

  // Asked for here rather than in the app, for two reasons. This is the
  // moment someone has just watched their own backend come up and grasped
  // that nobody is going to bill them for it — a better ask than a README
  // section. And it is outside the Play package, so it cannot run into
  // Google's payments policy on in-app donations.
  //
  // Built from an array rather than concatenated strings with escaped
  // newlines: the escapes did not survive being patched in through a shell
  // and left literal line breaks inside string literals, which stopped the
  // whole wizard from parsing. Nothing here needs an escape sequence now.
  note([
    'Roamkeep is free, has no paid features and no hosted tier. If it is',
    'useful to your family, you can help cover the push relay and keep',
    'development going:',
    '',
    '  ' + color.cyan('https://github.com/sponsors/roamkeep'),
    '  ' + color.cyan('https://ko-fi.com/roamkeep'),
    '',
    'Entirely optional — nothing here is gated behind it.',
  ].join('\n'), 'If you want to support it');

  outro(color.green('Done.'));
}

main().catch((e) => {
  console.error('\n' + color.red('Unexpected error:'), e?.message || e);
  console.error(color.dim('Re-run with --from <step> to resume, or --project <ref> to reuse the project.'));
  process.exit(1);
});
