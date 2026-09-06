# Stripe Connect — scope

Written 2026-09-06, after building the adapter far enough to find out what is
actually hard. The adapter exists (`server/lib/providers/stripe.js`) and its
primitives are tested. What follows is everything else, and the decisions that
are yours rather than mine.

## Why Connect and not a gateway

A plain gateway puts every customer payment into the platform's own account,
leaving Foxxers owing money to tradespeople. In the EU that is regulated
activity under PSD2. With Connect each foxxer has their own Stripe account,
Stripe does their identity and bank checks, money settles to them, and the
platform takes a stated fee without ever holding it.

That is the whole reason for the change. Everything below follows from it.

---

## The five decisions I cannot make for you

**All five are now made** (2026-09-06) and each one is built and pinned by a
test. They are kept below with their reasoning, because the reasoning is what a
future change has to argue against.

### 1. What is the platform fee?  — DECIDED: 2%

**200 basis points, and it is the default rather than something an instance has
to configure.** `DEFAULT_FEE_BPS` in `providers/stripe.js`; still overridable
per instance with `FOXXERS_PLATFORM_FEE_BPS` and `FOXXERS_PLATFORM_FEE_CENTS`.

On a €421.84 job that is €8.44. 5% would have been €21.09 — a standard
marketplace rate, but stacked on Stripe's own ~1.5% + €0.25 it takes ~6.5% off
a tradesperson's invoice, which is a lot to defend on work priced in hundreds.

**The known weakness: it does not cap.** On a €5,000 extension 2% is €100, for
a booking that cost the platform the same as a €200 one. If large jobs become
normal, a cap or a banded rate is the change to make — not a lower percentage
across the board.

Pinned by `a card payment produces a Stripe-hosted checkout…` in
`tests/connect.test.js`, which asserts the €3.37 fee on a €168.30 invoice, and
by the €4.90 transfer in `tests/deposits.test.js`.

### 2. Does the €5 deposit still get charged?  — DECIDED: no, it is a hold

**Authorised on request, cancelled on accept, captured on decline.** The old
charge-then-credit rule is gone; `credited` survives only as a state, so that
deposits taken under it can still settle.

What changed in the code: a deposit now goes through the same Stripe-hosted
checkout an invoice does, but with `capture_method: manual`, so completing the
page authorises rather than charges. `acceptQuote` calls `releaseDeposit`,
which cancels the PaymentIntent. The invoice is raised for the full quoted
price — there is no €5 to credit, because no €5 was taken.

The table that made the case:

| | today | with an authorisation |
|---|---|---|
| Quote accepted | €5 charged, then €5 off the invoice | hold released, nothing charged, invoice paid in full |
| Quote declined | foxxer keeps €5 | hold captured, foxxer gets €5 |
| Customer pays in total | the same either way | the same either way |
| Fees on the happy path | ~€0.25 wasted on every accepted quote | **nothing** |

Same money for everyone, cheaper, and no confusing €5 line on the invoice.
**But it is a change to the rule you chose**, so it is yours to make.

### 3. What happens when an authorisation expires?  — DECIDED: the request expires with it

**A hold that lapses closes its request.** `expireStaleHolds` in `domain.js`
sweeps every 15 minutes and at boot, moves the deposit to `expired` and the
request to `expired`, and `createQuote` re-checks on the way in so a request
cannot be quoted in the gap between two sweeps. The window is
`FOXXERS_HOLD_DAYS`, 7 by default.

The cost, stated plainly: a slow but genuine customer loses their request on
day 7 and has to send it again. That was judged better than the alternative,
which is a foxxer spending an evening pricing a job whose protection had
quietly evaporated.

Re-authorising was rejected rather than deferred: a fresh authorisation needs
the customer present to approve it, so it is a notification flow that usually
will not complete, dressed up as protection.

### 4. Can a foxxer trade before they have onboarded?  — DECIDED: yes

**They appear in search, take requests and quote like anyone else. They just
cannot be paid through the app, and are told so.** ID and a bank account
between signing up and getting any value is how a marketplace never reaches its
first hundred trades.

Built that way, and pinned by a test (`an un-onboarded foxxer still appears in
search and can be published`) so it cannot be quietly reversed. What they get
instead of a wall:

- an amber — not red — card at the top of the Business tab, saying they can
  quote and work today, and what Stripe will want when they are ready;
- a **Get paid** step in the new-foxxer setup guide, deliberately excluded from
  the "N things to do before customers can find and book you" count, because it
  is not one of them;
- the risk this accepts: a job can be done by someone with no way to collect
  through the app. Phase 2 refuses to *raise* a Stripe payment when
  `chargesEnabled` is false, and the other payment methods — cash, transfer,
  their own card reader — still work, so the job is collectable off-platform.

