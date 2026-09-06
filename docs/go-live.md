# Going live

Everything in Phase 4 that code can do is done. What is left is in Stripe's
dashboard and in your hands, because it needs your account, your identity and
your judgement. This is that list, in the order it actually has to happen.

Nothing here should be rushed to get a green tick. The whole point of the last
step is to find out what is wrong while it is still test money.

---

## Before anything else: the agreement is not reviewed

`server/lib/agreement.js` is wired into onboarding and a foxxer cannot get a
Stripe account without accepting it. **It has not been near a solicitor.**

It is an honest description of what the code does with a tradesperson's money —
the 2%, that Stripe holds the funds and Foxxers never does, how a deposit hold
behaves, and that a destination charge leaves the foxxer carrying disputes. It
is a good starting point and it is not a reviewed contract.

Get it looked at before a real tradesperson accepts one, particularly on:

- **Consumer law** — the customer is often a consumer, and the deposit hold is
  a pre-authorisation on their card.
- **PSD2 / the Payment Services Regulations** — the whole reason for Connect is
  that Foxxers must never hold anyone's money. The agreement says so; someone
  qualified should confirm the arrangement matches the words.
- **What a sole trader can be asked to indemnify** — clause 5 and the liability
  wording in clause 6.
- **Which law applies** — clause 8 splits Ireland and the UK by where the
  foxxer trades, which is a simplification.

When the wording changes, **change `VERSION`**. Acceptance is recorded against
it, so an unchanged version means stored acceptances point at text nobody saw.
Foxxers who accepted an older version are shown the agreement again.

---

## 1. Stripe dashboard — the platform profile

In your Stripe account, in **test mode** first.

- [ ] **Enable Connect.** Settings → Connect. Note that a platform can list
      connected accounts before it can create one, so "the API answered" is not
      proof this is done — the checker in step 3 creates one, which is.
- [ ] **Complete the platform profile.** Stripe asks what your business does,
      who your users are, and how money flows. Answer it as: a marketplace for
      trades in Ireland and the UK; connected accounts are sole traders; the
      platform takes a stated fee from each payment and never holds funds.
- [ ] **Set the responsibilities.** The code creates accounts with
      `fees_collector: application` and `losses_collector: application` — the
      platform collects fees and carries losses. Make sure the dashboard
      settings agree with that, because the code states it explicitly on every
      account and a mismatch will surface as a refused account creation.
- [ ] **Branding.** Business name, icon, brand colour, support email and URL.
      This is what a foxxer sees on the hosted onboarding page and what a
      customer sees on the hosted checkout page. An unbranded Stripe page in
      the middle of the flow is where people stop.
- [ ] **Statement descriptor** — but know what it does and does not control.

      The adapter sets `on_behalf_of: <connected account>` on every job
      payment, which makes **the foxxer the merchant of record**. The statement
      descriptor, the business name on the statement and the dispute liability
      all follow their account, not the platform's. So the platform descriptor
      you set here governs anything Foxxers charges directly — not the payments
      customers actually make.

      That leaves a real question, and it is not a technical one: a customer
      who booked through Foxxers sees `BYRNE ELECTRICAL` on their statement.
      Whether that is more or less recognisable than `FOXXERS` decides how many
      chargebacks land on your foxxers, and under destination charges they pay
      for every one.

      If it should say both, set `statement_descriptor_suffix` on the
      PaymentIntent in `charge()` — Stripe composes it with the connected
      account's own prefix. Nothing does that today.

## 2. Webhooks

- [ ] **Add an endpoint** pointing at `https://<your-host>/api/v1/webhooks/stripe`.
- [ ] **Subscribe to** at least: `account.updated`, `capability.updated`,
      `person.*`, `checkout.session.completed`,
      `checkout.session.async_payment_succeeded`, and
      `payment_intent.amount_capturable_updated`.

      That last one is load-bearing: it is the only thing that moves a deposit
      from `pending` to `held`. Without it, every deposit sits pending forever
      and no quote can ever be declined for money.
