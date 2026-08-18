// Thin wrapper over the Supabase Management API.
//
// Deliberately no supabase CLI and no Docker: a family setting up their
// own server should need Node and a browser, nothing else. Every step the
// wizard performs has a REST endpoint, including the pieces usually done
// by hand in the dashboard (extensions, auth settings, the webhook).
//
// Endpoint shapes drift. Anything that 4xxs is reported with the step
// name and a manual fallback rather than aborting the whole run — see
// steps.js.

const BASE = 'https://api.supabase.com';

export class ApiError extends Error {
  constructor(status, body, path) {
    super(`${status} on ${path}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

export function createClient(token) {
  async function call(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
    if (!res.ok) throw new ApiError(res.status, parsed, path);
    return parsed;
  }

  return {
    /** Also serves as the token check — a bad token 401s here. */
    listOrganizations: () => call('GET', '/v1/organizations'),
    listProjects: () => call('GET', '/v1/projects'),
    getProject: (ref) => call('GET', `/v1/projects/${ref}`),

    createProject: ({ name, organization_id, region, db_pass }) =>
      call('POST', '/v1/projects', {
        name, organization_id, region, db_pass, plan: 'free',
      }),

    /** Arbitrary SQL. The schema, the extensions and the webhook trigger
     *  all go through here — it is what removes the need for psql. */
    query: (ref, sql) =>
      call('POST', `/v1/projects/${ref}/database/query`, { query: sql }),

    getAuthConfig: (ref) => call('GET', `/v1/projects/${ref}/config/auth`),
    updateAuthConfig: (ref, patch) =>
      call('PATCH', `/v1/projects/${ref}/config/auth`, patch),

    listFunctions: (ref) => call('GET', `/v1/projects/${ref}/functions`),

    /** The API keys, so the wizard can print a setup link at the end. */
    getApiKeys: (ref) => call('GET', `/v1/projects/${ref}/api-keys`),
  };
}

/** Poll until a freshly created project is usable. */
export async function waitForProject(api, ref, { onTick, timeoutMs = 600000 } = {}) {
  const started = Date.now();
  for (;;) {
    let status = 'UNKNOWN';
    try {
      const p = await api.getProject(ref);
      status = p?.status || 'UNKNOWN';
    } catch (e) {
      // A just-created project 404s briefly; keep waiting.
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
      status = 'CREATING';
    }
    if (status === 'ACTIVE_HEALTHY') return status;
    if (status === 'INACTIVE' || status.includes('FAILED')) {
      throw new Error(`Project entered ${status}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Project still ${status} after ${Math.round(timeoutMs / 60000)} min`);
    }
    if (onTick) onTick(status, Math.round((Date.now() - started) / 1000));
    await new Promise((r) => setTimeout(r, 5000));
  }
}
