/*
 * The foxer's side: everything a tradesperson sees after signing in.
 *
 * The customer half of Foxers is a marketplace. This half is the job book —
 * what came in, what was agreed, what was done, and what is still owed. The
 * ordering of the console reflects the order of a working day: requests to
 * answer, quotes waiting on a yes, the diary, then the money.
 */

import { api, meta, session, login as doLogin, signup as doSignup, whoami } from './api.js';
import {
  el, frag, clear, money as fmtMoney, dateTime, dateOnly, relative,
  notice, loading, empty, field, input, select, values, statusChip,
  copyButton, whatsappLink, totalsBlock,
} from './ui.js';

const region = () => session.pro?.region || 'IE';
const cash = (n) => fmtMoney(n, region());

/* Every console screen leads with the same question: what needs doing. */
function heading(title, sub, action) {
  return el('div', { class: 'row between', style: 'margin-bottom:1rem' },
    el('div', {},
      el('h1', { style: 'margin:0' }, title),
      sub ? el('small', {}, sub) : null),
    action || null);
}

function busy(btn, label) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  return () => { btn.disabled = false; btn.textContent = original; };
}

/* Errors go where the eye already is: above the thing that failed. */
function fail(mount, err) {
  const n = notice('err', err.message || 'That did not work.');
  mount.prepend(n);
  n.scrollIntoView({ block: 'nearest' });
}

/* ---- sign in / sign up ----------------------------------------------- */

export async function login(mount, ctx) {
  const next = ctx.query.get('next') || '/dash';
  const form = el('form', { class: 'card', style: 'max-width:420px' });
  const emailIn = input({ name: 'email', type: 'email', autocomplete: 'username', required: true });
  const passIn = input({ name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const btn = el('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');

  form.append(
    field('Email', emailIn),
    field('Password', passIn),
    el('div', { style: 'margin-top:1rem' }, btn));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const done = busy(btn, 'Signing in…');
    try {
      await doLogin(emailIn.value.trim(), passIn.value);
      ctx.navigate(next, { replace: true });
    } catch (err) {
      done();
      fail(form, err);
    }
  });

  clear(mount).append(
    heading('Sign in', 'For tradespeople. Customers never need an account.'),
    form,
    el('p', { class: 'muted', style: 'margin-top:1rem' },
      'No account yet? ', el('a', { href: '/signup' }, 'List your business'), '.'),
    demoHint(emailIn, passIn));
}

/*
 * On a seeded local copy the demo logins are the whole point, and hunting
 * them out of the seed script to look at the app is friction with no payoff.
 * Gated on the hostname so it can never appear on a deployed instance.
 */
function demoHint(emailIn, passIn) {
  if (!['localhost', '127.0.0.1', '::1'].includes(location.hostname)) return null;
  const use = (email) => {
    emailIn.value = email;
    passIn.value = 'foxers-demo-2026';
    passIn.form.requestSubmit();
  };
  return el('div', { class: 'card', style: 'margin-top:1.5rem;max-width:420px' },
    el('h3', {}, 'Demo logins'),
    el('small', { class: 'muted' }, 'Local copy only. Password foxers-demo-2026.'),
    el('div', { class: 'stack', style: 'margin-top:.7rem' },
      [['byrne.electrical@example.com', 'Byrne Electrical — the busy one'],
       ['nowak.plumbing.heating@example.com', 'Nowak Plumbing & Heating'],
       ['mcallister.electrical.ni@example.com', 'McAllister Electrical NI — UK / CIS']]
        .map(([email, label]) => el('button', {
          class: 'btn sm block', type: 'button', onclick: () => use(email),
        }, label))));
}

export async function signup(mount, ctx) {
  const m = await meta();
  const form = el('form', { class: 'card', style: 'max-width:560px' });

  const tradeBoxes = m.trades.map((t) => {
    const box = input({ type: 'checkbox', id: `trade-${t.key}`, value: t.key });
    return { key: t.key, box, node: el('div', { class: 'check' }, box, el('label', { for: `trade-${t.key}` }, `${t.icon} ${t.name}`)) };
  });
  const areaBoxes = m.areas.map((a) => {
    const box = input({ type: 'checkbox', id: `area-${a.key}`, value: a.key });
    return { key: a.key, region: a.region, box, node: el('div', { class: 'check' }, box, el('label', { for: `area-${a.key}` }, a.name)) };
  });

  const btn = el('button', { class: 'btn primary block', type: 'submit' }, 'Create my page');

  form.append(
    el('div', { class: 'inline-fields' },
      field('Your name', input({ name: 'name', required: true, autocomplete: 'name' })),
      field('Business name', input({ name: 'business', autocomplete: 'organization' }, ), 'Leave blank to trade under your own name')),
    el('div', { class: 'inline-fields' },
      field('Email', input({ name: 'email', type: 'email', required: true, autocomplete: 'email' })),
      field('Phone', input({ name: 'phone', autocomplete: 'tel' }))),
    field('Password', input({ name: 'password', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }), 'At least 10 characters'),
    field('Where you work', select({ name: 'region' }, [
      { value: 'IE', label: 'Republic of Ireland — VAT and RCT' },
      { value: 'UK', label: 'Northern Ireland / UK — VAT and CIS' },
    ], 'IE')),

    el('hr', { class: 'hr' }),
    el('h3', {}, 'Your trades'),
    el('div', { class: 'grid three' }, tradeBoxes.map((t) => t.node)),

    el('hr', { class: 'hr' }),
    el('h3', {}, 'Counties you cover'),
    el('div', { class: 'grid three' }, areaBoxes.map((a) => a.node)),

    field('About the business', el('textarea', { name: 'bio', placeholder: 'Registrations, how long you have been at it, what you will and will not take on.' })),
    el('div', { style: 'margin-top:1rem' }, btn));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = values(form);
    const payload = {
      ...v,
      business: v.business || v.name,
      trades: tradeBoxes.filter((t) => t.box.checked).map((t) => t.key),
      areas: areaBoxes.filter((a) => a.box.checked).map((a) => a.key),
    };
    if (!payload.trades.length) return fail(form, new Error('Pick at least one trade.'));
    if (!payload.areas.length) return fail(form, new Error('Pick at least one county.'));
    const done = busy(btn, 'Creating…');
    try {
      await doSignup(payload);
      ctx.navigate('/dash/services', { replace: true });
    } catch (err) {
      done();
      fail(form, err);
    }
  });

  clear(mount).append(
    heading('List your business',
      'Free to list. Customers see your real availability and book the fixed-price work outright.'),
    form);
}

