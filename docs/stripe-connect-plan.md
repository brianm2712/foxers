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

**Two of them are made.** Decision 4 is *visible but unpayable* and decision 5 is
*Stripe-hosted checkout*; both are written up in place below and Phase 1 is built
around them. Decisions 1, 2 and 3 are still open and are not needed until Phase 2.

### 1. What is the platform fee?

Currently zero, and it stays zero until set — an instance that has not decided
should not silently take a cut. Set as basis points and/or cents:
`FOXXERS_PLATFORM_FEE_BPS`, `FOXXERS_PLATFORM_FEE_CENTS`.

On a €421.84 job: 5% is €21.09, 2% is €8.44, €2 flat is €2. Stripe's own fee
(~1.5% + €0.25 on EEA cards) comes off the foxxer's side, not yours.

### 2. Does the €5 deposit still get charged?

Right now the rule is: taken on request, **credited against the invoice** if
the quote is accepted. Stripe can do better than that.

An authorisation can be **cancelled** rather than captured. So:

| | today | with an authorisation |
|---|---|---|
| Quote accepted | €5 charged, then €5 off the invoice | hold released, nothing charged, invoice paid in full |
| Quote declined | foxxer keeps €5 | hold captured, foxxer gets €5 |
| Customer pays in total | the same either way | the same either way |
| Fees on the happy path | ~€0.25 wasted on every accepted quote | **nothing** |

Same money for everyone, cheaper, and no confusing €5 line on the invoice.
**But it is a change to the rule you chose**, so it is yours to make.

### 3. What happens when an authorisation expires?

Card holds last about **7 days**. A quote that takes longer leaves the foxxer
unprotected. Options: expire the request with it; re-authorise before it
lapses (needs the customer present); or accept that a slow quote loses the
protection and say so on screen.

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

### Phase 3 — deposits  (~1 day)

- Authorise on the platform account at request time
- Accept → cancel; decline → capture, then transfer to the foxxer
- `amount_capturable_updated` webhook moves `pending` → `held`
- Expiry handling per decision 3

### Phase 4 — going live  (~half a day plus Stripe's review)

- Stripe platform profile, Connect enabled, branding
- A platform agreement foxxers accept at onboarding
- Fees disclosed to both sides before they commit
- Test-mode run of every path, then live keys

**Roughly three days of building**, spread over however long Stripe takes to
approve the platform.

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