- [ ] **Copy the signing secret** into `FOXXERS_STRIPE_WEBHOOK_SECRET`. The
      endpoint returns 404 without one, rather than accepting unsigned events.
- [ ] Remember that a **classic endpoint receives the v1 connect events**
      (`account.updated`, `capability.updated`, `person.*`) even for v2
      accounts. The thin `v2.core.account…` events only arrive at a separately
      configured event destination. The handler takes both; you only need the
      classic endpoint.

## 3. The test-mode run

```bash
FOXXERS_STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-check.js
```

It refuses a live key. It creates a connected account, reads its capabilities
back, mints an onboarding link, authorises a deposit, raises an invoice as a
destination charge, and checks webhook signature verification — reporting what
Stripe actually said at each step.

Three steps it **cannot** do on its own, because they need a browser and a
card: capturing, transferring and cancelling. It prints the checkout URLs and
skips those steps. To finish them:

1. Open the deposit URL it printed, pay with a Stripe test card
   (`4242 4242 4242 4242`, any future expiry, any CVC).
2. Do it a second time, so you have one authorisation to capture and one to
   cancel.
3. Re-run with both intents:

```bash
FOXXERS_STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-check.js \
  --intent=pi_first --cancel-intent=pi_second --account=acct_from_step_one
```

**The run is not complete until it says so.** Skipped is not passed, and the
script keeps the two apart deliberately: everything below has still never
moved money against Stripe, and a mock cannot tell you otherwise.

A transfer needs the connected account to be genuinely onboarded — capabilities
`active`, not `restricted`. Complete the onboarding link with Stripe's test
data first, or the transfer step will fail with
`insufficient_capabilities_for_transfer`, which is the real error and worth
seeing once.

- [ ] Every step passes, and the script prints "Every money path has now run
      against real Stripe."

## 4. Also worth doing by hand, once

The checker exercises the adapter. These are end-to-end through the app, which
is a different thing:

- [ ] A foxxer signs up, is refused payouts until they accept the agreement,
      accepts it, and completes Stripe onboarding.
- [ ] A customer sends a request, completes the deposit hold, and the deposit
      reaches `held` **from the webhook** — not from the browser coming back.
- [ ] Accepting the quote releases the hold. Check the customer's test card in
      Stripe: there should be no charge at all, and the invoice should be for
      the full quoted price with no deposit line.
- [ ] Declining a different quote captures the hold and transfers it, less the
      2%. Check it lands in the connected account's balance.
- [ ] An invoice paid by card marks the invoice paid **only** after the webhook,
      and issues exactly one receipt when the webhook is redelivered.
- [ ] Leave a hold for eight days, or set `FOXXERS_HOLD_DAYS=0.001`, and check
      the request expires and can no longer be quoted.

## 5. Switching to live

Only after step 3 says complete and step 4 is done.

- [ ] Stripe reviews and approves the platform. This is the part with no
      deadline you control — start it early.
- [ ] Fee disclosed to both sides. It is on the payouts card and in the
      agreement; read them both once more as a stranger would.
- [ ] Swap `FOXXERS_STRIPE_SECRET_KEY` to `sk_live_…` and the webhook secret to
      the live endpoint's. The app logs `LIVE` or `test` at boot from the key
      shape — check the log line says what you expect.
- [ ] Take one real payment, of your own money, and refund it.

---

## Still not covered

Worth knowing before real money moves, none of it built:

- **Disputes and chargebacks.** With destination charges the foxxer carries
  them. The agreement says so; nothing in the app handles the dispute webhooks
  or tells a foxxer one has happened.
- **Payouts and statements.** A foxxer cannot see what Stripe owes them or
  when it lands. They have the Express dashboard for it, which is not nothing,
  but it is not in Foxxers.
- **The iOS and Android apps.** `ios/` does not exist. Apple forbids in-app
  purchase for real-world services, so job payments must use a card rail there
  regardless.