/* ---- today ------------------------------------------------------------ */

/* Trades start early and this screen is read at 7am as often as at 2pm. */
function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Morning';
  if (h < 18) return 'Afternoon';
  return 'Evening';
}

export async function dashboard(mount, ctx) {
  clear(mount).append(loading('Opening the job book'));
  const d = await api.get('/api/v1/pro/dashboard');

  const stat = (k, v, tone) => el('div', { class: `stat ${tone || ''}` },
    el('div', { class: 'k' }, k), el('div', { class: 'v' }, v));

  clear(mount).append(frag(
    heading(`${greeting()}, ${d.pro.name.split(' ')[0]}`, d.pro.business),

    el('div', { class: 'grid three' },
      stat('Owed to you', cash(d.money.owed)),
      stat('Overdue', cash(d.money.overdue), d.money.overdue > 0 ? 'bad' : ''),
      stat('Paid, last 30 days', cash(d.money.paid30), 'good'),
      stat('Withheld at source', cash(d.money.withheld)),
      stat('Deposits earned', cash(d.money.depositsEarned || 0),
        d.money.depositsEarned ? 'good' : '')),

    el('div', { class: 'grid two', style: 'margin-top:1rem' },
      actionCard('New requests', d.counts.openRequests,
        'Customers waiting on a price from you.', '/dash/requests', 'Answer them'),
      actionCard('Quotes out', d.counts.awaitingAcceptance,
        'Sent, not yet accepted or declined.', '/dash/quotes', 'Review')),

    d.chases.length ? frag(
      el('h2', { style: 'margin-top:1.6rem' }, 'Chase these'),
      el('div', { class: 'stack' }, d.chases.map(chaseCard))) : null,

    el('h2', { style: 'margin-top:1.6rem' }, 'Next out the door'),
    d.upcoming.length
      ? el('div', { class: 'stack' }, d.upcoming.map((b) => bookingCard(b, null)))
      : empty('Nothing booked yet.',
          el('a', { class: 'btn', href: '/dash/hours' }, 'Check your hours are right')),
  ));
}

function actionCard(title, count, sub, href, cta) {
  return el('div', { class: 'card' },
    el('div', { class: 'row between' },
      el('h3', { style: 'margin:0' }, title),
      el('span', { class: `chip ${count ? 'amber' : ''}` }, String(count))),
    el('p', { class: 'muted', style: 'margin:.5rem 0 .8rem' }, sub),
    el('a', { class: `btn ${count ? 'primary' : ''} sm`, href }, cta));
}

/*
 * A chase is a message, not a status change. The app writes the words and
 * hands them to WhatsApp; sending it stays the pro's decision, because the
 * customer is often someone they will meet again.
 */
function chaseCard(c, onSent) {
  const send = el('a', {
    class: 'btn primary sm', target: '_blank', rel: 'noopener',
    href: whatsappLink(c.customer?.phone || '', c.text),
  }, 'Send on WhatsApp');
  const mark = el('button', { class: 'btn sm ghost' }, 'Mark as sent');
  mark.addEventListener('click', async () => {
    const done = busy(mark, 'Saving…');
    try {
      await api.post(`/api/v1/pro/chases/${encodeURIComponent(c.invoiceId)}`, { key: c.key, channel: 'whatsapp' });
      mark.replaceWith(el('span', { class: 'chip good' }, 'logged'));
      if (onSent) onSent();
    } catch (err) { done(); }
  });

  return el('div', { class: 'card' },
    el('div', { class: 'row between' },
      el('div', {},
        el('h3', { style: 'margin:0' }, 'Invoice ', el('span', { class: 'mono' }, c.number)),
        el('small', {}, c.days > 0 ? `${c.days} days past due` : 'Due now')),
      el('span', { class: 'chip amber' }, c.key)),
    el('p', { style: 'margin:.6rem 0;white-space:pre-wrap' }, c.text),
    el('div', { class: 'row' }, send, mark, copyButton(c.text, 'Copy the wording')));
}

/* ---- requests --------------------------------------------------------- */

export async function requests(mount, ctx) {
  clear(mount).append(loading('Fetching requests'));
  const d = await api.get('/api/v1/pro/requests');

  if (!d.requests.length) {
    return clear(mount).append(
      heading('Requests', 'Jobs customers have described, waiting on a price.'),
      empty('Nothing waiting. Requests matching your trades and counties land here.',
        el('a', { class: 'btn', href: '/dash/profile' }, 'Widen your trades or counties')));
  }

  clear(mount).append(frag(
    heading('Requests', `${d.count} waiting on you. Emergencies first.`),
    el('div', { class: 'stack' }, d.requests.map((r) => el('div', { class: 'card' },
      el('div', { class: 'row between' },
        el('div', {},
          el('h3', { style: 'margin:0' }, r.tradeName),
          el('small', {}, `${r.customer?.name || 'Customer'} · ${relative(r.at)}`)),
        el('div', { class: 'row' },
          r.direct ? el('span', { class: 'chip good' }, 'asked for you') : null,
          el('span', { class: `chip ${r.urgency === 'emergency' ? 'bad' : 'amber'}` }, r.urgency))),

      el('p', { style: 'margin:.6rem 0' }, r.description),
      r.address ? el('div', { class: 'row' }, el('span', { class: 'chip' }, r.address)) : null,

      el('div', { class: 'row', style: 'margin-top:.8rem' },
        el('a', { class: 'btn primary sm', href: `/dash/quote?requestId=${encodeURIComponent(r.id)}` }, 'Price this job'),
        r.customer?.phone
          ? el('a', {
              class: 'btn sm', target: '_blank', rel: 'noopener',
              href: whatsappLink(r.customer.phone, `Hi ${r.customer.name.split(' ')[0]}, ${session.pro.business} here about your ${r.tradeName.toLowerCase()} job. `),
            }, 'Ask a question first')
          : null))),
    )));
}

