// The provisioning steps, as the Node wizard calls them.
//
// The logic is in engine.js, shared with the app's phone setup. What this
// file adds is the one thing only the desktop has: reading the inputs —
// db/schema.sql and the Edge Function sources — from disk, and binding
// them into the engine's steps so index.js can keep calling (api, ref).
//
// Inputs come from cli/assets/ when it exists (an npm package, populated
// by `npm pack` / prepack) and from the repo otherwise (a clone or ZIP).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from './engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKED = path.join(HERE, '..', 'assets');
const REPO = path.join(HERE, '..', '..');
const fromPack = fs.existsSync(path.join(PACKED, 'schema.sql'));

const schemaPath = fromPack ? path.join(PACKED, 'schema.sql') : path.join(REPO, 'db', 'schema.sql');
const functionsDir = fromPack ? path.join(PACKED, 'functions') : path.join(REPO, 'supabase', 'functions');

export const readSchema = () => fs.readFileSync(schemaPath, 'utf8');

export const readFunction = (slug = 'notify-checkin') =>
  fs.readFileSync(path.join(functionsDir, slug, 'index.ts'), 'utf8');

/** Every function's own source files, in the shape engine.deployFunctions takes. */
export function readFunctions() {
  const out = {};
  for (const slug of engine.FUNCTIONS) {
    const dir = path.join(functionsDir, slug);
    const names = fs.readdirSync(dir).filter((f) => /\.(ts|json)$/.test(f)).sort();
    out[slug] = {
      files: names.map((name) => ({ name, content: fs.readFileSync(path.join(dir, name), 'utf8') })),
      importMap: names.includes('deno.json') ? 'deno.json' : undefined,
    };
  }
  return out;
}

export const SCHEMA_VERSION = engine.SCHEMA_VERSION;
export const FUNCTIONS = engine.FUNCTIONS;

export const enableExtensions = engine.enableExtensions;
export const readSchemaVersion = engine.readSchemaVersion;
export const verifySchema = engine.verifySchema;
export const setProjectUrl = engine.setProjectUrl;
export const configureAuth = engine.configureAuth;
export const verifyWebhook = engine.verifyWebhook;
export const checkFunction = engine.checkFunction;
export const probeFunction = engine.probeFunction;
export const openSignupWindow = engine.openSignupWindow;
export const handOverSignups = engine.handOverSignups;
export const checkUpgradeable = engine.checkUpgradeable;
export const getClientKey = engine.getClientKey;
/** The old name, kept for existing callers: it now also accepts sb_publishable_. */
export const getAnonKey = engine.getClientKey;

export const applySchema = (api, ref) => engine.applySchema(api, ref, readSchema());
export const webhookSql = () => engine.webhookSql(readSchema());
export const createWebhook = (api, ref) => engine.createWebhook(api, ref, readSchema());
export const deployFunctions = (api, ref) => engine.deployFunctions(api, ref, readFunctions());
