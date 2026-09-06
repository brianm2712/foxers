#!/usr/bin/env node
'use strict';
/*
 * Foxers — job software and booking marketplace for trades.
 *
 * One HTTP server, one JSON API, three clients: the web PWA in ../web, and
 * the iOS and iPadOS apps in ../ios. The API is the contract between them, so
 * nothing here renders HTML for the app — every screen on every platform is
 * built from the same routes.
 *
 * Node standard library only. No npm, no build step, no outbound calls.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Store } = require('./lib/store');
const auth = require('./lib/auth');
const H = require('./lib/http');
const D = require('./lib/domain');
const { slotsFor, groupByDay, defaultAvailability, parseHm, DAYS } = require('./lib/schedule');
const { TRADES, AREAS, URGENCY, BY_KEY } = require('./lib/trades');
const { vatClasses, withholdingRates } = require('./lib/tax');
const pay = require('./lib/payments');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.FOXERS_DATA || path.join(ROOT, 'data');
const WEB_ROOT = fs.realpathSync(path.join(ROOT, 'web', 'public'));
const PORT = Number(process.env.FOXERS_PORT || 8120);
const HOST = process.env.FOXERS_HOST || '127.0.0.1';
const PUBLIC_SIGNUP = process.env.FOXERS_OPEN_SIGNUP !== '0';

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(path.join(DATA_DIR, 'foxers.json'));

/* Session/token signing key. Generated once, never in argv or the image. */
const SECRET = (() => {
  const f = path.join(DATA_DIR, '.session-key');
  try {
    return fs.readFileSync(f);
  } catch {
    const key = crypto.randomBytes(48);
    fs.writeFileSync(f, key, { mode: 0o600 });
    return key;
  }
})();

/*
 * Signing up and signing in are limited separately. Sharing one counter means
 * a burst of sign-ups locks out everyone trying to log in from the same
 * address — and behind Cloudflare or an office NAT that address is a crowd,
 * not a person. Login stays tight because it is the one being guessed at.
 */
/*
 * Ceilings are data, not literals, so an end-to-end test can raise them
 * without the code under test knowing it is being tested. The defaults are
 * the production ones and apply unless the environment says otherwise.
 */
const ceiling = (name, fallback) => {
  const v = Number(process.env[`FOXERS_LIMIT_${name}`]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const limits = {
  login: new auth.RateLimit(ceiling('LOGIN', 8), 15 * 60 * 1000),
  signup: new auth.RateLimit(ceiling('SIGNUP', 10), 60 * 60 * 1000),
  write: new auth.RateLimit(ceiling('WRITE', 30), 10 * 60 * 1000),
  read: new auth.RateLimit(ceiling('READ', 600), 5 * 60 * 1000),
};
setInterval(() => Object.values(limits).forEach((l) => l.sweep()), 60_000).unref();

const issueJobToken = (ref) => auth.issueJobToken(SECRET, ref);

/* ---- router ---------------------------------------------------------- */

const routes = [];
const on = (method, pattern, handler, opts = {}) => {
  // "/api/v1/pros/:slug/slots" -> regex with named groups
  const rx = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([a-zA-Z]+)/g, '(?<$1>[^/]+)') + '$');
  routes.push({ method, rx, handler, opts });
};

function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.rx.exec(pathname);
    if (m) return { route: r, params: m.groups || {} };
  }
  return null;
}

/* ---- auth plumbing --------------------------------------------------- */

/*
 * Two ways in, because a native app has no cookie jar worth relying on:
 * an HttpOnly cookie for the browser, a bearer token for iOS. Same token,
 * same signature check, so there is one code path to get wrong.
 */
function bearer(req) {
  const header = req.headers.authorization;
  return header && /^bearer /i.test(header) ? header.slice(7).trim() : null;
}

/*
 * A browser can hold both sessions at once — a tradesperson books a plumber
 * like anyone else — so the two live in separate cookies and are read
 * separately. The bearer header carries whichever one the caller meant.
 */
function currentPro(req) {
  const token = bearer(req) || H.parseCookies(req).fx_session;
  if (!token) return null;
  const session = auth.readSession(SECRET, token, 'pro');
  if (!session) return null;
  return store.get('pros', session.sub);
}

function currentCustomer(req) {
  const token = bearer(req) || H.parseCookies(req).fx_customer;
  if (!token) return null;
  const session = auth.readSession(SECRET, token, 'customer');
  if (!session) return null;
  return store.get('customers', session.sub);
}

function requirePro(req, res) {
  const pro = currentPro(req);
  if (!pro) {
    H.fail(req, res, 401, 'Sign in to continue', 'unauthenticated');
    return null;
  }
  return pro;
}

function requireCustomer(req, res) {
  const customer = currentCustomer(req);
  if (!customer) {
    H.fail(req, res, 401, 'Sign in to continue', 'unauthenticated');
    return null;
  }
  return customer;
}

/** What a customer is allowed to see about themselves. */
function customerView(c) {
  return {
    id: c.id, name: c.name, email: c.email, phone: c.phone,
    address: c.address, eircode: c.eircode, area: c.area || '',
  };
}

