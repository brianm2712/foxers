# Foxxers

Job software and a booking marketplace for trades, for Ireland and the UK.

Two apps share one domain, and the split between them is the product. A **customer**
signs in, searches by trade and county, and either books fixed-price work outright or
describes a job and gets a written quote. A **foxxer** — the tradesperson — signs in to a
console: requests to price, quotes waiting on a yes, the diary, and the money.

Node standard library only. No npm, no build step, no outbound calls.

![Foxxers, end to end](docs/demo.gif)

*A real run, not a mockup: a customer searches, signs in, opens a quote and picks one
of three hours the electrician actually has free — accepting is the booking — and it is
already in his diary when he opens it.*

---

## Why this can be a booking app at all

Most trade work cannot be booked. You cannot put a price on "the board keeps tripping"
without looking at it, and every attempt to make trades work like haircuts founders on
that.

But a real subset of it *can*, and that subset is bigger than it first looks: a boiler
service, an EICR, a gutter clean, a lock change, an EV charger survey. Known duration,
known price. `server/lib/trades.js` carries that split for twelve trades — a `bookable`
list and a `quoteOnly` list each. A foxxer publishes whichever they actually offer.

**Fixed scope is bookable. Everything else routes to a quote.** That one line is the
product; the rest of this repo is the consequences of it.

---

## Running it

```sh
git clone https://github.com/brianm2712/foxxers && cd foxxers

rm -rf data && FOXXERS_DATA=./data node scripts/seed.js
FOXXERS_DATA=./data FOXXERS_PORT=8120 node server/index.js
```

Then open <http://localhost:8120>. Password for every seeded account is
`foxxers-demo-2026`.

| Sign in as | Email | What it shows |
|---|---|---|
| Customer | `ciara@example.com` | Five jobs: one waiting on her answer, one paid with a receipt, one declined, one still being priced |
| Foxxer (IE) | `byrne.electrical@example.com` | RCT 20%, an overdue invoice with a chase queued, a deposit earned |
| Foxxer (UK) | `mcallister.electrical.ni@example.com` | The UK side — VAT 20% and CIS instead of RCT |

The foxxer sign-in page lists the demo logins, but only when the hostname is localhost.

> **Stop the server before reseeding.** It holds the whole database in memory and
> flushes on write, so `rm -rf data && node scripts/seed.js` against a running server
> gets silently clobbered when that process next saves.

### Tests

```sh
node tests/api.test.js       # 35 — end-to-end over real HTTP
node tests/schedule.test.js  #  7 — slot generation, DST, busy-time subtraction
node tests/tax.test.js       #  9 — VAT, RCT, CIS, reverse charge, invoice numbering
```

`api.test.js` spawns a real server on a throwaway data directory and drives it the way
the iOS client will: bearer token, JSON in, JSON out.

### On a Linux desktop

```sh
./scripts/install-desktop.sh
```

Puts Foxxers in the applications menu and on the desktop with the fox icon.
Launching it starts the server if it is not already running — seeding first if
there is no database yet — waits for it to answer, then opens the browser. If
it cannot start, it says so in a dialog rather than doing nothing. Everything
lands under `$HOME`; nothing needs root.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `FOXXERS_DATA` | `./data` | Where the JSON database and session key live |
| `FOXXERS_PORT` / `FOXXERS_HOST` | `8120` / `127.0.0.1` | Bind address |
| `FOXXERS_OPEN_SIGNUP` | on | Set to `0` to close foxxer signup |
| `FOXXERS_SEED_PASSWORD` | `foxxers-demo-2026` | Password for seeded accounts |
| `FOXXERS_LIMIT_LOGIN` \| `SIGNUP` \| `WRITE` \| `READ` | `8` \| `10` \| `30` \| `600` | Rate-limit ceilings, so tests can raise them without the code knowing it is being tested |

---

## Layout

```
server/index.js         one HTTP server, one router, every route
server/lib/domain.js    the business operations — everything that changes state
server/lib/tax.js       IE and UK construction tax. Rates are data, not literals
server/lib/payments.js  deposits, taking money, and the provider seam
server/lib/schedule.js  availability → bookable slots, DST-correct
server/lib/trades.js    the trade taxonomy: what is bookable, what can only be quoted
server/lib/store.js     append-and-flush JSON store
server/lib/auth.js      scrypt, signed session and job tokens, rate limiting
server/lib/http.js      request/response plumbing, static files, cookies

web/public/js/app.js       router and shell — the two front doors
web/public/js/customer.js  everything a customer sees
web/public/js/pro.js       everything a foxxer sees
web/public/js/api.js       the only place that talks to the server
web/public/js/ui.js        DOM and money-formatting helpers

scripts/seed.js         demo data — a marketplace worth looking at
scripts/foxxers          start it if it is not running, then open it
scripts/install-desktop.sh  applications-menu and desktop launcher, with the icon
scripts/make-icons.py   app icons from the artwork (dev only, needs Pillow)
tests/                  three suites, 51 assertions
```

