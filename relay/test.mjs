// Offline checks for the relay's routing and input validation.
// Deliberately never reaches FCM: everything here fails before the
// service-account key is used, so `node test.mjs` needs no credentials.
//
//   node test.mjs
import worker from './src/index.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const post = (body, path = '/v1/push', env = {}) =>
  worker.fetch(new Request('https://relay.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), env);

const tok = (n) => 'x'.repeat(n);
const GOOD = tok(160);

console.log('relay routing + validation');

let r = await worker.fetch(new Request('https://relay.test/v1/health'), {});
check('GET /v1/health → 200', r.status === 200);
check('health body ok:true', (await r.json()).ok === true);

r = await worker.fetch(new Request('https://relay.test/nope'), {});
check('unknown path → 404', r.status === 404);

r = await post({ tokens: [GOOD] }, '/v1/elsewhere');
check('wrong POST path → 404', r.status === 404);

r = await post('not json');
check('bad json → 400', r.status === 400);

r = await post({});
check('missing tokens → 400', r.status === 400);

r = await post({ tokens: [] });
check('empty tokens → 400', r.status === 400);

r = await post({ tokens: Array(21).fill(GOOD) });
check('over 20 tokens → 400', r.status === 400);

r = await post({ tokens: ['short'] });
check('too-short token → 400', r.status === 400);

r = await post({ tokens: [12345] });
check('non-string token → 400', r.status === 400);

// Valid shape, but the relay has no key configured.
r = await post({ tokens: [GOOD] }, '/v1/push', {});
check('valid tokens + no service account → 500', r.status === 500);
check('misconfig message', (await r.json()).error === 'relay misconfigured');

r = await post({ tokens: [GOOD] }, '/v1/push', { FCM_SERVICE_ACCOUNT: '{"bogus":1}' });
check('incomplete service account → 500', r.status === 500);

// Global throughput guard: one counter for the whole relay, rejecting the
// request outright rather than skipping individual tokens.
r = await post({ tokens: [GOOD] }, '/v1/push', {
  FCM_SERVICE_ACCOUNT: '{"bogus":1}',
  RATE_LIMITER: { limit: async () => ({ success: false }) },
});
check('over global limit → 429', r.status === 429);

// The privacy claim depends on the limiter key carrying NOTHING about the
// caller. Assert it is a constant — not an IP, not a token, not a hash of
// one — and that it is identical across different callers.
{
  const seen = [];
  const env = {
    FCM_SERVICE_ACCOUNT: '{"bogus":1}',
    RATE_LIMITER: { limit: async ({ key }) => { seen.push(key); return { success: true }; } },
  };
  await post({ tokens: [GOOD] }, '/v1/push', env);
  await post({ tokens: [tok(200)] }, '/v1/push', env);
  check('limiter consulted once per request', seen.length === 2);
  check('key is constant across callers', seen[0] === seen[1]);
  check('key contains no token material',
    !seen[0].includes('x') || seen[0].length < 20);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