/* ---- shaping --------------------------------------------------------- */

function serviceView(s) {
  return {
    id: s.id, name: s.name, minutes: s.minutes, price: s.price,
    bookable: s.bookable, description: s.description, vatClass: s.vatClass, active: s.active,
  };
}

function proProfile(pro) {
  const services = store.filter('services', (s) => s.proId === pro.id && s.active).map(serviceView);
  const reviews = store.filter('reviews', (r) => r.proId === pro.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 20)
    .map((r) => ({ id: r.id, rating: r.rating, text: r.text, at: r.createdAt, verified: r.verified }));
  return {
    ...D.publicPro(pro),
    services,
    bookable: services.filter((s) => s.bookable),
    quoteOnly: services.filter((s) => !s.bookable),
    reviews,
    rating: D.ratingFor(store, pro.id),
    tradeNames: pro.trades.map((t) => BY_KEY.get(t)?.name).filter(Boolean),
  };
}

/** Everything the customer holding this reference is allowed to see. */
function jobView(ref) {
  const booking = store.find('bookings', (b) => b.ref === ref);
  const request = store.find('requests', (r) => r.ref === ref);
  const quotes = store.filter('quotes', (q) => q.ref === ref)
    .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
  const invoices = store.filter('invoices', (i) => i.ref === ref);
  // A pro quoting a walk-in raises a quote with no request behind it. That
  // still has to produce a working customer link, so the quote itself can be
  // the root of the view.
  const root = booking || request || quotes[0] || invoices[0] || null;
  if (!root) return null;
  const proId = root.proId;
  const pro = proId ? store.get('pros', proId) : null;
  const customer = root.customerId ? store.get('customers', root.customerId) : null;
  return {
    ref,
    kind: booking ? 'booking' : 'request',
    booking: booking ? {
      id: booking.id, status: booking.status, start: booking.start, end: booking.end,
      minutes: booking.minutes, price: booking.price, address: booking.address,
      notes: booking.notes, service: serviceView(store.get('services', booking.serviceId) || {}),
    } : null,
    request: request ? {
      id: request.id, status: request.status, trade: request.trade,
      tradeName: BY_KEY.get(request.trade)?.name || request.trade,
      urgency: request.urgency, description: request.description,
      address: request.address, photos: request.photos, at: request.createdAt,
    } : null,
    pro: pro ? D.publicPro(pro) : null,
    quotes: quotes.map((q) => ({
      id: q.id, title: q.title, status: q.status, notes: q.notes, terms: q.terms,
      lines: q.lines, totals: q.totals, validUntil: q.validUntil,
      sentAt: q.sentAt, acceptedAt: q.acceptedAt, depositPercent: q.depositPercent,
      slots: q.slots || [], minutes: q.minutes || null, acceptedSlot: q.acceptedSlot || null,
    })),
    invoices: invoices.map((i) => ({
      id: i.id, number: i.number, status: i.status, totals: i.totals,
      issuedAt: i.issuedAt, dueAt: i.dueAt, paidAt: i.paidAt,
      paymentLink: i.paymentLink, vatNumber: i.vatNumber,
      depositCredit: i.depositCredit || 0, dueNow: i.dueNow ?? i.totals.payable,
      paidMethod: i.paidMethod || null,
    })),
    deposit: depositView(request),
    receipt: receiptView(store.find('receipts', (r) => r.ref === ref)),
    customer: customer ? { name: customer.name, phone: customer.phone, address: customer.address } : null,
  };
}

/* What the customer is told about their €5: where it is and where it went. */
function depositView(request) {
  const d = request?.depositId ? store.get('payments', request.depositId) : null;
  if (!d) return null;
  const said = {
    held: 'Held. It comes off the price if you accept the quote.',
    credited: 'Credited — it has come off what you owe.',
    captured: 'Kept by the tradesperson for pricing the job.',
    refunded: 'Refunded.',
  };
  return {
    amount: d.amount, currency: d.currency, status: d.status,
    note: said[d.status] || null,
    settled: !!d.moved,
  };
}

function receiptView(r) {
  if (!r) return null;
  return {
    number: r.number, issuedAt: r.issuedAt, business: r.business,
    vatNumber: r.vatNumber, vatRegistered: r.vatRegistered, region: r.region,
    lines: r.lines, totals: r.totals, depositCredit: r.depositCredit,
    paid: r.paid, method: r.method,
    methodName: pay.METHOD_BY_KEY.get(r.method)?.name || r.method,
    providerRef: r.providerRef, settled: r.settled,
  };
}

/* ---- public routes --------------------------------------------------- */

on('GET', '/api/v1/meta', async (req, res) => {
  H.json(res, 200, {
    trades: TRADES.map((t) => ({
      key: t.key, name: t.name, icon: t.icon,
      bookable: t.bookable, quoteOnly: t.quoteOnly,
    })),
    areas: AREAS,
    urgency: URGENCY,
    vat: { IE: vatClasses('IE'), UK: vatClasses('UK') },
    withholding: { IE: withholdingRates('IE'), UK: withholdingRates('UK') },
    deposit: { IE: pay.depositAmount('IE'), UK: pay.depositAmount('UK') },
    paymentMethods: pay.METHODS,
    days: DAYS,
  });
});