### 5. Loading Stripe.js breaks a promise the site makes  — DECIDED: hosted checkout

**Web customers go to a Stripe-hosted checkout page.** One redirect out; nothing
third-party loads on a Foxxers page, so the footer stays literally true. Not
seamless, and that is the price.

The original three options are below, since the reasoning still matters if the
native apps change the trade-off — the SDK is bundled there rather than fetched,
so in-app card entry can be seamless without breaking anything the web promises.

The footer says **"No tracking, no analytics, no third-party requests."** That
is true today and it is unusual. Seamless in-app card entry means loading
`js.stripe.com`, which is a third-party request that also does fraud
fingerprinting.

Three ways out:

- accept it and change the footer to something still true;
- keep the web app payment-free and take card payments **only in the native
  apps**, where the SDK is bundled rather than fetched;
- send web customers to a Stripe-hosted checkout page — one redirect, nothing
  third-party loaded on your own pages, but not seamless.

This one is a brand decision as much as a technical one.

---

## The work, in the order I would do it

### Phase 1 — onboarding, no money  — BUILT

Nothing can charge anything, so it was safe to build and ship first.

- ✅ `pros.stripeAccountId` and a cached `pros.payouts` status
- ✅ `POST /api/v1/pro/payouts/onboard` — creates a connected account **once**
  and mints a fresh link on every call, since links are single-use
