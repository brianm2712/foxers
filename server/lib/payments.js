'use strict';
/*
 * Money movement, and the seam a real provider drops into.
 *
 * Nothing here talks to a card network. This server makes no outbound calls,
 * so the `manual` provider below records what *would* have happened and moves
 * no money — but every state transition, every amount and every receipt is
 * real, stored and tested. Wiring in SumUp (the RFID reader), Revolut or
 * Stripe (Apple Pay, Terminal) means writing one more object with the same
 * four methods; nothing above this file changes.
 *
 * Two kinds of money, and they behave differently:
 *
 *   DEPOSIT  taken when the customer sends a request. Held, then either
 *            CREDITED against the invoice when the quote is accepted, or
 *            CAPTURED by the foxxer when it is declined — payment for the
 *            time spent pricing a job that went nowhere.
 *
 *   BALANCE  taken when the job is done, at the door, by card reader or
 *            wallet. This is the one that settles the invoice.
 */

const DEPOSIT_AMOUNT = { IE: 5, UK: 5 };

/*
 * How the balance can be taken. `card_reader` is a tap on the foxxer's own
 * terminal; the wallets are a link or a QR the customer opens on their phone.
 * `cash` and `transfer` exist because they are what actually happens on half
 * the jobs and pretending otherwise puts the ledger out of step with reality.
 */
const METHODS = [
  { key: 'card_reader', name: 'Card reader (tap)', instant: true },
  { key: 'apple_pay', name: 'Apple Pay', instant: true },
  { key: 'google_pay', name: 'Google Pay', instant: true },
  { key: 'revolut', name: 'Revolut', instant: true },
  { key: 'transfer', name: 'Bank transfer', instant: false },
  { key: 'cash', name: 'Cash', instant: false },
];
const METHOD_BY_KEY = new Map(METHODS.map((m) => [m.key, m]));

/*
 * A deposit's life.
 *
 * `pending` exists because a real card is not charged the instant a form is
 * submitted: the customer has to complete a checkout, and we only learn the
 * outcome when the provider says so. The `manual` provider skips straight to
 * `held` because nothing has to happen; Revolut does not.
 *
 * `held` is the only state money can leave from, and it can only go one of
 * three ways — which is what stops a deposit being both credited against an
 * invoice and pocketed by the foxxer.
 */
const DEPOSIT_STATES = {
  pending: ['held', 'failed', 'refunded'],
  held: ['credited', 'captured', 'refunded'],
  credited: [],
  captured: [],
  refunded: [],
  failed: [],
};