on('GET', '/api/v1/pros', async (req, res, _p, url) => {
  const results = D.searchPros(store, {
    trade: url.searchParams.get('trade'),
    area: url.searchParams.get('area'),
    q: url.searchParams.get('q'),
    emergency: url.searchParams.get('emergency') === '1',
  });
  H.json(res, 200, { count: results.length, results });
});

on('GET', '/api/v1/pros/:slug', async (req, res, p) => {
  const pro = D.proBySlug(store, p.slug);
  if (!pro || !pro.published) return H.fail(req, res, 404, 'No such tradesperson', 'not_found');
  H.json(res, 200, proProfile(pro));
});

on('GET', '/api/v1/pros/:slug/slots', async (req, res, p, url) => {
  const pro = D.proBySlug(store, p.slug);
  if (!pro || !pro.published) return H.fail(req, res, 404, 'No such tradesperson', 'not_found');
  const service = store.get('services', url.searchParams.get('serviceId'));
  if (!service || service.proId !== pro.id) {
    return H.fail(req, res, 404, 'No such service', 'not_found');
  }
  if (!service.bookable) {
    return H.fail(req, res, 400, 'That service is quote-only', 'not_bookable');
  }
  const av = D.availabilityFor(store, pro.id);
  const slots = slotsFor(av, service.minutes, {
    days: Math.min(Number(url.searchParams.get('days') || 14), 60),
    busy: D.busyFor(store, pro.id),
  });
  H.json(res, 200, { service: serviceView(service), tz: av.tz, days: groupByDay(slots, av.tz) });
});

/*
 * Booking and asking both need an account. The customer is taken from the
 * session, never from the body, so a booking cannot be filed against someone
 * else. The job token still comes back: it is what the confirmation page and
 * any link the customer shares are addressed by.
 */
on('POST', '/api/v1/bookings', async (req, res) => {
  const customer = requireCustomer(req, res); if (!customer) return;
  const body = await H.readJson(req);
  const pro = body.proSlug ? D.proBySlug(store, body.proSlug) : store.get('pros', body.proId);
  if (!pro) return H.fail(req, res, 404, 'No such tradesperson', 'not_found');
  const { booking, token } = D.createBooking(store, issueJobToken,
    { ...body, proId: pro.id, customerId: customer.id });
  H.json(res, 201, { ref: booking.ref, token, job: jobView(booking.ref) });
});

on('POST', '/api/v1/requests', async (req, res) => {
  const customer = requireCustomer(req, res); if (!customer) return;
  const body = await H.readJson(req);
  const { request, deposit } = D.createRequest(store, issueJobToken,
    { ...body, customerId: customer.id });
  const token = issueJobToken(request.ref);
  H.json(res, 201, {
    ref: request.ref, token, job: jobView(request.ref),
    deposit: deposit ? { id: deposit.id, amount: deposit.amount, currency: deposit.currency,
      status: deposit.status, settled: deposit.moved } : null,
  });
});

/*
 * The customer's view of their own job. The token in the query string is the
 * whole credential, so it is checked against this exact reference — a token
 * for one job must not open another.
 */
function jobGate(req, res, ref, url) {
  const token = url.searchParams.get('t') || req.headers['x-foxers-job-token'];
  if (!auth.readJobToken(SECRET, token, ref)) {
    H.fail(req, res, 403, 'That link is not valid for this job', 'forbidden');
    return false;
  }
  return true;
}

on('GET', '/api/v1/jobs/:ref', async (req, res, p, url) => {
  if (!jobGate(req, res, p.ref, url)) return;
  const view = jobView(p.ref);
  if (!view) return H.fail(req, res, 404, 'No such job', 'not_found');
  H.json(res, 200, view);
});

on('POST', '/api/v1/jobs/:ref/accept', async (req, res, p, url) => {
  if (!jobGate(req, res, p.ref, url)) return;
  const body = await H.readJson(req);
  const quote = store.get('quotes', body.quoteId);
  if (!quote || quote.ref !== p.ref) return H.fail(req, res, 404, 'No such quote', 'not_found');
  D.acceptQuote(store, quote.id, 'customer', { start: body.start });
  H.json(res, 200, jobView(p.ref));
});

on('POST', '/api/v1/jobs/:ref/decline', async (req, res, p, url) => {
  if (!jobGate(req, res, p.ref, url)) return;
  const body = await H.readJson(req);
  const quote = store.get('quotes', body.quoteId);
  if (!quote || quote.ref !== p.ref) return H.fail(req, res, 404, 'No such quote', 'not_found');
  D.declineQuote(store, quote.id, body.reason);
  H.json(res, 200, jobView(p.ref));
});

on('POST', '/api/v1/jobs/:ref/review', async (req, res, p, url) => {
  if (!jobGate(req, res, p.ref, url)) return;
  const body = await H.readJson(req);
  const booking = store.find('bookings', (b) => b.ref === p.ref);
  if (!booking) return H.fail(req, res, 400, 'Only a completed booking can be reviewed', 'bad_request');
  const review = D.addReview(store, { ...body, bookingId: booking.id });
  H.json(res, 201, { id: review.id, rating: review.rating });
});

