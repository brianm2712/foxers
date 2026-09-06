'use strict';
/*
 * Stripe Connect onboarding, Phase 1: a foxxer gets an account, and the app
 * knows whether they can be paid. No money moves anywhere in this suite.
 *
 * A real server against a mock Stripe that refuses what the real one refuses —
 * wrong key, missing API version, form encoding where v2 wants JSON. A mock
 * that accepts anything proves the code runs, not that it is right. The shapes
 * below were taken from real responses, not from the documentation.
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

/*
 * A v2 account, in the shape the real API actually returns: capabilities carry
 * a `status`, and outstanding requirements are `entries` naming a dotted path.
 */
function newAccount(id) {
  return {
    id,
    object: 'v2.core.account',
    applied_configurations: ['merchant', 'recipient'],
    configuration: {
      merchant: { capabilities: { card_payments: { status: 'restricted' } } },
      recipient: {
        capabilities: {
          stripe_balance: { payouts: { status: 'restricted' }, stripe_transfers: { status: 'restricted' } },
        },
      },
    },
    requirements: {
      summary: { minimum_deadline: { status: 'past_due', time: null } },
      entries: [
        { awaiting_action_from: 'user', description: 'identity.individual.date_of_birth.day', errors: [] },
        { awaiting_action_from: 'user', description: 'external_account', errors: [] },
        // Stripe is reviewing this one; it is not something to ask the foxxer for.
        { awaiting_action_from: 'stripe', description: 'identity.verification', errors: [] },
      ],
    },
  };
}

function makeReady(a) {
  a.configuration.merchant.capabilities.card_payments.status = 'active';
  a.configuration.recipient.capabilities.stripe_balance.payouts.status = 'active';
  a.configuration.recipient.capabilities.stripe_balance.stripe_transfers.status = 'active';
  a.requirements = { summary: { minimum_deadline: { status: 'not_applicable' } }, entries: [] };
  return a;
}

test.before(async () => {
  stripe = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const ctype = req.headers['content-type'] || '';
    const isJson = /application\/json/.test(ctype);
    const body = raw ? (isJson ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : {};
    seen.push({ method: req.method, url: req.url, body, isJson });

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

    const [pathname] = req.url.split('?');

    // v2 speaks JSON. v1 speaks form encoding. Sending the wrong one is the
    // mistake this migration was most likely to make, so the mock refuses it.
    if (req.method === 'POST' && pathname.startsWith('/v2/') && !isJson) {
      return bad(400, 'v2 endpoints require a JSON body');
    }
    if (req.method === 'POST' && pathname.startsWith('/v1/') && isJson) {
      return bad(400, 'v1 endpoints require form encoding');
    }

    if (req.method === 'POST' && pathname === '/v2/core/accounts') {
      if (body.type) return bad(400, 'the legacy `type` parameter does not exist on v2');
      if (!body.identity?.country) return bad(400, 'identity.country is required');
      if (!body.configuration?.merchant) return bad(400, 'no merchant configuration requested');
      if (!body.configuration?.recipient) return bad(400, 'no recipient configuration requested');
      const id = 'acct_' + crypto.randomBytes(6).toString('hex');
      accounts.set(id, newAccount(id));
      return ok(accounts.get(id));
    }

    const one = pathname.match(/^\/v2\/core\/accounts\/([^/]+)$/);
    if (req.method === 'GET' && one) {
      const acct = accounts.get(decodeURIComponent(one[1]));
      if (!acct) return bad(404, 'No such account');
      // The real API returns null for anything not asked for via `include`.
      if (!/include=/.test(req.url)) return ok({ ...acct, configuration: null, requirements: null });
      return ok(acct);
    }

    /*
     * Hosted checkout. The decision was that web customers go to Stripe's own
     * page rather than the site loading js.stripe.com, so this is the shape
     * the invoice path produces.
     */
    if (req.method === 'POST' && pathname === '/v1/checkout/sessions') {
      if (body.mode !== 'payment') return bad(400, 'mode must be payment');
      const unit = Number(body['line_items[0][price_data][unit_amount]']);
      if (!Number.isInteger(unit) || unit <= 0) return bad(400, 'unit_amount must be a positive integer');
      const id = 'cs_test_' + crypto.randomBytes(6).toString('hex');
      seen[seen.length - 1].responseId = id;   // so a test can act as Stripe does
      return ok({
        id,
        object: 'checkout.session',
        url: `https://checkout.stripe.test/c/pay/${id}`,
        payment_intent: 'pi_' + crypto.randomBytes(6).toString('hex'),
        payment_status: 'unpaid',
        status: 'open',
      });
    }

    // Account links stayed on v1, even for v2 accounts.
    if (req.method === 'POST' && pathname === '/v1/account_links') {
      if (!accounts.has(body.account)) return bad(404, 'No such account');
      if (body.type !== 'account_onboarding') return bad(400, 'bad link type');
      if (!body.return_url || !body.refresh_url) return bad(400, 'return_url and refresh_url are required');
      return ok({
        url: `https://connect.stripe.test/setup/${body.account}`,
        expires_at: Math.floor(Date.now() / 1000) + 300,
      });
    }

    return bad(404, `mock has no route for ${req.method} ${pathname}`);
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

/*
 * Ask the server to stop, then wait until it is actually gone. It flushes the
 * store on the way out, so removing the data directory while it is still
 * shutting down is a race: rmSync walks past foxxers.json, the server writes
 * it back, and the rmdir behind it finds a directory that is not empty.
 */
function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const hard = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(hard); resolve(); });
    child.kill('SIGTERM');
  });
}

