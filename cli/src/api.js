// The Node shell's transport for the provisioning engine (engine.js).
//
// All the Management API logic lives in engine.js, which the app also
// runs; this file only supplies Node's fetch as the engine's `http`.
// Deliberately no supabase CLI and no Docker: a family setting up their
// own server should need Node and a browser, nothing else — and since
// Edge Functions now deploy through the API too, that is finally true.

import { createClient as createEngineClient, waitForProject, ApiError } from './engine.js';

export { waitForProject, ApiError };

/** fetch, in the shape the engine asks for. */
export async function nodeHttp({ method, url, headers, body }) {
  const res = await fetch(url, { method, headers, body });
  return { status: res.status, text: await res.text() };
}

export function createClient(token) {
  return createEngineClient({ token, http: nodeHttp });
}