/* ---- customer auth --------------------------------------------------- */

on('POST', '/api/v1/auth/customer/signup', async (req, res) => {
  const gate = limits.signup.check(H.clientIp(req));
  if (!gate.ok) return H.fail(req, res, 429, 'Too many accounts from here. Try again later.', 'rate_limited');

  const body = await H.readJson(req);
  const password = String(body.password || '');
  if (password.length < 10) return H.fail(req, res, 400, 'Password must be at least 10 characters', 'weak_password');
  const customer = D.createCustomerAccount(store, { ...body, passwordHash: auth.hashPassword(password) });
  const token = auth.issueSession(SECRET, customer.id, 'customer');
  H.setCookie(res, 'fx_customer', token, { maxAge: auth.CUSTOMER_SESSION_MS, secure: H.viaTunnel(req) });
  H.json(res, 201, { token, customer: customerView(customer) });
});

on('POST', '/api/v1/auth/customer/login', async (req, res) => {
  const gate = limits.login.check(H.clientIp(req));
  if (!gate.ok) {
    return H.fail(req, res, 429, `Too many attempts. Try again in ${gate.retryAfter}s.`, 'rate_limited');
  }
  const body = await H.readJson(req);
  const customer = D.customerByEmail(store, body.email);
  // Same reply and the same work either way, so a missing account and a wrong
  // password are indistinguishable in both wording and timing.
  const ok = customer
    ? auth.verifyPassword(String(body.password || ''), customer.passwordHash)
    : auth.verifyPassword(String(body.password || ''), auth.hashPassword('decoy-work-factor'));
  if (!customer || !ok) return H.fail(req, res, 401, 'Email or password is wrong', 'bad_credentials');

  const token = auth.issueSession(SECRET, customer.id, 'customer');
  H.setCookie(res, 'fx_customer', token, { maxAge: auth.CUSTOMER_SESSION_MS, secure: H.viaTunnel(req) });
  store.log('customer.login', customer.id, {});
  H.json(res, 200, { token, customer: customerView(customer) });
});

on('POST', '/api/v1/auth/customer/logout', async (req, res) => {
  H.clearCookie(res, 'fx_customer');
  H.json(res, 200, { ok: true });
});

on('GET', '/api/v1/me', async (req, res) => {
  const customer = requireCustomer(req, res); if (!customer) return;
  H.json(res, 200, { customer: customerView(customer) });
});

on('PUT', '/api/v1/me', async (req, res) => {
  const customer = requireCustomer(req, res); if (!customer) return;
  const body = await H.readJson(req);
  H.json(res, 200, { customer: customerView(D.updateCustomer(store, customer.id, body)) });
});

/*
 * The customer's own job list. Each row carries the job token, because the
 * job page is addressed by ref plus token whether it was reached from this
 * list or from a link a foxer sent — one page, one access check.
 */
on('GET', '/api/v1/me/jobs', async (req, res) => {
  const customer = requireCustomer(req, res); if (!customer) return;
  const rows = D.jobsForCustomer(store, customer.id).map((j) => {
    const pro = j.proId ? store.get('pros', j.proId) : null;
    const service = j.serviceId ? store.get('services', j.serviceId) : null;
    const quotes = store.filter('quotes', (q) => q.ref === j.ref);
    const invoice = store.find('invoices', (i) => i.ref === j.ref);
    return {
      ...j,
      token: issueJobToken(j.ref),
      service: service ? service.name : null,
      tradeName: j.trade ? BY_KEY.get(j.trade)?.name : null,
      pro: pro ? { slug: pro.slug, business: pro.business, phone: pro.phone, region: pro.region } : null,
      awaitingYou: quotes.some((q) => q.status === 'sent'),
      invoice: invoice ? { number: invoice.number, status: invoice.status,
        payable: invoice.totals.payable, dueAt: invoice.dueAt } : null,
    };
  });
  H.json(res, 200, { count: rows.length, jobs: rows });
});

/* ---- pro auth -------------------------------------------------------- */

