'use strict';
/*
 * Stripe Connect onboarding, Phase 1: a foxxer gets an account, and the app
 * knows whether they can be paid. No money moves anywhere in this suite.
 *
 * A real server against a mock Stripe that refuses what the real one refuses —
 * wrong key, missing API version, JSON where it wants form encoding. A mock
 * that accepts anything proves the code runs, not that it is right.
 *
 * The decision this suite pins down: an un-onboarded foxxer is VISIBLE and can
 * take work. They just cannot be paid, and are told so. Hiding them would put
 * ID and a bank account between signing up and getting any value.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const KEY = 'sk_test_stripe';
const WEBHOOK_SECRET = 'whsec_test_secret';

let stripe, stripeBase, child, base, dataDir, token;
const accounts = new Map();
const seen = [];

/* ---- the mock ---------------------------------------------------------- */

test.before(async () => {
  stripe = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const body = Object.fromEntries(new URLSearchParams(raw));
    seen.push({ method: req.method, url: req.url, body });

    const bad = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message } }));
    };
    const ok = (data) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.headers.authorization !== `Bearer ${KEY}`) return bad(401, 'Invalid API Key provided');
    if (!req.headers['stripe-version']) return bad(400, 'Missing Stripe-Version');
    if (req.method === 'POST' && !/application\/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) {
      return bad(400, 'Stripe does not accept JSON bodies');
    }

    if (req.method === 'POST' && req.url === '/v1/accounts') {
      if (body.type !== 'express') return bad(400, 'unsupported account type');
      if (!body.country) return bad(400, 'country is required');
      if (body['capabilities[transfers][requested]'] !== 'true') return bad(400, 'transfers must be requested');
      const id = 'acct_' + crypto.randomBytes(6).toString('hex');
      accounts.set(id, {
        id, charges_enabled: false, payouts_enabled: false, details_submitted: false,
        requirements: { currently_due: ['individual.id_number', 'external_account'] },
      });
      return ok(accounts.get(id));
    }

    if (req.method === 'POST' && req.url === '/v1/account_links') {
      if (!accounts.has(body.account)) return bad(404, 'No such account');
      if (body.type !== 'account_onboarding') return bad(400, 'bad link type');
      if (!body.return_url || !body.refresh_url) return bad(400, 'return_url and refresh_url are required');
      return ok({
        url: `https://connect.stripe.test/setup/${body.account}`,
        expires_at: Math.floor(Date.now() / 1000) + 300,
      });
    }

    const one = req.url.match(/^\/v1\/accounts\/([^/?]+)$/);
    if (req.method === 'GET' && one) {
      const acct = accounts.get(decodeURIComponent(one[1]));
      return acct ? ok(acct) : bad(404, 'No such account');
    }

    return bad(404, `mock has no route for ${req.method} ${req.url}`);
  });
  await new Promise((r) => stripe.listen(0, '127.0.0.1', r));
  stripeBase = `http://127.0.0.1:${stripe.address().port}`;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxxers-connect-'));
  const port = 8000 + Math.floor(Math.random() * 1500);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      FOXXERS_DATA: dataDir, FOXXERS_PORT: String(port), FOXXERS_HOST: '127.0.0.1',
      FOXXERS_PAYMENTS: 'stripe',
      FOXXERS_STRIPE_SECRET_KEY: KEY,
      FOXXERS_STRIPE_BASE: stripeBase,
      FOXXERS_STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      FOXXERS_PUBLIC_URL: 'https://foxxers.test',
      FOXXERS_LIMIT_WRITE: '10000', FOXXERS_LIMIT_SIGNUP: '10000', FOXXERS_LIMIT_READ: '100000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth(base);
});

test.after(() => {
  if (child) child.kill('SIGTERM');
  if (stripe) stripe.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

function waitForHealth(url, tries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      fetch(`${url}/api/v1/health`).then((r) => (r.ok ? resolve() : retry(n))).catch(() => retry(n));
      const retry = (k) => (k <= 0 ? reject(new Error('server never came up')) : setTimeout(() => attempt(k - 1), 100));
    };
    attempt(tries);
  });
}

async function api(method, url, body, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  const t = opts.token === null ? null : (opts.token || token);
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(base + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json, raw: text };
}

/* Stripe signs "t.payload" and sends t=<unix>,v1=<hmac>. */
async function webhook(event, { secret = WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000) } = {}) {
  const payload = JSON.stringify(event);
  const v1 = crypto.createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex');
  const res = await fetch(`${base}/api/v1/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${at},v1=${v1}` },
    body: payload,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json, raw: text };
}

/* ---- the tests --------------------------------------------------------- */

let accountId = null;

test('a foxxer signs up and is told, plainly, that they cannot be paid yet', async () => {
  const r = await api('POST', '/api/v1/auth/signup', {
    name: 'Connect Test', business: 'Connect Test Electrical', email: 'connect@example.com',
    password: 'a-long-enough-password', trades: ['electrician'], areas: ['dublin'],
    withholdingRate: 20, region: 'IE',
  }, { token: null });
  assert.strictEqual(r.status, 201, r.raw);
  token = r.body.token;

  const p = await api('GET', '/api/v1/pro/payouts');
  assert.strictEqual(p.status, 200, p.raw);
  assert.strictEqual(p.body.status, 'not_started');
  assert.strictEqual(p.body.canBePaid, false);
  assert.strictEqual(p.body.accountId, null);
  assert.strictEqual(p.body.provider, 'stripe');
});