/* ---- the quote builder ------------------------------------------------ */

const BLANK_LINE = () => ({ kind: 'labour', description: '', qty: 1, unitPrice: 0, vatClass: 'reduced' });

/*
 * The builder prices on the server on every change rather than doing the
 * arithmetic here. VAT, RCT and CIS have to come out the same on the quote,
 * the invoice and the customer's copy, and there is exactly one implementation
 * of that — in server/lib/tax.js. A second one in the browser would drift.
 */
export async function quoteBuilder(mount, ctx) {
  clear(mount).append(loading());
  const m = await meta();
  const requestId = ctx.query.get('requestId');

  let request = null;
  if (requestId) {
    const d = await api.get('/api/v1/pro/requests');
    request = d.requests.find((r) => r.id === requestId) || null;
  }

  const vatOptions = m.vat[region()].map((v) => ({ value: v.key, label: v.label }));
  const rateOptions = m.withholding[region()].rates.map((r) => ({ value: String(r), label: r ? `${m.withholding[region()].scheme} ${r}%` : 'No deduction' }));

  let lines = [BLANK_LINE()];
  const linesWrap = el('div', { class: 'stack' });
  const totalsWrap = el('div', {});

  const titleIn = input({ name: 'title', required: true, value: request ? `${request.tradeName} — ${request.description.slice(0, 60)}` : '' });
  const minutesIn = input({ name: 'minutes', type: 'number', value: 120, min: 15, step: 15 });
  const rateSel = select({ name: 'withholdingRate' }, rateOptions, String(session.private?.withholdingRate ?? 0));
  const rcBox = input({ type: 'checkbox', id: 'rc' });
  const validIn = input({ name: 'validDays', type: 'number', value: 30, min: 1, max: 180 });
  const notesIn = el('textarea', { name: 'notes', placeholder: 'What the price assumes, and what would count as a variation.' });
  const termsIn = el('textarea', { name: 'terms', placeholder: 'Payment terms, retention of title.' });

  /*
   * The times being offered. Accepting one is what puts the job in the diary,
   * so these have to be real free slots for the length of work quoted — which
   * means re-fetching them whenever that length changes.
   */
  let chosen = [];
  const slotsWrap = el('div', {});

  async function loadSlots() {
    const minutes = Number(minutesIn.value) || 120;
    clear(slotsWrap).append(loading('Reading your diary'));
    let free;
    try {
      free = await api.get(`/api/v1/pro/slots?minutes=${minutes}&days=21`);
    } catch (err) {
      return clear(slotsWrap).append(notice('err', err.message));
    }
    chosen = chosen.filter((iso) => free.days.some((d) => d.slots.some((sl) => sl.start === iso)));
    drawSlots(free);
  }

  function drawSlots(free) {
    clear(slotsWrap);
    if (!free.days.length) {
      return slotsWrap.append(notice('info',
        'Nothing free for that length of job in the next three weeks. Send the quote without times and agree a date after.'));
    }
    const strip = el('div', { class: 'daystrip' });
    const grid = el('div', { class: 'slots' });
    let day = 0;

    const paint = () => {
      clear(strip);
      free.days.forEach((d, i) => {
        strip.append(el('button', {
          class: `daybtn${i === day ? ' on' : ''}`, type: 'button',
          onclick: () => { day = i; paint(); },
        }, d.label));
      });
      clear(grid);
      for (const sl of free.days[day].slots) {
        const on = chosen.includes(sl.start);
        const btn = el('button', { class: `slot${on ? ' on' : ''}`, type: 'button' },
          new Intl.DateTimeFormat('en-IE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
            .format(new Date(sl.start)));
        btn.addEventListener('click', () => {
          if (on) chosen = chosen.filter((x) => x !== sl.start);
          else if (chosen.length < 3) chosen = [...chosen, sl.start].sort();
          paint();
        });
        grid.append(btn);
      }
      count.textContent = chosen.length
        ? `${chosen.length} of 3 offered: ${chosen.map((c) => dateTime(c)).join(' · ')}`
        : 'Pick up to three. The customer books whichever suits them.';
    };

    const count = el('small', { class: 'muted' });
    slotsWrap.append(strip, grid, el('div', { style: 'margin-top:.5rem' }, count));
    paint();
  }

  minutesIn.addEventListener('change', loadSlots);

  let priceTimer = null;
  const repriceSoon = () => {
    clearTimeout(priceTimer);
    priceTimer = setTimeout(reprice, 250);
  };

  async function reprice() {
    const usable = lines.filter((l) => l.description.trim() || l.unitPrice);
    if (!usable.length) return clear(totalsWrap).append(el('p', { class: 'muted' }, 'Add a line to see the total.'));
    try {
      const t = await api.post('/api/v1/pro/price', {
        lines: usable,
        reverseCharge: rcBox.checked,
        withholdingRate: Number(rateSel.value),
      });
      clear(totalsWrap).append(totalsBlock(t, region()));
    } catch (err) {
      clear(totalsWrap).append(notice('err', err.message));
    }
  }

  function drawLines() {
    clear(linesWrap);
    lines.forEach((line, i) => {
      const kindSel = select({}, [{ value: 'labour', label: 'Labour' }, { value: 'materials', label: 'Materials' }], line.kind);
      const descIn = input({ value: line.description, placeholder: 'What it is' });
      const qtyIn = input({ type: 'number', step: '0.25', min: '0', value: line.qty });
      const priceIn = input({ type: 'number', step: '0.01', min: '0', value: line.unitPrice });
      const vatSel = select({}, vatOptions, line.vatClass);

      const bind = (node, key, cast) => node.addEventListener('input', () => {
        line[key] = cast ? cast(node.value) : node.value;
        repriceSoon();
      });
      bind(kindSel, 'kind'); bind(descIn, 'description');
      bind(qtyIn, 'qty', Number); bind(priceIn, 'unitPrice', Number); bind(vatSel, 'vatClass');
      kindSel.addEventListener('change', () => { line.kind = kindSel.value; repriceSoon(); });
      vatSel.addEventListener('change', () => { line.vatClass = vatSel.value; repriceSoon(); });

      const del = el('button', { class: 'btn sm ghost danger', type: 'button', title: 'Remove this line' }, '✕');
      del.addEventListener('click', () => {
        lines.splice(i, 1);
        if (!lines.length) lines.push(BLANK_LINE());
        drawLines(); reprice();
      });

      linesWrap.append(el('div', { class: 'card' },
        el('div', { class: 'inline-fields' },
          field('Kind', kindSel),
          field('Description', descIn),
          field('Qty / hours', qtyIn),
          field('Unit price', priceIn),
          field('VAT', vatSel)),
        el('div', { class: 'row', style: 'margin-top:.5rem' }, el('span', { class: 'spacer' }), del)));
    });
  }

  const addBtn = el('button', { class: 'btn sm', type: 'button' }, '+ Add a line');
  addBtn.addEventListener('click', () => { lines.push(BLANK_LINE()); drawLines(); });

  const sendBtn = el('button', { class: 'btn primary', type: 'submit' }, 'Send this quote');
  const form = el('form', {});

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const usable = lines.filter((l) => l.description.trim());
    if (!usable.length) return fail(form, new Error('A quote needs at least one described line.'));
    const done = busy(sendBtn, 'Sending…');
    try {
      const r = await api.post('/api/v1/pro/quotes', {
        requestId: requestId || undefined,
        title: titleIn.value,
        minutes: Number(minutesIn.value) || 120,
        slots: chosen,
        lines: usable,
        withholdingRate: Number(rateSel.value),
        reverseCharge: rcBox.checked,
        validDays: Number(validIn.value) || 30,
        notes: notesIn.value,
        terms: termsIn.value,
      });
      sent(r);
    } catch (err) {
      done();
      fail(form, err);
    }
  });

  /* The link is the deliverable. Nothing is emailed, so it has to be handed
   * over deliberately — and it must be easy to hand over on the phone. */
  function sent(r) {
    const url = `${location.origin}${r.customerLink}`;
    const when = chosen.length
      ? ` Times offered: ${chosen.map((c) => dateTime(c)).join(', ')}.`
      : '';
    const text = `Quote from ${session.pro.business} for ${titleIn.value} — ${cash(r.totals.payable)}.${when} Accept or ask a question here: ${url}`;
    clear(mount).append(
      notice('ok', `Quote sent. Reference ${r.ref}.`),
      el('div', { class: 'card' },
        el('h3', {}, 'Give the customer this link'),
        el('p', { class: 'muted' }, 'It is the only way into the job, and accepting it is timestamped.'),
        el('div', { class: 'mono', style: 'word-break:break-all;margin-bottom:.8rem' }, url),
        el('div', { class: 'row' },
          request?.customer?.phone
            ? el('a', { class: 'btn primary', target: '_blank', rel: 'noopener', href: whatsappLink(request.customer.phone, text) }, 'Send on WhatsApp')
            : null,
          copyButton(url),
          el('a', { class: 'btn ghost', href: '/dash/quotes' }, 'All quotes'))),
      el('div', { class: 'card' }, totalsBlock(r.totals, region())));
  }

  form.append(
    request ? el('div', { class: 'card' },
      el('div', { class: 'row between' },
        el('h3', { style: 'margin:0' }, request.customer?.name || 'Customer'),
        el('span', { class: 'chip amber' }, request.urgency)),
      el('p', { class: 'muted', style: 'margin:.5rem 0 0' }, request.description),
      request.address ? el('small', {}, request.address) : null) : null,

    field('What is this quote for', titleIn),

    el('h2', { style: 'margin-top:1.4rem' }, 'When you could do it'),
    el('p', { class: 'muted', style: 'margin:.2rem 0 .8rem' },
      'Accepting the quote books one of these outright, so only offer hours you would actually take.'),
    el('div', { class: 'card' },
      el('div', { class: 'inline-fields' },
        field('How long on site', minutesIn, 'Minutes. Changes which slots are long enough.')),
      slotsWrap),

    el('h2', { style: 'margin-top:1.4rem' }, 'The price'),
    linesWrap,
    el('div', { class: 'row', style: 'margin:.6rem 0 1.2rem' }, addBtn),

    el('div', { class: 'inline-fields' },
      field('Deduction at source', rateSel, 'Set by the principal contractor, not by you'),
      field('Quote valid for (days)', validIn)),
    el('div', { class: 'check', style: 'margin-top:.7rem' }, rcBox,
      el('label', { for: 'rc' }, 'VAT reverse charge — the customer accounts for the VAT')),

    el('hr', { class: 'hr' }),
    field('Notes for the customer', notesIn),
    field('Terms', termsIn),

    el('hr', { class: 'hr' }),
    totalsWrap,
    el('div', { class: 'row', style: 'margin-top:1rem' }, sendBtn,
      el('a', { class: 'btn ghost', href: '/dash/requests' }, 'Cancel')));

  rcBox.addEventListener('change', reprice);
  rateSel.addEventListener('change', reprice);

  clear(mount).append(
    heading(request ? 'Quote this job' : 'New quote',
      'Priced on the server, so the customer sees the same arithmetic you do.'),
    form);
  drawLines();
  reprice();
  loadSlots();
}