on('POST', '/api/v1/auth/signup', async (req, res) => {
  if (!PUBLIC_SIGNUP) return H.fail(req, res, 403, 'Signup is closed', 'forbidden');
  const gate = limits.signup.check(H.clientIp(req));
  if (!gate.ok) return H.fail(req, res, 429, 'Too many accounts from here. Try again later.', 'rate_limited');

  const body = await H.readJson(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return H.fail(req, res, 400, 'Give a valid email', 'bad_request');
  if (password.length < 10) return H.fail(req, res, 400, 'Password must be at least 10 characters', 'weak_password');
  if (store.find('pros', (p) => p.email === email)) {
    return H.fail(req, res, 409, 'That email is already registered', 'conflict');
  }
  const pro = D.createPro(store, { ...body, email, passwordHash: auth.hashPassword(password) });
  const token = auth.issueSession(SECRET, pro.id);
  H.setCookie(res, 'fx_session', token, { maxAge: auth.SESSION_MS, secure: H.viaTunnel(req) });
  H.json(res, 201, { token, pro: proProfile(pro), private: privateProfile(pro) });
});

on('POST', '/api/v1/auth/login', async (req, res) => {
  const gate = limits.login.check(H.clientIp(req));
  if (!gate.ok) {
    return H.fail(req, res, 429, `Too many attempts. Try again in ${gate.retryAfter}s.`, 'rate_limited');
  }
  const body = await H.readJson(req);
  const email = String(body.email || '').trim().toLowerCase();
  const pro = store.find('pros', (p) => p.email === email);
  // Same reply either way, and the hash still runs, so a missing account and
  // a wrong password are indistinguishable in both wording and timing.
  const ok = pro
    ? auth.verifyPassword(String(body.password || ''), pro.passwordHash)
    : auth.verifyPassword(String(body.password || ''), auth.hashPassword('decoy-work-factor'));
  if (!pro || !ok) return H.fail(req, res, 401, 'Email or password is wrong', 'bad_credentials');

  const token = auth.issueSession(SECRET, pro.id);
  H.setCookie(res, 'fx_session', token, { maxAge: auth.SESSION_MS, secure: H.viaTunnel(req) });
  store.log('pro.login', pro.id, {});
  H.json(res, 200, { token, pro: proProfile(pro), private: privateProfile(pro) });
});

on('POST', '/api/v1/auth/logout', async (req, res) => {
  H.clearCookie(res, 'fx_session');
  H.json(res, 200, { ok: true });
});

/* Everything the signed-in pro may see about themselves that a customer
 * may not. Returned by every route that establishes a session, so a client
 * never has to make a second call to find out its own tax settings. */
function privateProfile(pro) {
  return {
    email: pro.email, phone: pro.phone, vatNumber: pro.vatNumber,
    withholdingRate: pro.withholdingRate, invoicePrefix: pro.invoicePrefix,
    region: pro.region, published: pro.published,
  };
}

on('GET', '/api/v1/auth/me', async (req, res) => {
  const pro = currentPro(req);
  if (!pro) return H.fail(req, res, 401, 'Not signed in', 'unauthenticated');
  H.json(res, 200, { pro: proProfile(pro), private: privateProfile(pro) });
});

/* ---- pro console ----------------------------------------------------- */

on('GET', '/api/v1/pro/dashboard', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  const now = Date.now();
  const bookings = store.filter('bookings', (b) => b.proId === pro.id);
  const upcoming = bookings
    .filter((b) => ['confirmed', 'scheduled'].includes(b.status) && Date.parse(b.start) >= now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const invoices = store.filter('invoices', (i) => i.proId === pro.id);
  const outstanding = invoices.filter((i) => i.status === 'issued');
  const overdue = outstanding.filter((i) => Date.parse(i.dueAt) < now);

  H.json(res, 200, {
    pro: D.publicPro(pro),
    counts: {
      openRequests: openRequestsFor(pro).length,
      upcoming: upcoming.length,
      awaitingAcceptance: store.filter('quotes', (q) => q.proId === pro.id && q.status === 'sent').length,
      outstanding: outstanding.length,
      overdue: overdue.length,
    },
    money: {
      owed: round2(outstanding.reduce((s, i) => s + (i.dueNow ?? i.totals.payable), 0)),
      overdue: round2(overdue.reduce((s, i) => s + (i.dueNow ?? i.totals.payable), 0)),
      paid30: round2(invoices
        .filter((i) => i.status === 'paid' && Date.parse(i.paidAt) > now - 30 * 86400000)
        .reduce((s, i) => s + (i.paidAmount ?? i.totals.payable), 0)),
      withheld: round2(invoices.reduce((s, i) => s + (i.totals.withholding?.amount || 0), 0)),
      depositsEarned: round2(store
        .filter('payments', (p) => p.kind === 'deposit' && p.proId === pro.id && p.status === 'captured')
        .reduce((s, d) => s + d.amount, 0)),
    },
    upcoming: upcoming.slice(0, 10).map(bookingRow),
    chases: D.chasesDue(store, now).filter((c) => c.proId === pro.id).map(withCustomer),
  });
});

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function bookingRow(b) {
  const c = store.get('customers', b.customerId);
  const s = store.get('services', b.serviceId);
  return {
    id: b.id, ref: b.ref, status: b.status, start: b.start, end: b.end,
    price: b.price, address: b.address, notes: b.notes, kind: b.kind || 'booking',
    service: s ? s.name : (b.title || 'Job'),
    fromQuote: !!b.quoteId,
    customer: c ? { name: c.name, phone: c.phone } : null,
  };
}

/*
 * A pro sees requests aimed at them plus open ones matching their trade and
 * area. Broadcasting to everyone in the county is how a marketplace becomes
 * a spam channel, so the match has to be on both axes.
 */
function openRequestsFor(pro) {
  return store.filter('requests', (r) => {
    if (r.status !== 'open') return false;
    if (r.proId) return r.proId === pro.id;
    if (!pro.trades.includes(r.trade)) return false;
    return !r.area || pro.areas.includes(r.area);
  });
}

on('GET', '/api/v1/pro/requests', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  const rank = { emergency: 0, week: 1, flexible: 2, planning: 3 };
  const rows = openRequestsFor(pro)
    .sort((a, b) => (rank[a.urgency] - rank[b.urgency]) || (Date.parse(a.createdAt) - Date.parse(b.createdAt)))
    .map((r) => {
      const c = store.get('customers', r.customerId);
      return {
        id: r.id, ref: r.ref, trade: r.trade, tradeName: BY_KEY.get(r.trade)?.name,
        urgency: r.urgency, description: r.description, address: r.address,
        area: r.area, at: r.createdAt, direct: !!r.proId,
        customer: c ? { name: c.name, phone: c.phone } : null,
      };
    });
  H.json(res, 200, { count: rows.length, requests: rows });
});