class PaymentError extends Error {
  constructor(message, status = 400, code = 'payment_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/*
 * The provider contract. Four methods, all synchronous from the caller's
 * point of view; a real one returns a provider reference to store against
 * the payment so a charge can be reconciled or refunded later.
 */
const manual = {
  key: 'manual',
  /** Take a deposit. A real provider authorises or charges the card here. */
  hold({ amount, currency }) {
    return { ref: `manual-hold-${Date.now().toString(36)}`, amount, currency, moved: false };
  },
  /** Settle a held deposit to the foxxer. */
  capture({ payment }) {
    return { ref: `${payment.providerRef}-cap`, moved: false };
  },
  /** Give a held deposit back. */
  refund({ payment }) {
    return { ref: `${payment.providerRef}-ref`, moved: false };
  },
  /** Take the balance at the door. */
  charge({ amount, currency, method }) {
    return { ref: `manual-${method}-${Date.now().toString(36)}`, amount, currency, moved: false };
  },
};

const providers = new Map([[manual.key, manual]]);
const registerProvider = (p) => providers.set(p.key, p);

function providerFor(name) {
  const p = providers.get(name || 'manual');
  if (!p) throw new PaymentError(`No payment provider called ${name}`, 500, 'no_provider');
  return p;
}

const currencyFor = (region) => (region === 'UK' ? 'GBP' : 'EUR');
const cents = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/* ---- deposits -------------------------------------------------------- */

function depositAmount(region) {
  return DEPOSIT_AMOUNT[region === 'UK' ? 'UK' : 'IE'];
}

async function holdDeposit(store, { customerId, region, providerName, reference }) {
  const provider = providerFor(providerName);
  const amount = depositAmount(region);
  const currency = currencyFor(region);
  const result = await provider.hold({ amount, currency, reference });

  // A provider that needs the customer to do something hands back `pending`
  // and somewhere to send them. One that does not says `held` and is done.
  const status = result.state === 'pending' ? 'pending' : 'held';

  const payment = store.insert('payments', {
    kind: 'deposit',
    status,
    amount,
    currency,
    customerId,
    proId: null,          // not known until a foxxer quotes
    ref: null,            // linked to the job once the request exists
    method: 'card',
    provider: provider.key,
    providerRef: result.ref,
    checkoutUrl: result.checkoutUrl || null,
    moved: !!result.moved,
    heldAt: new Date().toISOString(),
    settledAt: null,
  });
  store.log(`deposit.${status}`, payment.id, { amount, currency, provider: provider.key });
  return payment;
}

/*
 * The provider has told us how a pending payment finished. Called from the
 * webhook, never from a page: a browser saying "I paid" is not evidence.
 */
function settleDeposit(store, paymentId, { ok, providerRef }) {
  const payment = store.get('payments', paymentId);
  if (!payment) throw new PaymentError('No such payment', 404, 'not_found');
  if (payment.status !== 'pending') return payment;   // already resolved; webhooks repeat
  return transitionDeposit(store, paymentId, ok ? 'held' : 'failed', {
    moved: !!ok,
    providerRef: providerRef || payment.providerRef,
  });
}

function transitionDeposit(store, paymentId, to, extra = {}) {
  const payment = store.get('payments', paymentId);
  if (!payment) throw new PaymentError('No such payment', 404, 'not_found');
  if (payment.kind !== 'deposit') throw new PaymentError('Not a deposit', 400, 'bad_request');
  const allowed = DEPOSIT_STATES[payment.status] || [];
  if (!allowed.includes(to)) {
    throw new PaymentError(
      `A deposit that is ${payment.status} cannot become ${to}`, 409, 'bad_transition');
  }
  return store.update('payments', paymentId, {
    ...extra, status: to, settledAt: new Date().toISOString(),
  });
}

/** The quote was declined: the foxxer is paid for the time they spent on it. */
async function captureDeposit(store, paymentId, proId) {
  const payment = store.get('payments', paymentId);
  if (!payment) throw new PaymentError('No such payment', 404, 'not_found');
  const provider = providerFor(payment.provider);
  const result = await provider.capture({ payment });
  return transitionDeposit(store, paymentId, 'captured',
    { proId, providerRef: result.ref, moved: !!result.moved });
}

/** The quote was accepted: it comes off what is owed at the end instead. */
function creditDeposit(store, paymentId, proId) {
  return transitionDeposit(store, paymentId, 'credited', { proId });
}

/** Nobody quoted, so nobody earned it. */
async function refundDeposit(store, paymentId) {
  const payment = store.get('payments', paymentId);
  if (!payment) throw new PaymentError('No such payment', 404, 'not_found');
  const provider = providerFor(payment.provider);
  const result = await provider.refund({ payment });
  return transitionDeposit(store, paymentId, 'refunded',
    { providerRef: result.ref, moved: !!result.moved });
}

/* ---- taking the balance ---------------------------------------------- */

async function takePayment(store, { invoice, pro, amount, method, providerName }) {
  if (!METHOD_BY_KEY.has(method)) {
    throw new PaymentError(`Unknown payment method: ${method}`, 400, 'bad_method');
  }
  const provider = providerFor(providerName);
  const currency = currencyFor(pro.region);
  const due = cents(amount);
  if (!(due > 0)) throw new PaymentError('Nothing to take', 400, 'bad_request');

  const result = await provider.charge({ amount: due, currency, method, reference: invoice.number });
  const payment = store.insert('payments', {
    kind: 'balance',
    status: result.state === 'pending' ? 'pending' : 'paid',
    amount: due,
    currency,
    customerId: invoice.customerId,
    proId: pro.id,
    ref: invoice.ref,
    invoiceId: invoice.id,
    method,
    provider: provider.key,
    providerRef: result.ref,
    checkoutUrl: result.checkoutUrl || null,
    moved: !!result.moved,
    heldAt: null,
    settledAt: result.state === 'pending' ? null : new Date().toISOString(),
  });
  store.log('payment.taken', payment.id, { amount: due, method, invoice: invoice.number });
  return payment;
}

module.exports = {
  PaymentError, METHODS, METHOD_BY_KEY, DEPOSIT_AMOUNT, DEPOSIT_STATES,
  depositAmount, currencyFor, holdDeposit, settleDeposit, captureDeposit,
  creditDeposit, refundDeposit, takePayment, registerProvider, providerFor, manual,
};
