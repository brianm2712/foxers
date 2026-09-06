'use strict';
/*
 * The agreement a foxxer accepts before Foxxers creates them a Stripe account.
 *
 * NOT LEGAL ADVICE, AND NOT REVIEWED BY ANYONE QUALIFIED. This is a plain
 * statement of what the software actually does with a tradesperson's money,
 * written so that the terms and the code cannot quietly disagree. It needs a
 * solicitor's eyes before a real person accepts it — particularly on consumer
 * law, the Payment Services Regulations, and what an Irish or UK sole trader
 * can be asked to indemnify.
 *
 * VERSIONING. `VERSION` is the date the wording last changed. Acceptance is
 * recorded against it, so "they agreed" always means a specific set of words.
 * Change the words, change the version — otherwise a stored acceptance points
 * at text nobody ever saw.
 *
 * The fee is interpolated from what the instance is actually configured to
 * charge rather than typed in, because an agreement that states a different
 * number from the one the code deducts is worse than no agreement at all. The
 * fee in force is recorded alongside the version at acceptance, so a later
 * change to it is visible rather than retroactive.
 */

const VERSION = '2026-09-06';

const TITLE = 'Foxxers platform agreement';

/*
 * `feeDescription` comes from the payment provider — the same source the
 * deduction itself uses. See `platformFee` in providers/stripe.js.
 */
function body({ feeDescription = '2% of each payment' } = {}) {
  return `
# ${TITLE}

Version ${VERSION}

This is the agreement between you — the tradesperson, called a foxxer here —
and Foxxers, about money taken through the app. Plain words on purpose.

## 1. What Foxxers does, and does not do

Foxxers is job software and a booking marketplace. It is not a bank and it is
not a payment institution. Card payments are processed by **Stripe**, and you
hold your own Stripe account. Foxxers never holds your money and cannot spend
it, move it, or stop it reaching you.

When a customer pays an invoice through the app, the money is routed to your
Stripe account as it is taken. Stripe pays it out to your bank on its own
schedule, under its own agreement with you.

## 2. What it costs you

Foxxers charges **${feeDescription}** taken through the app. It is deducted at
the moment the payment is taken, before the money reaches you, and it is shown
on the payment in your console.

Stripe charges you its own processing fee on top of that, under your agreement
with Stripe. Foxxers does not set it, does not receive it, and cannot waive it.

There is no subscription, no listing fee and no charge for quoting.

## 3. Deposits on requests

A customer sends a request with a small deposit **held** on their card — an
authorisation, not a charge.

- If the customer accepts your quote, the hold is released. Nothing is charged
  to them and nothing is paid to you. The invoice is for the quoted price.
- If the customer declines your quote, the hold is captured and transferred to
  you, less the platform fee, for the time you spent pricing the job.
- A card authorisation lasts about seven days. If nobody answers in that time
  the hold lapses, the request closes, and nobody is paid.

## 4. Disputes and chargebacks

**You carry disputes and chargebacks on payments made to you.** Because money
is routed to your account as it is taken, a customer who disputes a payment is
disputing one that reached you, and Stripe recovers it from your balance —
including any dispute fee Stripe charges.

Foxxers will pass on what it knows about the job: the quote, what was agreed,
the times offered and accepted, and the receipt. It cannot decide a dispute and
does not represent you in one.

If you disagree with a customer, the app's record of what was quoted and agreed
is the evidence. That is what it is for.

## 5. What you are responsible for

- Being who you say you are, and holding whatever registration, insurance and
  qualification your trade requires.
- The work itself. Foxxers introduces you to customers and records what was
  agreed; it does not carry out, supervise or guarantee any job.
- Your own tax. Foxxers calculates VAT and construction withholding to help you
  invoice correctly, but the return is yours and the numbers are yours to
  check. Nothing in the app is tax advice.
- Honouring the hours you offer. An offered time that is not real is the one
  thing that makes the whole thing worthless to a customer.

## 6. What Foxxers is responsible for

- Showing customers your real availability, and never selling placement in
  search above tradespeople who can genuinely start sooner.
- Keeping an accurate record of quotes, acceptances, invoices and receipts, and
  making it available to you.
- Not taking a fee that has not been stated here.
- Telling you before the fee changes. A change applies to payments taken after
  it takes effect, never to ones already made.

Foxxers is provided as it is. It is not liable for work you carry out, for a
customer who does not pay, or for money Stripe holds, delays or recovers under
its own agreement with you.

## 7. Ending it

You can stop using Foxxers whenever you like. Your Stripe account is yours and
is unaffected. Jobs already agreed stay in the record, because a customer with
an accepted quote is entitled to it.

Foxxers may suspend an account that misrepresents who it is, offers times it
cannot keep, or attempts to take customers' money outside the terms above.

## 8. Law

This agreement is governed by the law of Ireland for foxxers trading in
Ireland, and by the law of England and Wales for foxxers trading in the United
Kingdom. Nothing here removes a right you have under consumer or employment law
that cannot be signed away.
`.trim();
}

module.exports = { VERSION, TITLE, body };
