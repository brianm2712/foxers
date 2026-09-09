#!/usr/bin/env node
'use strict';
/*
 * The go-live checker: point the adapter at real Stripe and report what
 * actually happened.
 *
 *   FOXXERS_STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-check.js
 *
 * WHY THIS EXISTS
 *
 * Every money path in this app is covered by tests against a mock that
 * refuses what the real one refuses. That is worth a lot and proves nothing
 * about Stripe: the first real round trip found that `POST /v1/accounts` was
 * the wrong endpoint entirely, and no mock would ever have said so. This is
 * the thing that goes and asks.
 *
 * WHAT IT WILL NOT DO
 *
 * It refuses a live key. Every step below either creates something in a test
 * sandbox or moves money, and neither belongs on a live account being driven
 * by a script. Run it in test mode, read the report, then switch keys by hand.
 *
 * WHAT IT CANNOT DO ALONE
 *
 * Capturing, cancelling and transferring all need an authorisation that
 * exists, and an authorisation needs a customer to complete a hosted checkout
 * page with a card. There is no honest way to do that headlessly, so those
 * steps are SKIPPED and say so. Complete the deposit URL this prints, then
 * run it again with the PaymentIntent to finish them:
 *
 *   node scripts/stripe-check.js --intent=pi_123 --account=acct_123
 *
 * A skip is not a pass. `complete` is false until every step has really run,
 * and the summary keeps the two apart — a checker believed to have proven
 * something it skipped is worse than no checker at all.
 */

const stripe = require('../server/lib/providers/stripe');

const EUR = 'EUR';
const DEPOSIT = 5;
const INVOICE = 100;

/* ---- reporting --------------------------------------------------------- */

const MARK = { pass: '✅', fail: '❌', skip: '⬜' };

function reporter(quiet) {
  return (step) => {
    if (quiet) return;
    const tail = step.status === 'skip' ? `  — ${step.reason}`
      : step.detail ? `  — ${step.detail}` : '';
    console.log(`${MARK[step.status]}  ${step.name}${tail}`);
    // Anything the reader has to go and do, under the line it belongs to.
    if (step.note) console.log(`      ${step.note}`);
  };
}

/**
 * Run one step and record it. A thrown error is a failed step, never a crashed
 * run: the point is to learn everything Stripe objects to in one pass, rather
 * than one objection per invocation.
 */
async function step(report, name, fn) {
  const entry = { name, status: 'pass', detail: null, note: null };
  try {
    const out = await fn();
    if (out && out.skip) {
      entry.status = 'skip';
      entry.reason = out.skip;
    } else if (out && typeof out === 'object') {
      entry.detail = out.detail === undefined ? null : String(out.detail);
      entry.note = out.note || null;
    } else if (out) {
      entry.detail = String(out);
    }
  } catch (err) {
    entry.status = 'fail';
    entry.detail = err.message;
  }
  report.steps.push(entry);
  report.emit(entry);
  return entry;
}

/* ---- the run ----------------------------------------------------------- */