`data/` is gitignored. It holds every password hash and the key that signs every
session and job token.

---

## The job lifecycle

Two doors into the same set of records.

```
BOOK   (fixed scope)     confirmed → scheduled → done → invoiced → paid
ASK    (unknown scope)   open → quoted → accepted → done → invoiced → paid
```

The **accept** step is timestamped and immutable. It is the record of what was agreed,
which is the thing a WhatsApp voice note never produces.

### Asking, in full

1. **The customer sends a request, and €5 is taken.** Not to accept — to ask.
2. **The foxxer prices it and offers up to three genuinely free hours**, checked against
   their real availability at the moment of sending.
3. **The customer accepts one of those hours.** Accepting *is* the booking: it lands in
   the diary at that instant, and that hour immediately stops being offerable to anyone
   else. A price agreed without a date is the failure this app exists to prevent.
   - **Declined instead?** The foxxer keeps the €5, for pricing a job that went nowhere.
   - **Accepted?** The €5 is credited against the invoice, so it costs a genuine
     customer nothing at all.
4. **The job is done, and the balance is taken at the door** — card reader, Apple or
   Google Pay, Revolut, transfer or cash.
5. **The receipt is issued in the same request as the payment**, because they are one
   event: the customer wants it before the van has pulled away.

---

## Money and tax

Construction tax lives in `server/lib/tax.js` with its own test suite, rather than being
sprinkled through the invoice renderer. Rates are data, so a budget change is an edit to
one table.

- **Ireland** — VAT at 13.5% (most construction services), 23%, 9%, zero and exempt.
  **RCT** withheld by the principal contractor at 0/20/35% of the **whole net**.
- **UK** — VAT at 20% and 5%. **CIS** at 0/20/30%, deducted from the **labour element
  only**; materials are excluded.
- **Reverse charge** zeroes the VAT charged but still reports what it would have been.

Three things that are easy to get backwards, and are tested because of it:

- **VAT is computed per line at that line's own rate**, on the net.
- **Withholding is computed on the net, never on the VAT.**
- **A credited deposit is money on account, not a discount.** VAT is charged on the full
  price; the €5 only reduces what is left to collect. Treating it as a discount would
  understate the VAT on every job that began as a request.

Invoice numbers are sequential per foxxer with no gaps, and the counter advances at issue
and never at draft — a number derived from a timestamp is not a sequence, and neither is
one that skips when a draft is deleted.

**None of this is tax advice.** The rates are the published ones as of 2026-09 and an
accountant signs them off before a real invoice goes out.

### Chasing

An overdue invoice queues a message, written for the foxxer to send on WhatsApp: three
days before due, then at 1, 7, 14 and 30 days past. Only **the stage actually reached**
is offered — an invoice ten days late must not offer "due in three days" alongside two
later messages. Sending stays the foxxer's decision, because the customer is often
someone they will meet again.

---

## Payments: a seam, and no money moves

`server/lib/payments.js` defines the contract. The built-in `manual` provider records
what *would* have happened, sets `moved: false`, and the UI says so plainly in both
places it matters. **No card is ever charged.**

Every state transition, every amount, every receipt is real, stored and tested. Wiring
in a real rail is one object with the same four methods:

```js
registerProvider({
  key: 'sumup',
  hold({ amount, currency }) { /* … */ return { ref, amount, currency, moved: true }; },
  capture({ payment })       { /* … */ return { ref, moved: true }; },
  refund({ payment })        { /* … */ return { ref, moved: true }; },
  charge({ amount, currency, method }) { /* … */ return { ref, moved: true }; },
});
```

Nothing above that file changes. Candidates: **SumUp** if the RFID card reader is the
priority, **Stripe** for Apple Pay plus Terminal, **Revolut** if that is already the
business account.

A deposit's life is a transition table, which is what stops it being both credited to an
invoice and pocketed by the foxxer:

```
held → credited    quote accepted; comes off the invoice
     → captured    quote declined; the foxxer keeps it
     → refunded    nobody quoted, so nobody earned it
```

---

## Who is signed in

Both sides sign in with an email and a password (scrypt). Sessions are signed tokens
carrying a `kind`, so a customer token can never be presented as a foxxer one — the kind
is inside the signature, and flipping it invalidates it.

**A browser can hold both sessions at once.** A tradesperson books a plumber like anyone
else, so the two live in separate cookies (`fx_session`, `fx_customer`) and separate
storage keys. `web/public/js/api.js` picks the right token by URL prefix, so no route can
accidentally be called with the wrong identity.

