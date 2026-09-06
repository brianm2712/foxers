'use strict';
/*
 * The business operations. Everything that changes state goes through here,
 * so the HTTP layer stays a thin translation of requests into these calls and
 * the iOS client cannot reach a code path the web client does not.
 *
 * The job lifecycle, and the two doors into it:
 *
 *   BOOK   (fixed scope)   confirmed -> scheduled -> done -> invoiced -> paid
 *   ASK    (unknown scope)  open -> quoted -> accepted -> scheduled -> done -> invoiced -> paid
 *
 * The accept step is timestamped and immutable. It is the record of what was
 * agreed, which is the thing a WhatsApp voice note never produces.
 */

const { newRef, slugify } = require('./store');
const { priceLines, nextInvoiceNumber } = require('./tax');
const { defaultAvailability, slotsFor } = require('./schedule');
const pay = require('./payments');
const { BY_KEY, URGENCY_BY_KEY, AREA_BY_KEY } = require('./trades');

class DomainError extends Error {
  constructor(message, status = 400, code = 'bad_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (msg, code) => { throw new DomainError(msg, 400, code || 'bad_request'); };
const notFound = (what) => { throw new DomainError(`${what} not found`, 404, 'not_found'); };

/* ---- pros ------------------------------------------------------------ */

/*
 * Invoice prefix. Shared across pros it would be ambiguous to a customer
 * holding two Foxers invoices, so it defaults to the business initials.
 */
function initials(business) {
  const letters = String(business).normalize('NFKD').replace(/[^A-Za-z ]/g, '')
    .split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase();
  return letters.slice(0, 4) || 'FX';
}

function createPro(store, input) {
  const name = String(input.name || '').trim();
  const business = String(input.business || name).trim();
  if (name.length < 2) bad('A name is required');
  const trades = (input.trades || []).filter((t) => BY_KEY.has(t));
  if (!trades.length) bad('Pick at least one trade');

  let slug = slugify(business);
  let n = 1;
  while (store.find('pros', (p) => p.slug === slug)) slug = `${slugify(business)}-${++n}`;

  const pro = store.insert('pros', {
    slug,
    name,
    business,
    email: String(input.email || '').trim().toLowerCase(),
    phone: String(input.phone || '').trim(),
    trades,
    areas: (input.areas || []).map(String),
    region: input.region === 'UK' ? 'UK' : 'IE',
    bio: String(input.bio || '').slice(0, 1200),
    vatNumber: String(input.vatNumber || '').trim(),
    vatRegistered: !!input.vatRegistered,
    withholdingRate: Number(input.withholdingRate || 0),
    calloutFee: Number(input.calloutFee || 0),
    hourlyRate: Number(input.hourlyRate || 0),
    invoicePrefix: (input.invoicePrefix || initials(business)).toUpperCase().slice(0, 6),
    invoiceSeq: null,
    passwordHash: input.passwordHash || null,
    verified: false,
    acceptsEmergency: input.acceptsEmergency !== false,
    published: input.published !== false,
    photos: [],
  });

  store.insert('availability', defaultAvailability(pro.id));
  store.log('pro.created', pro.id, { slug });
  return pro;
}

function proBySlug(store, slug) {
  return store.find('pros', (p) => p.slug === slug);
}

function availabilityFor(store, proId) {
  return store.find('availability', (a) => a.proId === proId) || defaultAvailability(proId);
}

/** Everything that occupies the pro's calendar right now. */
function busyFor(store, proId) {
  const live = new Set(['confirmed', 'scheduled', 'quoted', 'accepted']);
  return store
    .filter('bookings', (b) => b.proId === proId && live.has(b.status))
    .map((b) => ({ start: b.start, end: b.end }));
}

function ratingFor(store, proId) {
  const rs = store.filter('reviews', (r) => r.proId === proId);
  if (!rs.length) return { count: 0, average: null };
  const sum = rs.reduce((s, r) => s + Number(r.rating || 0), 0);
  return { count: rs.length, average: Math.round((sum / rs.length) * 10) / 10 };
}

/*
 * Search. Ranking is deliberately simple and explainable: a pro who can
 * actually start sooner ranks above one with a better star average, because
 * "when can you come" is the question customers are really asking. Every
 * marketplace that inverts this ends up selling placement instead.
 */
function searchPros(store, q = {}) {
  const trade = q.trade && BY_KEY.has(q.trade) ? q.trade : null;
  const area = q.area || null;
  const text = String(q.q || '').trim().toLowerCase();
  const now = q.now ?? Date.now();

  let list = store.filter('pros', (p) => p.published);
  if (trade) list = list.filter((p) => p.trades.includes(trade));
  if (area) list = list.filter((p) => p.areas.includes(area));
  if (q.emergency) list = list.filter((p) => p.acceptsEmergency);
  if (text) {
    list = list.filter((p) =>
      `${p.business} ${p.name} ${p.bio}`.toLowerCase().includes(text));
  }

  return list.map((pro) => {
    const services = store.filter('services', (s) => s.proId === pro.id && s.active);
    const bookable = services.filter((s) => s.bookable);
    const av = availabilityFor(store, pro.id);
    const busy = busyFor(store, pro.id);
    // Cheapest honest signal of "soonest": the first slot for the shortest
    // bookable service. Nothing bookable means the pro is quote-only.
    let next = null;
    if (bookable.length) {
      const shortest = bookable.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
      const s = slotsFor(av, shortest.minutes, { now, days: 14, busy, limit: 1 });
      next = s[0] || null;
    }
    const rating = ratingFor(store, pro.id);
    return {
      ...publicPro(pro),
      rating,
      serviceCount: services.length,
      bookableCount: bookable.length,
      nextSlot: next,
      fromPrice: bookable.length ? Math.min(...bookable.map((s) => s.price)) : null,
    };
  }).sort((a, b) => {
    const at = a.nextSlot ? Date.parse(a.nextSlot.start) : Infinity;
    const bt = b.nextSlot ? Date.parse(b.nextSlot.start) : Infinity;
    if (at !== bt) return at - bt;
    const ar = a.rating.average ?? 0, br = b.rating.average ?? 0;
    if (ar !== br) return br - ar;
    return a.business.localeCompare(b.business);
  });
}

/** The projection a customer is allowed to see. Never the whole record. */
function publicPro(pro) {
  return {
    id: pro.id, slug: pro.slug, business: pro.business, name: pro.name,
    trades: pro.trades, areas: pro.areas, region: pro.region, bio: pro.bio,
    verified: pro.verified, acceptsEmergency: pro.acceptsEmergency,
    calloutFee: pro.calloutFee, hourlyRate: pro.hourlyRate,
    vatRegistered: pro.vatRegistered, photos: pro.photos || [],
  };
}

/* ---- services -------------------------------------------------------- */

function addService(store, proId, input) {
  const name = String(input.name || '').trim();
  if (!name) bad('Service needs a name');
  const minutes = Number(input.minutes || 60);
  if (!Number.isFinite(minutes) || minutes < 15 || minutes > 8 * 60) {
    bad('Duration must be between 15 minutes and 8 hours');
  }
  const bookable = !!input.bookable;
  const price = Number(input.price || 0);
  if (bookable && !(price > 0)) {
    // The whole promise of instant booking is that the price is settled
    // before anyone commits. A bookable service with no price is a quote.
    bad('A bookable service needs a fixed price — otherwise make it quote-only');
  }
  return store.insert('services', {
    proId, name, minutes, price, bookable,
    vatClass: input.vatClass || 'reduced',
    description: String(input.description || '').slice(0, 600),
    active: input.active !== false,
  });
}

/* ---- booking (the Booksy path) --------------------------------------- */

/* ---- customers ------------------------------------------------------- */

/*
 * Customers hold an account now, so a phone number is no longer an identity.
 * This still exists for the one case with nobody signed in: a foxer writing
 * up a walk-in, where the only record of who it was is what they typed.
 *
 * It must never merge into an account. Two people share a landline, a builder
 * puts his own mobile on a client's job, a digit gets mistyped — any of those
 * would otherwise drop a stranger's job into someone's signed-in job list.
 * An account is only ever joined by signing into it.
 */
function upsertCustomer(store, input) {
  const phone = String(input.phone || '').replace(/\s+/g, '');
  const name = String(input.name || '').trim();
  if (name.length < 2) bad('Please give a name');
  if (phone.replace(/\D/g, '').length < 7) bad('Please give a contact phone number');
  const existing = store.find('customers', (c) => c.phone === phone && !c.passwordHash);
  if (existing) {
    store.update('customers', existing.id, {
      name: name || existing.name,
      email: input.email || existing.email,
      address: input.address || existing.address,
    });
    return existing;
  }
  return store.insert('customers', {
    name, phone,
    email: String(input.email || '').trim().toLowerCase(),
    address: String(input.address || '').trim(),
    eircode: String(input.eircode || '').trim().toUpperCase(),
  });
}

const normalEmail = (v) => String(v || '').trim().toLowerCase();

function customerByEmail(store, email) {
  const wanted = normalEmail(email);
  return wanted ? store.find('customers', (c) => c.email === wanted && c.passwordHash) : null;
}

/*
 * A customer account. `area` is asked for at sign-up and is the county their
 * search starts in — "who can come to me" is the first question, and making
 * them re-pick it on every visit is the friction that sends people back to
 * asking in a WhatsApp group.
 */
function createCustomerAccount(store, input) {
  const name = String(input.name || '').trim();
  const email = normalEmail(input.email);
  const phone = String(input.phone || '').replace(/\s+/g, '');
  if (name.length < 2) bad('Please give a name');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Give a valid email');
  if (phone.replace(/\D/g, '').length < 7) bad('Please give a contact phone number');
  if (!input.passwordHash) bad('A password is required');
  if (customerByEmail(store, email)) {
    throw new DomainError('That email already has an account', 409, 'conflict');
  }

  const customer = store.insert('customers', {
    name, phone, email,
    passwordHash: input.passwordHash,
    address: String(input.address || '').trim(),
    eircode: String(input.eircode || '').trim().toUpperCase(),
    area: AREA_BY_KEY.has(input.area) ? input.area : '',
  });
  store.log('customer.created', customer.id, {});
  return customer;
}

function updateCustomer(store, customerId, input) {
  const c = store.get('customers', customerId) || notFound('Customer');
  const patch = {};
  for (const k of ['name', 'address']) if (input[k] != null) patch[k] = String(input[k]).slice(0, 200);
  if (input.phone != null) {
    const phone = String(input.phone).replace(/\s+/g, '');
    if (phone.replace(/\D/g, '').length < 7) bad('Please give a contact phone number');
    patch.phone = phone;
  }
  if (input.eircode != null) patch.eircode = String(input.eircode).trim().toUpperCase();
  if (input.area != null) patch.area = AREA_BY_KEY.has(input.area) ? input.area : '';
  return store.update('customers', c.id, patch);
}

/*
 * Who a job belongs to. A signed-in customer is taken from their session and
 * nothing the request body says can override it — otherwise anyone could
 * file a booking against someone else's account by posting their id.
 */
function resolveCustomer(store, input) {
  if (input.customerId) {
    return store.get('customers', input.customerId) || notFound('Customer');
  }
  return upsertCustomer(store, input.customer || {});
}

/* Everything this customer has going on, newest first. */
function jobsForCustomer(store, customerId) {
  const rows = [
    ...store.filter('bookings', (b) => b.customerId === customerId)
      .map((b) => ({ kind: 'booking', ref: b.ref, status: b.status, proId: b.proId,
        at: b.start, createdAt: b.acceptedAt || b.start, price: b.price,
        serviceId: b.serviceId, address: b.address })),
    ...store.filter('requests', (r) => r.customerId === customerId)
      .map((r) => ({ kind: 'request', ref: r.ref, status: r.status, proId: r.proId,
        at: null, createdAt: r.createdAt, trade: r.trade, urgency: r.urgency,
        description: r.description, address: r.address })),
  ];
  return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function createBooking(store, secretIssuer, input) {
  const pro = store.get('pros', input.proId) || notFound('Tradesperson');
  const service = store.get('services', input.serviceId);
  if (!service || service.proId !== pro.id) notFound('Service');
  if (!service.bookable) bad('That service is quote-only — send a job request instead', 'not_bookable');

  const start = Date.parse(input.start);
  if (!Number.isFinite(start)) bad('Invalid start time');
  const end = start + service.minutes * 60000;

  // Re-derive the slot rather than trusting the one the client posted back.
  // Two customers can be looking at the same free 09:00 at the same moment.
  const av = availabilityFor(store, pro.id);
  const busy = busyFor(store, pro.id);
  const offered = slotsFor(av, service.minutes, {
    now: input.now ?? Date.now(), days: av.maxDaysAhead || 60, busy, limit: 5000,
  });
  if (!offered.some((s) => Date.parse(s.start) === start)) {
    throw new DomainError('That time has just been taken. Pick another slot.', 409, 'slot_gone');
  }

  const customer = resolveCustomer(store, input);
  const ref = newRef();
  const booking = store.insert('bookings', {
    ref,
    proId: pro.id,
    serviceId: service.id,
    customerId: customer.id,
    kind: 'booking',
    status: 'confirmed',
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    minutes: service.minutes,
    price: service.price,
    address: String(input.address || input.customer?.address || customer.address || ''),
    notes: String(input.notes || '').slice(0, 1000),
    acceptedAt: new Date().toISOString(), // booking IS the agreement
  });
  store.log('booking.created', booking.id, { ref, proId: pro.id });
  return { booking, customer, token: secretIssuer(ref) };
}

/* ---- request (the everything-else path) ------------------------------ */

function createRequest(store, secretIssuer, input) {
  const trade = BY_KEY.get(input.trade) || bad('Pick a trade');
  const urgency = URGENCY_BY_KEY.get(input.urgency) ? input.urgency : 'flexible';
  const description = String(input.description || '').trim();
  if (description.length < 10) bad('Describe the job in a sentence or two');

  const pro = input.proId ? store.get('pros', input.proId) : null;
  if (input.proId && !pro) notFound('Tradesperson');

  const customer = resolveCustomer(store, input);

  /*
   * The deposit is taken to send the request, not to accept the quote. It is
   * what makes a request worth a foxer's time to price: declined, they keep
   * it; accepted, it comes off the invoice, so it costs a real customer
   * nothing at all. Held here, settled by acceptQuote or declineQuote.
   */
  const deposit = input.deposit === null
    ? null
    : pay.holdDeposit(store, {
        customerId: customer.id,
        region: pro ? pro.region : 'IE',
        providerName: input.provider,
      });

  const ref = newRef();
  const request = store.insert('requests', {
    ref,
    proId: pro ? pro.id : null,       // null = open to any matching pro
    trade: trade.key,
    area: String(input.area || ''),
    urgency,
    description: description.slice(0, 2000),
    customerId: customer.id,
    address: String(input.address || input.customer?.address || customer.address || ''),
    photos: [],
    status: 'open',
    depositId: deposit ? deposit.id : null,
    preferredTimes: (input.preferredTimes || []).slice(0, 5).map(String),
  });
  if (deposit) store.update('payments', deposit.id, { ref });
  store.log('request.created', request.id, { ref, trade: trade.key, urgency, proId: pro?.id || null });
  return { request, customer, deposit, token: secretIssuer(ref) };
}

/* ---- quotes ---------------------------------------------------------- */

function createQuote(store, proId, input) {
  const pro = store.get('pros', proId) || notFound('Tradesperson');
  const request = input.requestId ? store.get('requests', input.requestId) : null;
  if (input.requestId && !request) notFound('Request');
  if (request && request.proId && request.proId !== pro.id) {
    throw new DomainError('That request belongs to another tradesperson', 403, 'forbidden');
  }

  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length) bad('A quote needs at least one line');

  const totals = priceLines(lines, {
    region: pro.region,
    reverseCharge: !!input.reverseCharge,
    withholdingRate: Number(input.withholdingRate ?? pro.withholdingRate ?? 0),
  });

  /*
   * The times the foxer is offering. They are checked against the same
   * availability the booking form uses, so a quote can never offer an hour
   * that is already gone — and accepting one is what puts it in the diary.
   */
  const minutes = Number(input.minutes || 120);
  const offered = offerableSlots(store, pro, minutes, input.slots || []);
  if ((input.slots || []).length && !offered.length) {
    bad('None of those times are still free — pick again from your diary', 'slots_gone');
  }

  const validDays = Number(input.validDays || 30);
  const quote = store.insert('quotes', {
    ref: request ? request.ref : newRef(),
    proId: pro.id,
    requestId: request ? request.id : null,
    customerId: request ? request.customerId : input.customerId || null,
    title: String(input.title || 'Quote').slice(0, 120),
    notes: String(input.notes || '').slice(0, 2000),
    terms: String(input.terms || '').slice(0, 2000),
    depositPercent: Number(input.depositPercent || 0),
    lines: totals.lines,
    totals,
    status: 'sent',
    minutes,
    slots: offered,
    validUntil: new Date(Date.now() + validDays * 86400000).toISOString(),
    sentAt: new Date().toISOString(),
    acceptedAt: null,
  });

  if (request) store.update('requests', request.id, { status: 'quoted', proId: pro.id });
  store.log('quote.sent', quote.id, { proId: pro.id, gross: totals.gross });
  return quote;
}

/*
 * The keystone. Timestamped, one-way, and it snapshots the totals so that a
 * later edit to the quote cannot retroactively change what was agreed.
 */
/*
 * Filter proposed start times down to the ones genuinely bookable: inside the
 * working week, long enough for the job, not already taken. Re-derived from
 * availability rather than trusted, because the diary moves between writing a
 * quote and sending it.
 */
function offerableSlots(store, pro, minutes, wanted) {
  if (!wanted.length) return [];
  const av = availabilityFor(store, pro.id);
  const free = new Set(slotsFor(av, minutes, {
    days: av.maxDaysAhead || 60, busy: busyFor(store, pro.id), limit: 5000,
  }).map((sl) => Date.parse(sl.start)));

  const seen = new Set();
  return wanted
    .map((w) => Date.parse(w))
    .filter((t) => Number.isFinite(t) && free.has(t) && !seen.has(t) && seen.add(t))
    .sort((a, b) => a - b)
    .slice(0, 3)
    .map((t) => new Date(t).toISOString());
}

/*
 * Accepting is the moment everything becomes real: the price is locked, the
 * deposit stops being the foxer's to keep and comes off the bill instead, and
 * the chosen hour turns into a booking in the diary. Doing any one of those
 * without the others is how a customer ends up with an agreed price and no
 * date, which is the failure this whole app exists to stop.
 */
function acceptQuote(store, quoteId, who = 'customer', choice = {}) {
  const quote = store.get('quotes', quoteId) || notFound('Quote');
  if (quote.status === 'accepted') return quote;
  if (quote.status !== 'sent') bad(`This quote is ${quote.status} and cannot be accepted`);
  if (Date.parse(quote.validUntil) < Date.now()) {
    bad('This quote has expired — ask for an updated one', 'expired');
  }
  const pro = store.get('pros', quote.proId) || notFound('Tradesperson');
  const offered = quote.slots || [];
  let booking = null;

  if (offered.length) {
    const picked = choice.start || (offered.length === 1 ? offered[0] : null);
    if (!picked) bad('Pick one of the times offered', 'slot_required');
    if (!offered.includes(picked)) bad('That time was not one of the ones offered', 'slot_not_offered');
    // Somebody else may have taken it in the meantime.
    if (!offerableSlots(store, pro, quote.minutes || 120, [picked]).length) {
      throw new DomainError('That time has just been taken. Ask for new times.', 409, 'slot_gone');
    }
    const start = Date.parse(picked);
    booking = store.insert('bookings', {
      ref: quote.ref,
      proId: pro.id,
      serviceId: null,
      customerId: quote.customerId,
      quoteId: quote.id,
      kind: 'quoted',
      status: 'scheduled',
      start: new Date(start).toISOString(),
      end: new Date(start + (quote.minutes || 120) * 60000).toISOString(),
      minutes: quote.minutes || 120,
      price: quote.totals.gross,
      title: quote.title,
      address: addressForQuote(store, quote),
      notes: '',
      acceptedAt: new Date().toISOString(),
    });
  }

  const accepted = store.update('quotes', quoteId, {
    status: 'accepted',
    acceptedAt: new Date().toISOString(),
    acceptedBy: who,
    acceptedSlot: booking ? booking.start : null,
    bookingId: booking ? booking.id : null,
    agreed: JSON.parse(JSON.stringify(quote.totals)),
  });

  // The deposit was the foxer's to keep only if this went nowhere.
  const deposit = depositForQuote(store, quote);
  if (deposit && deposit.status === 'held') pay.creditDeposit(store, deposit.id, pro.id);

  if (quote.requestId) store.update('requests', quote.requestId, { status: 'accepted' });
  store.log('quote.accepted', quoteId, { by: who, gross: quote.totals.gross, slot: booking?.start || null });
  return accepted;
}

function addressForQuote(store, quote) {
  const request = quote.requestId ? store.get('requests', quote.requestId) : null;
  if (request?.address) return request.address;
  const c = quote.customerId ? store.get('customers', quote.customerId) : null;
  return c?.address || '';
}

function depositForQuote(store, quote) {
  const request = quote.requestId ? store.get('requests', quote.requestId) : null;
  return request?.depositId ? store.get('payments', request.depositId) : null;
}

function declineQuote(store, quoteId, reason = '') {
  const quote = store.get('quotes', quoteId) || notFound('Quote');
  if (quote.status !== 'sent') bad(`This quote is ${quote.status}`);
  const out = store.update('quotes', quoteId, {
    status: 'declined', declinedAt: new Date().toISOString(), declineReason: String(reason).slice(0, 500),
  });

  // The foxer priced a job that is not happening. This is what they get for it.
  const deposit = depositForQuote(store, quote);
  if (deposit && deposit.status === 'held') pay.captureDeposit(store, deposit.id, quote.proId);

  if (quote.requestId) store.update('requests', quote.requestId, { status: 'declined' });
  store.log('quote.declined', quoteId, { deposit: deposit ? deposit.id : null });
  return out;
}

/* ---- invoices -------------------------------------------------------- */

function createInvoice(store, proId, input) {
  const pro = store.get('pros', proId) || notFound('Tradesperson');
  const quote = input.quoteId ? store.get('quotes', input.quoteId) : null;
  const booking = input.bookingId ? store.get('bookings', input.bookingId) : null;
  if (input.quoteId && !quote) notFound('Quote');
  if (input.bookingId && !booking) notFound('Booking');
  if (quote && quote.proId !== pro.id) throw new DomainError('Not your quote', 403, 'forbidden');
  if (booking && booking.proId !== pro.id) throw new DomainError('Not your booking', 403, 'forbidden');
  if (quote && quote.status !== 'accepted') {
    bad('Invoice from an accepted quote — otherwise there is nothing agreed to invoice against');
  }

  // Variations are additional lines agreed after acceptance. They are kept
  // separate on the invoice so the customer can see what changed and why.
  const base = quote ? quote.lines : bookingLines(store, booking);
  const variations = Array.isArray(input.variations) ? input.variations : [];
  const totals = priceLines([...base, ...variations], {
    region: pro.region,
    reverseCharge: quote ? quote.totals.reverseCharge : !!input.reverseCharge,
    withholdingRate: Number(input.withholdingRate ?? pro.withholdingRate ?? 0),
  });

  /*
   * A credited deposit is money already received, not a discount. VAT is
   * charged on the full price either way — the €5 only changes what is left
   * to hand over at the door. Getting this the other way round would
   * understate the VAT on every job that started as a request.
   */
  const deposit = quote ? depositForQuote(store, quote) : null;
  const depositCredit = deposit && deposit.status === 'credited' ? deposit.amount : 0;

  const { number, seq } = nextInvoiceNumber(pro);
  store.update('pros', pro.id, { invoiceSeq: seq });

  const dueDays = Number(input.dueDays || 14);
  const invoice = store.insert('invoices', {
    number,
    ref: quote ? quote.ref : booking ? booking.ref : newRef(),
    proId: pro.id,
    quoteId: quote ? quote.id : null,
    bookingId: booking ? booking.id : null,
    customerId: (quote && quote.customerId) || (booking && booking.customerId) || null,
    lines: totals.lines,
    variations,
    totals,
    depositCredit,
    depositId: deposit ? deposit.id : null,
    dueNow: Math.round((totals.payable - depositCredit + Number.EPSILON) * 100) / 100,
    vatNumber: pro.vatNumber,
    status: 'issued',
    issuedAt: new Date().toISOString(),
    dueAt: new Date(Date.now() + dueDays * 86400000).toISOString(),
    paidAt: null,
    paymentLink: input.paymentLink || null,
    chases: [],
  });

  if (booking) store.update('bookings', booking.id, { status: 'invoiced' });
  store.log('invoice.issued', invoice.id, { number, gross: totals.gross, payable: totals.payable });
  return invoice;
}

function bookingLines(store, booking) {
  const service = store.get('services', booking.serviceId);
  return [{
    kind: 'labour',
    description: service ? service.name : 'Work carried out',
    qty: 1,
    unitPrice: booking.price,
    vatClass: (service && service.vatClass) || 'reduced',
  }];
}

/*
 * Take the balance and issue the receipt, in one step, because they are one
 * event: the customer taps a card at the door and wants the receipt before
 * the van has pulled away. The receipt is a snapshot, not a view — it has to
 * keep saying what was charged even if the invoice is corrected afterwards.
 */
function settleInvoice(store, invoiceId, input = {}) {
  const inv = store.get('invoices', invoiceId) || notFound('Invoice');
  if (inv.status === 'paid') bad('That invoice is already paid');
  const pro = store.get('pros', inv.proId) || notFound('Tradesperson');
  const amount = Number(input.amount ?? inv.dueNow ?? inv.totals.payable);

  const payment = pay.takePayment(store, {
    invoice: inv, pro, amount,
    method: input.method || 'card_reader',
    providerName: input.provider,
  });

  const paid = store.update('invoices', invoiceId, {
    status: 'paid',
    paidAt: new Date().toISOString(),
    paidMethod: payment.method,
    paidAmount: payment.amount,
    paymentId: payment.id,
  });
  if (inv.bookingId) store.update('bookings', inv.bookingId, { status: 'paid' });
  const booking = store.find('bookings', (b) => b.ref === inv.ref);
  if (booking && booking.status !== 'paid') store.update('bookings', booking.id, { status: 'paid' });

  const receipt = store.insert('receipts', {
    number: `R-${inv.number}`,
    invoiceId: inv.id,
    ref: inv.ref,
    proId: pro.id,
    customerId: inv.customerId,
    business: pro.business,
    vatNumber: pro.vatNumber || null,
    vatRegistered: !!pro.vatRegistered,
    region: pro.region,
    issuedAt: new Date().toISOString(),
    lines: inv.lines,
    totals: inv.totals,
    depositCredit: inv.depositCredit || 0,
    paid: payment.amount,
    method: payment.method,
    provider: payment.provider,
    providerRef: payment.providerRef,
    settled: !!payment.moved,
  });
  store.log('invoice.settled', invoiceId, { number: inv.number, method: payment.method, amount });
  return { invoice: paid, payment, receipt };
}

function markPaid(store, invoiceId, input = {}) {
  const inv = store.get('invoices', invoiceId) || notFound('Invoice');
  if (inv.status === 'paid') return inv;
  const out = store.update('invoices', invoiceId, {
    status: 'paid',
    paidAt: new Date().toISOString(),
    paidMethod: String(input.method || 'unknown'),
    paidAmount: Number(input.amount ?? inv.totals.payable),
  });
  if (inv.bookingId) store.update('bookings', inv.bookingId, { status: 'paid' });
  store.log('invoice.paid', invoiceId, { number: inv.number });
  return out;
}

/*
 * Chasing. The deck calls this the actual wedge, and the reason is that it
 * runs without being asked — a tradie who has to remember to chase does not
 * chase. This function is pure: it says what should be sent right now, and
 * the caller decides how (WhatsApp link first; SMS costs €0.04–0.07 a message
 * in Ireland and would become the largest line in cost of goods).
 */
const CHASE_STEPS = [
  { at: -3, key: 'due-soon',  text: (i, p) => `Hi — invoice ${i.number} from ${p.business} is due in 3 days. ${money(i.totals.payable)}.` },
  { at: 1,  key: 'day-1',     text: (i, p) => `Hi — invoice ${i.number} from ${p.business} (${money(i.totals.payable)}) was due yesterday. Link to pay inside.` },
  { at: 7,  key: 'day-7',     text: (i, p) => `Following up on invoice ${i.number} from ${p.business}, now a week overdue. ${money(i.totals.payable)}.` },
  { at: 14, key: 'day-14',    text: (i, p) => `Invoice ${i.number} from ${p.business} is two weeks overdue. Please get in touch if there is a problem with it.` },
  { at: 30, key: 'day-30',    text: (i, p) => `Invoice ${i.number} (${money(i.totals.payable)}) is 30 days overdue. Next step is a formal demand.` },
];

function money(n) {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(n || 0);
}

function chasesDue(store, now = Date.now()) {
  const out = [];
  for (const inv of store.all('invoices')) {
    if (inv.status !== 'issued') continue;
    const pro = store.get('pros', inv.proId);
    if (!pro) continue;
    const days = Math.floor((now - Date.parse(inv.dueAt)) / 86400000);
    const sent = new Set((inv.chases || []).map((c) => c.key));

    // Only the stage the invoice has actually reached, never the backlog
    // behind it. An invoice ten days late would otherwise offer "due in
    // three days" alongside two later messages, and sending that to a
    // customer is worse than sending nothing. If the current stage has
    // already gone out, there is nothing to say until the next one falls due.
    const reached = CHASE_STEPS.filter((step) => days >= step.at);
    const step = reached[reached.length - 1];
    if (step && !sent.has(step.key)) {
      out.push({ invoiceId: inv.id, number: inv.number, key: step.key, days,
        text: step.text(inv, pro), proId: pro.id, customerId: inv.customerId });
    }
  }
  return out;
}

function recordChase(store, invoiceId, key, channel = 'whatsapp') {
  const inv = store.get('invoices', invoiceId) || notFound('Invoice');
  const chases = [...(inv.chases || []), { key, channel, at: new Date().toISOString() }];
  store.log('invoice.chased', invoiceId, { key, channel });
  return store.update('invoices', invoiceId, { chases });
}

/* ---- reviews --------------------------------------------------------- */

function addReview(store, input) {
  const booking = store.get('bookings', input.bookingId);
  if (!booking) notFound('Booking');
  if (!['done', 'invoiced', 'paid'].includes(booking.status)) {
    bad('You can review a job once it has been carried out');
  }
  if (store.find('reviews', (r) => r.bookingId === booking.id)) {
    bad('This job has already been reviewed');
  }
  const rating = Number(input.rating);
  if (!(rating >= 1 && rating <= 5)) bad('Rating must be 1 to 5');
  const review = store.insert('reviews', {
    proId: booking.proId,
    bookingId: booking.id,
    customerId: booking.customerId,
    rating: Math.round(rating),
    text: String(input.text || '').slice(0, 1000),
    // Only a completed, invoiced job can be reviewed, so every review on the
    // platform is attached to real money changing hands.
    verified: true,
  });
  store.log('review.added', review.id, { proId: booking.proId, rating });
  return review;
}

module.exports = {
  DomainError, createPro, initials, proBySlug, availabilityFor, busyFor, ratingFor,
  searchPros, publicPro, addService, upsertCustomer, createBooking, createRequest,
  customerByEmail, createCustomerAccount, updateCustomer, jobsForCustomer,
  offerableSlots, depositForQuote,
  createQuote, acceptQuote, declineQuote, createInvoice, markPaid, settleInvoice,
  chasesDue, recordChase, addReview, CHASE_STEPS, money,
};