/* ---- quotes ----------------------------------------------------------- */

export async function quotes(mount, ctx) {
  clear(mount).append(loading());
  const d = await api.get('/api/v1/pro/quotes');

  const render = (rows) => clear(mount).append(frag(
    heading('Quotes', `${rows.length} sent. An accepted quote is what an invoice is built from.`,
      el('a', { class: 'btn sm', href: '/dash/quote' }, 'New quote')),
    rows.length ? el('div', { class: 'stack' }, rows.map(quoteRow))
      : empty('No quotes yet. They start life as a request.',
          el('a', { class: 'btn', href: '/dash/requests' }, 'See requests'))));

  function quoteRow(q) {
    const card = el('div', { class: 'card' });
    const invoiceBtn = el('button', { class: 'btn primary sm' }, 'Raise the invoice');
    invoiceBtn.addEventListener('click', async () => {
      const done = busy(invoiceBtn, 'Raising…');
      try {
        const inv = await api.post('/api/v1/pro/invoices', {
          quoteId: q.id,
          withholdingRate: session.private?.withholdingRate ?? 0,
          dueDays: 14,
        });
        card.append(notice('ok', `Invoice ${inv.number} raised — ${cash(inv.totals.payable)} payable.`));
        invoiceBtn.replaceWith(el('a', { class: 'btn sm', href: '/dash/money' }, 'See it in Money'));
      } catch (err) { done(); fail(card, err); }
    });

    card.append(
      el('div', { class: 'row between' },
        el('div', {},
          el('h3', { style: 'margin:0' }, q.title),
          el('small', {}, `${q.customer?.name || 'Customer'} · sent ${relative(q.sentAt)} · ref `,
            el('span', { class: 'mono' }, q.ref))),
        statusChip(q.status)),
      el('div', { class: 'row between', style: 'margin-top:.7rem' },
        el('div', { class: 'row' },
          el('span', { class: 'chip' }, `Total ${cash(q.gross)}`),
          q.payable !== q.gross ? el('span', { class: 'chip amber' }, `You get ${cash(q.payable)}`) : null,
          q.acceptedAt ? el('span', { class: 'chip good' }, `Accepted ${dateOnly(q.acceptedAt)}`)
            : el('small', { class: 'muted' }, `Valid until ${dateOnly(q.validUntil)}`)),
        q.status === 'accepted' ? invoiceBtn : null));
    return card;
  }

  render(d.quotes);
}

