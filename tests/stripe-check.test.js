'use strict';
/*
 * The go-live checker, checked.
 *
 * `scripts/stripe-check.js` is the thing that finally points the adapter at
 * real Stripe. It is worth testing for the same reason a smoke alarm is worth
 * testing: a checker that reports PASS because it never really ran is worse
 * than no checker, since it is believed.
 *
 * So it takes its base URL like everything else, and here it runs against a
 * mock. What that proves is the runner: that it performs each step, reports
 * what actually happened, refuses a live key, and does not quietly count a
 * step it skipped as a step that passed.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { run } = require(path.join(ROOT, 'scripts', 'stripe-check.js'));

const KEY = 'sk_test_checker';
let stripe, base;
const seen = [];
const accounts = new Map();
let failCheckoutOnce = false;
/*
 * A freshly created account has no capabilities — that is what Stripe really
 * returns, and it is why the destination-charge step cannot pass on a first
 * run. Flipped on by the tests that need an onboarded one.
 */
let accountsReady = false;
/* How many polls a "waiting" session takes before it reports a payment. */
let completeAfter = 0;
const polls = new Map();

test.before(async () => {
  stripe = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const isJson = /application\/json/.test(req.headers['content-type'] || '');
    const body = raw ? (isJson ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : {};
    const [pathname] = req.url.split('?');
    seen.push({ method: req.method, pathname, body, isJson });

    const bad = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message } }));
    };
    const ok = (d) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(d));
    };

    if (req.headers.authorization !== `Bearer ${KEY}`) return bad(401, 'Invalid API Key provided');
    if (!req.headers['stripe-version']) return bad(400, 'Missing Stripe-Version');

    if (req.method === 'POST' && pathname === '/v2/core/accounts') {
      if (!isJson) return bad(400, 'v2 endpoints require a JSON body');
      const id = 'acct_' + crypto.randomBytes(6).toString('hex');
      const status = accountsReady ? 'active' : 'restricted';
      accounts.set(id, {
        id,
        configuration: {
          merchant: { capabilities: { card_payments: { status } } },
          recipient: {
            capabilities: { stripe_balance: { payouts: { status }, stripe_transfers: { status } } },
          },
        },
        requirements: {
          entries: accountsReady ? []
            : [{ awaiting_action_from: 'user', description: 'external_account' }],
        },
      });
      return ok(accounts.get(id));
    }
    const one = pathname.match(/^\/v2\/core\/accounts\/([^/]+)$/);
    if (req.method === 'GET' && one) {
      const a = accounts.get(decodeURIComponent(one[1]));
      if (!a) return bad(404, 'No such account');
      if (!/include=/.test(req.url)) return ok({ ...a, configuration: null, requirements: null });
      return ok(a);
    }
    if (req.method === 'POST' && pathname === '/v1/account_links') {
      if (!accounts.has(body.account)) return bad(404, 'No such account');
      return ok({ url: `https://connect.stripe.test/setup/${body.account}`,
        expires_at: Math.floor(Date.now() / 1000) + 300 });
    }
    if (req.method === 'POST' && pathname === '/v1/checkout/sessions') {
      if (failCheckoutOnce) { failCheckoutOnce = false; return bad(400, 'Sessions are switched off'); }
      const id = 'cs_test_' + crypto.randomBytes(6).toString('hex');
      // null, as real Stripe returns at creation — the intent does not exist
      // until the customer completes the session.
      return ok({ id, url: `https://checkout.stripe.test/c/pay/${id}`, payment_intent: null });
    }
    const cap = pathname.match(/^\/v1\/payment_intents\/([^/]+)\/capture$/);
    if (req.method === 'POST' && cap) return ok({ id: decodeURIComponent(cap[1]), status: 'succeeded' });

    const can = pathname.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && can) return ok({ id: decodeURIComponent(can[1]), status: 'canceled' });

    if (req.method === 'POST' && pathname === '/v1/transfers') {
      if (!accounts.has(body.destination)) return bad(404, 'No such destination account');
      return ok({ id: 'tr_' + crypto.randomBytes(4).toString('hex'), amount: Number(body.amount) });
    }

    /* A completed session, which is the only place the intent id shows up. */
    const cs = pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (req.method === 'GET' && cs) {
      const id = decodeURIComponent(cs[1]);
      if (/^cs_test_missing/.test(id)) return bad(404, `No such checkout.session: ${id}`);
      if (/^cs_test_done/.test(id)) return ok({ id, payment_intent: 'pi_from_' + id, status: 'complete' });
      // A session somebody is in the middle of paying: null until it is not.
      const n = (polls.get(id) || 0) + 1;
      polls.set(id, n);
      if (completeAfter && n >= completeAfter) {
        return ok({ id, payment_intent: 'pi_paid_' + id, status: 'complete' });
      }
      return ok({ id, payment_intent: null, status: 'open' });
    }

    return bad(404, `mock has no route for ${req.method} ${pathname}`);
  });
  await new Promise((r) => stripe.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${stripe.address().port}`;
});

test.after(() => { if (stripe) stripe.close(); });

const byName = (report, re) => report.steps.find((s) => re.test(s.name));

/* ---- the tests --------------------------------------------------------- */

test('a live key is refused before a single call is made', async () => {
  const before = seen.length;
  const report = await run({ secretKey: 'sk_live_realmoney', base, quiet: true });

  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.refused, 'live_key');
  assert.strictEqual(seen.length, before, 'and nothing was sent to Stripe on the way to refusing');
});

test('every step it can do headlessly is actually performed and reported', async () => {
  accountsReady = true;
  const report = await run({ secretKey: KEY, base, publicUrl: 'https://foxxers.test', quiet: true });
  assert.strictEqual(report.ok, true, JSON.stringify(report.steps, null, 1));

  // A write, not a read. Listing accounts succeeds on a platform that cannot
  // create one, which is exactly how this went wrong the first time.
  const created = byName(report, /connected account/i);
  assert.strictEqual(created.status, 'pass');
  assert.ok(seen.some((s) => s.method === 'POST' && s.pathname === '/v2/core/accounts' && s.isJson),
    'the account was created for real, as JSON');

  assert.strictEqual(byName(report, /capabilities/i).status, 'pass');
  assert.strictEqual(byName(report, /onboarding link/i).status, 'pass');
  assert.strictEqual(byName(report, /deposit/i).status, 'pass');
  assert.strictEqual(byName(report, /invoice/i).status, 'pass');
  assert.strictEqual(byName(report, /webhook signature/i).status, 'pass');
});

test('the deposit is authorised, and the invoice carries the platform fee', async () => {
  accountsReady = true;
  seen.length = 0;
  await run({ secretKey: KEY, base, publicUrl: 'https://foxxers.test', feeBps: 200, quiet: true });

  const sessions = seen.filter((s) => s.pathname === '/v1/checkout/sessions');
  assert.strictEqual(sessions.length, 2, 'one for the deposit, one for the invoice');

  const deposit = sessions.find((s) => s.body['payment_intent_data[capture_method]'] === 'manual');
  assert.ok(deposit, 'the deposit is a hold, not a charge');
  assert.strictEqual(deposit.body['payment_intent_data[transfer_data][destination]'], undefined,
    'and it is authorised on the platform, since a request has no foxxer yet');

  const invoice = sessions.find((s) => s !== deposit);
  assert.ok(invoice.body['payment_intent_data[transfer_data][destination]'], 'a destination charge');
  assert.strictEqual(invoice.body['payment_intent_data[application_fee_amount]'], '200',
    '2% of the EUR 100 it bills with');
});

/*
 * A brand-new connected account has no capabilities, and Stripe refuses a
 * destination charge to one — correctly. Calling that a FAILURE would mean the
 * step can never pass on a first run, and a checker with a permanent red line
 * is a checker whose red lines stop being read.
 */
test('a destination charge to an un-onboarded account is skipped, not failed', async () => {
  accountsReady = false;
  const report = await run({ secretKey: KEY, base, quiet: true });

  const invoice = byName(report, /invoice/i);
  assert.strictEqual(invoice.status, 'skip');
  assert.match(invoice.reason, /stripe_transfers|onboarding/i);
  assert.strictEqual(report.failed, 0, 'nothing is actually broken');
  assert.strictEqual(report.complete, false, 'but there is plainly more to do');
});

/*
 * The steps that cannot be done without a browser and a card. They must be
 * reported as skipped, with the reason — a checker that counts them as passes
 * would say the money paths are proven when nothing has moved.
 */
test('the steps that need a human are skipped, and say why', async () => {
  accountsReady = true;
  const report = await run({ secretKey: KEY, base, quiet: true });

  const capture = byName(report, /capture/i);
  assert.strictEqual(capture.status, 'skip');
  assert.match(capture.reason, /complete|browser|card/i);

  assert.strictEqual(byName(report, /cancel/i).status, 'skip');
  assert.strictEqual(byName(report, /transfer/i).status, 'skip');

  // Skipped is not passed. The summary has to keep them apart, or "all green"
  // means nothing.
  assert.ok(report.skipped >= 3, 'skips are counted');
  assert.strictEqual(report.ok, true, 'but skipping is not failing — there is just more to do');
  assert.strictEqual(report.complete, false, 'and the run is explicitly not complete');
});

/*
 * The point of --session: a completed session is where the intent id lives,
 * and nobody should have to go and find it in the dashboard to finish a check.
 */
test('a completed session id is enough to finish the money steps', async () => {
  accountsReady = true;
  const report = await run({
    secretKey: KEY, base, quiet: true,
    session: 'cs_test_done_one', cancelSession: 'cs_test_done_two',
  });

  assert.strictEqual(byName(report, /capture/i).status, 'pass', JSON.stringify(report.steps));
  assert.strictEqual(byName(report, /transfer/i).status, 'pass');
  assert.strictEqual(byName(report, /cancel/i).status, 'pass');
  assert.strictEqual(report.skipped, 0, 'nothing left waiting on a human');
  assert.strictEqual(report.complete, true, 'and only now is the run complete');

  // The intent it acted on came from the session, not from a flag.
  assert.ok(seen.some((x) => x.pathname === '/v1/payment_intents/pi_from_cs_test_done_one/capture'));
  assert.ok(seen.some((x) => x.pathname === '/v1/payment_intents/pi_from_cs_test_done_two/cancel'));
});

test('a session that has not been completed is refused, not guessed at', async () => {
  accountsReady = true;
  const report = await run({ secretKey: KEY, base, quiet: true, session: 'cs_test_still_open' });

  const capture = byName(report, /capture/i);
  assert.strictEqual(capture.status, 'skip');
  assert.match(capture.reason, /not been (completed|paid)|no payment/i);
});

/*
 * The id that does not exist is almost always a mistyped or pasted-placeholder
 * one, not a broken integration. Sinking the run over it buries the steps that
 * did tell you something.
 */
test('a session id that does not exist is a skip, not an integration failure', async () => {
  accountsReady = true;
  const report = await run({ secretKey: KEY, base, quiet: true, session: 'cs_test_missing_one' });

  const capture = byName(report, /capture/i);
  assert.strictEqual(capture.status, 'skip');
  assert.match(capture.reason, /no such|does not exist|check the id/i);
  assert.strictEqual(report.failed, 0, 'a wrong id is not a failed integration');
});

/*
 * The whole copy-a-session-id-between-runs dance exists because each run mints
 * a new session. Waiting removes it: it prints the URL, you pay, it carries on.
 */
test('waiting polls the session and then runs the money steps for real', async () => {
  accountsReady = true;
  completeAfter = 3;
  polls.clear();

  const report = await run({
    secretKey: KEY, base, quiet: true, wait: true, waitSeconds: 10, pollMs: 5,
  });

  assert.strictEqual(byName(report, /capture/i).status, 'pass', JSON.stringify(report.steps));
  assert.strictEqual(byName(report, /transfer/i).status, 'pass');
  assert.strictEqual(byName(report, /cancel/i).status, 'pass');
  assert.strictEqual(report.complete, true, 'every money path has now really run');

  // Two separate holds: the first is captured, and a captured intent cannot
  // then be cancelled, so cancelling needs its own.
  assert.strictEqual(polls.size, 2, 'it waited on two different sessions');
  completeAfter = 0;
});

test('waiting gives up rather than hanging, and says what it was waiting for', async () => {
  accountsReady = true;
  completeAfter = 0;   // never completes
  polls.clear();

  const report = await run({
    secretKey: KEY, base, quiet: true, wait: true, waitSeconds: 0.05, pollMs: 5,
  });

  const capture = byName(report, /capture/i);
  assert.strictEqual(capture.status, 'skip');
  assert.match(capture.reason, /not completed|timed out|gave up|still open/i);
  assert.strictEqual(report.failed, 0, 'nobody paying is not a failure');
});

test('a step that fails is reported as failed, and sinks the run', async () => {
  accountsReady = true;
  failCheckoutOnce = true;
  const report = await run({ secretKey: KEY, base, quiet: true });

  assert.strictEqual(report.ok, false);
  const failed = report.steps.filter((s) => s.status === 'fail');
  assert.strictEqual(failed.length, 1);
  assert.match(failed[0].detail, /switched off/, 'and it says what Stripe actually complained about');
});