**Job tokens survive alongside all this.** A foxxer quoting a walk-in has nobody to attach
an account to, and the link they hand over still has to open, so a signed per-job token
remains a credential in its own right — bound to exactly one reference, checked in
constant time. A customer's own job list hands out those same tokens, so it is one page
with one access check whether it was reached from the list or from a link.

An account is only ever joined by signing into it. A walk-in a foxxer writes up is never
merged into one on a matching phone number — a shared landline or a mistyped digit would
otherwise drop a stranger's job into someone's job list.

---

## The API

The contract between the server and every client. Nothing renders HTML on the server, so
each screen on each platform is built from these routes.

**Public**

| | |
|---|---|
| `GET /api/v1/meta` | Trades, counties, urgency levels, VAT classes, withholding rates, deposit amounts, payment methods |
| `GET /api/v1/pros` | Search. `?trade=&area=&q=&emergency=1` |
| `GET /api/v1/pros/:slug` | Profile, services, reviews, rating |
| `GET /api/v1/pros/:slug/slots` | Bookable slots. `?serviceId=&days=` |
| `GET /api/v1/health` | |

**Customer account**

| | |
|---|---|
| `POST /api/v1/auth/customer/signup` `/login` `/logout` | |
| `GET` `PUT /api/v1/me` | Their details |
| `GET /api/v1/me/jobs` | Their jobs, each carrying the token its page opens with |
| `POST /api/v1/bookings` | Book a slot. Requires a session |
| `POST /api/v1/requests` | Describe a job; takes the deposit. Requires a session |

**A job, by reference and token** — `?t=<job token>`

| | |
|---|---|
| `GET /api/v1/jobs/:ref` | The whole job: quotes, invoices, deposit, receipt |
| `POST /api/v1/jobs/:ref/accept` | `{ quoteId, start }` — accepting books that hour |
| `POST /api/v1/jobs/:ref/decline` | The foxxer keeps the deposit |
| `POST /api/v1/jobs/:ref/review` | Only a job that was actually carried out |

**Foxxer console** — bearer token or `fx_session` cookie

| | |
|---|---|
| `POST /api/v1/auth/signup` `/login` `/logout`, `GET /api/v1/auth/me` | |
| `GET /api/v1/pro/dashboard` | Money, counts, what is coming up, chases due |
| `GET /api/v1/pro/requests` | Aimed at them, plus open ones matching trade **and** area |
| `GET /api/v1/pro/bookings`, `PATCH /api/v1/pro/bookings/:id` | The diary |
| `GET /api/v1/pro/slots` | Their own free hours, for offering on a quote |
| `GET` `POST /api/v1/pro/services`, `PATCH` `DELETE …/:id` | Retiring, never deleting — past bookings point at these |
| `GET` `PUT /api/v1/pro/availability` | The working week and the rules around it |
| `GET` `POST /api/v1/pro/quotes` | |
| `POST /api/v1/pro/price` | Price lines without saving — the builder recalculates as you type |
| `GET` `POST /api/v1/pro/invoices` | |
| `POST /api/v1/pro/invoices/:id/paid` | `{ method }` — takes the money and returns the receipt |
| `GET /api/v1/pro/deposits` | Earned from declined quotes, credited to jobs that went ahead |
| `GET /api/v1/pro/chases`, `POST /api/v1/pro/chases/:invoiceId` | |
| `PUT /api/v1/pro/profile` | |

---

## Constraints worth keeping

- **Node standard library only.** No npm, no build step, no lockfile, no supply chain.
  The single exception is `scripts/make-icons.py`, which regenerates the app icons
  from the artwork and runs on a workstation, never at runtime.
- **No outbound calls.** The server talks to nothing on the internet. Adding a payment
  provider is the first and only planned exception, and it goes behind the seam above.
- **No tracking, no analytics, no third-party requests** on the web client. No web fonts
  are fetched.
- **One implementation of the arithmetic.** The quote builder prices on the server on
  every keystroke rather than doing the sums in the browser. A customer and a foxxer
  looking at different totals is the one bug this app cannot afford.
- **Ranking is explainable.** Search puts whoever can start soonest above whoever has a
  better star average, because "when can you come" is the question customers are really
  asking. Every marketplace that inverts this ends up selling placement instead.

## Not built yet

- **The iOS and iPadOS clients.** `ios/` is empty. The API above is the contract they are
  meant to be built against, and `web/public/js/api.js` is the file to mirror.
- **A real payment provider.** See the seam above.
- **Photos on a request.** The field exists and is always empty.
- **Refunding a deposit on a request nobody ever quoted.** The state and the transition
  exist; nothing schedules it.