test.after(async () => {
  if (child) await stopServer(child);
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

/* A v2 event is thin: it names the object and where to read it, not its state. */
const capabilityEvent = (id) => ({
  id: 'evt_' + crypto.randomBytes(4).toString('hex'),
  type: 'v2.core.account[configuration.merchant].capability_status_updated',
  related_object: { id, type: 'v2.core.account', url: `/v2/core/accounts/${id}?include=configuration.merchant` },
});

/*
 * What a classic webhook endpoint ACTUALLY receives for a v2 account, verified
 * against real Stripe: v1 connect events. The thin v2 events above only arrive
 * at a separately configured event destination, so an endpoint that handles
 * only those silently stops tracking status. The connected account is named by
 * `account` on the envelope.
 */
const connectEvent = (id, type = 'account.updated') => ({
  id: 'evt_' + crypto.randomBytes(4).toString('hex'),
  type,
  account: id,
  data: { object: { id, object: 'account' } },
});

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

/* ---- what they are told before they commit ----------------------------- */

/*
 * The platform takes a cut and the foxxer carries disputes. Both are things a
 * sole trader finds out either here, or from a number that does not match
 * their invoice three weeks later.
 */
test('a foxxer is told the platform takes 2% before they set anything up', async () => {
  const r = await api('GET', '/api/v1/pro/payouts');
  assert.strictEqual(r.status, 200, r.raw);
  assert.strictEqual(r.body.fee.bps, 200, r.raw);
  assert.strictEqual(r.body.fee.cents, 0);
  // Said in money, not basis points: "200 bps" is not a disclosure to someone
  // pricing a job on the back of a van.
  assert.match(r.body.fee.description, /2%/);
});

test('onboarding is refused until the platform agreement is accepted', async () => {
  const r = await api('POST', '/api/v1/pro/payouts/onboard');
  assert.strictEqual(r.status, 400, r.raw);
  assert.strictEqual(r.body.code, 'agreement_required');

  // And nothing was created at Stripe on the way to being refused.
  assert.strictEqual(seen.filter((s) => s.url === '/v2/core/accounts' && s.method === 'POST').length, 0,
    'a refused onboarding must not leave a half-made account behind');
});

test('the agreement says what it costs and who carries a dispute', async () => {
  const r = await api('GET', '/api/v1/pro/agreement');
  assert.strictEqual(r.status, 200, r.raw);
  assert.ok(r.body.version, 'it is versioned, so acceptance means something specific');
  assert.match(r.body.body, /2%/, 'the fee is in the agreement, not only in the UI');
  assert.match(r.body.body, /dispute|chargeback/i, 'and so is who carries a dispute');
  assert.strictEqual(r.body.accepted, null, 'not accepted yet');
});

test('accepting the agreement is recorded against the version that was shown', async () => {
  const current = (await api('GET', '/api/v1/pro/agreement')).body.version;

  // Accepting some other version is refused: the whole point of a version is
  // that it says which words were agreed to.
  const stale = await api('POST', '/api/v1/pro/agreement/accept', { version: '1970-01-01' });
  assert.strictEqual(stale.status, 400, stale.raw);
  assert.strictEqual(stale.body.code, 'stale_agreement');

  const ok = await api('POST', '/api/v1/pro/agreement/accept', { version: current });
  assert.strictEqual(ok.status, 200, ok.raw);
  assert.strictEqual(ok.body.accepted.version, current);
  assert.ok(Date.parse(ok.body.accepted.at) > 0, 'and when');

  const seenAgain = await api('GET', '/api/v1/pro/agreement');
  assert.strictEqual(seenAgain.body.accepted.version, current);
});

test('onboarding creates one v2 account, as JSON, and hands back a Stripe link', async () => {
  const r = await api('POST', '/api/v1/pro/payouts/onboard');
  assert.strictEqual(r.status, 200, r.raw);
  assert.match(r.body.url, /^https:\/\/connect\.stripe\.test\/setup\/acct_/);
  assert.ok(r.body.accountId.startsWith('acct_'));
  assert.strictEqual(r.body.status, 'incomplete');
  accountId = r.body.accountId;

  const created = seen.filter((s) => s.url === '/v2/core/accounts' && s.method === 'POST');
  assert.strictEqual(created.length, 1, 'exactly one account was created');
  assert.strictEqual(created[0].isJson, true, 'v2 takes JSON, not form encoding');
  assert.strictEqual(created[0].body.identity.country, 'ie');
  assert.strictEqual(created[0].body.identity.entity_type, 'individual');
  assert.strictEqual(created[0].body.contact_email, 'connect@example.com');
  assert.strictEqual(created[0].body.type, undefined, 'no legacy account type');
  // Both are needed: merchant to take an invoice, recipient to be transferred
  // a captured deposit.
  assert.ok(created[0].body.configuration.merchant, 'merchant configuration requested');
  assert.ok(created[0].body.configuration.recipient, 'recipient configuration requested');

  assert.ok(seen.some((s) => s.url === '/v1/account_links' && s.isJson === false),
    'account links stayed on v1 and stayed form-encoded');
});

test('asking to onboard again reuses the account rather than making a second', async () => {
  const r = await api('POST', '/api/v1/pro/payouts/onboard');
  assert.strictEqual(r.status, 200, r.raw);
  assert.strictEqual(r.body.accountId, accountId, 'same account');

  const created = seen.filter((s) => s.url === '/v2/core/accounts' && s.method === 'POST');
  assert.strictEqual(created.length, 1, 'still exactly one account, ever');
});

test('the status is read from Stripe, and asks only for what the foxxer can supply', async () => {
  const r = await api('GET', '/api/v1/pro/payouts');
  assert.strictEqual(r.status, 200, r.raw);
  assert.strictEqual(r.body.status, 'incomplete');
  assert.strictEqual(r.body.canBePaid, false);
  assert.strictEqual(r.body.detailsSubmitted, false);
  // Requirements Stripe is handling itself must not be shown as the foxxer's
  // homework — they cannot act on them and would wait forever.
  assert.deepStrictEqual(r.body.needs, ['identity.individual.date_of_birth.day', 'external_account']);

  // Reading a v2 account without `include` returns nulls, which would look
  // exactly like "no capabilities" and strand every foxxer on incomplete.
  const reads = seen.filter((s) => s.method === 'GET' && s.url.startsWith('/v2/core/accounts/'));
  assert.ok(reads.length > 0);
  assert.ok(reads.every((s) => /include=/.test(s.url)), 'every account read asks for what it needs');
});

test('a capability event moves them to ready, and the cache follows', async () => {
  makeReady(accounts.get(accountId));

  const w = await webhook(capabilityEvent(accountId));
  assert.strictEqual(w.status, 200, w.raw);
  assert.strictEqual(w.body.matched, true);

  const r = await api('GET', '/api/v1/pro/payouts');
  assert.strictEqual(r.body.status, 'ready');
  assert.strictEqual(r.body.canBePaid, true);
  assert.deepStrictEqual(r.body.needs, []);
});

test('the v1 connect events a classic endpoint really receives also work', async () => {
  // This is the shape that arrives in practice. Handling only the v2 thin
  // events passes a mock and tracks nothing in production.
  const a = accounts.get(accountId);
  a.configuration.merchant.capabilities.card_payments.status = 'restricted';
  a.requirements = {
    summary: { minimum_deadline: { status: 'past_due' } },
    entries: [{ awaiting_action_from: 'user', description: 'external_account', errors: [] }],
  };
  const back = await webhook(connectEvent(accountId));
  assert.strictEqual(back.status, 200, back.raw);
  assert.strictEqual(back.body.matched, true, 'account.updated must be acted on');
  let r = await api('GET', '/api/v1/pro/payouts');
  assert.strictEqual(r.body.status, 'incomplete', 'the webhook alone moved it back');

  makeReady(a);
  const fwd = await webhook(connectEvent(accountId, 'capability.updated'));
  assert.strictEqual(fwd.body.matched, true, 'capability.updated too');
  r = await api('GET', '/api/v1/pro/payouts');
  assert.strictEqual(r.body.status, 'ready');
});

test('an unrelated event is acknowledged but not acted on', async () => {
  const w = await webhook({ id: 'evt_x', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } });
  assert.strictEqual(w.status, 200, w.raw);
  assert.strictEqual(w.body.ignored, 'payment_intent.succeeded');
});

test('a webhook with a bad signature is refused', async () => {
  const w = await webhook(capabilityEvent(accountId), { secret: 'whsec_wrong' });
  assert.strictEqual(w.status, 401, w.raw);
});

test('an event for an account we have never heard of is not an error', async () => {
  // Say 200 or the provider redelivers it for days.
  const w = await webhook(capabilityEvent('acct_nobody'));
  assert.strictEqual(w.status, 200, w.raw);
  assert.strictEqual(w.body.matched, false);
});

test('getting paid is a step in the setup guide, and it clears when Stripe says so', async () => {
  // Onboarding is the one setup step a foxxer cannot finish inside this app,
  // so leaving it out of the guide is how it gets forgotten until the first
  // invoice cannot be collected.
  const a = accounts.get(accountId);
  a.configuration.merchant.capabilities.card_payments.status = 'restricted';
  a.requirements = {
    summary: { minimum_deadline: { status: 'past_due' } },
    entries: [{ awaiting_action_from: 'user', description: 'external_account', errors: [] }],
  };
  await api('GET', '/api/v1/pro/payouts');            // the refresh the card does
  let d = (await api('GET', '/api/v1/pro/dashboard')).body;
  assert.strictEqual(d.setup.payouts, 'incomplete');

  // The dashboard is the first screen of every session. It reads the cache the
  // webhook and the payouts card keep honest, and must not put an outbound
  // call to Stripe on the critical path of loading it.
  const before = seen.length;
  await api('GET', '/api/v1/pro/dashboard');
  assert.strictEqual(seen.length, before, 'loading the dashboard called Stripe');

  makeReady(a);
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

test('being able to take a card is not the same as being able to receive it', async () => {
  /*
   * A destination charge needs two capabilities, not one: the platform takes
   * the card (merchant) and routes the money onward (recipient transfers).
   * Real Stripe refuses the charge outright when the second is missing —
   * `insufficient_capabilities_for_transfer` — so a gate that only checks the
   * first waves the foxxer through to a failure at the till.
   */
  const a = accounts.get(accountId);
  makeReady(a);
  a.configuration.recipient.capabilities.stripe_balance.stripe_transfers.status = 'restricted';

  const r = await api('GET', '/api/v1/pro/payouts');
  assert.strictEqual(r.body.chargesEnabled, true, 'they can take a card');
  assert.strictEqual(r.body.transfersEnabled, false, 'but nothing can be routed to them');
  assert.strictEqual(r.body.canBePaid, false, 'so they cannot be paid');
  assert.notStrictEqual(r.body.status, 'ready');

  makeReady(a);
  await api('GET', '/api/v1/pro/payouts');
});

/* ---- phase 2: taking an invoice ---------------------------------------- */

let serviceId, proSlug, customerToken;

/*
 * A booking rather than a quote, so the payment path is exercised without
 * dragging in the deposit, which is phase 3. Each job gets its own invoice:
 * a job carries one receipt, so two invoices on one booking would leave the
 * second payment looking at the first one's receipt.
 */
async function bookAndInvoice() {
  const slots = await api('GET', `/api/v1/pros/${proSlug}/slots?serviceId=${serviceId}`,
    undefined, { token: null });
  const free = slots.body.days.flatMap((d) => d.slots);
  const booked = await api('POST', '/api/v1/bookings', {
    proSlug, serviceId, start: free[0].start, address: '2 Meadow View, Dublin 6',
  }, { token: customerToken });
  assert.strictEqual(booked.status, 201, booked.raw);

  const diary = await api('GET', '/api/v1/pro/bookings');
  const b = diary.body.bookings.find((x) => x.ref === booked.body.ref);
  await api('PATCH', `/api/v1/pro/bookings/${b.id}`, { status: 'done' });

  const inv = await api('POST', '/api/v1/pro/invoices', { bookingId: b.id, dueDays: 7 });
  assert.strictEqual(inv.status, 201, inv.raw);
  return { invoiceId: inv.body.id, ref: booked.body.ref, token: booked.body.token };
}

const jobView = (job) =>
  api('GET', `/api/v1/jobs/${job.ref}?t=${encodeURIComponent(job.token)}`, undefined, { token: null });

test('a foxxer with a bookable service and a customer to book it', async () => {
  const svc = await api('POST', '/api/v1/pro/services',
    { name: 'EICR', minutes: 60, price: 180, bookable: true });
  assert.strictEqual(svc.status, 201, svc.raw);
  serviceId = svc.body.id;
  proSlug = (await api('GET', '/api/v1/auth/me')).body.pro.slug;

  const cust = await api('POST', '/api/v1/auth/customer/signup', {
    name: 'Aine Walsh', email: 'aine@example.com', password: 'a-long-enough-password',
    phone: '087 555 0111', address: '2 Meadow View, Dublin 6', area: 'dublin',
  }, { token: null });
  assert.strictEqual(cust.status, 201, cust.raw);
  customerToken = cust.body.token;
});

test('a card rail puts a card payment link on the menu', async () => {
  const m = await api('GET', '/api/v1/meta');
  assert.ok(m.body.paymentMethods.some((x) => x.key === 'card'),
    'the method exists only where something can actually take it');
});

test('cash never travels through Stripe, and settles on the spot', async () => {
  // Money that moved outside the app is recorded, not charged. Routing it to
  // a card rail would invent a fee and a charge that never happened.
  const job = await bookAndInvoice();
  const before = seen.length;
  const r = await api('POST', `/api/v1/pro/invoices/${job.invoiceId}/paid`, { method: 'cash' });
  assert.strictEqual(r.status, 200, r.raw);
  assert.strictEqual(r.body.invoice, 'paid', 'settled on the spot, as it really was');
  assert.ok(r.body.receipt, 'and the receipt is issued there and then');
  assert.strictEqual(r.body.checkoutUrl, null, 'nowhere to send anyone');
  assert.strictEqual(seen.length, before, 'Stripe was not called');
});

test('a card payment is refused while the foxxer cannot be paid', async () => {
  const a = accounts.get(accountId);
  a.configuration.merchant.capabilities.card_payments.status = 'restricted';
  await api('GET', '/api/v1/pro/payouts');

  const job = await bookAndInvoice();
  const r = await api('POST', `/api/v1/pro/invoices/${job.invoiceId}/paid`, { method: 'card' });
  assert.strictEqual(r.status, 400, r.raw);
  assert.strictEqual(r.body.code, 'payouts_not_ready');
  assert.match(r.body.error, /payouts/i, 'and it says why, in words a tradesperson can act on');
  assert.match(r.body.error, /cash|transfer/i, 'and what still works meanwhile');

  makeReady(a);
  await api('GET', '/api/v1/pro/payouts');
});

let cardJob;

test('a card payment produces a Stripe-hosted checkout, and does not mark it paid', async () => {
  cardJob = await bookAndInvoice();
  const r = await api('POST', `/api/v1/pro/invoices/${cardJob.invoiceId}/paid`, { method: 'card' });
  assert.strictEqual(r.status, 200, r.raw);
  assert.match(r.body.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//,
    'the customer goes to Stripe, not to a card form on our page');
  assert.strictEqual(r.body.invoice, 'issued', 'still unpaid — nobody has paid anything yet');
  assert.strictEqual(r.body.receipt, null, 'and no receipt for money that has not moved');
  assert.strictEqual(r.body.settled, false);

  const sess = lastSession();
  assert.ok(sess, 'a checkout session was created');
  // A destination charge: the money is routed to the foxxer as it is taken,
  // so the platform never holds it.
  assert.strictEqual(sess.body['payment_intent_data[transfer_data][destination]'], accountId);
  assert.strictEqual(sess.body['payment_intent_data[on_behalf_of]'], accountId);
  assert.strictEqual(sess.body['line_items[0][price_data][currency]'], 'eur');
  /*
   * €168.30, not the €180 the service costs: net 180, VAT at 13.5% on top,
   * less the 20% RCT the principal withholds at source. The customer is
   * charged what is actually payable — billing the pre-withholding figure
   * would overcharge them by the exact amount somebody else remits to
   * Revenue on their behalf.
   */
  assert.strictEqual(sess.body['line_items[0][price_data][unit_amount]'], '16830');
  /*
   * The platform's 2%, taken from the €168.30 the customer pays: €3.37. It is
   * the decided default rather than something this instance configured, so it
   * is pinned here — a change to it should have to be made on purpose.
   */
  assert.strictEqual(sess.body['payment_intent_data[application_fee_amount]'], '337');
});

const lastSession = () => seen.filter((s) => s.url === '/v1/checkout/sessions').pop();

const paidEvent = (sessionId) => ({
  id: 'evt_paid', type: 'checkout.session.completed',
  data: { object: { id: sessionId, object: 'checkout.session', payment_status: 'paid' } },
});

test('the invoice is paid when Stripe says so, and only then', async () => {
  const inv = (await api('GET', '/api/v1/pro/invoices')).body.invoices.find((i) => i.id === cardJob.invoiceId);
  assert.strictEqual(inv.status, 'issued', 'still unpaid before the webhook');

  const w = await webhook(paidEvent(lastSession().responseId));
  assert.strictEqual(w.status, 200, w.raw);
  assert.strictEqual(w.body.matched, true);

  const after = (await api('GET', '/api/v1/pro/invoices')).body.invoices.find((i) => i.id === cardJob.invoiceId);
  assert.strictEqual(after.status, 'paid');

  const job = await jobView(cardJob);
  assert.ok(job.body.receipt, `and the receipt exists now that the money has moved: ${job.raw}`);
  assert.strictEqual(job.body.receipt.settled, true);
});

test('a redelivered webhook does not issue a second receipt', async () => {
  const before = (await jobView(cardJob)).body.receipt.number;
  const count = (await jobView(cardJob)).body.invoices.length;

  const again = await webhook(paidEvent(lastSession().responseId));
  assert.strictEqual(again.status, 200, again.raw);

  const job = (await jobView(cardJob)).body;
  assert.strictEqual(job.receipt.number, before, 'the same receipt, not a second one');
  assert.strictEqual(job.invoices.length, count);
});

test('a checkout session nobody here started is acknowledged and ignored', async () => {
  const w = await webhook(paidEvent('cs_test_never_seen'));
  assert.strictEqual(w.status, 200, w.raw);
  assert.strictEqual(w.body.matched, false);
});
