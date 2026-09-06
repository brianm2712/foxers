'use strict';
/*
 * Deposits, Phase 3: the €5 that makes a request worth pricing.
 *
 * Three decisions were made before this was written, and each one is pinned by
 * a test here rather than left to a comment:
 *
 *   The deposit is an AUTHORISATION, not a charge. Accepting a quote releases
 *   the hold and nothing is ever charged; declining captures it. Same money to
 *   everyone as the old charge-then-credit rule, minus a Stripe fee on every
 *   accepted quote, and with no confusing €5 credit line on the invoice.
 *
 *   The platform fee is 2%. It comes off the captured deposit before it is
 *   transferred to the foxxer.
 *
 *   A hold lasts about 7 days, and when it lapses the REQUEST goes with it.
 *   A foxxer must never be able to open a request whose protection has quietly
 *   expired underneath it.
 *
 * A real server against a mock Stripe that refuses what the real one refuses.
 * The one thing a mock cannot prove is that Stripe agrees, so the amounts and
 * the capture/cancel split are asserted on what was actually sent to it.
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

let stripe, stripeBase, child, base, dataDir;
let proToken = null, customerToken = null;
const accounts = new Map();
const intents = new Map();
const seen = [];

const sent = (method, re) => seen.filter((s) => s.method === method && re.test(s.url));
const lastSent = (method, re) => sent(method, re).at(-1);

/* ---- the mock ---------------------------------------------------------- */

function newAccount(id) {
  return {
    id,
    object: 'v2.core.account',
    applied_configurations: ['merchant', 'recipient'],
    configuration: {
      merchant: { capabilities: { card_payments: { status: 'active' } } },
      recipient: {
        capabilities: {
          stripe_balance: { payouts: { status: 'active' }, stripe_transfers: { status: 'active' } },
        },
      },
    },
    requirements: { summary: { minimum_deadline: { status: 'not_applicable' } }, entries: [] },
  };
}

test.before(async () => {
  stripe = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const isJson = /application\/json/.test(req.headers['content-type'] || '');
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
    if (req.method === 'POST' && pathname.startsWith('/v2/') && !isJson) {
      return bad(400, 'v2 endpoints require a JSON body');
    }
    if (req.method === 'POST' && pathname.startsWith('/v1/') && isJson) {
      return bad(400, 'v1 endpoints require form encoding');
    }

    if (req.method === 'POST' && pathname === '/v2/core/accounts') {
      const id = 'acct_' + crypto.randomBytes(6).toString('hex');
      accounts.set(id, newAccount(id));
      return ok(accounts.get(id));
    }
    const one = pathname.match(/^\/v2\/core\/accounts\/([^/]+)$/);
    if (req.method === 'GET' && one) {
      const acct = accounts.get(decodeURIComponent(one[1]));
      if (!acct) return bad(404, 'No such account');
      if (!/include=/.test(req.url)) return ok({ ...acct, configuration: null, requirements: null });
      return ok(acct);
    }
    if (req.method === 'POST' && pathname === '/v1/account_links') {
      if (!accounts.has(body.account)) return bad(404, 'No such account');
      return ok({ url: `https://connect.stripe.test/setup/${body.account}`,
        expires_at: Math.floor(Date.now() / 1000) + 300 });
    }

    /*
     * Hosted checkout. A deposit goes through the same page an invoice does —
     * the promise in the footer does not get an exception for small amounts —
     * but in manual-capture mode, so completing it authorises rather than
     * charges.
     */
    if (req.method === 'POST' && pathname === '/v1/checkout/sessions') {
      if (body.mode !== 'payment') return bad(400, 'mode must be payment');
      const unit = Number(body['line_items[0][price_data][unit_amount]']);
      if (!Number.isInteger(unit) || unit <= 0) return bad(400, 'unit_amount must be a positive integer');
      const id = 'cs_test_' + crypto.randomBytes(6).toString('hex');
      const pi = 'pi_' + crypto.randomBytes(6).toString('hex');
      intents.set(pi, {
        id: pi,
        amount: unit,
        capture_method: body['payment_intent_data[capture_method]'] || 'automatic',
        status: 'requires_payment_method',
      });
      seen[seen.length - 1].responseId = id;
      seen[seen.length - 1].paymentIntent = pi;
      return ok({ id, object: 'checkout.session', url: `https://checkout.stripe.test/c/pay/${id}`,
        payment_intent: pi, payment_status: 'unpaid', status: 'open' });
    }

    /* An authorisation is taken, not charged. Capturing it moves the money. */
    const cap = pathname.match(/^\/v1\/payment_intents\/([^/]+)\/capture$/);
    if (req.method === 'POST' && cap) {
      const pi = intents.get(decodeURIComponent(cap[1]));
      if (!pi) return bad(404, 'No such PaymentIntent');
      if (pi.capture_method !== 'manual') {
        return bad(400, 'Only a PaymentIntent with capture_method=manual can be captured');
      }
      if (pi.status === 'canceled') return bad(400, 'This PaymentIntent has been cancelled');
      pi.status = 'succeeded';
      return ok(pi);
    }

    /* Cancelling releases the hold. Nothing ever reaches the statement. */
    const can = pathname.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && can) {
      const pi = intents.get(decodeURIComponent(can[1]));
      if (!pi) return bad(404, 'No such PaymentIntent');
      if (pi.status === 'succeeded') return bad(400, 'Cannot cancel a captured PaymentIntent');
      pi.status = 'canceled';
      return ok(pi);
    }

    if (req.method === 'POST' && pathname === '/v1/transfers') {
      const amount = Number(body.amount);
      if (!Number.isInteger(amount) || amount <= 0) return bad(400, 'amount must be a positive integer');
      if (!accounts.has(body.destination)) return bad(404, 'No such destination account');
      return ok({ id: 'tr_' + crypto.randomBytes(6).toString('hex'), amount,
        destination: body.destination });
    }

    return bad(404, `mock has no route for ${req.method} ${pathname}`);
  });
  await new Promise((r) => stripe.listen(0, '127.0.0.1', r));
  stripeBase = `http://127.0.0.1:${stripe.address().port}`;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxxers-deposits-'));
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
      // Deliberately unset: the 2% platform fee is the decided default, and a
      // test that set it here would prove only that the env var is read.
      FOXXERS_PLATFORM_FEE_BPS: '',
      FOXXERS_PLATFORM_FEE_CENTS: '',
      FOXXERS_LIMIT_WRITE: '10000', FOXXERS_LIMIT_SIGNUP: '10000', FOXXERS_LIMIT_READ: '100000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth(base);
});