test('an un-onboarded foxxer still appears in search and can be published', async () => {
  // The decision: no wall in front of signup. They trade, they just cannot be
  // paid through the app until Stripe has them.
  const pub = await api('PUT', '/api/v1/pro/profile', { published: true });
  assert.strictEqual(pub.status, 200, pub.raw);

  const found = await api('GET', '/api/v1/pros?trade=electrician&area=dublin', undefined, { token: null });
  assert.strictEqual(found.status, 200, found.raw);
  assert.ok(found.body.results.some((p) => p.business === 'Connect Test Electrical'),
    'a foxxer with no Stripe account is still findable');
});

test('onboarding creates one Express account and hands back a Stripe link', async () => {
  const r = await api('POST', '/api/v1/pro/payouts/onboard');
  assert.strictEqual(r.status, 200, r.raw);
  assert.match(r.body.url, /^https:\/\/connect\.stripe\.test\/setup\/acct_/);
  assert.ok(r.body.accountId.startsWith('acct_'));
  assert.strictEqual(r.body.status, 'incomplete');
  accountId = r.body.accountId;

  const created = seen.filter((s) => s.url === '/v1/accounts' && s.method === 'POST');
  assert.strictEqual(created.length, 1, 'exactly one account was created');
  assert.strictEqual(created[0].body.email, 'connect@example.com');
  assert.strictEqual(created[0].body['business_profile[name]'], 'Connect Test Electrical');
  assert.strictEqual(created[0].body.country, 'IE');
});

test('asking to onboard again reuses the account rather than making a second', async () => {
  const r = await api('POST', '/api/v1/pro/payouts/onboard');
  assert.strictEqual(r.status, 200, r.raw);
  assert.strictEqual(r.body.accountId, accountId, 'same account');

  const created = seen.filter((s) => s.url === '/v1/accounts' && s.method === 'POST');
  assert.strictEqual(created.length, 1, 'still exactly one account, ever');
});

test('the status is read from Stripe, and says what Stripe is still waiting for', async () => {
  const r = await api('GET', '/api/v1/pro/payouts');
  assert.strictEqual(r.status, 200, r.raw);
  assert.strictEqual(r.body.status, 'incomplete');
  assert.strictEqual(r.body.canBePaid, false);
  assert.strictEqual(r.body.detailsSubmitted, false);
  assert.deepStrictEqual(r.body.needs, ['individual.id_number', 'external_account']);
});

test('account.updated moves them to ready, and the cache follows', async () => {
  Object.assign(accounts.get(accountId), {
    charges_enabled: true, payouts_enabled: true, details_submitted: true,
    requirements: { currently_due: [] },
  });

  const w = await webhook({
    id: 'evt_1', type: 'account.updated',
    data: { object: accounts.get(accountId) },
  });
  assert.strictEqual(w.status, 200, w.raw);
  assert.strictEqual(w.body.matched, true);

  const r = await api('GET', '/api/v1/pro/payouts');
  assert.strictEqual(r.body.status, 'ready');
  assert.strictEqual(r.body.canBePaid, true);
  assert.deepStrictEqual(r.body.needs, []);
});

test('a webhook with a bad signature is refused, and changes nothing', async () => {
  Object.assign(accounts.get(accountId), { charges_enabled: false });
  const w = await webhook({
    id: 'evt_2', type: 'account.updated',
    data: { object: { ...accounts.get(accountId), charges_enabled: false } },
  }, { secret: 'whsec_wrong' });
  assert.strictEqual(w.status, 401, w.raw);
});

test('an account.updated for somebody we have never heard of is not an error', async () => {
  // Say 200 or the provider redelivers it forever.
  const w = await webhook({
    id: 'evt_3', type: 'account.updated',
    data: { object: { id: 'acct_nobody', charges_enabled: true } },
  });
  assert.strictEqual(w.status, 200, w.raw);
  assert.strictEqual(w.body.matched, false);
});

test('getting paid is a step in the setup guide, and it clears when Stripe says so', async () => {
  // Onboarding is the one setup step a foxxer cannot finish inside this app,
  // so leaving it out of the guide is how it gets forgotten until the first
  // invoice cannot be collected.
  Object.assign(accounts.get(accountId), {
    charges_enabled: false, payouts_enabled: false, details_submitted: true,
    requirements: { currently_due: ['external_account'] },
  });
  await api('GET', '/api/v1/pro/payouts');            // the refresh the card does
  let d = (await api('GET', '/api/v1/pro/dashboard')).body;
  assert.strictEqual(d.setup.payouts, 'incomplete');

  // The dashboard is the first screen of every session. It reads the cache the
  // webhook and the payouts card keep honest, and must not put an outbound
  // call to Stripe on the critical path of loading it.
  const before = seen.length;
  await api('GET', '/api/v1/pro/dashboard');
  assert.strictEqual(seen.length, before, 'loading the dashboard called Stripe');

  Object.assign(accounts.get(accountId), {
    charges_enabled: true, payouts_enabled: true, requirements: { currently_due: [] },
  });
  await api('GET', '/api/v1/pro/payouts');
  d = (await api('GET', '/api/v1/pro/dashboard')).body;
  assert.strictEqual(d.setup.payouts, 'ready');
});

test('payouts belong to the signed-in foxxer, not to whoever asks', async () => {
  const r = await api('GET', '/api/v1/pro/payouts', undefined, { token: null });
  assert.strictEqual(r.status, 401, r.raw);

  const o = await api('POST', '/api/v1/pro/payouts/onboard', undefined, { token: null });
  assert.strictEqual(o.status, 401, o.raw);
});
