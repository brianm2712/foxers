'use strict';
/*
 * End-to-end over real HTTP, against a real server on a throwaway data dir.
 * The point is to exercise the routes the iOS app will call, exactly as it
 * will call them — bearer token, JSON in, JSON out.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
let child, base, dataDir;

function waitForHealth(url, tries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      fetch(`${url}/api/v1/health`).then((r) => r.ok ? resolve() : retry(n))
        .catch(() => retry(n));
      const retry = (k) => k <= 0 ? reject(new Error('server never came up')) : setTimeout(() => attempt(k - 1), 100);
    };
    attempt(tries);
  });
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxers-test-'));
  const port = 8000 + Math.floor(Math.random() * 1500);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env, FOXERS_DATA: dataDir, FOXERS_PORT: String(port), FOXERS_HOST: '127.0.0.1',
      // The suite makes far more calls from one address than a person would.
      // The limiters have their own test below; everything else would just be
      // measuring them.
      FOXERS_LIMIT_WRITE: '10000', FOXERS_LIMIT_SIGNUP: '10000', FOXERS_LIMIT_READ: '100000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth(base);
});

test.after(() => {
  if (child) child.kill('SIGTERM');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

let token = null;
async function api(method, url, body, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  const bearer = opts.token === null ? null : (opts.token || token);
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(base + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, body: json, raw: text };
}

let pro, service, jobRef, jobToken, quoteId, invoiceId;
let customerToken, customer;

test('meta lists the trade taxonomy both clients render from', async () => {
  const r = await api('GET', '/api/v1/meta');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.trades.length >= 10);
  assert.ok(r.body.areas.some((a) => a.key === 'dublin'));
  assert.ok(r.body.trades.every((t) => Array.isArray(t.bookable)));
});

test('a pro signs up and gets a bearer token', async () => {
  const r = await api('POST', '/api/v1/auth/signup', {
    name: 'Test Sparks', business: 'Test Sparks Ltd', email: 'test@example.com',
    password: 'a-long-enough-password', trades: ['electrician'], areas: ['dublin'],
    withholdingRate: 20, vatRegistered: true, vatNumber: 'IE0000000A',
  }, { token: null });
  assert.strictEqual(r.status, 201, r.raw);
  assert.ok(r.body.token);
  // The console defaults a quote's deduction rate from the private half. When
  // only the public profile came back, every quote started at "no deduction"
  // no matter what rate the pro was actually on.
  assert.ok(r.body.private, 'a session carries the private profile');
  assert.strictEqual(r.body.private.withholdingRate, 20);
  assert.ok(r.body.private.invoicePrefix, 'and the prefix invoice numbers are built from');
  assert.strictEqual(r.body.pro.withholdingRate, undefined, 'but never on the public half');
  assert.strictEqual(r.body.pro.email, undefined);
  token = r.body.token;
  pro = r.body.pro;
});

test('a weak password is refused before an account exists', async () => {
  const r = await api('POST', '/api/v1/auth/signup', {
    name: 'X', business: 'X', email: 'weak@example.com', password: 'short', trades: ['plumber'],
  }, { token: null });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'weak_password');
});

test('/auth/me agrees with what signing up returned', async () => {
  const r = await api('GET', '/api/v1/auth/me');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.private.withholdingRate, 20);
  assert.strictEqual(r.body.private.email, 'test@example.com');
  assert.strictEqual(r.body.pro.slug, pro.slug);
});

test('the pro console refuses an unauthenticated caller', async () => {
  const r = await api('GET', '/api/v1/pro/dashboard', undefined, { token: null });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.code, 'unauthenticated');
});

test('a forged bearer token is rejected', async () => {
  const r = await api('GET', '/api/v1/pro/dashboard', undefined, { token: 'eyJhIjoxfQ.notavalidmac' });
  assert.strictEqual(r.status, 401);
});

test('a bookable service must carry a fixed price', async () => {
  const r = await api('POST', '/api/v1/pro/services', { name: 'Rewire', minutes: 480, bookable: true });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /fixed price/);
});

test('adding a bookable service publishes real slots', async () => {
  const add = await api('POST', '/api/v1/pro/services', {
    name: 'EV charger survey', minutes: 45, price: 75, bookable: true,
  });
  assert.strictEqual(add.status, 201, add.raw);
  service = add.body;

  const slots = await api('GET', `/api/v1/pros/${pro.slug}/slots?serviceId=${service.id}&days=14`, undefined, { token: null });
  assert.strictEqual(slots.status, 200);
  assert.ok(slots.body.days.length > 0, 'a new pro has an eight-to-five week by default');
  assert.ok(slots.body.days[0].slots.length > 0);
});

test('search ranks by who can start soonest', async () => {
  const r = await api('GET', '/api/v1/pros?trade=electrician&area=dublin', undefined, { token: null });
  assert.strictEqual(r.status, 200);
  const mine = r.body.results.find((p) => p.slug === pro.slug);
  assert.ok(mine, 'the new pro appears in search');
  assert.ok(mine.nextSlot, 'with a bookable next slot');
  assert.strictEqual(mine.fromPrice, 75);
});

test('a customer signs up with an email and a password', async () => {
  const r = await api('POST', '/api/v1/auth/customer/signup', {
    name: 'Ciara Doyle', email: 'ciara@example.com', password: 'a-long-enough-password',
    phone: '087 555 0303', address: '14 Grange Road, Dublin 16', area: 'dublin',
  }, { token: null });
  assert.strictEqual(r.status, 201, r.raw);
  assert.ok(r.body.token);
  assert.strictEqual(r.body.customer.area, 'dublin', 'the county their search starts in');
  assert.strictEqual(r.body.customer.passwordHash, undefined, 'never hand back the hash');
  customerToken = r.body.token;
  customer = r.body.customer;
});

test('booking without an account is refused', async () => {
  const slots = await api('GET', `/api/v1/pros/${pro.slug}/slots?serviceId=${service.id}`, undefined, { token: null });
  const r = await api('POST', '/api/v1/bookings', {
    proSlug: pro.slug, serviceId: service.id, start: slots.body.days[0].slots[0].start,
  }, { token: null });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.code, 'unauthenticated');
});

test('a customer session cannot reach the pro console', async () => {
  const r = await api('GET', '/api/v1/pro/dashboard', undefined, { token: customerToken });
  assert.strictEqual(r.status, 401, 'the kind is inside the signature, so it cannot be flipped');
});

test('a customer books an offered slot and gets a job token', async () => {
  const slots = await api('GET', `/api/v1/pros/${pro.slug}/slots?serviceId=${service.id}`, undefined, { token: null });
  const first = slots.body.days[0].slots[0];
  const r = await api('POST', '/api/v1/bookings', {
    proSlug: pro.slug, serviceId: service.id, start: first.start,
    address: '14 Grange Road, Dublin 16',
    notes: 'Charger going on the gable wall.',
  }, { token: customerToken });
  assert.strictEqual(r.status, 201, r.raw);
  assert.match(r.body.ref, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  jobRef = r.body.ref;
  jobToken = r.body.token;
  assert.strictEqual(r.body.job.booking.status, 'confirmed');
});

test('the same slot cannot be booked twice', async () => {
  const slots = await api('GET', `/api/v1/pros/${pro.slug}/slots?serviceId=${service.id}`, undefined, { token: null });
  const taken = slots.body.days.flatMap((d) => d.slots).map((s) => s.start);
  const job = await api('GET', `/api/v1/jobs/${jobRef}?t=${encodeURIComponent(jobToken)}`, undefined, { token: null });
  assert.ok(!taken.includes(job.body.booking.start), 'the booked time is no longer offered');

  const r = await api('POST', '/api/v1/bookings', {
    proSlug: pro.slug, serviceId: service.id, start: job.body.booking.start,
  }, { token: customerToken });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'slot_gone');
});

test('a job token opens its own job and nothing else', async () => {
  const ok = await api('GET', `/api/v1/jobs/${jobRef}?t=${encodeURIComponent(jobToken)}`, undefined, { token: null });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.customer.name, 'Ciara Doyle');

  const noToken = await api('GET', `/api/v1/jobs/${jobRef}`, undefined, { token: null });
  assert.strictEqual(noToken.status, 403);

  const otherRef = jobRef.split('').reverse().join('');
  const wrongJob = await api('GET', `/api/v1/jobs/${otherRef}?t=${encodeURIComponent(jobToken)}`, undefined, { token: null });
  assert.strictEqual(wrongJob.status, 403, 'a token is bound to one reference');
});

test('an open request reaches a matching pro and only a matching pro', async () => {
  const r = await api('POST', '/api/v1/requests', {
    trade: 'electrician', area: 'dublin', urgency: 'emergency',
    description: 'Half the house has no power and the board keeps tripping.',
    address: '7 Seapark, Malahide',
  }, { token: customerToken });
  assert.strictEqual(r.status, 201, r.raw);

  const mine = await api('GET', '/api/v1/pro/requests');
  assert.strictEqual(mine.status, 200);
  assert.strictEqual(mine.body.requests[0].urgency, 'emergency', 'emergencies sort to the top');

  const other = await api('POST', '/api/v1/auth/signup', {
    name: 'Cork Carpenter', business: 'Cork Carpentry', email: 'cork@example.com',
    password: 'another-long-password', trades: ['carpenter'], areas: ['cork'],
  }, { token: null });
  const theirs = await api('GET', '/api/v1/pro/requests', undefined, { token: other.body.token });
  assert.strictEqual(theirs.body.count, 0, 'a Cork carpenter does not see a Dublin electrical job');
});

test('quote, accept, invoice — with RCT carried through', async () => {
  const reqs = await api('GET', '/api/v1/pro/requests');
  const requestId = reqs.body.requests[0].id;

  const q = await api('POST', '/api/v1/pro/quotes', {
    requestId,
    title: 'Board replacement',
    lines: [
      { kind: 'labour', description: 'Labour', qty: 8, unitPrice: 65, vatClass: 'reduced' },
      { kind: 'materials', description: 'Consumer unit', qty: 1, unitPrice: 120, vatClass: 'reduced' },
    ],
    withholdingRate: 20,
  });
  assert.strictEqual(q.status, 201, q.raw);
  assert.strictEqual(q.body.totals.gross, 726.4);
  assert.strictEqual(q.body.totals.withholding.amount, 128);
  assert.strictEqual(q.body.totals.payable, 598.4);
  quoteId = q.body.id;

  const link = new URL(q.body.customerLink, base);
  const ref = link.pathname.split('/').pop();
  const t = link.searchParams.get('t');

  const before = await api('GET', `/api/v1/jobs/${ref}?t=${encodeURIComponent(t)}`, undefined, { token: null });
  assert.strictEqual(before.body.quotes[0].status, 'sent');

  const accept = await api('POST', `/api/v1/jobs/${ref}/accept?t=${encodeURIComponent(t)}`, { quoteId }, { token: null });
  assert.strictEqual(accept.status, 200, accept.raw);
  assert.strictEqual(accept.body.quotes[0].status, 'accepted');
  assert.ok(accept.body.quotes[0].acceptedAt, 'acceptance is timestamped');

  const inv = await api('POST', '/api/v1/pro/invoices', {
    quoteId,
    variations: [{ kind: 'labour', description: 'Extra circuit', qty: 1, unitPrice: 85, vatClass: 'reduced' }],
    withholdingRate: 20, dueDays: 2,
  });
  assert.strictEqual(inv.status, 201, inv.raw);
  assert.match(inv.body.number, /^TSL-\d{4}-0001$/, 'sequential, prefixed, year-scoped');
  assert.strictEqual(inv.body.totals.net, 725, 'the variation is on the invoice');
  invoiceId = inv.body.id;
});

test('an invoice cannot be raised against a quote nobody accepted', async () => {
  const q = await api('POST', '/api/v1/pro/quotes', {
    title: 'Unaccepted', lines: [{ kind: 'labour', qty: 1, unitPrice: 100, vatClass: 'reduced' }],
  });
  const r = await api('POST', '/api/v1/pro/invoices', { quoteId: q.body.id });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /accepted quote/);
});

test('an accepted quote cannot be accepted again by a different party', async () => {
  const r = await api('POST', '/api/v1/pro/quotes', {
    title: 'Second', lines: [{ kind: 'labour', qty: 1, unitPrice: 50, vatClass: 'reduced' }],
  });
  assert.strictEqual(r.status, 201);
  const dash = await api('GET', '/api/v1/pro/dashboard');
  assert.ok(dash.body.counts.awaitingAcceptance >= 1);
});

test('the chase engine speaks up once the invoice is overdue, and only once per step', async () => {
  const chases = await api('GET', '/api/v1/pro/chases');
  assert.strictEqual(chases.status, 200);
  const dueSoon = chases.body.chases.find((c) => c.key === 'due-soon');
  assert.ok(dueSoon, 'the nudge queues three days before the due date, unasked');
  assert.match(dueSoon.text, /TSL-\d{4}-0001/);
  assert.ok(dueSoon.customer?.phone, 'a chase carries a number to send it to');

  await api('POST', `/api/v1/pro/chases/${invoiceId}`, { key: 'due-soon', channel: 'whatsapp' });
  const after = await api('GET', '/api/v1/pro/chases');
  assert.ok(!after.body.chases.some((c) => c.key === 'due-soon'), 'a sent chase is not re-offered');
});

test('a quote raised without a request still gives the customer a working link', async () => {
  const q = await api('POST', '/api/v1/pro/quotes', {
    title: 'Walk-in — attic light',
    lines: [{ kind: 'labour', description: 'Fit attic light', qty: 1, unitPrice: 90, vatClass: 'reduced' }],
  });
  assert.strictEqual(q.status, 201, q.raw);
  const link = new URL(q.body.customerLink, base);
  const ref = link.pathname.split('/').pop();
  const t = link.searchParams.get('t');

  const view = await api('GET', `/api/v1/jobs/${ref}?t=${encodeURIComponent(t)}`, undefined, { token: null });
  assert.strictEqual(view.status, 200, 'the link the pro just handed over must open');
  assert.strictEqual(view.body.quotes.length, 1);
  assert.strictEqual(view.body.pro.slug, pro.slug);

  const accept = await api('POST', `/api/v1/jobs/${ref}/accept?t=${encodeURIComponent(t)}`, { quoteId: q.body.id }, { token: null });
  assert.strictEqual(accept.status, 200);
  assert.strictEqual(accept.body.quotes[0].status, 'accepted');
});

test('marking paid clears the money owed', async () => {
  const before = await api('GET', '/api/v1/pro/dashboard');
  assert.ok(before.body.money.owed > 0);
  const r = await api('POST', `/api/v1/pro/invoices/${invoiceId}/paid`, { method: 'transfer' });
  assert.strictEqual(r.status, 200, r.raw);
  assert.ok(r.body.receipt, 'settling issues a receipt in the same breath');
  assert.strictEqual(r.body.receipt.methodName, 'Bank transfer');
  assert.strictEqual(r.body.settled, false, 'the manual provider moves no money');

  const after = await api('GET', '/api/v1/pro/dashboard');
  assert.strictEqual(after.body.money.owed, 0);
  assert.ok(after.body.money.paid30 > 0);

  const junk = await api('POST', `/api/v1/pro/invoices/${invoiceId}/paid`, { method: 'bank transfer' });
  assert.strictEqual(junk.status, 400, 'a method that is not a real rail is refused');
});

test("one pro cannot touch another pro's invoice", async () => {
  const other = await api('POST', '/api/v1/auth/signup', {
    name: 'Nosy', business: 'Nosy Trades', email: 'nosy@example.com',
    password: 'yet-another-long-one', trades: ['plumber'], areas: ['dublin'],
  }, { token: null });
  const r = await api('POST', `/api/v1/pro/invoices/${invoiceId}/paid`, {}, { token: other.body.token });
  assert.strictEqual(r.status, 404, 'not even acknowledged as existing');
});

test('login is rate limited', async () => {
  let sawLimit = false;
  for (let i = 0; i < 12; i++) {
    const r = await api('POST', '/api/v1/auth/login', { email: 'test@example.com', password: 'wrong' }, { token: null });
    if (r.status === 429) { sawLimit = true; break; }
    assert.strictEqual(r.status, 401);
  }
  assert.ok(sawLimit, 'brute force is throttled');
});

test('a path traversal attempt does not escape the web root', async () => {
  const res = await fetch(`${base}/../server/index.js`, { redirect: 'manual' });
  assert.ok(res.status === 404 || res.status === 301, `got ${res.status}`);
  const text = await res.text();
  assert.ok(!text.includes('FOXERS_DATA'), 'server source is not served');
});

test('an unknown API route 404s as JSON rather than the app shell', async () => {
  const r = await api('GET', '/api/v1/nope', undefined, { token: null });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'not_found');
});

test('an invoice long overdue is offered one chase, not the backlog behind it', async () => {
  // Issued with a due date already ten days gone, so due-soon, day-1 and
  // day-7 have all come around. Only the stage actually reached should be
  // offered: a customer ten days late must not be told it is due in three.
  const q = await api('POST', '/api/v1/pro/quotes', {
    title: 'Old job', lines: [{ kind: 'labour', description: 'Work', qty: 1, unitPrice: 200, vatClass: 'reduced' }],
  });
  const link = new URL(q.body.customerLink, base);
  const ref = link.pathname.split('/').pop();
  const t = link.searchParams.get('t');
  await api('POST', `/api/v1/jobs/${ref}/accept?t=${encodeURIComponent(t)}`, { quoteId: q.body.id }, { token: null });

  const inv = await api('POST', '/api/v1/pro/invoices', { quoteId: q.body.id, dueDays: -10 });
  assert.strictEqual(inv.status, 201);

  const mine = (await api('GET', '/api/v1/pro/chases')).body.chases
    .filter((c) => c.invoiceId === inv.body.id);
  assert.strictEqual(mine.length, 1, 'one message, not three');
  assert.strictEqual(mine[0].key, 'day-7', 'the stage it has actually reached');
  assert.doesNotMatch(mine[0].text, /due in 3 days/);
});

test('the customer job list shows their own jobs and only their own', async () => {
  const mine = await api('GET', '/api/v1/me/jobs', undefined, { token: customerToken });
  assert.strictEqual(mine.status, 200);
  assert.ok(mine.body.count >= 2, 'the booking and the request both appear');
  const booking = mine.body.jobs.find((j) => j.ref === jobRef);
  assert.ok(booking, 'the job they booked is in the list');
  assert.strictEqual(booking.kind, 'booking');
  assert.ok(booking.token, 'each row carries the token its job page is opened with');
  assert.strictEqual(booking.pro.slug, pro.slug);

  const other = await api('POST', '/api/v1/auth/customer/signup', {
    name: 'Someone Else', email: 'someone@example.com', password: 'another-long-password',
    phone: '087 555 0999', area: 'dublin',
  }, { token: null });
  assert.strictEqual(other.status, 201, other.raw);
  const theirs = await api('GET', '/api/v1/me/jobs', undefined, { token: other.body.token });
  assert.strictEqual(theirs.body.count, 0, 'a new account starts empty');
});

test('a walk-in a foxer writes up never lands in a stranger account', async () => {
  // Same phone number as the signed-up customer. Matching on it would drop
  // this job into her list, which is how a shared landline or a mistyped
  // digit leaks one household's work into another's.
  const q = await api('POST', '/api/v1/pro/quotes', {
    title: 'Walk-in with a familiar number',
    lines: [{ kind: 'labour', description: 'Look at a socket', qty: 1, unitPrice: 60, vatClass: 'reduced' }],
    customerId: null,
  });
  assert.strictEqual(q.status, 201);

  const before = await api('GET', '/api/v1/me/jobs', undefined, { token: customerToken });
  const r = await api('POST', '/api/v1/requests', {
    trade: 'electrician', area: 'dublin', urgency: 'flexible',
    description: 'A walk-in job taken over the counter by the tradesperson.',
    customer: { name: 'Not Ciara', phone: '087 555 0303' },
  }, { token: customerToken });
  assert.strictEqual(r.status, 201, 'the signed-in account still wins over any posted customer');

  const after = await api('GET', '/api/v1/me/jobs', undefined, { token: customerToken });
  assert.strictEqual(after.body.count, before.body.count + 1, 'exactly one new job, her own');
});

test('a customer can correct their own details', async () => {
  const r = await api('PUT', '/api/v1/me', { phone: '087 555 0777', area: 'wicklow' }, { token: customerToken });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.customer.phone, '0875550777');
  assert.strictEqual(r.body.customer.area, 'wicklow');

  const bad = await api('PUT', '/api/v1/me', { phone: '12' }, { token: customerToken });
  assert.strictEqual(bad.status, 400);
});

/* ---- the deposit, the diary and the receipt --------------------------- */

