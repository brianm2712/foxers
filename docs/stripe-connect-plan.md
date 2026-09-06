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

### 4. Can a foxxer trade before they have onboarded?

Onboarding takes minutes but needs ID and a bank account. Until it is done
they cannot be paid. Do they:

- appear in search and take quote requests, but cannot be paid until onboarded
  (nothing blocks them, risk of a job with no way to pay for it); or
- stay hidden until payouts are live (clean, but a wall in front of signup)?

My preference is the first, with the setup guide making it loud.

### 5. Loading Stripe.js breaks a promise the site makes

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

### Phase 1 — onboarding, no money  (~half a day)

Nothing can charge anything, so it is safe to build and ship first.

- `pros.stripeAccountId` and a cached `pros.payouts` status
- `POST /api/v1/pro/payouts/onboard` — create an Express account, return a
  Stripe onboarding link
- `GET /api/v1/pro/payouts` — live status
- A card in the **Business** tab: not started / incomplete / ready, with what
  Stripe still wants
- A step in the new-foxxer setup guide
- `account.updated` webhook to keep the status honest

**Testable end to end in Stripe test mode with no real money.**

### Phase 2 — invoice payments  (~1 day)

- Destination charge to the foxxer's account, platform fee deducted
- Refuse to raise a payment if `chargesEnabled` is false, with a clear reason
- `payment_intent.succeeded` webhook marks paid and issues the receipt
- Receipt records the connected account and the fee
- Client: confirm the PaymentIntent (see decision 5)

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
  authorise/capture/cancel/refund, transfers, account creation, onboarding
  links, and webhook signature verification. Form encoding and minor units are
  handled and tested.
- `server/lib/payments.js` — the seam, with the `pending` state a real rail
  needs and webhook-driven settlement.
- `server/lib/providers/revolut.js` — single-merchant, so wrong for
  customer-to-foxxer. **Keep it**: it is the right shape if Foxxers ever bills
  tradespeople directly, outside the app stores.

**Nothing has ever spoken to Stripe.** It needs a test-mode key and one real
round trip before it goes near a card.

## What this does not cover

- **The iOS and Android apps do not exist.** `ios/` is empty. Apple Pay and
  Google Pay in-app are a native build, not a web change — and Apple forbids
  in-app purchase for real-world services, so job payments must use a card
  rail regardless.
- Disputes and chargebacks. With destination charges the foxxer carries them;
  worth saying so in the agreement.
- Payouts scheduling, statements, and what a foxxer sees about their own money.