/* ---- the diary -------------------------------------------------------- */

export async function calendar(mount, ctx) {
  clear(mount).append(loading('Opening the diary'));
  const d = await api.get('/api/v1/pro/bookings');

  const now = Date.now();
  const upcoming = d.bookings.filter((b) => Date.parse(b.end) >= now && b.status !== 'cancelled');
  const past = d.bookings.filter((b) => Date.parse(b.end) < now || b.status === 'cancelled').reverse();

  const reload = () => calendar(mount, ctx);

  clear(mount).append(frag(
    heading('Diary', 'Booked work. Marking a job done is what lets you invoice it.'),
    el('h2', {}, 'Coming up'),
    upcoming.length ? el('div', { class: 'stack' }, upcoming.map((b) => bookingCard(b, reload)))
      : empty('Nothing booked. Customers can only book the services you have priced.',
          el('a', { class: 'btn', href: '/dash/services' }, 'Check your services')),
    past.length ? frag(
      el('h2', { style: 'margin-top:1.6rem' }, 'Done and gone'),
      el('div', { class: 'stack' }, past.slice(0, 20).map((b) => bookingCard(b, reload)))) : null));
}

function bookingCard(b, reload) {
  const card = el('div', { class: 'card' });

  const setStatus = async (status, btn) => {
    const done = busy(btn, '…');
    try {
      await api.patch(`/api/v1/pro/bookings/${encodeURIComponent(b.id)}`, { status });
      if (reload) reload(); else { done(); btn.replaceWith(statusChip(status)); }
    } catch (err) { done(); fail(card, err); }
  };

  const actions = el('div', { class: 'row' });
  if (b.status === 'confirmed') {
    const btn = el('button', { class: 'btn sm' }, 'Put in the van');
    btn.addEventListener('click', () => setStatus('scheduled', btn));
    actions.append(btn);
  }
  if (['confirmed', 'scheduled'].includes(b.status)) {
    const btn = el('button', { class: 'btn primary sm' }, 'Mark done');
    btn.addEventListener('click', () => setStatus('done', btn));
    actions.append(btn);
  }
  if (b.customer?.phone) {
    actions.append(el('a', {
      class: 'btn sm ghost', target: '_blank', rel: 'noopener',
      href: whatsappLink(b.customer.phone, `Hi ${b.customer.name.split(' ')[0]}, ${session.pro.business} here — confirming ${dateTime(b.start)} for the ${b.service.toLowerCase()}.`),
    }, 'Message'));
  }

  card.append(
    el('div', { class: 'row between' },
      el('div', {},
        el('h3', { style: 'margin:0' }, b.service),
        el('small', {}, `${dateTime(b.start)} · ${b.customer?.name || 'Customer'}`)),
      statusChip(b.status)),
    b.address ? el('div', { class: 'row', style: 'margin-top:.5rem' }, el('span', { class: 'chip' }, b.address)) : null,
    b.notes ? el('p', { class: 'muted', style: 'margin:.5rem 0 0' }, b.notes) : null,
    el('div', { class: 'row between', style: 'margin-top:.8rem' },
      el('span', { class: 'chip' }, cash(b.price)), actions));
  return card;
}

/* ---- money ------------------------------------------------------------ */