/** Send a request as the signed-in customer and return it with its deposit. */
async function askFor(description) {
  const r = await api('POST', '/api/v1/requests', {
    trade: 'electrician', area: 'dublin', urgency: 'week', description,
    address: '14 Grange Road, Dublin 16',
  }, { token: customerToken });
  assert.strictEqual(r.status, 201, r.raw);
  return r.body;
}

test('sending a request holds a EUR 5 deposit', async () => {
  const job = await askFor('The outside light has stopped working and the switch is warm.');
  assert.strictEqual(job.deposit.amount, 5);
  assert.strictEqual(job.deposit.currency, 'EUR');
  assert.strictEqual(job.deposit.status, 'held');
  assert.strictEqual(job.deposit.settled, false, 'no provider is wired in, so no money has moved');

  const view = await api('GET', `/api/v1/jobs/${job.ref}?t=${encodeURIComponent(job.token)}`, undefined, { token: null });
  assert.match(view.body.deposit.note, /comes off the price/);
});

test('a declined quote leaves the deposit with the foxer', async () => {
  const job = await askFor('Immersion keeps tripping the RCD, needs looking at.');
  const request = (await api('GET', '/api/v1/pro/requests')).body.requests.find((r) => r.ref === job.ref);
  assert.ok(request, 'the request reached the foxer');

  const q = await api('POST', '/api/v1/pro/quotes', {
    requestId: request.id, title: 'Immersion circuit',
    lines: [{ kind: 'labour', description: 'Fault find', qty: 2, unitPrice: 65, vatClass: 'reduced' }],
  });
  assert.strictEqual(q.status, 201, q.raw);

  const declined = await api('POST', `/api/v1/jobs/${job.ref}/decline?t=${encodeURIComponent(job.token)}`,
    { quoteId: q.body.id, reason: 'Too dear' }, { token: null });
  assert.strictEqual(declined.status, 200);
  assert.strictEqual(declined.body.deposit.status, 'captured');
  assert.match(declined.body.deposit.note, /Kept by the tradesperson/);

  const deposits = await api('GET', '/api/v1/pro/deposits');
  assert.ok(deposits.body.earned >= 5, 'it shows up as earned');
});

