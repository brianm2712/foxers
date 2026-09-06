'use strict';
/*
 * Stripe Connect: customer pays, the money lands in the FOXXER's account.
 *
 * WHY CONNECT AND NOT A PLAIN GATEWAY
 *
 * A single-merchant gateway would put every customer's payment into the
 * platform's own account, leaving the platform owing money to tradespeople.
 * In the EU that is regulated activity. With Connect each foxxer has their own
 * Stripe account, funds settle there, and the platform takes a stated fee
 * without ever holding anyone's money.
 *
 * TWO SHAPES OF PAYMENT, FOR ONE STUBBORN REASON
 *
 *   Invoice  — a destination charge. The foxxer is known, so the money is
 *              routed to them at the moment it is taken and the platform fee
 *              comes off automatically.
 *
 *   Deposit  — taken when the customer sends a REQUEST, which may be open to
 *              any matching foxxer. There is nobody to route it to yet, so it
 *              is authorised on the platform account and only transferred to
 *              a foxxer if their quote is declined and the hold is captured.
 *              A quote that is accepted cancels the authorisation instead, so
 *              on the happy path no money moves and nobody pays a fee.
 *
 * TWO APIS, TWO ENCODINGS
 *
 * Connected accounts are Accounts v2 (`/v2/core/accounts`), which is Stripe's
 * supported path — the v1 `type: 'express'` shorthand is legacy. v2 takes
 * JSON; v1 takes form encoding nested with square brackets. Account links
 * stayed on v1, so this file speaks both, and `call` picks by path.
 *
 * v2 also returns null for anything not named in `include`, which reads
 * exactly like "this account has no capabilities" if you forget it.
 *
 * Amounts are integer minor units.
 *
 * NOT YET RUN AGAINST STRIPE. Written to the documented API and exercised
 * against a mock that refuses what the real one refuses. It needs a test-mode
 * key and a real round trip before it sees a card.
 */

const crypto = require('crypto');

const API = 'https://api.stripe.com';
/* Pinned: Stripe dates its API and old versions keep working. Bump on purpose.
 * This one is not optional — the v2 endpoints reject older versions outright
 * rather than falling back. */
const API_VERSION = '2026-04-22.dahlia';
const TIMEOUT_MS = 15_000;

const toMinor = (amount) => Math.round(Number(amount) * 100);
const fromMinor = (minor) => Math.round(Number(minor)) / 100;

/* Stripe's flavour of form encoding: nested[keys][like]=this, arrays by index. */
function form(data, prefix = '', out = []) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) form(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => form({ [i]: item }, key, out));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

class StripeError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status >= 400 && status < 500 ? 400 : 502;
    this.code = 'provider_error';
    this.providerStatus = status;
    this.declineCode = body?.error?.decline_code || null;
    this.body = body;
  }
}