export async function money(mount, ctx) {
  clear(mount).append(loading('Counting'));
  const [inv, ch, dep, m] = await Promise.all([
    api.get('/api/v1/pro/invoices'),
    api.get('/api/v1/pro/chases'),
    api.get('/api/v1/pro/deposits'),
    meta(),
  ]);

  const reload = () => money(mount, ctx);
  const outstanding = inv.invoices.filter((i) => i.status === 'issued');
  const paid = inv.invoices.filter((i) => i.status === 'paid');

  clear(mount).append(frag(
    heading('Money', 'What is owed, what was withheld, and what to say about it.'),

    el('div', { class: 'grid three' },
      el('div', { class: 'stat' },
        el('div', { class: 'k' }, 'Deposits earned'),
        el('div', { class: 'v' }, cash(dep.earned)),
        el('small', {}, 'quotes that were turned down')),
      el('div', { class: 'stat' },
        el('div', { class: 'k' }, 'Deposits credited'),
        el('div', { class: 'v' }, cash(dep.credited)),
        el('small', {}, 'came off jobs that went ahead'))),


    ch.chases.length ? frag(
      el('h2', {}, 'Chase these'),
      el('div', { class: 'stack', style: 'margin-bottom:1.6rem' }, ch.chases.map((c) => chaseCard(c, reload)))) : null,

    el('h2', {}, 'Outstanding'),
    outstanding.length ? invoiceTable(outstanding, reload, m.paymentMethods || [])
      : empty('Nothing outstanding. Every invoice you have raised is paid.'),

    paid.length ? frag(
      el('h2', { style: 'margin-top:1.6rem' }, 'Paid'),
      invoiceTable(paid, reload, m.paymentMethods || [])) : null));
}

/*
 * The receipt exists the moment the money is taken, and the customer wants it
 * before the van moves. This puts the link in front of the foxer to send on.
 */
function receiptNotice(r) {
  const url = `${location.origin}${r.customerLink}`;
  return el('div', { class: 'notice ok' },
    el('strong', {}, `${r.receipt.number} — ${r.receipt.methodName}. `),
    r.settled ? 'Payment taken. ' : 'Recorded. No card was charged: no payment provider is connected. ',
    el('div', { class: 'row', style: 'margin-top:.5rem' },
      copyButton(url, 'Copy the receipt link'),
      el('a', { class: 'btn sm', href: r.customerLink }, 'Open it')));
}

function invoiceTable(rows, reload, methods = []) {
  const wrap = el('div', { class: 'table-wrap' });
  wrap.append(el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, 'Invoice'), el('th', {}, 'Customer'), el('th', {}, 'Due'),
      el('th', { class: 'right' }, 'Total'), el('th', { class: 'right' }, 'Withheld'),
      el('th', { class: 'right' }, 'To collect'), el('th', {}, ''))),
    el('tbody', {}, rows.map((i) => {
      /*
       * How the money came in is not a detail — it is what the receipt says
       * and what reconciles against the bank later. So the method is picked
       * here rather than assumed, with the card reader first because that is
       * what happens at the door.
       */
      const methodSel = select({ 'aria-label': 'How it was paid' },
        methods.map((mm) => ({ value: mm.key, label: mm.name })), 'card_reader');
      const payBtn = el('button', { class: 'btn sm primary' }, 'Take payment');
      payBtn.addEventListener('click', async () => {
        busy(payBtn, 'Taking…');
        try {
          const r = await api.post(`/api/v1/pro/invoices/${encodeURIComponent(i.id)}/paid`,
            { method: methodSel.value });
          wrap.prepend(receiptNotice(r));
          reload();
        } catch (err) { fail(wrap, err); }
      });
      return el('tr', {},
        el('td', {}, el('span', { class: 'mono' }, i.number),
          i.chases ? el('div', {}, el('small', {}, `${i.chases} chase(s) sent`)) : null),
        el('td', {}, i.customer?.name || '—'),
        el('td', {},
          dateOnly(i.dueAt),
          i.overdueDays ? el('div', {}, el('span', { class: 'chip bad' }, `${i.overdueDays}d late`)) : null),
        el('td', { class: 'right mono' }, cash(i.gross)),
        el('td', { class: 'right mono' }, i.withheld ? `− ${cash(i.withheld)}` : '—'),
        el('td', { class: 'right mono' },
          cash(i.dueNow ?? i.payable),
          i.depositCredit ? el('div', {}, el('small', {}, `after ${cash(i.depositCredit)} deposit`)) : null),
        el('td', { class: 'right' }, i.status === 'issued'
          ? el('div', { class: 'row', style: 'justify-content:flex-end' }, methodSel, payBtn)
          : statusChip('paid')));
    }))));
  return wrap;
}

/* ---- services --------------------------------------------------------- */

export async function services(mount, ctx) {
  clear(mount).append(loading());
  const m = await meta();
  const d = await api.get('/api/v1/pro/services');
  const reload = () => services(mount, ctx);
  const vatOptions = m.vat[region()].map((v) => ({ value: v.key, label: v.label }));

  const live = d.services.filter((s) => s.active);

  /*
   * The split that makes the product: a service with a fixed price and a
   * known duration can be booked outright, everything else can only be
   * asked about. The form enforces it rather than explaining it.
   */
  const addForm = el('form', { class: 'card' });
  const nameIn = input({ name: 'name', required: true, placeholder: 'e.g. Annual boiler service' });
  const minsIn = input({ name: 'minutes', type: 'number', value: 60, min: 15, step: 15 });
  const priceIn = input({ name: 'price', type: 'number', value: 0, min: 0, step: '0.01' });
  const vatSel = select({ name: 'vatClass' }, vatOptions, 'reduced');
  const bookBox = input({ type: 'checkbox', id: 'bookable', checked: true });
  const addBtn = el('button', { class: 'btn primary', type: 'submit' }, 'Add this service');

  addForm.append(
    el('h3', {}, 'Add a service'),
    field('Name', nameIn),
    el('div', { class: 'inline-fields' },
      field('How long', minsIn, 'Minutes on site, including tidy-up'),
      field('Fixed price', priceIn, 'Before VAT'),
      field('VAT', vatSel)),
    el('div', { class: 'check', style: 'margin-top:.7rem' }, bookBox,
      el('label', { for: 'bookable' }, 'Customers can book this outright')),
    el('div', { style: 'margin-top:1rem' }, addBtn));

  addForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const done = busy(addBtn, 'Adding…');
    try {
      await api.post('/api/v1/pro/services', {
        name: nameIn.value, minutes: Number(minsIn.value),
        price: Number(priceIn.value), vatClass: vatSel.value, bookable: bookBox.checked,
      });
      reload();
    } catch (err) { done(); fail(addForm, err); }
  });

  /* Suggestions from the trade taxonomy — one tap beats typing on a phone. */
  const suggestions = [];
  for (const t of d.templates || []) {
    for (const b of t.bookable) {
      if (live.some((s) => s.name.toLowerCase() === b.name.toLowerCase())) continue;
      const btn = el('button', { class: 'btn sm', type: 'button' },
        `${b.name} · ${b.minutes}m`);
      btn.addEventListener('click', () => {
        nameIn.value = b.name;
        minsIn.value = b.minutes;
        bookBox.checked = true;
        priceIn.focus();
      });
      suggestions.push(btn);
    }
  }

  clear(mount).append(frag(
    heading('Services', 'Priced work is bookable. Everything else routes to a quote.'),

    live.length ? el('div', { class: 'stack' }, live.map((s) => serviceCard(s, vatOptions, reload)))
      : empty('No services yet. Add one below and you become bookable.'),

    suggestions.length ? frag(
      el('h2', { style: 'margin-top:1.6rem' }, 'Common in your trades'),
      el('p', { class: 'muted' }, 'Tap one to fill the form, then set your own price.'),
      el('div', { class: 'row' }, suggestions.slice(0, 12))) : null,

    el('h2', { style: 'margin-top:1.6rem' }, 'Add'),
    addForm));
}