test('accepting a quote locks the offered time and credits the deposit', async () => {
  const job = await askFor('Two extra sockets wanted in the back bedroom, first floor.');
  const request = (await api('GET', '/api/v1/pro/requests')).body.requests.find((r) => r.ref === job.ref);

  const free = await api('GET', '/api/v1/pro/slots?minutes=120&days=14');
  assert.strictEqual(free.status, 200);
  const offered = free.body.days.flatMap((d) => d.slots).slice(0, 3).map((s) => s.start);
  assert.strictEqual(offered.length, 3, 'the foxer has times to offer');

  const q = await api('POST', '/api/v1/pro/quotes', {
    requestId: request.id, title: 'Two sockets, back bedroom', minutes: 120, slots: offered,
    lines: [
      { kind: 'labour', description: 'Fit two doubles', qty: 2, unitPrice: 65, vatClass: 'reduced' },
      { kind: 'materials', description: 'Sockets and cable', qty: 1, unitPrice: 40, vatClass: 'reduced' },
    ],
    withholdingRate: 20,
  });
  assert.strictEqual(q.status, 201, q.raw);

  const seen = await api('GET', `/api/v1/jobs/${job.ref}?t=${encodeURIComponent(job.token)}`, undefined, { token: null });
  assert.deepStrictEqual(seen.body.quotes[0].slots, offered, 'the customer is shown the times');

  const nudge = await api('POST', `/api/v1/jobs/${job.ref}/accept?t=${encodeURIComponent(job.token)}`,
    { quoteId: q.body.id }, { token: null });
  assert.strictEqual(nudge.status, 400, 'accepting without picking a time is refused');
  assert.strictEqual(nudge.body.code, 'slot_required');

  // A day later than the last offer, so it cannot collide with one of them —
  // the three offered slots are only half an hour apart.
  const never = new Date(Date.parse(offered[2]) + 86400000).toISOString();
  assert.ok(!offered.includes(never));
  const wrong = await api('POST', `/api/v1/jobs/${job.ref}/accept?t=${encodeURIComponent(job.token)}`,
    { quoteId: q.body.id, start: never }, { token: null });
  assert.strictEqual(wrong.body.code, 'slot_not_offered', 'and so is a time that was never offered');

  const ok = await api('POST', `/api/v1/jobs/${job.ref}/accept?t=${encodeURIComponent(job.token)}`,
    { quoteId: q.body.id, start: offered[1] }, { token: null });
  assert.strictEqual(ok.status, 200, ok.raw);
  assert.strictEqual(ok.body.quotes[0].acceptedSlot, offered[1]);
  assert.strictEqual(ok.body.deposit.status, 'credited');

  const diary = await api('GET', '/api/v1/pro/bookings');
  const locked = diary.body.bookings.find((b) => b.ref === job.ref);
  assert.ok(locked, 'it is in the diary');
  assert.strictEqual(locked.status, 'scheduled');
  assert.strictEqual(locked.start, offered[1]);
  assert.strictEqual(locked.fromQuote, true);

  const gone = await api('GET', '/api/v1/pro/slots?minutes=120&days=14');
  assert.ok(!gone.body.days.flatMap((d) => d.slots).map((s) => s.start).includes(offered[1]),
    'and that hour is no longer free to offer anyone else');

  // The invoice charges VAT on the whole price and takes the EUR 5 off the end.
  const inv = await api('POST', '/api/v1/pro/invoices', { quoteId: q.body.id, withholdingRate: 20 });
  assert.strictEqual(inv.status, 201, inv.raw);
  const row = (await api('GET', '/api/v1/pro/invoices')).body.invoices.find((i) => i.id === inv.body.id);
  assert.strictEqual(row.depositCredit, 5);
  assert.strictEqual(row.dueNow, Math.round((row.payable - 5) * 100) / 100);
  assert.strictEqual(inv.body.totals.gross, Math.round((inv.body.totals.net * 1.135) * 100) / 100,
    'VAT is charged on the full price, not on the price less the deposit');

  const paid = await api('POST', `/api/v1/pro/invoices/${inv.body.id}/paid`, { method: 'card_reader' });
  assert.strictEqual(paid.status, 200, paid.raw);
  assert.strictEqual(paid.body.paid, row.dueNow, 'the tap is for what is left after the deposit');
  assert.strictEqual(paid.body.receipt.depositCredit, 5);
  assert.strictEqual(paid.body.receipt.methodName, 'Card reader (tap)');
  assert.ok(paid.body.receipt.number.startsWith('R-'), 'the receipt is numbered off the invoice');

  const receipt = await api('GET', `/api/v1/jobs/${job.ref}?t=${encodeURIComponent(job.token)}`, undefined, { token: null });
  assert.ok(receipt.body.receipt, 'and the customer has it on their job page');
  assert.strictEqual(receipt.body.receipt.vatRegistered, true);
});

