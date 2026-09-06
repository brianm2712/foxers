'use strict';
/*
 * The Revolut adapter, against a mock that speaks the same protocol.
 *
 * The mock refuses what the real API refuses — wrong auth, missing version
 * header, amounts that are not integer minor units, capturing an order twice.
 * A stand-in that accepts anything is worse than no test: it proves the code
 * runs, not that it is right, and the last time that happened here it hid a
 * bug that only showed up against a real server.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const revolut = require('../server/lib/providers/revolut');

let server, base;
const orders = new Map();
const seen = [];

test.before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });

    const bad = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message }));
    };
    const ok = (data) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.headers.authorization !== 'Bearer sk_test_key') return bad(401, 'Unauthorised');
    if (!req.headers['revolut-api-version']) return bad(400, 'Missing Revolut-Api-Version');

    const capture = req.url.match(/^\/api\/orders\/([^/]+)\/capture$/);
    const cancel = req.url.match(/^\/api\/orders\/([^/]+)\/cancel$/);
    const refund = req.url.match(/^\/api\/orders\/([^/]+)\/refund$/);

    if (req.method === 'POST' && req.url === '/api/orders') {
      if (!Number.isInteger(body.amount)) return bad(400, 'amount must be an integer in minor units');
      if (body.amount <= 0) return bad(400, 'amount must be positive');
      if (!['manual', 'automatic'].includes(body.capture_mode)) return bad(400, 'bad capture_mode');
      // Idempotent on our own reference, exactly as the real one is.
      const existing = [...orders.values()].find((o) => o.ref === body.merchant_order_ext_ref);
      if (existing) return ok(existing);
      const id = 'ord_' + crypto.randomBytes(6).toString('hex');
      const order = {
        id, amount: body.amount, currency: body.currency, state: 'pending',
        capture_mode: body.capture_mode, ref: body.merchant_order_ext_ref,
        checkout_url: `https://checkout.revolut.test/${id}`,
      };
      orders.set(id, order);
      return ok(order);
    }
    if (capture) {
      const o = orders.get(capture[1]);
      if (!o) return bad(404, 'Order not found');
      if (o.state === 'completed') return bad(409, 'Order already captured');
      o.state = 'completed';
      return ok(o);
    }
    if (cancel) {
      const o = orders.get(cancel[1]);
      if (!o) return bad(404, 'Order not found');
      if (o.state === 'completed') return bad(409, 'Cannot cancel a captured order');
      o.state = 'cancelled';
      return ok(o);
    }
    if (refund) {
      const o = orders.get(refund[1]);
      if (!o) return bad(404, 'Order not found');
      if (o.state !== 'completed') return bad(409, 'Only a captured order can be refunded');
      if (!Number.isInteger(body?.amount)) return bad(400, 'amount must be an integer in minor units');
      o.state = 'refunded';
      return ok(o);
    }
    return bad(404, 'No such endpoint');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const provider = () => revolut.create({ secretKey: 'sk_test_key', base });

test('a deposit is authorised, not charged, and the customer is sent somewhere', async () => {
  const r = await provider().hold({ amount: 5, currency: 'EUR', reference: 'ABCD-1234' });
  assert.strictEqual(r.state, 'pending', 'nothing has been paid until the customer pays it');
  assert.strictEqual(r.moved, false);
  assert.match(r.checkoutUrl, /^https:\/\/checkout\.revolut\.test\//);

  const sent = seen.at(-1).body;
  assert.strictEqual(sent.amount, 500, 'EUR 5.00 goes over the wire as 500 minor units');
  assert.strictEqual(sent.capture_mode, 'manual', 'authorised now, taken or released later');
  assert.strictEqual(sent.merchant_order_ext_ref, 'ABCD-1234');
});

test('the same reference does not create a second order', async () => {
  const a = await provider().hold({ amount: 5, currency: 'EUR', reference: 'SAME-REF' });
  const b = await provider().hold({ amount: 5, currency: 'EUR', reference: 'SAME-REF' });
  assert.strictEqual(a.ref, b.ref, 'a retry after a timeout must not charge twice');
});

test('a declined quote captures the authorisation', async () => {
  const held = await provider().hold({ amount: 5, currency: 'EUR', reference: 'CAP-1' });
  const cap = await provider().capture({ payment: { providerRef: held.ref, status: 'held' } });
  assert.strictEqual(cap.moved, true);
  assert.strictEqual(orders.get(held.ref).state, 'completed');
});

test('an uncaptured deposit is cancelled, a captured one is refunded', async () => {
  const a = await provider().hold({ amount: 5, currency: 'EUR', reference: 'CANCEL-1' });
  await provider().refund({ payment: { providerRef: a.ref, status: 'held', amount: 5, currency: 'EUR' } });
  assert.strictEqual(orders.get(a.ref).state, 'cancelled',
    'releasing a hold should never show as a refund on the customer statement');

  const b = await provider().hold({ amount: 5, currency: 'EUR', reference: 'REFUND-1' });
  await provider().capture({ payment: { providerRef: b.ref, status: 'held' } });
  await provider().refund({ payment: { providerRef: b.ref, status: 'captured', amount: 5, currency: 'EUR' } });
  assert.strictEqual(orders.get(b.ref).state, 'refunded');
  assert.strictEqual(seen.at(-1).body.amount, 500, 'refunds are in minor units too');
});

test('the balance at the door is taken outright', async () => {
  const r = await provider().charge({ amount: 128.26, currency: 'EUR', reference: 'BE-2026-0002' });
  assert.strictEqual(seen.at(-1).body.amount, 12826, 'no rounding drift on a real total');
  assert.strictEqual(seen.at(-1).body.capture_mode, 'automatic');
  assert.strictEqual(r.state, 'pending');
});

test('a bad key is reported as a provider failure, not a decline', async () => {
  const wrong = revolut.create({ secretKey: 'sk_wrong', base });
  await assert.rejects(
    () => wrong.hold({ amount: 5, currency: 'EUR', reference: 'X' }),
    (err) => err.code === 'provider_error' && err.providerStatus === 401);
});

test('an unreachable provider is a 504, never a silent success', async () => {
  const dead = revolut.create({ secretKey: 'sk_test_key', base: 'http://127.0.0.1:1' });
  await assert.rejects(
    () => dead.hold({ amount: 5, currency: 'EUR', reference: 'Y' }),
    (err) => err.status === 502 || err.status === 504);
});

test('webhook signatures are checked against the raw body, in constant time', () => {
  const secret = 'wh_secret';
  const body = JSON.stringify({ event: 'ORDER_COMPLETED', order_id: 'ord_1', state: 'completed' });
  const ts = String(Date.now());
  const sign = (t, b, k = secret) =>
    'v1=' + crypto.createHmac('sha256', k).update(`v1.${t}.${b}`).digest('hex');

  const args = { secret, signatureHeader: sign(ts, body), timestamp: ts, rawBody: body };
  assert.strictEqual(revolut.verifyWebhook(args), true);

  assert.strictEqual(revolut.verifyWebhook({ ...args, rawBody: body + ' ' }), false, 'body tampered');
  assert.strictEqual(revolut.verifyWebhook({ ...args, secret: 'other' }), false, 'wrong secret');
  assert.strictEqual(revolut.verifyWebhook({ ...args, signatureHeader: 'v1=short' }), false, 'truncated');
  assert.strictEqual(revolut.verifyWebhook({ ...args, signatureHeader: undefined }), false, 'absent');
  assert.strictEqual(
    revolut.verifyWebhook({ ...args, timestamp: String(Date.now() - 3 * 60 * 60 * 1000),
      signatureHeader: sign(String(Date.now() - 3 * 60 * 60 * 1000), body) }),
    false, 'an old message is a replay even with a good signature');

  // Several versions in one header, one of which is ours.
  assert.strictEqual(revolut.verifyWebhook({
    ...args, signatureHeader: `v0=deadbeef, ${sign(ts, body)}`,
  }), true);
});