async function run(opts = {}) {
  const secretKey = opts.secretKey || process.env.FOXXERS_STRIPE_SECRET_KEY || '';
  const quiet = !!opts.quiet;
  const report = {
    ok: false, complete: false, refused: null,
    steps: [], passed: 0, failed: 0, skipped: 0,
    emit: reporter(quiet),
  };

  if (!secretKey) {
    report.refused = 'no_key';
    if (!quiet) console.error('Set FOXXERS_STRIPE_SECRET_KEY to a test-mode key (sk_test_…).');
    return finish(report);
  }
  /*
   * Checked before anything is constructed, let alone sent. A script that
   * creates accounts and moves money has no business running against live
   * keys, and finding that out from the first API call is too late.
   */
  if (/^sk_live/.test(secretKey) || /^rk_live/.test(secretKey)) {
    report.refused = 'live_key';
    if (!quiet) {
      console.error('Refusing to run against a LIVE key. This creates accounts and moves money.');
      console.error('Use a test-mode key (sk_test_…), read the report, then switch by hand.');
    }
    return finish(report);
  }

  const api = stripe.create({
    secretKey,
    base: opts.base,
    publicUrl: opts.publicUrl || process.env.FOXXERS_PUBLIC_URL || 'https://example.invalid',
    ...(opts.feeBps === undefined ? {} : { feeBps: opts.feeBps }),
  });

  if (!quiet) {
    const fee = api.fee();
    console.log(`\nFoxxers — Stripe go-live check (test mode)\nPlatform fee: ${fee.description}\n`);
  }

  /*
   * A WRITE first, deliberately. `GET /v1/accounts` returned a clean empty
   * list on a platform that had never signed up for Connect at all, which
   * read as "Connect is enabled" and was wrong. Never use a read to prove a
   * write will work.
   */
  let accountId = opts.account || null;
  await step(report, 'Create a connected account (v2)', async () => {
    if (accountId) return { skip: `reusing ${accountId}, given on the command line` };
    const acct = await api.createAccount({
      email: `go-live-check+${Date.now()}@example.com`,
      business: 'Foxxers go-live check',
      country: 'IE',
    });
    accountId = acct.id;
    return acct.id;
  });

  let ready = null;
  await step(report, 'Read its capabilities back', async () => {
    if (!accountId) return { skip: 'no account to read' };
    const a = await api.account({ accountId });
    ready = a;
    // Every one of these comes back null without the `include` list, which
    // reads exactly like a foxxer who has done nothing.
    return `charges ${a.chargesEnabled} · transfers ${a.transfersEnabled} · payouts ${a.payoutsEnabled}`
      + (a.needs.length ? ` · waiting on ${a.needs.length}` : '');
  });

  await step(report, 'Mint a hosted onboarding link', async () => {
    if (!accountId) return { skip: 'no account to onboard' };
    const link = await api.accountLink({ accountId });
    return link.url;
  });

  /*
   * The intent can be named directly, or — far easier — found from the session
   * the checker itself printed. A session id is on screen already; a
   * PaymentIntent id is buried in the dashboard.
   */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /*
   * `status === 'complete'` is the signal, NOT the presence of a
   * PaymentIntent. Stripe attaches an intent to a session before anybody pays
   * it, and capturing one of those is refused with `requires_payment_method`.
   * Verified the hard way against real Stripe on 2026-09-07.
   *
   * For a manual-capture session `payment_status` stays `unpaid` even once the
   * money is authorised — it means "not captured", not "not paid" — so it is
   * the wrong thing to gate on too.
   */
  function readPaid(cs, sessionId) {
    if (cs.status !== 'complete') {
      return { skip: `session ${sessionId} is still open — it has not been completed. `
        + 'It has a PaymentIntent already, but nobody has paid it' };
    }
    if (!cs.payment_intent) {
      return { skip: `session ${sessionId} completed without a payment` };
    }
    return { intent: cs.payment_intent };
  }

  async function intentFrom(sessionId, given) {
    if (given) return { intent: given };
    if (!sessionId) return { skip: needsIntent };

    let cs;
    try {
      cs = await api.retrieveSession({ id: sessionId });
    } catch (err) {
      /*
       * An id Stripe has never heard of is a typo or a pasted placeholder,
       * not a broken integration. Sinking the run over it buries the steps
       * that did have something to say.
       */
      if (/no such checkout\.session/i.test(err.message)) {
        return { skip: `no such session ${sessionId} — check the id, it is the cs_test_… `
          + 'string printed on the deposit line above' };
      }
      throw err;
    }
    return readPaid(cs, sessionId);
  }

  /*
   * Wait for a human to pay.
   *
   * Every run mints a fresh session, so copying an id from one run into the
   * next is a dance that only works if you are paying attention. Waiting
   * collapses it: the URL is on screen, you pay it, and the run carries on
   * into the steps that move money.
   */
  const waitSeconds = Number(opts.waitSeconds ?? 300);
  const pollMs = Number(opts.pollMs ?? 3000);

  async function waitForPayment(sessionId, label) {
    const until = Date.now() + waitSeconds * 1000;
    if (!quiet) console.log(`      waiting for you to pay the ${label} — Ctrl-C to skip`);
    for (;;) {
      const cs = await api.retrieveSession({ id: sessionId });
      if (cs.status === 'complete' && cs.payment_intent) return { intent: cs.payment_intent };
      if (Date.now() >= until) {
        return { skip: `${label} was still open after ${waitSeconds}s — nobody paid it. `
          + `Pay it and re-run with --session=${sessionId}` };
      }
      await sleep(pollMs);
    }
  }

  let depositIntent = opts.intent || null;
  let heldSession = null, cancelSession = null;
  await step(report, 'Authorise a deposit (hold, not a charge)', async () => {
    const held = await api.hold({
      amount: DEPOSIT, currency: EUR, reference: `check-dep-${Date.now()}`, ref: 'CHECK-DEP',
    });
    heldSession = held.ref;
    depositIntent = depositIntent || held.paymentIntent;
    /*
     * There is no PaymentIntent yet, and there is not supposed to be: Stripe
     * creates one when the customer completes the session. Saying so beats
     * printing "intent null" and leaving the reader to wonder what broke.
     */
    return {
      detail: held.paymentIntent
        ? `session ${held.ref} · intent ${held.paymentIntent}`
        : `session ${held.ref} · no intent until the session is completed`,
      note: `complete it at: ${held.checkoutUrl}`,
    };
  });

  await step(report, 'Raise an invoice as a destination charge', async () => {
    if (!accountId) return { skip: 'no account to route it to' };
    /*
     * A freshly created account has no capabilities at all, and Stripe refuses
     * a destination charge to one — correctly. Reporting that as a FAILURE
     * would mean this step can never pass on a first run, and a checker that
     * always shows one red line is a checker whose red lines stop being read.
     *
     * The app makes the same check before raising a payment: `canBePaid` in
     * payoutsView needs both card_payments and stripe_transfers, because real
     * Stripe refuses with `insufficient_capabilities_for_transfer` when the
     * second is missing.
     */
    if (ready && !ready.transfersEnabled) {
      return { skip: 'the account has no stripe_transfers capability yet — complete the '
        + 'onboarding link above with Stripe test data, then re-run with --account=' + accountId };
    }
    const charged = await api.charge({
      amount: INVOICE, currency: EUR, reference: `check-inv-${Date.now()}`,
      destination: accountId, ref: 'CHECK-INV',
    });
    return {
      detail: `session ${charged.ref} · fee ${charged.fee} minor units`,
      note: `pay it at: ${charged.checkoutUrl}`,
    };
  });

  /*
   * The three that move money. Each needs a real authorisation, which needs a
   * browser and a card — so unless one is handed in, they are skipped and the
   * run is explicitly not complete.
   */
  const needsIntent = 'complete the deposit checkout above in a browser with test card '
    + '4242 4242 4242 4242, then re-run with --session=cs_… (the session id is printed above)';

  /*
   * A SECOND hold, because the first one is about to be captured and a
   * captured intent cannot then be cancelled. Only minted when waiting, since
   * otherwise it is one more URL nobody asked for.
   */
  if (opts.wait) {
    await step(report, 'Authorise a second deposit, to cancel', async () => {
      const held = await api.hold({
        amount: DEPOSIT, currency: EUR, reference: `check-cnl-${Date.now()}`, ref: 'CHECK-CNL',
      });
      cancelSession = held.ref;
      return { detail: `session ${held.ref}`, note: `complete this one too: ${held.checkoutUrl}` };
    });
  }

  let captureIntent = null;
  await step(report, 'Capture an authorisation', async () => {
    const found = opts.wait && heldSession && !opts.session && !opts.intent
      ? await waitForPayment(heldSession, 'first deposit')
      : await intentFrom(opts.session, opts.intent);
    if (found.skip) return found;
    captureIntent = found.intent;
    /*
     * The id is what the adapter builds its idempotency key from, and in the
     * app it is a unique payment row. Here it has to be derived from the
     * intent: a constant stand-in means a second run reuses a key against a
     * different PaymentIntent, which Stripe refuses — so the first run works
     * and every one after it fails.
     */
    const captured = await api.capture({
      payment: { id: `cap-${captureIntent}`, paymentIntentRef: captureIntent, amount: DEPOSIT, currency: EUR },
    });
    return `captured ${captured.ref}`;
  });

  await step(report, 'Transfer a captured deposit to the foxxer', async () => {
    if (!captureIntent) return { skip: needsIntent };
    if (!accountId) return { skip: 'no account to transfer to' };
    const moved = await api.capture({
      payment: { id: `tr-${captureIntent}`, paymentIntentRef: captureIntent, amount: DEPOSIT, currency: EUR },
      destination: accountId,
    });
    return moved.transferRef
      ? `transfer ${moved.transferRef}`
      : 'no transfer was made — the whole amount was taken as fee';
  });

  await step(report, 'Cancel an authorisation', async () => {
    // A second one, deliberately: the first has been captured, and a captured
    // intent cannot be cancelled. Cancelling needs its own untouched hold.
    const found = opts.wait && cancelSession && !opts.cancelSession && !opts.cancelIntent
      ? await waitForPayment(cancelSession, 'second deposit')
      : await intentFrom(opts.cancelSession, opts.cancelIntent);
    if (found.skip) {
      return { skip: `${found.skip} — this needs a SECOND, uncaptured hold (--cancel-session=cs_…)` };
    }
    const released = await api.refund({
      payment: { id: `cn-${found.intent}`, paymentIntentRef: found.intent, status: 'held',
        providerRef: opts.cancelSession || cancelSession, amount: DEPOSIT, currency: EUR },
    });
    return `cancelled ${released.ref}`;
  });

  /* No network, but it is the thing standing between the app and a forged
   * "this invoice is paid", so it gets checked with the rest. */
  await step(report, 'Verify a webhook signature end to end', async () => {
    const secret = 'whsec_check_only';
    const payload = JSON.stringify({ id: 'evt_check', type: 'account.updated' });
    const t = Math.floor(Date.now() / 1000);
    const sig = require('crypto').createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');

    const good = stripe.verifyWebhook({ secret, signatureHeader: `t=${t},v1=${sig}`, rawBody: payload });
    if (!good) throw new Error('a correctly signed payload was rejected');
    const forged = stripe.verifyWebhook({
      secret, signatureHeader: `t=${t},v1=${'0'.repeat(64)}`, rawBody: payload,
    });
    if (forged) throw new Error('a forged signature was accepted');
    const stale = stripe.verifyWebhook({
      secret, signatureHeader: `t=${t - 4000},v1=${sig}`, rawBody: payload,
    });
    if (stale) throw new Error('a replayed old message was accepted');
    return 'good signature accepted, forged and replayed both refused';
  });

  return finish(report, { accountId, depositIntent });
}