on('GET', '/api/v1/pro/bookings', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  const rows = store.filter('bookings', (b) => b.proId === pro.id)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map(bookingRow);
  H.json(res, 200, { count: rows.length, bookings: rows });
});

on('PATCH', '/api/v1/pro/bookings/:id', async (req, res, p) => {
  const pro = requirePro(req, res); if (!pro) return;
  const b = store.get('bookings', p.id);
  if (!b || b.proId !== pro.id) return H.fail(req, res, 404, 'No such booking', 'not_found');
  const body = await H.readJson(req);
  const allowed = ['confirmed', 'scheduled', 'done', 'cancelled'];
  if (body.status && !allowed.includes(body.status)) {
    return H.fail(req, res, 400, `Status must be one of ${allowed.join(', ')}`, 'bad_request');
  }
  const patch = {};
  if (body.status) patch.status = body.status;
  if (body.notes != null) patch.notes = String(body.notes).slice(0, 1000);
  if (body.status === 'done') patch.doneAt = new Date().toISOString();
  H.json(res, 200, bookingRow(store.update('bookings', b.id, patch)));
});

on('GET', '/api/v1/pro/services', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  H.json(res, 200, {
    services: store.filter('services', (s) => s.proId === pro.id).map(serviceView),
    templates: pro.trades.map((t) => BY_KEY.get(t)).filter(Boolean),
  });
});

on('POST', '/api/v1/pro/services', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  const body = await H.readJson(req);
  H.json(res, 201, serviceView(D.addService(store, pro.id, body)));
});

on('PATCH', '/api/v1/pro/services/:id', async (req, res, p) => {
  const pro = requirePro(req, res); if (!pro) return;
  const s = store.get('services', p.id);
  if (!s || s.proId !== pro.id) return H.fail(req, res, 404, 'No such service', 'not_found');
  const body = await H.readJson(req);
  const patch = {};
  for (const k of ['name', 'description', 'vatClass']) if (body[k] != null) patch[k] = String(body[k]);
  for (const k of ['minutes', 'price']) if (body[k] != null) patch[k] = Number(body[k]);
  for (const k of ['bookable', 'active']) if (body[k] != null) patch[k] = !!body[k];
  if ((patch.bookable ?? s.bookable) && !((patch.price ?? s.price) > 0)) {
    return H.fail(req, res, 400, 'A bookable service needs a fixed price', 'bad_request');
  }
  H.json(res, 200, serviceView(store.update('services', s.id, patch)));
});

on('DELETE', '/api/v1/pro/services/:id', async (req, res, p) => {
  const pro = requirePro(req, res); if (!pro) return;
  const s = store.get('services', p.id);
  if (!s || s.proId !== pro.id) return H.fail(req, res, 404, 'No such service', 'not_found');
  // Deactivate rather than delete: past bookings point at this row.
  H.json(res, 200, serviceView(store.update('services', s.id, { active: false })));
});

on('GET', '/api/v1/pro/availability', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  H.json(res, 200, D.availabilityFor(store, pro.id));
});

on('PUT', '/api/v1/pro/availability', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  const body = await H.readJson(req);
  const current = store.find('availability', (a) => a.proId === pro.id)
    || store.insert('availability', defaultAvailability(pro.id));

  const weekly = {};
  for (const day of DAYS) {
    const windows = Array.isArray(body.weekly?.[day]) ? body.weekly[day] : current.weekly[day] || [];
    weekly[day] = [];
    for (const w of windows.slice(0, 4)) {
      const s = parseHm(w.start), e = parseHm(w.end);
      if (!s || !e) return H.fail(req, res, 400, `Bad time on ${day} — use HH:MM`, 'bad_request');
      if (e.hh * 60 + e.mm <= s.hh * 60 + s.mm) {
        return H.fail(req, res, 400, `${day} finishes before it starts`, 'bad_request');
      }
      weekly[day].push({ start: w.start, end: w.end });
    }
  }
  const patch = { weekly };
  for (const k of ['leadTimeHours', 'bufferMinutes', 'maxDaysAhead', 'slotStepMinutes']) {
    if (body[k] != null) patch[k] = Math.max(0, Number(body[k]) || 0);
  }
  if (body.tz) {
    try { new Intl.DateTimeFormat('en', { timeZone: String(body.tz) }); patch.tz = String(body.tz); }
    catch { return H.fail(req, res, 400, 'Unknown time zone', 'bad_request'); }
  }
  if (Array.isArray(body.blocks)) {
    patch.blocks = body.blocks.slice(0, 200)
      .filter((b) => Number.isFinite(Date.parse(b.start)) && Number.isFinite(Date.parse(b.end)))
      .map((b) => ({ start: b.start, end: b.end, reason: String(b.reason || '').slice(0, 120) }));
  }
  H.json(res, 200, store.update('availability', current.id, patch));
});