function serviceCard(s, vatOptions, reload) {
  const card = el('div', { class: 'card' });
  const priceIn = input({ type: 'number', value: s.price, min: 0, step: '0.01' });
  const minsIn = input({ type: 'number', value: s.minutes, min: 15, step: 15 });
  const vatSel = select({}, vatOptions, s.vatClass || 'reduced');
  const bookBox = input({ type: 'checkbox', id: `bk-${s.id}`, checked: s.bookable });

  const saveBtn = el('button', { class: 'btn sm primary' }, 'Save');
  saveBtn.addEventListener('click', async () => {
    const done = busy(saveBtn, 'Saving…');
    try {
      await api.patch(`/api/v1/pro/services/${encodeURIComponent(s.id)}`, {
        price: Number(priceIn.value), minutes: Number(minsIn.value),
        vatClass: vatSel.value, bookable: bookBox.checked,
      });
      done();
      saveBtn.after(el('span', { class: 'chip good' }, 'saved'));
      setTimeout(() => saveBtn.nextSibling?.remove(), 1500);
    } catch (err) { done(); fail(card, err); }
  });

  const offBtn = el('button', { class: 'btn sm ghost danger' }, 'Retire');
  offBtn.addEventListener('click', async () => {
    busy(offBtn, '…');
    try { await api.del(`/api/v1/pro/services/${encodeURIComponent(s.id)}`); reload(); }
    catch (err) { fail(card, err); }
  });

  card.append(
    el('div', { class: 'row between' },
      el('h3', { style: 'margin:0' }, s.name),
      s.bookable ? el('span', { class: 'chip good' }, 'bookable') : el('span', { class: 'chip' }, 'quote only')),
    el('div', { class: 'inline-fields', style: 'margin-top:.7rem' },
      field('Price', priceIn), field('Minutes', minsIn), field('VAT', vatSel)),
    el('div', { class: 'row between', style: 'margin-top:.7rem' },
      el('div', { class: 'check' }, bookBox, el('label', { for: `bk-${s.id}` }, 'Bookable outright')),
      el('div', { class: 'row' }, saveBtn, offBtn)));
  return card;
}

/* ---- hours ------------------------------------------------------------ */

const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export async function hours(mount, ctx) {
  clear(mount).append(loading());
  const av = await api.get('/api/v1/pro/availability');

  const rows = WEEK.map((day) => {
    const w = (av.weekly[day] || [])[0] || null;
    const on = input({ type: 'checkbox', id: `on-${day}`, checked: !!w });
    const from = input({ type: 'time', value: w?.start || '08:00' });
    const to = input({ type: 'time', value: w?.end || '17:00' });
    const sync = () => { from.disabled = to.disabled = !on.checked; };
    on.addEventListener('change', sync);
    sync();
    return { day, on, from, to };
  });

  const lead = input({ type: 'number', value: av.leadTimeHours, min: 0, max: 168 });
  const buffer = input({ type: 'number', value: av.bufferMinutes, min: 0, max: 240, step: 5 });
  const ahead = input({ type: 'number', value: av.maxDaysAhead, min: 1, max: 365 });
  const step = select({}, [15, 30, 60].map((n) => ({ value: String(n), label: `${n} minutes` })), String(av.slotStepMinutes));

  const saveBtn = el('button', { class: 'btn primary' }, 'Save my hours');
  const form = el('form', {});

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const weekly = {};
    for (const r of rows) weekly[r.day] = r.on.checked ? [{ start: r.from.value, end: r.to.value }] : [];
    const done = busy(saveBtn, 'Saving…');
    try {
      await api.put('/api/v1/pro/availability', {
        weekly,
        leadTimeHours: Number(lead.value),
        bufferMinutes: Number(buffer.value),
        maxDaysAhead: Number(ahead.value),
        slotStepMinutes: Number(step.value),
      });
      done();
      form.prepend(notice('ok', 'Saved. Your bookable slots have moved to match.'));
    } catch (err) { done(); fail(form, err); }
  });

  form.append(
    el('div', { class: 'card' },
      el('h3', {}, 'A normal week'),
      el('div', { class: 'stack', style: 'margin-top:.8rem' }, rows.map((r) =>
        el('div', { class: 'row' },
          el('div', { class: 'check', style: 'min-width:160px' }, r.on, el('label', { for: `on-${r.day}` }, DAY_NAMES[r.day])),
          r.from, el('span', { class: 'muted' }, 'to'), r.to)))),

    el('div', { class: 'card' },
      el('h3', {}, 'The rules around it'),
      el('div', { class: 'inline-fields', style: 'margin-top:.7rem' },
        field('Notice needed', lead, 'Hours. Nothing books inside this.'),
        field('Travel between jobs', buffer, 'Minutes held after each job'),
        field('Book up to', ahead, 'Days ahead'),
        field('Start times land on', step))),

    el('div', { class: 'row', style: 'margin-top:1rem' }, saveBtn));

  clear(mount).append(
    heading('Hours', `Times are ${av.tz}. This is what decides the slots a customer is offered.`),
    form);
}