- ✅ `GET /api/v1/pro/payouts` — live status, and it writes the cache
- ✅ A card in the **Business** tab: not started / incomplete / ready, with what
  Stripe still wants translated out of Stripe's vocabulary
  (`identity.individual.date_of_birth.day` and its two siblings → "your date
  of birth", once)
- ✅ A step in the new-foxxer setup guide
- ✅ a webhook that keeps the status honest, taking both event families

`tests/connect.test.js` — 12 assertions, a real server against a strict mock
Stripe. Three are load-bearing beyond the happy path: exactly one account is
ever created for a foxxer (a second would split their money across two
accounts), **loading the dashboard makes no outbound call to Stripe** (it reads
the cache the webhook keeps honest), and the webhook handles the event family
Stripe actually sends.

### It has now spoken to Stripe, and that changed the code twice

Run against a real sandbox, which found two things a mock never would.

**Accounts v1 `type: 'express'` is the legacy path.** Connected accounts are now
created with the Accounts v2 API (`POST /v2/core/accounts`), which replaces the
opaque account type with stated responsibilities — the platform collects fees
and carries losses, the foxxer gets an Express-style dashboard — and takes
`merchant` and `recipient` configurations rather than a `capabilities` list. v2
speaks JSON where v1 speaks form encoding, and it returns `null` for anything
not named in `include`, which reads exactly like an account with no
capabilities. The pinned API version is no longer cosmetic: the v2 endpoints
reject old versions outright rather than falling back.

**A classic webhook endpoint does not receive v2 events.** The handler was
written for the thin `v2.core.account[…]` events the v2 documentation shows.
Pointing the Stripe CLI at a running server and reading what actually turned up
showed `account.updated`, `capability.updated` and `person.*` — the v1 connect
events — for a v2 account. The thin events only reach a separately configured
event destination. The handler had been returning 200 and ignoring every one of
them: it would have passed its tests and tracked nothing in production. It now
takes both families, and since neither is parsed for state — both just mean
"re-read the account" — supporting both costs one condition, not one code path.

Verified end to end: a real connected account created through the app, a real
hosted-onboarding link opened and branded, real requirements parsed into the
Business tab, and a real connect event received, matched to a foxxer, and
applied.

**The money paths remain unexercised.** No charge, deposit, capture or transfer
has ever been made against Stripe.

### What the second real round trip found  (2026-09-06, evening)

`scripts/stripe-check.js` against a live test sandbox. Account creation, the
capability read, the onboarding link and both checkout sessions were all
accepted — including with `http://localhost` return and success URLs, which had
been the predicted first failure and was not one.

**A checkout session has no PaymentIntent when you create it.** Real Stripe
returns `payment_intent: null`; the intent is created when the customer
completes the session. The mock had been handing one back at creation, and that
single courtesy hid a bug that would have broken every deposit in production:
`holdDeposit` stored the null, and `payment_intent.amount_capturable_updated`
matched deposits on that stored id — so no deposit would ever have left
`pending`, no quote could ever have been declined for money, and the tests
would have stayed green throughout.

Fixed by carrying the job reference in `payment_intent_data.metadata`, so the
intent identifies itself whatever order the events arrive in, and by recording
the intent id from `checkout.session.completed`. Both orderings are now pinned
by tests, because the two events race and the app has no say in which wins.

### And what the third found  (2026-09-07)

Running the money steps for real, with `--wait`.

**A Checkout Session has a PaymentIntent before anybody pays it.** The checker
had been waiting for an intent to appear and treating that as payment, so it
carried on into capture against an unpaid session and Stripe refused with
`requires_payment_method`. `status === 'complete'` is the signal. Note that
`payment_status` is *not* — on a manual-capture session it stays `unpaid` even
once the money is authorised, because it means "not captured".

**You cannot cancel a PaymentIntent that Checkout created while its session is
open.** Stripe says so in as many words and tells you to expire the session
instead. This one reaches past the checker into the app: a customer who opens a
request and closes the tab leaves a deposit at `pending`, and the seven-day
sweep releases it — by cancelling an intent that cannot be cancelled. The
release would have failed, the session would have stayed open, and the customer
could still have completed it afterwards, putting a hold on their card for a
request that closed a week ago.

`refund()` now expires the session when there is no capturable intent, and
falls back to expiring if a cancel is refused for this reason — the app can
believe a deposit is held, because a webhook said so, while Stripe still
considers the session open. `tests/stripe-adapter.test.js` pins all four paths.

**A destination charge to a fresh account is refused, and should be.** Stripe
asked for `configurations.recipient.capabilities.stripe_balance.stripe_transfers`
by name — the exact capability the account is created requesting, so the request
shape is right; the account simply has not been onboarded. The checker now
reports that as a skip with instructions rather than a failure, since a first
run can never pass it and a permanent red line is one people stop reading.

### Phase 2 — invoice payments  — BUILT

- ✅ Destination charge to the foxxer's account, platform fee deducted
- ✅ Refuse to raise a payment before they can be paid, with a clear reason —
  and it checks **both** capabilities, not just charges (see below)
- ✅ `checkout.session.completed` marks paid and issues the receipt, idempotently
- ✅ Receipt records the connected account and the fee
- ✅ Client: a link to send, per decision 5 — no Stripe.js on our pages

Three things this turned up that were not in the plan.

**No caller ever named a provider.** `providerFor(undefined)` fell through to
`manual`, so a registered rail was never reached by anything. An instance
configured for Revolut had been recording every payment as manual and moving
nothing — the setup instructions in the README worked, and did nothing. The
configured rail is now the default, and a provider declares which methods it
actually takes so cash and transfers still never touch it.

**An invoice was marked paid before the money moved.** `settleInvoice` wrote
the receipt in the same breath as taking payment, which is right for cash and
wrong for anything asynchronous. A pending payment now leaves the invoice owed
and writes no receipt; `completePayment` finishes it from the webhook.

**Two capabilities, not one.** A destination charge needs `merchant`
card-payments *and* `recipient` transfers. Real Stripe refuses with
`insufficient_capabilities_for_transfer` when the second is missing, so a gate
that checked only the first would have sent a foxxer to a failure at the till.

### Phase 3 — deposits  — BUILT

- ✅ Authorised on the platform account at request time, through the same
  hosted checkout an invoice uses, in manual-capture mode
- ✅ Accept → cancel the hold; decline → capture, then transfer to the foxxer
  less the 2% fee
- ✅ `payment_intent.amount_capturable_updated` moves `pending` → `held`
- ✅ Expiry per decision 3, swept every 15 minutes and re-checked at quote time

`tests/deposits.test.js` — six tests against a mock Stripe that refuses what
the real one refuses (it will not capture an automatic-capture intent, or
cancel a captured one). Four things this turned up that were not in the plan.

**A capture with no destination pays nobody.** `captureDeposit` called
`provider.capture({ payment })` and never passed the foxxer's account, so the
transfer branch was dead code: the €5 would have been captured onto the
platform and stopped there, while every screen in the app said the foxxer had
earned it. It now looks the pro up and passes `destination`.

**A hold is a session, but a capture is an intent.** The payment stores the
checkout session id, because that is what `checkout.session.completed` names —
but capture, cancel and refund all act on the PaymentIntent. Both references
are now kept, and `intentOf` prefers the intent while falling back to
`providerRef` for anything taken before that was true.

**`checkout.session.completed` fires for deposits too, and meant the wrong
thing.** The handler assumed every completed session was an invoice and called
`completePayment`, which would have thrown on a deposit — no invoice — or, worse
on a different code path, marked something paid that was only authorised. It now
branches on `kind` and lets the capturable event do the work.

**Cancelling a hold moves no money.** `refund` reported `moved: true` for both
branches. For a cancellation that is false, and it would have put a €5 movement
in the ledger that never happened.

### Phase 4 — going live  (partly built)

- ⬜ Stripe platform profile, Connect enabled, branding — **yours, in the Stripe
  dashboard.** Nothing in this repo can do it.
- ✅ A platform agreement foxxers accept at onboarding. `server/lib/agreement.js`,
  versioned, served at `GET /api/v1/pro/agreement` and accepted at
  `POST /api/v1/pro/agreement/accept`. `payouts/onboard` refuses with
  `agreement_required` until it is accepted, checked **before** anything is
  created at Stripe so a refusal cannot leave a half-made account behind.
- ✅ Fees disclosed before they commit. The rate is stated on the payouts card
  in the Business tab and inside the agreement — and both read it from the same
  provider that performs the deduction, so the words cannot drift from the
  arithmetic.
- ⬜ Test-mode run of every path, then live keys — **needs your test key.** The
  runner is built: `scripts/stripe-check.js` refuses a live key, exercises
  account creation, capability reads, onboarding links, a deposit hold, a
  destination charge and webhook signature verification, and reports what
  Stripe actually said. Capture, transfer and cancel need a browser and a card,
  so it prints the checkout URLs, skips those three, and refuses to call the
  run complete until they have really run.

**The agreement text is not legal advice and has not been reviewed by anyone
qualified.** It is a plain statement of what the code actually does with a
foxxer's money, written so the terms and the behaviour cannot quietly disagree.
It needs a solicitor before a real person accepts it, particularly on consumer
law, PSD2/PSR, and what an Irish or UK sole trader can be asked to indemnify.

Two details worth keeping:

**The version is checked on the way in.** `accept` takes the version the client
was shown and refuses anything else with `stale_agreement`. Accepting whatever
the server currently holds would record agreement to words that changed while
the page was open, which is the exact case a version exists to catch.

**The fee in force is stored with the acceptance.** An instance that later
changes its cut cannot present the new one as something already agreed to; the
console shows an amber notice and asks them to read it again.

What is left is the half of Phase 4 that only you can do: the platform profile
in Stripe's dashboard, and a test-mode run with a real key. Both are written
out step by step in [go-live.md](go-live.md).

---

## What already exists

- `server/lib/providers/stripe.js` — the adapter. Destination charges,
  authorise/capture/cancel/refund, transfers, **Accounts v2** account creation,
  onboarding links (still v1, even for v2 accounts), and webhook signature
  verification. Both encodings, and minor units, are handled and tested.
- `server/lib/payments.js` — the seam, with the `pending` state a real rail
  needs and webhook-driven settlement.
- `server/lib/providers/revolut.js` — single-merchant, so wrong for
  customer-to-foxxer. **Keep it**: it is the right shape if Foxxers ever bills
  tradespeople directly, outside the app stores.

## What the first real round trip found  (2026-09-06)

The adapter has now spoken to Stripe once, against a test sandbox. It got
further than expected and then hit one thing no mock could have produced.

Confirmed working against the real API:

- the pinned `Stripe-Version: 2024-06-20` is accepted
- authentication, form encoding and error parsing are all correct — a 400 from
  Stripe surfaced as a clean `provider_error`, not a crash
- `GET /api/v1/pro/payouts` returns `not_started` correctly
- the CLI webhook listener forwards to `/api/v1/webhooks/stripe`

**The blocker: `POST /v1/accounts` is the wrong endpoint for a new integration.**

> Stripe no longer recommends Accounts v1 for new Connect integrations. Create
> connected accounts with `POST /v2/core/accounts` instead.

`createAccount` and `accountLink` in `providers/stripe.js` are written against
Accounts v1. Stripe still serves v1, and an account can opt back into it at
`dashboard.stripe.com/settings/features/feat_accounts_v1_support` — but this is
a new integration, which is exactly the case Stripe is steering off v1.

So there is a decision here, and it is not merely cosmetic:

- **Toggle v1 back on.** Nothing to rewrite. Ships on an endpoint Stripe has
  already started moving people off, which is a poor foundation for something
  that is meant to handle tradespeople's money for years.
- **Migrate to Accounts v2.** `POST /v2/core/accounts`, a different account
  shape, and the onboarding-link call almost certainly changes with it. Its own
  piece of work, with its own tests.

Worth knowing before deciding: **a lesson from this round trip is that listing
connected accounts succeeds even when account *creation* is not available.**
`GET /v1/accounts` returned a clean empty list on an account that had never
signed up for Connect at all, which read as "Connect is enabled" and was wrong.
Do not use a read to prove a write will work.

**Nothing beyond account creation has been exercised.** The onboarding link,
the account-status read and a real `account.updated` signature are all still
unverified, because the flow stops at the first call.

## What this does not cover

- **The iOS and Android apps do not exist.** `ios/` is empty. Apple Pay and
  Google Pay in-app are a native build, not a web change — and Apple forbids
  in-app purchase for real-world services, so job payments must use a card
  rail regardless.
- Disputes and chargebacks. With destination charges the foxxer carries them;
  worth saying so in the agreement.
- Payouts scheduling, statements, and what a foxxer sees about their own money.