on('GET', '/api/v1/pro/quotes', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  const rows = store.filter('quotes', (q) => q.proId === pro.id)
    .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))
    .map((q) => ({
      id: q.id, ref: q.ref, title: q.title, status: q.status,
      gross: q.totals.gross, payable: q.totals.payable,
      sentAt: q.sentAt, acceptedAt: q.acceptedAt, validUntil: q.validUntil,
      customer: shortCustomer(q.customerId),
    }));
  H.json(res, 200, { count: rows.length, quotes: rows });
});

function shortCustomer(id) {
  const c = id ? store.get('customers', id) : null;
  return c ? { name: c.name, phone: c.phone } : null;
}

/* A chase without a phone number is a note to self, so carry the customer. */
function withCustomer(c) {
  return { ...c, customer: shortCustomer(c.customerId) };
}

on('POST', '/api/v1/pro/quotes', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  const body = await H.readJson(req);
  const quote = D.createQuote(store, pro.id, body);
  H.json(res, 201, { id: quote.id, ref: quote.ref, totals: quote.totals,
    customerLink: `/j/${quote.ref}?t=${issueJobToken(quote.ref)}` });
});

/* Price a quote without saving it — the builder recalculates as you type. */
on('POST', '/api/v1/pro/price', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  const body = await H.readJson(req);
  const { priceLines } = require('./lib/tax');
  H.json(res, 200, priceLines(Array.isArray(body.lines) ? body.lines : [], {
    region: pro.region,
    reverseCharge: !!body.reverseCharge,
    withholdingRate: Number(body.withholdingRate ?? pro.withholdingRate ?? 0),
  }));
});

on('GET', '/api/v1/pro/invoices', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  const rows = store.filter('invoices', (i) => i.proId === pro.id)
    .sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt))
    .map((i) => ({
      id: i.id, number: i.number, ref: i.ref, status: i.status,
      gross: i.totals.gross, payable: i.totals.payable,
      dueNow: i.dueNow ?? i.totals.payable, depositCredit: i.depositCredit || 0,
      withheld: i.totals.withholding?.amount || 0,
      issuedAt: i.issuedAt, dueAt: i.dueAt, paidAt: i.paidAt,
      overdueDays: i.status === 'issued'
        ? Math.max(0, Math.floor((Date.now() - Date.parse(i.dueAt)) / 86400000)) : 0,
      customer: shortCustomer(i.customerId),
      chases: (i.chases || []).length,
    }));
  H.json(res, 200, { count: rows.length, invoices: rows });
});

on('POST', '/api/v1/pro/invoices', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  const body = await H.readJson(req);
  const inv = D.createInvoice(store, pro.id, body);
  H.json(res, 201, { id: inv.id, number: inv.number, ref: inv.ref, totals: inv.totals,
    customerLink: `/j/${inv.ref}?t=${issueJobToken(inv.ref)}` });
});

/*
 * Taking the money and issuing the receipt are the same request. `method`
 * says how it was taken — a tap on the reader, a wallet, or a transfer that
 * already landed — and the receipt comes straight back so it can be handed
 * over before the foxer leaves the driveway.
 */
on('POST', '/api/v1/pro/invoices/:id/paid', async (req, res, p) => {
  const pro = requirePro(req, res); if (!pro) return;
  const inv = store.get('invoices', p.id);
  if (!inv || inv.proId !== pro.id) return H.fail(req, res, 404, 'No such invoice', 'not_found');
  const body = await H.readJson(req);
  const { invoice, payment, receipt } = D.settleInvoice(store, inv.id, {
    method: body.method || 'transfer',
    amount: body.amount,
  });
  H.json(res, 200, {
    ok: true,
    invoice: invoice.status,
    paid: payment.amount,
    method: payment.method,
    settled: !!payment.moved,
    receipt: receiptView(receipt),
    customerLink: `/j/${invoice.ref}?t=${issueJobToken(invoice.ref)}`,
  });
});

/*
 * The foxer's own free slots, for choosing the times a quote offers. Same
 * derivation the customer's booking form uses, so the two cannot disagree.
 */
on('GET', '/api/v1/pro/slots', async (req, res, _p, url) => {
  const pro = requirePro(req, res); if (!pro) return;
  const minutes = Math.max(15, Math.min(Number(url.searchParams.get('minutes') || 120), 600));
  const av = D.availabilityFor(store, pro.id);
  const slots = slotsFor(av, minutes, {
    days: Math.min(Number(url.searchParams.get('days') || 21), 60),
    busy: D.busyFor(store, pro.id),
  });
  H.json(res, 200, { minutes, tz: av.tz, days: groupByDay(slots, av.tz) });
});