/* ---- the business ----------------------------------------------------- */

export async function settings(mount, ctx) {
  clear(mount).append(loading());
  const m = await meta();
  const me = await whoami();
  const p = me.pro;
  const priv = me.private;

  const form = el('form', {});
  const businessIn = input({ name: 'business', value: p.business, required: true });
  const nameIn = input({ name: 'name', value: p.name, required: true });
  const phoneIn = input({ name: 'phone', value: priv.phone || '' });
  const bioIn = el('textarea', { name: 'bio' }, p.bio || '');
  const regionSel = select({ name: 'region' }, [
    { value: 'IE', label: 'Republic of Ireland — VAT and RCT' },
    { value: 'UK', label: 'Northern Ireland / UK — VAT and CIS' },
  ], p.region);
  const vatBox = input({ type: 'checkbox', id: 'vatreg', checked: p.vatRegistered });
  const vatIn = input({ name: 'vatNumber', value: priv.vatNumber || '' });
  const prefixIn = input({ name: 'invoicePrefix', value: priv.invoicePrefix || '', maxlength: 6 });
  const calloutIn = input({ name: 'calloutFee', type: 'number', value: p.calloutFee || 0, min: 0, step: '0.01' });
  const hourlyIn = input({ name: 'hourlyRate', type: 'number', value: p.hourlyRate || 0, min: 0, step: '0.01' });
  const emergBox = input({ type: 'checkbox', id: 'emerg', checked: p.acceptsEmergency });
  const pubBox = input({ type: 'checkbox', id: 'pub', checked: priv.published });

  /* The withholding options depend on the region, so they are rebuilt when
   * it changes rather than listing IE and UK rates side by side. */
  const rateWrap = el('div', {});
  let rateSel;
  const drawRates = () => {
    const w = m.withholding[regionSel.value];
    rateSel = select({ name: 'withholdingRate' },
      w.rates.map((r) => ({ value: String(r), label: r ? `${w.scheme} ${r}%` : 'No deduction' })),
      String(priv.withholdingRate ?? 0));
    clear(rateWrap).append(field(`Deduction at source (${w.scheme})`, rateSel,
      'The rate a principal contractor withholds from you'));
  };
  regionSel.addEventListener('change', drawRates);
  drawRates();

  const tradeBoxes = m.trades.map((t) => {
    const box = input({ type: 'checkbox', id: `t-${t.key}`, checked: p.trades.includes(t.key) });
    return { key: t.key, box, node: el('div', { class: 'check' }, box, el('label', { for: `t-${t.key}` }, `${t.icon} ${t.name}`)) };
  });
  const areaBoxes = m.areas.map((a) => {
    const box = input({ type: 'checkbox', id: `a-${a.key}`, checked: p.areas.includes(a.key) });
    return { key: a.key, box, node: el('div', { class: 'check' }, box, el('label', { for: `a-${a.key}` }, a.name)) };
  });

  const saveBtn = el('button', { class: 'btn primary' }, 'Save');

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const done = busy(saveBtn, 'Saving…');
    try {
      const updated = await api.put('/api/v1/pro/profile', {
        business: businessIn.value, name: nameIn.value, phone: phoneIn.value,
        bio: bioIn.value, region: regionSel.value,
        vatRegistered: vatBox.checked, vatNumber: vatIn.value,
        invoicePrefix: prefixIn.value,
        calloutFee: Number(calloutIn.value), hourlyRate: Number(hourlyIn.value),
        withholdingRate: Number(rateSel.value),
        acceptsEmergency: emergBox.checked, published: pubBox.checked,
        trades: tradeBoxes.filter((t) => t.box.checked).map((t) => t.key),
        areas: areaBoxes.filter((a) => a.box.checked).map((a) => a.key),
      });
      session.pro = updated;
      done();
      form.prepend(notice('ok', 'Saved.'));
    } catch (err) { done(); fail(form, err); }
  });

  form.append(
    el('div', { class: 'card' },
      el('h3', {}, 'Who you are'),
      el('div', { class: 'inline-fields' },
        field('Business name', businessIn), field('Your name', nameIn), field('Phone', phoneIn)),
      field('About', bioIn)),

    el('div', { class: 'card' },
      el('h3', {}, 'Tax'),
      el('div', { class: 'inline-fields' },
        field('Region', regionSel), field('VAT number', vatIn), field('Invoice prefix', prefixIn, 'Appears as PREFIX-2026-0001')),
      el('div', { class: 'check', style: 'margin-top:.7rem' }, vatBox, el('label', { for: 'vatreg' }, 'VAT registered')),
      rateWrap),

    el('div', { class: 'card' },
      el('h3', {}, 'Rates'),
      el('div', { class: 'inline-fields' },
        field('Callout fee', calloutIn), field('Hourly rate', hourlyIn))),

    el('div', { class: 'card' },
      el('h3', {}, 'Trades'),
      el('div', { class: 'grid three' }, tradeBoxes.map((t) => t.node))),

    el('div', { class: 'card' },
      el('h3', {}, 'Counties'),
      el('div', { class: 'grid three' }, areaBoxes.map((a) => a.node))),

    el('div', { class: 'card' },
      el('h3', {}, 'Visibility'),
      el('div', { class: 'check' }, emergBox, el('label', { for: 'emerg' }, 'I take emergency callouts')),
      el('div', { class: 'check', style: 'margin-top:.5rem' }, pubBox, el('label', { for: 'pub' }, 'Show my page in search')),
      el('p', { class: 'muted', style: 'margin:.7rem 0 0' },
        'Your public page: ', el('a', { href: `/pro/${p.slug}` }, `/pro/${p.slug}`))),

    el('div', { class: 'row', style: 'margin-top:1rem' }, saveBtn));

  clear(mount).append(heading('Business', 'What customers see, and what the invoices are built from.'), form);
}
