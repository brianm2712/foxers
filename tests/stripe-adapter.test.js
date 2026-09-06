'use strict';
/*
 * The Stripe adapter's release path, against a mock that refuses what real
 * Stripe refuses.
 *
 * The rule this suite exists for, learned from a real sandbox on 2026-09-07:
 *
 *   You cannot cancel a PaymentIntent that Checkout created while its session
 *   is still open. Stripe answers "You cannot perform this action on
 *   PaymentIntents created by Checkout. Try expiring the Checkout Session
 *   instead."
 *
 * That matters beyond the go-live checker. A deposit whose customer never
 * finished paying sits at `pending`, and the seven-day sweep releases it — by
 * cancelling an intent that cannot be cancelled. Left alone, the session stays
 * open at Stripe and the customer can still complete it afterwards, putting a
 * hold on their card for a request the app has already closed.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const stripe = require(path.join(path.resolve(__dirname, '..'), 'server', 'lib', 'providers', 'stripe.js'));

const KEY = 'sk_test_adapter';
let server, base, api;
const seen = [];

test.before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const [pathname] = req.url.split('?');
    seen.push({ method: req.method, pathname });

    const ok = (d) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(d));
    };
    const bad = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message } }));
    };

    const can = pathname.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && can) {
      const id = decodeURIComponent(can[1]);
      // Real Stripe's refusal, word for word.
      if (/^pi_open/.test(id)) {
        return bad(400, 'You cannot perform this action on PaymentIntents created by Checkout. '
          + 'Try expiring the Checkout Session instead.');
      }
      return ok({ id, status: 'canceled' });
    }

    const exp = pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/);
    if (req.method === 'POST' && exp) return ok({ id: decodeURIComponent(exp[1]), status: 'expired' });

    if (req.method === 'POST' && pathname === '/v1/refunds') return ok({ id: 're_1' });

    return bad(404, `no route for ${req.method} ${pathname}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  api = stripe.create({ secretKey: KEY, base, publicUrl: 'https://foxxers.test' });
});

test.after(() => { if (server) server.close(); });

const paths = () => seen.map((s) => s.pathname);

test('a hold that was authorised is released by cancelling the intent', async () => {
  seen.length = 0;
  const out = await api.refund({
    payment: { id: 'p1', status: 'held', providerRef: 'cs_1', paymentIntentRef: 'pi_held_1', amount: 5, currency: 'EUR' },
  });

  assert.ok(paths().some((p) => p === '/v1/payment_intents/pi_held_1/cancel'));
  assert.strictEqual(out.moved, false, 'cancelling a hold moves no money');
});

/*
 * The one that would have gone wrong quietly. Nothing was ever authorised, so
 * there is no intent to cancel — and Stripe refuses to be asked.
 */
test('a deposit nobody finished paying is released by expiring the session', async () => {
  seen.length = 0;
  const out = await api.refund({
    payment: { id: 'p2', status: 'pending', providerRef: 'cs_2', paymentIntentRef: null, amount: 5, currency: 'EUR' },
  });

  assert.ok(paths().includes('/v1/checkout/sessions/cs_2/expire'),
    'the session is expired, which actually closes it');
  assert.ok(!paths().some((p) => /\/cancel$/.test(p)), 'and no doomed cancel was attempted');
  assert.strictEqual(out.moved, false);
});

/*
 * Belt and braces: the app can believe a deposit is `held` — the webhook said
 * so — while Stripe still considers the session open. Falling back rather than
 * throwing means the sweep still closes it.
 */
test('a refused cancel falls back to expiring the session', async () => {
  seen.length = 0;
  const out = await api.refund({
    payment: { id: 'p3', status: 'held', providerRef: 'cs_3', paymentIntentRef: 'pi_open_3', amount: 5, currency: 'EUR' },
  });

  assert.ok(paths().includes('/v1/payment_intents/pi_open_3/cancel'), 'it tried the right thing first');
  assert.ok(paths().includes('/v1/checkout/sessions/cs_3/expire'), 'then did the thing that works');
  assert.strictEqual(out.moved, false);
});

test('a captured deposit is given back with a refund, not a cancel', async () => {
  seen.length = 0;
  await api.refund({
    payment: { id: 'p4', status: 'captured', providerRef: 'cs_4', paymentIntentRef: 'pi_cap_4', amount: 5, currency: 'EUR' },
  });

  assert.ok(paths().includes('/v1/refunds'));
  assert.ok(!paths().some((p) => /\/cancel$|\/expire$/.test(p)));
});