/* Deposits: what is riding on quotes still out, and what has been earned. */
on('GET', '/api/v1/pro/deposits', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  const mine = store.filter('payments', (p) => p.kind === 'deposit' && p.proId === pro.id);
  const rows = mine.map((d) => ({
    id: d.id, ref: d.ref, amount: d.amount, currency: d.currency,
    status: d.status, at: d.settledAt || d.heldAt, settled: !!d.moved,
    customer: shortCustomer(d.customerId),
  }));
  H.json(res, 200, {
    earned: round2(rows.filter((r) => r.status === 'captured').reduce((s, r) => s + r.amount, 0)),
    credited: round2(rows.filter((r) => r.status === 'credited').reduce((s, r) => s + r.amount, 0)),
    deposits: rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
  });
});

on('GET', '/api/v1/pro/chases', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  H.json(res, 200, { chases: D.chasesDue(store).filter((c) => c.proId === pro.id).map(withCustomer) });
});

on('POST', '/api/v1/pro/chases/:invoiceId', async (req, res, p) => {
  const pro = requirePro(req, res); if (!pro) return;
  const inv = store.get('invoices', p.invoiceId);
  if (!inv || inv.proId !== pro.id) return H.fail(req, res, 404, 'No such invoice', 'not_found');
  const body = await H.readJson(req);
  H.json(res, 200, { ok: true, chases: (D.recordChase(store, inv.id, String(body.key), body.channel).chases || []).length });
});

on('PUT', '/api/v1/pro/profile', async (req, res) => {
  const pro = requirePro(req, res); if (!pro) return;
  const body = await H.readJson(req);
  const patch = {};
  for (const k of ['business', 'name', 'phone', 'bio', 'vatNumber', 'invoicePrefix']) {
    if (body[k] != null) patch[k] = String(body[k]).slice(0, 400);
  }
  for (const k of ['calloutFee', 'hourlyRate', 'withholdingRate']) {
    if (body[k] != null) patch[k] = Number(body[k]) || 0;
  }
  for (const k of ['vatRegistered', 'acceptsEmergency', 'published']) {
    if (body[k] != null) patch[k] = !!body[k];
  }
  if (Array.isArray(body.trades)) patch.trades = body.trades.filter((t) => BY_KEY.has(t));
  if (Array.isArray(body.areas)) patch.areas = body.areas.map(String).slice(0, 12);
  if (body.region) patch.region = body.region === 'UK' ? 'UK' : 'IE';
  if (patch.withholdingRate != null) {
    const region = patch.region || pro.region;
    const ok = withholdingRates(region).rates.includes(patch.withholdingRate);
    if (!ok) return H.fail(req, res, 400, 'Invalid withholding rate for that region', 'bad_request');
  }
  H.json(res, 200, proProfile(store.update('pros', pro.id, patch)));
});

on('GET', '/api/v1/health', async (req, res) => {
  H.json(res, 200, { ok: true, pros: store.all('pros').length, version: 1 });
});

/* ---- server ---------------------------------------------------------- */

/* Deep links the web client owns; served the app shell, routed in the browser. */
const APP_PATHS = [/^\/$/, /^\/find/, /^\/ask/, /^\/pro(\/|$)/, /^\/j\//, /^\/book\//,
  /^\/me(\/|$)/, /^\/signin/, /^\/join/,
  /^\/dash(\/|$)/, /^\/signup/, /^\/login/, /^\/about/];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'foxers.local'}`);
  const pathname = url.pathname;

  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'DENY');

  try {
    if (pathname.startsWith('/api/')) {
      const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
      const gate = (isWrite ? limits.write : limits.read).check(H.clientIp(req));
      if (!gate.ok && !pathname.startsWith('/api/v1/auth/')) {
        return H.fail(req, res, 429, 'Slow down a moment.', 'rate_limited');
      }
      const hit = match(req.method, pathname);
      if (!hit) return H.fail(req, res, 404, 'No such endpoint', 'not_found');
      await hit.route.handler(req, res, hit.params, url);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return H.fail(req, res, 405, 'Method not allowed', 'method_not_allowed');
    }

    if (H.serveStatic(WEB_ROOT, pathname, res)) return;
    if (APP_PATHS.some((rx) => rx.test(pathname))) {
      if (H.serveStatic(WEB_ROOT, '/index.html', res)) return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found\n');
  } catch (err) {
    // A 5xx is replaced by Cloudflare's own page when this sits behind a
    // tunnel, so anything the caller needs to read must not be one.
    const status = err.status || (err instanceof D.DomainError ? err.status : 500);
    if (status >= 500) console.error('[foxers]', req.method, pathname, err);
    H.fail(req, res, status, status >= 500 ? 'Something went wrong' : err.message, err.code || 'error');
  }
});

server.headersTimeout = 20_000;
server.requestTimeout = 60_000;

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`[foxers] listening on http://${HOST}:${PORT}  data=${DATA_DIR}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`[foxers] ${sig} — flushing`);
      store.saveNow();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

module.exports = { server, store, SECRET, issueJobToken };