function finish(report, extra = {}) {
  report.passed = report.steps.filter((s) => s.status === 'pass').length;
  report.failed = report.steps.filter((s) => s.status === 'fail').length;
  report.skipped = report.steps.filter((s) => s.status === 'skip').length;
  report.ok = !report.refused && report.failed === 0;
  // Passing is not the same as being done. Anything skipped means a money path
  // still has not been exercised against Stripe, and saying "all green" here
  // would be the exact lie this script exists to prevent.
  report.complete = report.ok && report.skipped === 0;
  Object.assign(report, extra);
  delete report.emit;
  return report;
}

/* ---- cli --------------------------------------------------------------- */

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = m[2] === undefined ? true : m[2];
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  run(args).then((report) => {
    if (report.refused) process.exit(2);
    console.log(`\n${report.passed} passed · ${report.failed} failed · ${report.skipped} skipped`);
    if (report.complete) {
      console.log('\nEvery money path has now run against real Stripe.');
    } else if (report.ok) {
      console.log('\nNothing failed, but this run is NOT complete — the skipped steps above');
      console.log('have still never moved money. Do those before switching to live keys.');
    }
    process.exit(report.failed ? 1 : 0);
  }).catch((err) => {
    console.error('The check itself fell over:', err.message);
    process.exit(3);
  });
}

module.exports = { run };