function create({ secretKey, base, publicUrl, feeBps = 0, feeFlat = 0 } = {}) {
  const key = secretKey || process.env.FOXXERS_STRIPE_SECRET_KEY;
  const root = (base || process.env.FOXXERS_STRIPE_BASE || API).replace(/\/+$/, '');
  const site = (publicUrl || process.env.FOXXERS_PUBLIC_URL || '').replace(/\/+$/, '');
  /* The platform's cut, in basis points and cents. Zero unless configured, so
   * an instance that has not decided on a fee does not silently take one. */
  const bps = Number(process.env.FOXXERS_PLATFORM_FEE_BPS ?? feeBps) || 0;
  const flat = Number(process.env.FOXXERS_PLATFORM_FEE_CENTS ?? feeFlat) || 0;
  if (!key) throw new Error('Stripe needs FOXXERS_STRIPE_SECRET_KEY');

  async function call(method, path, data, { idempotencyKey, onBehalfOf } = {}) {
    // The encoding follows the API, not the caller: v2 is JSON, v1 is form.
    const isV2 = path.startsWith('/v2/');
    const headers = {
      authorization: `Bearer ${key}`,
      'stripe-version': API_VERSION,
      'content-type': isV2 ? 'application/json' : 'application/x-www-form-urlencoded',
    };
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    // Acting as a connected account, for the calls that must be made as them.
    if (onBehalfOf) headers['stripe-account'] = onBehalfOf;

    let res;
    try {
      res = await fetch(root + path, {
        method, headers,
        body: data === undefined ? undefined : (isV2 ? JSON.stringify(data) : form(data)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Never read a network failure as a decline: the charge may exist.
      throw new StripeError(`Could not reach Stripe: ${err.message}`, 504, null);
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      throw new StripeError(body?.error?.message || `Stripe refused the request (${res.status})`,
        res.status, body);
    }
    return body;
  }

  const platformFee = (amount) => Math.max(0, Math.round(toMinor(amount) * bps / 10_000) + flat);

  /*
   * A PaymentIntent is what the app's SDK completes. The client secret is
   * what makes it seamless — Apple Pay and Google Pay are one tap on it, and
   * the customer never leaves the app.
   */
  async function intent({ amount, currency, captureMode, reference, destination, description }) {
    const body = {
      amount: toMinor(amount),
      currency: String(currency).toLowerCase(),
      capture_method: captureMode,
      description,
      automatic_payment_methods: { enabled: true },
      metadata: { foxxers_ref: reference || '' },
    };
    // Destination charge: the money is routed to the foxxer as it is taken.
    if (destination) {
      body.transfer_data = { destination };
      body.on_behalf_of = destination;
      const fee = platformFee(amount);
      if (fee > 0) body.application_fee_amount = fee;
    }
    const pi = await call('POST', '/v1/payment_intents', body,
      { idempotencyKey: reference ? `pi_${reference}` : undefined });
    return {
      ref: pi.id,
      clientSecret: pi.client_secret,
      checkoutUrl: site && reference ? `${site}/j/${encodeURIComponent(reference)}` : null,
      state: 'pending',
      amount: fromMinor(pi.amount),
      currency: (pi.currency || currency).toUpperCase(),
      destination: destination || null,
      moved: false,
    };
  }

  return {
    key: 'stripe',

    /*
     * The deposit. Authorised on the platform because an open request has no
     * foxxer yet; captured only if a quote is declined.
     */
    hold: ({ amount, currency, reference }) => intent({
      amount, currency, captureMode: 'manual', reference,
      description: 'Foxxers deposit — released if you go ahead with the quote',
    }),

    /* The quote was declined. Take the hold, then pass it to the foxxer. */
    async capture({ payment, destination }) {
      const pi = await call('POST', `/v1/payment_intents/${encodeURIComponent(payment.providerRef)}/capture`,
        {}, { idempotencyKey: `cap_${payment.id}` });

      let transfer = null;
      if (destination) {
        const fee = platformFee(payment.amount);
        const amount = Math.max(0, toMinor(payment.amount) - fee);
        if (amount > 0) {
          transfer = await call('POST', '/v1/transfers', {
            amount, currency: String(payment.currency).toLowerCase(), destination,
            transfer_group: payment.ref || undefined,
            metadata: { foxxers_payment: payment.id },
          }, { idempotencyKey: `tr_${payment.id}` });
        }
      }
      return { ref: pi.id, transferRef: transfer?.id || null, moved: true };
    },

    /*
     * Giving it back. An uncaptured authorisation is cancelled, which releases
     * the hold without a refund ever reaching the customer's statement.
     */
    async refund({ payment }) {
      if (payment.status === 'captured') {
        const r = await call('POST', '/v1/refunds',
          { payment_intent: payment.providerRef, amount: toMinor(payment.amount) },
          { idempotencyKey: `rf_${payment.id}` });
        return { ref: r.id, moved: true };
      }
      const pi = await call('POST', `/v1/payment_intents/${encodeURIComponent(payment.providerRef)}/cancel`,
        {}, { idempotencyKey: `cn_${payment.id}` });
      return { ref: pi.id, moved: true };
    },

    /* What this rail can actually take. Anything else moved somewhere else and
     * is only being recorded — see `railFor` in payments.js. Deposits are
     * absent until phase 3 can handle one that starts out pending. */
    handles: ['card', 'apple_pay', 'google_pay'],

    /*
     * The invoice. The foxxer is known, so it is a destination charge that
     * routes to them as it is taken and the platform fee comes off
     * automatically.
     *
     * A Stripe-HOSTED checkout page, not a card form on our own pages. That is
     * the decision the footer forces: seamless in-app entry means loading
     * js.stripe.com, which is a third-party request that also fingerprints.
     * One redirect out costs a little polish and keeps the promise.
     */
    async charge({ amount, currency, reference, destination, ref }) {
      const fee = destination ? platformFee(amount) : 0;
      const back = site && ref ? `${site}/j/${encodeURIComponent(ref)}` : undefined;
      const session = await call('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        line_items: [{
          quantity: 1,
          price_data: {
            currency: String(currency).toLowerCase(),
            unit_amount: toMinor(amount),
            product_data: { name: `Invoice ${reference || ''}`.trim() },
          },
        }],
        payment_intent_data: {
          description: `Foxxers — ${reference || 'job'}`,
          ...(destination ? { transfer_data: { destination }, on_behalf_of: destination } : {}),
          ...(fee > 0 ? { application_fee_amount: fee } : {}),
        },
        client_reference_id: ref || undefined,
        success_url: back && `${back}?paid=1`,
        cancel_url: back,
        // How the webhook finds the payment this session belongs to. The
        // session id is not known to us until after it is created.
        metadata: { foxxers_ref: ref || '', foxxers_payment: reference || '' },
      }, { idempotencyKey: reference ? `cs_${reference}` : undefined });

      return {
        ref: session.id,
        paymentIntent: session.payment_intent || null,
        checkoutUrl: session.url,
        // Nobody has paid anything yet. A customer arriving back on the
        // success page is not evidence; only the webhook is.
        state: 'pending',
        amount, currency: String(currency).toUpperCase(),
        destination: destination || null,
        fee,
        moved: false,
      };
    },

    /* ---- connected accounts ------------------------------------------- */

    /*
     * Onboarding a foxxer. Stripe does the identity and bank checks and owns
     * the result; Foxxers stores an id and never sees a bank detail.
     */
    async createAccount({ email, business, country = 'IE' }) {
      const acct = await call('POST', '/v2/core/accounts', {
        contact_email: email,
        display_name: business,
        // Stripe's own dashboard for the foxxer. They are sole traders, not
        // finance teams; a full dashboard is more than they asked for.
        dashboard: 'express',
        identity: { country: String(country).toLowerCase(), entity_type: 'individual' },
        configuration: {
          // Two configurations, for the two ways money reaches a foxxer.
          // `merchant` lets an invoice be charged and routed to them.
          merchant: { capabilities: { card_payments: { requested: true } } },
          // `recipient` lets a captured deposit be transferred to them, which
          // is a separate movement with no charge of its own.
          recipient: {
            capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
          },
        },
        defaults: {
          currency: country === 'UK' || country === 'GB' ? 'gbp' : 'eur',
          // The platform carries losses and pays the fees. This is the
          // liability decision, stated rather than implied by an account type.
          responsibilities: { fees_collector: 'application', losses_collector: 'application' },
        },
        include: ['configuration.merchant', 'configuration.recipient', 'requirements'],
      });
      return { id: acct.id };
    },

    async accountLink({ accountId, refreshPath = '/dash/profile', returnPath = '/dash/profile' }) {
      const link = await call('POST', '/v1/account_links', {
        account: accountId,
        refresh_url: `${site}${refreshPath}`,
        return_url: `${site}${returnPath}`,
        type: 'account_onboarding',
      });
      return { url: link.url, expiresAt: link.expires_at };
    },

    /*
     * What a v2 account can currently do. There is no `charges_enabled` flag
     * any more: each capability carries its own status, and the ones that
     * matter here are being able to take a card and being able to be paid out.
     *
     * The `include` list is load-bearing — without it every one of these comes
     * back null, which is indistinguishable from a foxxer who has done nothing.
     */
    async account({ accountId }) {
      const include = ['configuration.merchant', 'configuration.recipient', 'requirements']
        .map((i) => `include=${encodeURIComponent(i)}`).join('&');
      const a = await call('GET', `/v2/core/accounts/${encodeURIComponent(accountId)}?${include}`);

      const merchant = a.configuration?.merchant?.capabilities || {};
      const recipient = a.configuration?.recipient?.capabilities || {};
      const active = (cap) => cap?.status === 'active';
      const balanceOf = (c) => c?.stripe_balance || {};

      const entries = a.requirements?.entries || [];
      // Only what the foxxer can actually act on. Requirements Stripe is
      // working through itself are not their homework, and showing them as
      // such leaves someone refreshing a page waiting for a bank to answer.
      const theirs = entries.filter((e) => e.awaiting_action_from === 'user');

      return {
        id: a.id,
        chargesEnabled: active(merchant.card_payments),
        payoutsEnabled: active(balanceOf(recipient).payouts) || active(balanceOf(merchant).payouts),
        transfersEnabled: active(balanceOf(recipient).stripe_transfers),
        detailsSubmitted: theirs.length === 0,
        needs: theirs.map((e) => e.description).filter(Boolean),
      };
    },
  };
}

/*
 * Webhook signatures. Stripe sends `t=<unix>,v1=<hmac of "t.payload">`.
 * Constant-time, against the raw body, and old messages are replays.
 */
function verifyWebhook({ secret, signatureHeader, rawBody, toleranceSec = 300 }) {
  if (!secret || !signatureHeader) return false;
  const parts = Object.fromEntries(String(signatureHeader).split(',')
    .map((p) => p.trim().split('=')).filter((p) => p.length === 2));
  const t = Number(parts.t);
  if (!Number.isFinite(t)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const got = parts.v1 || '';
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

module.exports = { create, verifyWebhook, form, toMinor, fromMinor, API_VERSION };