function stopServer(c) {
  return new Promise((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve();
    const hard = setTimeout(() => c.kill('SIGKILL'), 5000);
    c.once('exit', () => { clearTimeout(hard); resolve(); });
    c.kill('SIGTERM');
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
  const t = opts.token === null ? null : opts.token;
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(base + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json, raw: text };
}

async function webhook(event) {
  const payload = JSON.stringify(event);
  const at = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${at}.${payload}`).digest('hex');
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

/* The event that means the money is genuinely held, not merely promised. */
const capturableEvent = (pi, amount) => ({
  id: 'evt_' + crypto.randomBytes(4).toString('hex'),
  type: 'payment_intent.amount_capturable_updated',
  data: { object: { id: pi, object: 'payment_intent', amount_capturable: amount, status: 'requires_capture' } },
});

/* ---- setting the stage ------------------------------------------------- */

let accountId = null;

test('a foxxer onboards and can take money', async () => {
  const r = await api('POST', '/api/v1/auth/signup', {
    name: 'Deposit Test', business: 'Deposit Test Electrical', email: 'deposits@example.com',
    password: 'a-long-enough-password', trades: ['electrician'], areas: ['dublin'],
    withholdingRate: 0, region: 'IE',
  }, { token: null });
  assert.strictEqual(r.status, 201, r.raw);
  proToken = r.body.token;

  await api('PUT', '/api/v1/pro/profile', { published: true }, { token: proToken });

  // Nothing reaches Stripe until they have agreed to what it costs them.
  const terms = await api('GET', '/api/v1/pro/agreement', undefined, { token: proToken });
  const accepted = await api('POST', '/api/v1/pro/agreement/accept',
    { version: terms.body.version }, { token: proToken });
  assert.strictEqual(accepted.status, 200, accepted.raw);

  const on = await api('POST', '/api/v1/pro/payouts/onboard', undefined, { token: proToken });
  assert.strictEqual(on.status, 200, on.raw);
  accountId = on.body.accountId;

  // The mock's accounts come back ready, so one refresh is all it takes.
  const payouts = await api('GET', '/api/v1/pro/payouts', undefined, { token: proToken });
  assert.strictEqual(payouts.body.canBePaid, true, payouts.raw);

  const c = await api('POST', '/api/v1/auth/customer/signup', {
    name: 'Deposit Customer', email: 'deposit-customer@example.com',
    password: 'a-long-enough-password', phone: '087 555 0404',
    address: '1 Test Street, Dublin', area: 'dublin',
  }, { token: null });
  assert.strictEqual(c.status, 201, c.raw);
  customerToken = c.body.token;
});

/* ---- the deposit is a hold, not a charge ------------------------------- */

let heldRef = null, heldIntent = null, heldToken = null;

test('sending a request authorises the deposit, and charges nothing', async () => {
  const r = await api('POST', '/api/v1/requests', {
    trade: 'electrician', area: 'dublin', urgency: 'flexible',
    description: 'Two sockets in the kitchen have stopped working entirely.',
  }, { token: customerToken });
  assert.strictEqual(r.status, 201, r.raw);
  heldRef = r.body.ref;
  heldToken = r.body.token;

  // Nothing is held until the customer completes the checkout, and nothing in
  // this process gets to decide that they have.
  assert.strictEqual(r.body.deposit.status, 'pending', r.raw);
  assert.strictEqual(r.body.deposit.amount, 5);
  assert.strictEqual(r.body.deposit.settled, false);
  assert.match(r.body.deposit.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);

  const session = lastSent('POST', /^\/v1\/checkout\/sessions/);
  assert.ok(session, 'the deposit went to Stripe, not to the manual rail');
  assert.strictEqual(session.body['payment_intent_data[capture_method]'], 'manual',
    'a deposit is authorised, never charged outright');
  assert.strictEqual(Number(session.body['line_items[0][price_data][unit_amount]']), 500);
  // An open request has no foxxer yet, so there is nobody to route it to.
  assert.strictEqual(session.body['payment_intent_data[transfer_data][destination]'], undefined);
  heldIntent = session.paymentIntent;
});

test('the deposit is only held once Stripe says the money is capturable', async () => {
  const w = await webhook(capturableEvent(heldIntent, 500));
  assert.strictEqual(w.status, 200, w.raw);
  assert.strictEqual(w.body.matched, true, w.raw);

  const job = await api('GET', `/api/v1/jobs/${heldRef}?t=${encodeURIComponent(heldToken)}`,
    undefined, { token: null });
  assert.strictEqual(job.body.deposit.status, 'held', job.raw);
});

/* ---- accepting releases it --------------------------------------------- */

test('accepting a quote releases the hold and invoices the job in full', async () => {
  const reqs = await api('GET', '/api/v1/pro/requests', undefined, { token: proToken });
  const mine = reqs.body.requests.find((x) => x.ref === heldRef);
  assert.ok(mine, reqs.raw);

  const q = await api('POST', '/api/v1/pro/quotes', {
    requestId: mine.id, title: 'Two sockets',
    lines: [{ description: 'Replace two sockets', quantity: 1, unitPrice: 200, vatRate: 13.5 }],
  }, { token: proToken });
  assert.strictEqual(q.status, 201, q.raw);

  const accept = await api('POST', `/api/v1/jobs/${heldRef}/accept?t=${encodeURIComponent(heldToken)}`,
    { quoteId: q.body.id }, { token: null });
  assert.strictEqual(accept.status, 200, accept.raw);

  // Released, not credited: the authorisation is cancelled and the customer is
  // never charged the €5 at all.
  const after = await api('GET', `/api/v1/jobs/${heldRef}?t=${encodeURIComponent(heldToken)}`,
    undefined, { token: null });
  assert.strictEqual(after.body.deposit.status, 'released', after.raw);

  const cancel = lastSent('POST', new RegExp(`/v1/payment_intents/${heldIntent}/cancel$`));
  assert.ok(cancel, 'the hold was cancelled at Stripe');
  assert.strictEqual(sent('POST', new RegExp(`/v1/payment_intents/${heldIntent}/capture$`)).length, 0,
    'an accepted quote must never capture the deposit');

  const inv = await api('POST', '/api/v1/pro/invoices', { quoteId: q.body.id }, { token: proToken });
  assert.strictEqual(inv.status, 201, inv.raw);

  // No €5 line, and nothing knocked off: the money was never taken.
  const list = await api('GET', '/api/v1/pro/invoices', undefined, { token: proToken });
  const issued = list.body.invoices.find((i) => i.number === inv.body.number);
  assert.ok(issued, list.raw);
  assert.strictEqual(issued.depositCredit, 0, list.raw);
  assert.strictEqual(issued.dueNow, inv.body.totals.payable, list.raw);
});

/* ---- declining captures it, minus the platform's 2% -------------------- */

test('declining a quote captures the hold and transfers it, less the 2% fee', async () => {
  const r = await api('POST', '/api/v1/requests', {
    trade: 'electrician', area: 'dublin', urgency: 'flexible',
    description: 'An outside light needs replacing before the winter sets in.',
  }, { token: customerToken });
  const ref = r.body.ref;
  const jobToken = r.body.token;
  const pi = lastSent('POST', /^\/v1\/checkout\/sessions/).paymentIntent;
  await webhook(capturableEvent(pi, 500));

  const reqs = await api('GET', '/api/v1/pro/requests', undefined, { token: proToken });
  const mine = reqs.body.requests.find((x) => x.ref === ref);
  const q = await api('POST', '/api/v1/pro/quotes', {
    requestId: mine.id, title: 'Outside light',
    lines: [{ description: 'Replace outside light', quantity: 1, unitPrice: 150, vatRate: 13.5 }],
  }, { token: proToken });

  const declined = await api('POST', `/api/v1/jobs/${ref}/decline?t=${encodeURIComponent(jobToken)}`,
    { quoteId: q.body.id, reason: 'Going with someone else' }, { token: null });
  assert.strictEqual(declined.status, 200, declined.raw);

  const after = await api('GET', `/api/v1/jobs/${ref}?t=${encodeURIComponent(jobToken)}`,
    undefined, { token: null });
  assert.strictEqual(after.body.deposit.status, 'captured', after.raw);

  assert.ok(lastSent('POST', new RegExp(`/v1/payment_intents/${pi}/capture$`)), 'the hold was captured');

  // €5.00 less 2% = €4.90. The foxxer is paid for the time they spent pricing
  // a job that went nowhere; the platform's cut is stated, not silent.
  const transfer = lastSent('POST', /^\/v1\/transfers/);
  assert.ok(transfer, 'a captured deposit reaches the foxxer, rather than sitting on the platform');
  assert.strictEqual(Number(transfer.body.amount), 490, 'a 2% platform fee, and nothing more');
  assert.strictEqual(transfer.body.destination, accountId);
});

/* ---- a lapsed hold takes the request with it --------------------------- */

test('a request whose hold has expired is expired too, and cannot be quoted', async () => {
  // Time is the input here, so this one runs against the domain directly: the
  // alternative is a suite that sleeps for seven days.
  const D = require(path.join(ROOT, 'server', 'lib', 'domain.js'));
  const { Store } = require(path.join(ROOT, 'server', 'lib', 'store.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxxers-expiry-'));
  const store = new Store(path.join(dir, 'foxxers.json'));

  try {
    const deposit = store.insert('payments', {
      kind: 'deposit', status: 'held', amount: 5, currency: 'EUR',
      provider: 'manual', providerRef: 'pi_stale', moved: false,
      heldAt: new Date(Date.now() - 8 * 86400000).toISOString(), settledAt: null,
    });
    const request = store.insert('requests', {
      ref: 'STALE1', proId: null, trade: 'electrician', status: 'open',
      description: 'A hold that nobody answered in time', depositId: deposit.id,
    });

    const n = await D.expireStaleHolds(store, { now: Date.now() });
    assert.strictEqual(n, 1, 'the sweep found exactly the one stale hold');

    assert.strictEqual(store.get('payments', deposit.id).status, 'expired');
    assert.strictEqual(store.get('requests', request.id).status, 'expired');

    // The point of expiring it: a foxxer can never open a request whose
    // protection lapsed underneath them without being told.
    assert.throws(() => D.assertQuotable(store, store.get('requests', request.id)),
      /expired/i, 'an expired request refuses to be quoted');

    // A hold inside its window is left alone.
    const fresh = store.insert('payments', {
      kind: 'deposit', status: 'held', amount: 5, currency: 'EUR',
      provider: 'manual', providerRef: 'pi_fresh', moved: false,
      heldAt: new Date().toISOString(), settledAt: null,
    });
    store.insert('requests', { ref: 'FRESH1', trade: 'electrician', status: 'open',
      description: 'Still well inside its week', depositId: fresh.id });
    assert.strictEqual(await D.expireStaleHolds(store, { now: Date.now() }), 0);
    assert.strictEqual(store.get('payments', fresh.id).status, 'held');
  } finally {
    /*
     * The store coalesces writes behind a 25ms timer, so removing the
     * directory the instant the assertions finish is a race: the pending
     * persist lands on a path that is no longer there. Flush, let the timer
     * run out, then clean up — the same trap the server shutdown hit.
     */
    store.saveNow();
    await new Promise((r) => setTimeout(r, 60));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
