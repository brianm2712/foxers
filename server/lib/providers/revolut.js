'use strict';
/*
 * Revolut Merchant API, behind the payments seam.
 *
 * This is the one place in the server that talks to the internet. Everything
 * else in Foxxers is deliberately offline; this file is the exception, and it
 * is kept to four methods and one HTTP helper so it stays reviewable.
 *
 * WHAT IS DIFFERENT ABOUT A REAL RAIL
 *
 * The `manual` provider pretends money moves the instant a form is submitted.
 * Revolut does not: creating an order gives you a checkout URL, the customer
 * pays on Revolut's page, and you learn the outcome from a webhook. So `hold`
 * and `charge` return `state: 'pending'` and somewhere to send the customer,
 * and the payment is only `held`/`paid` once Revolut says so. A browser
 * arriving back on a success page is not evidence that anything was paid.
 *
 * MONEY IS IN MINOR UNITS. Revolut takes integer cents; this app works in
 * euro. Every crossing of that boundary goes through toMinor/fromMinor, and
 * getting it wrong by a factor of a hundred is the classic way to lose a lot
 * of money quietly.
 *
 * NOT YET RUN AGAINST THE REAL API. It is written to the documented shape of
 * the Merchant API and exercised against a mock that speaks the same
 * protocol, but no request has ever reached Revolut from here — there are no
 * credentials on this machine. Point FOXXERS_REVOLUT_BASE at the sandbox with
 * a sandbox key before trusting it with anything.
 */

const crypto = require('crypto');

const SANDBOX = 'https://sandbox-merchant.revolut.com';
const LIVE = 'https://merchant.revolut.com';

/* Pinned: the Merchant API is versioned by date and silently changes shape
 * across versions. Bump this deliberately, having read the changelog. */
const API_VERSION = '2024-09-01';
const TIMEOUT_MS = 12_000;

const toMinor = (amount) => Math.round(Number(amount) * 100);
const fromMinor = (minor) => Math.round(Number(minor)) / 100;

class RevolutError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status >= 400 && status < 500 ? 400 : 502;
    this.code = 'provider_error';
    this.providerStatus = status;
    this.body = body;
  }
}

function create({ secretKey, base, publicUrl } = {}) {
  const key = secretKey || process.env.FOXXERS_REVOLUT_SECRET_KEY;
  const root = (base || process.env.FOXXERS_REVOLUT_BASE
    || (process.env.FOXXERS_REVOLUT_LIVE === '1' ? LIVE : SANDBOX)).replace(/\/+$/, '');
  const site = publicUrl || process.env.FOXXERS_PUBLIC_URL || '';
  if (!key) throw new Error('Revolut needs FOXXERS_REVOLUT_SECRET_KEY');

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(root + path, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          'revolut-api-version': API_VERSION,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // A timeout or a DNS failure is not the customer's fault and must not
      // read as a decline: the order may well exist at Revolut's end.
      throw new RevolutError(`Could not reach Revolut: ${err.message}`, 504, null);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    if (!res.ok) {
      throw new RevolutError(
        data?.message || `Revolut refused the request (${res.status})`, res.status, data);
    }
    return data;
  }

  /*
   * One order per payment. `merchant_order_ext_ref` is our own reference, and
   * Revolut treats it as idempotent — a retry after a timeout finds the order
   * that already exists rather than charging twice.
   */
  async function order({ amount, currency, captureMode, reference, description }) {
    const data = await call('POST', '/api/orders', {
      amount: toMinor(amount),
      currency,
      capture_mode: captureMode,
      merchant_order_ext_ref: reference,
      description,
      ...(site ? { redirect_url: `${site.replace(/\/+$/, '')}/j/${encodeURIComponent(reference || '')}` } : {}),
    });
    return {
      ref: data.id,
      checkoutUrl: data.checkout_url || null,
      state: 'pending',
      amount: data.amount != null ? fromMinor(data.amount) : amount,
      currency: data.currency || currency,
      moved: false,
    };
  }

  return {
    key: 'revolut',

    /* The deposit. Authorised now, taken or released later, so capture is
     * manual — charging €5 and refunding it on every accepted quote would
     * cost the foxxer fees on work that went ahead. */
    hold: ({ amount, currency, reference }) => order({
      amount, currency, captureMode: 'manual', reference,
      description: 'Foxxers deposit — comes off the price if the quote is accepted',
    }),

    /* The quote was declined: the authorisation becomes a real charge. */
    async capture({ payment }) {
      const data = await call('POST', `/api/orders/${encodeURIComponent(payment.providerRef)}/capture`);
      return { ref: data?.id || payment.providerRef, moved: true };
    },

    /*
     * Giving it back. An authorisation that was never captured is cancelled,
     * which releases the hold without a refund ever appearing on the
     * customer's statement; a captured one has to be refunded properly.
     */
    async refund({ payment }) {
      const captured = payment.status === 'captured';
      const path = captured
        ? `/api/orders/${encodeURIComponent(payment.providerRef)}/refund`
        : `/api/orders/${encodeURIComponent(payment.providerRef)}/cancel`;
      const data = await call('POST', path,
        captured ? { amount: toMinor(payment.amount), currency: payment.currency } : undefined);
      return { ref: data?.id || payment.providerRef, moved: true };
    },

    /* The balance at the door. Taken outright, so capture is automatic. */
    charge: ({ amount, currency, reference }) => order({
      amount, currency, captureMode: 'automatic', reference,
      description: `Foxxers — invoice ${reference || ''}`.trim(),
    }),
  };
}

/*
 * Webhook signatures. Revolut signs `v1.{timestamp}.{raw body}` with the
 * signing secret and sends it as `v1=<hex>` in Revolut-Signature.
 *
 * Three things matter and all three are easy to get wrong: compare in
 * constant time, verify against the RAW body rather than a re-serialised
 * object, and reject anything old enough to be a replay.
 */
function verifyWebhook({ secret, signatureHeader, timestamp, rawBody, toleranceMs = 5 * 60 * 1000 }) {
  if (!secret || !signatureHeader || !timestamp) return false;

  const age = Math.abs(Date.now() - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceMs) return false;

  const expected = crypto.createHmac('sha256', secret)
    .update(`v1.${timestamp}.${rawBody}`)
    .digest('hex');

  // The header can carry several versions; any one matching is enough.
  return String(signatureHeader).split(',').some((part) => {
    const [, value] = part.trim().split('=');
    if (!value || value.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  });
}

/* Which Revolut order states mean the money is really there. */
const PAID_STATES = new Set(['authorised', 'completed']);
const DEAD_STATES = new Set(['cancelled', 'failed', 'declined']);

module.exports = { create, verifyWebhook, toMinor, fromMinor, PAID_STATES, DEAD_STATES, API_VERSION, SANDBOX, LIVE };