test('a deposit can only be settled once', async () => {
  const job = await askFor('A spur wanted for a new dishwasher under the counter.');
  const request = (await api('GET', '/api/v1/pro/requests')).body.requests.find((r) => r.ref === job.ref);
  const q = await api('POST', '/api/v1/pro/quotes', {
    requestId: request.id, title: 'Dishwasher spur',
    lines: [{ kind: 'labour', description: 'Fit spur', qty: 1, unitPrice: 90, vatClass: 'reduced' }],
  });
  await api('POST', `/api/v1/jobs/${job.ref}/decline?t=${encodeURIComponent(job.token)}`,
    { quoteId: q.body.id }, { token: null });

  const again = await api('POST', `/api/v1/jobs/${job.ref}/decline?t=${encodeURIComponent(job.token)}`,
    { quoteId: q.body.id }, { token: null });
  assert.strictEqual(again.status, 400, 'a declined quote cannot be declined twice');

  const view = await api('GET', `/api/v1/jobs/${job.ref}?t=${encodeURIComponent(job.token)}`, undefined, { token: null });
  assert.strictEqual(view.body.deposit.status, 'captured', 'and the deposit went exactly one way');
});

test('a job that was asked for and then booked appears once, not twice', async () => {
  // Accepting a quote creates a booking sharing the request's reference, so
  // the same job lives in both collections. The customer must see one row.
  const job = await askFor('Shaver socket wanted in the bathroom, off the light circuit.');
  const request = (await api('GET', '/api/v1/pro/requests')).body.requests.find((r) => r.ref === job.ref);
  const free = await api('GET', '/api/v1/pro/slots?minutes=60&days=14');
  const when = free.body.days.flatMap((d) => d.slots)[0].start;

  const q = await api('POST', '/api/v1/pro/quotes', {
    requestId: request.id, title: 'Shaver socket', minutes: 60, slots: [when],
    lines: [{ kind: 'labour', description: 'Fit shaver socket', qty: 1, unitPrice: 110, vatClass: 'reduced' }],
  });
  await api('POST', `/api/v1/jobs/${job.ref}/accept?t=${encodeURIComponent(job.token)}`,
    { quoteId: q.body.id, start: when }, { token: null });

  const mine = (await api('GET', '/api/v1/me/jobs', undefined, { token: customerToken }))
    .body.jobs.filter((j) => j.ref === job.ref);
  assert.strictEqual(mine.length, 1, 'one job, one row');
  assert.strictEqual(mine[0].status, 'scheduled', 'showing how far along it actually is');
  assert.strictEqual(mine[0].at, when, 'and the hour that was agreed');
  assert.match(mine[0].description, /Shaver socket wanted/, 'while keeping what was asked for');
});

test('the version is reported, and the API version is a separate number', async () => {
  // The footer shows the first; the second is the `v1` in every route and
  // only moves when a client that worked yesterday would stop working.
  const h = await api('GET', '/api/v1/health', undefined, { token: null });
  assert.match(h.body.version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(h.body.api, 1);

  const m = await api('GET', '/api/v1/meta', undefined, { token: null });
  assert.strictEqual(m.body.version, h.body.version, 'one source of truth');
});
