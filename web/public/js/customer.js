/*
 * Everything a customer sees.
 *
 * Customers hold an account now: booking and asking both need one, so the
 * name, number and address come from the session rather than being retyped
 * into every form. The job page is still addressed by ref plus token, because
 * it is the same page whether it was reached from the customer's own job list
 * or from a link the foxer sent.
 */

import { api, meta, jobs, session, myJobs, saveMe, customerLogin, customerSignup } from './api.js';
import {
  el, frag, clear, money, dateTime, dateOnly, relative, stars,
  notice, loading, empty, field, input, select, values, statusChip, copyButton, totalsBlock,
} from './ui.js';

/*
 * Sending someone to sign in has to bring them back. Every guarded view calls
 * this first and returns if it is false, so the half-filled form they were
 * looking at is the thing they land back on.
 */
function needsAccount(ctx) {
  if (session.customer) return false;
  ctx.navigate(`/signin?next=${encodeURIComponent(ctx.path + location.search)}`, { replace: true });
  return true;
}

const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';

/* ---- home ------------------------------------------------------------ */

export async function home(mount, ctx) {
  const m = await meta();
  const areaOptions = [{ value: '', label: 'Anywhere' },
    ...m.areas.map((a) => ({ value: a.key, label: a.name }))];
  const tradeOptions = [{ value: '', label: 'Any trade' },
    ...m.trades.map((t) => ({ value: t.key, label: t.name }))];

  const tradeSel = select({ name: 'trade', 'aria-label': 'Trade' }, tradeOptions, ctx.query.get('trade') || '');
  const areaSel = select({ name: 'area', 'aria-label': 'County' }, areaOptions, ctx.query.get('area') || '');

  const go = () => {
    const p = new URLSearchParams();
    if (tradeSel.value) p.set('trade', tradeSel.value);
    if (areaSel.value) p.set('area', areaSel.value);
    ctx.navigate(`/find?${p}`);
  };

  clear(mount).append(frag(
    el('section', { class: 'hero' },
      el('h1', {}, 'Find a tradesperson who can actually come.'),
      el('p', { class: 'lede' },
        'See real availability, book the fixed-price jobs outright, and ask for a quote on everything else. ',
        'What you agree is written down and timestamped — not left in a voice note.'),
      el('div', { class: 'searchbar' },
        tradeSel, areaSel,
        el('button', { class: 'btn primary', onclick: go }, 'Search')),
    ),

    el('h2', {}, 'Browse by trade'),
    el('div', { class: 'trade-grid' },
      m.trades.map((t) => el('a', {
        class: 'trade-tile',
        href: `/find?trade=${t.key}${areaSel.value ? `&area=${areaSel.value}` : ''}`,
      }, el('span', { class: 'ic' }, t.icon), t.name))),

    el('div', { class: 'card', style: 'margin-top:2rem' },
      el('div', { class: 'row between' },
        el('div', {},
          el('h2', {}, 'Emergency?'),
          el('p', { class: 'muted', style: 'margin:0' },
            'Nobody books a 30-minute slot for a leaking boiler. Tell us what has happened and it goes to the top of the list for every matching trade in your county.')),
        el('a', { class: 'btn primary', href: '/find?emergency=1' }, 'Get someone out'))),

    el('div', { class: 'card' },
      el('div', { class: 'row between' },
        el('div', {},
          el('h2', {}, 'On the tools?'),
          el('p', { class: 'muted', style: 'margin:0' },
            'Quote, get it accepted, invoice, get paid. VAT at 13.5%, RCT and CIS withholding and reverse charge handled properly — not bolted on.')),
        el('a', { class: 'btn', href: '/signup' }, 'List your business'))),
  ));
}

/* ---- search ---------------------------------------------------------- */

export async function find(mount, ctx) {
  const m = await meta();
  const q = ctx.query;
  clear(mount).append(loading('Finding tradespeople'));

  const params = new URLSearchParams();
  for (const k of ['trade', 'area', 'q', 'emergency']) if (q.get(k)) params.set(k, q.get(k));

  const tradeName = m.trades.find((t) => t.key === q.get('trade'))?.name;
  const areaName = m.areas.find((a) => a.key === q.get('area'))?.name;

  let data;
  try {
    data = await api.get(`/api/v1/pros?${params}`);
  } catch (err) {
    return clear(mount).append(notice('err', err.message));
  }

  const filters = el('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); apply(); } },
    el('div', { class: 'inline-fields' },
      field('Trade', select({ name: 'trade' },
        [{ value: '', label: 'Any trade' }, ...m.trades.map((t) => ({ value: t.key, label: t.name }))],
        q.get('trade') || '')),
      field('County', select({ name: 'area' },
        [{ value: '', label: 'Anywhere' }, ...m.areas.map((a) => ({ value: a.key, label: a.name }))],
        q.get('area') || '')),
      field('Search', input({ name: 'q', value: q.get('q') || '', placeholder: 'Business name' }))),
    el('div', { class: 'row', style: 'margin-top:.7rem' },
      el('div', { class: 'check' },
        input({ type: 'checkbox', name: 'emergency', id: 'emg', checked: q.get('emergency') === '1' }),
        el('label', { for: 'emg' }, 'Takes emergency callouts')),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn primary', type: 'submit' }, 'Update')));

  const apply = () => {
    const v = values(filters);
    const p = new URLSearchParams();
    if (v.trade) p.set('trade', v.trade);
    if (v.area) p.set('area', v.area);
    if (v.q) p.set('q', v.q);
    if (v.emergency) p.set('emergency', '1');
    ctx.navigate(`/find?${p}`);
  };

  const heading = [tradeName || 'Tradespeople', areaName ? `in ${areaName}` : null]
    .filter(Boolean).join(' ');

  clear(mount).append(frag(
    el('h1', {}, heading),
    el('p', { class: 'muted' }, `${data.count} ${data.count === 1 ? 'result' : 'results'}, soonest available first.`),
    filters,
    el('div', { class: 'stack', style: 'margin-top:1rem' },
      data.results.length
        ? data.results.map((p) => proCard(p, m))
        : empty('Nobody matches that yet.',
            el('a', { class: 'btn', href: '/find' }, 'Widen the search'))),
    el('div', { class: 'card', style: 'margin-top:1rem' },
      el('div', { class: 'row between' },
        el('div', {},
          el('h3', {}, 'Not sure who you need?'),
          el('span', { class: 'muted' }, 'Describe the job once and let matching tradespeople come back to you.')),
        el('a', { class: 'btn primary', href: `/ask?${params}` }, 'Describe the job')))));
}

function proCard(p, m) {
  const tradeNames = p.trades.map((t) => m.trades.find((x) => x.key === t)?.name).filter(Boolean);
  return el('div', { class: 'card' },
    el('div', { class: 'pro-card' },
      el('div', {},
        el('div', { class: 'row' },
          el('h2', { style: 'margin:0' }, el('a', { href: `/pro/${p.slug}` }, p.business)),
          p.verified ? el('span', { class: 'chip good' }, 'Verified') : null,
          p.acceptsEmergency ? el('span', { class: 'chip amber' }, 'Emergency callouts') : null),
        el('div', { class: 'row', style: 'margin:.35rem 0' },
          stars(p.rating.average),
          el('small', {}, p.rating.count ? `${p.rating.average} · ${p.rating.count} reviews` : 'New to Foxers')),
        el('p', { class: 'muted', style: 'margin:.4rem 0' }, p.bio || tradeNames.join(', ')),
        el('div', { class: 'row' }, tradeNames.map((t) => el('span', { class: 'chip' }, t)))),
      el('div', { class: 'when' },
        p.nextSlot
          ? frag(
              el('small', {}, 'Next available'),
              el('div', { style: 'font-weight:650' }, dateTime(p.nextSlot.start)),
              p.fromPrice ? el('small', {}, `from ${money(p.fromPrice, p.region)}`) : null)
          : el('small', {}, 'Quote only — ask for a callout'),
        el('a', { class: 'btn primary sm', href: `/pro/${p.slug}`, style: 'margin-top:.5rem' },
          p.bookableCount ? 'See times' : 'Ask for a quote'))));
}

/* ---- profile --------------------------------------------------------- */

export async function profile(mount, ctx) {
  clear(mount).append(loading());
  let p;
  try {
    p = await api.get(`/api/v1/pros/${encodeURIComponent(ctx.params.slug)}`);
  } catch (err) {
    return clear(mount).append(notice('err', err.message));
  }

  const bookable = p.bookable.filter((s) => s.active);
  const quoteOnly = p.quoteOnly.filter((s) => s.active);

  clear(mount).append(frag(
    el('a', { href: '/find', class: 'muted' }, '← All tradespeople'),
    el('h1', { style: 'margin-top:.6rem' }, p.business),
    el('div', { class: 'row' },
      stars(p.rating.average),
      el('small', {}, p.rating.count ? `${p.rating.average} from ${p.rating.count} reviews` : 'New to Foxers'),
      p.verified ? el('span', { class: 'chip good' }, 'Verified') : null,
      p.vatRegistered ? el('span', { class: 'chip' }, 'VAT registered') : null,
      p.acceptsEmergency ? el('span', { class: 'chip amber' }, 'Emergency callouts') : null),
    el('p', { class: 'lede', style: 'margin-top:.8rem' }, p.bio),
    el('div', { class: 'row' }, p.tradeNames.map((t) => el('span', { class: 'chip' }, t))),

    bookable.length ? frag(
      el('h2', { style: 'margin-top:2rem' }, 'Book straight in'),
      el('p', { class: 'muted' }, 'Fixed price, known duration. Pick a time and it is confirmed.'),
      el('div', { class: 'stack' }, bookable.map((s) => el('div', { class: 'card' },
        el('div', { class: 'row between' },
          el('div', {},
            el('h3', { style: 'margin:0' }, s.name),
            el('small', {}, `${s.minutes} min`),
            s.description ? el('p', { class: 'muted', style: 'margin:.3rem 0 0' }, s.description) : null),
          el('div', { class: 'right' },
            el('div', { style: 'font-weight:700;font-size:1.15rem' }, money(s.price, p.region)),
            el('a', { class: 'btn primary sm', href: `/book/${p.slug}/${s.id}`, style: 'margin-top:.4rem' }, 'See times'))))))) : null,

    el('h2', { style: 'margin-top:2rem' }, 'Ask for a quote'),
    el('p', { class: 'muted' },
      'Anything priced after a look at the job. Describe it and ',
      p.name.split(' ')[0], ' comes back with a written quote you can accept or decline.'),
    quoteOnly.length ? el('div', { class: 'row', style: 'margin-bottom:.8rem' },
      quoteOnly.map((s) => el('span', { class: 'chip' }, s.name))) : null,
    el('a', { class: 'btn primary', href: `/ask?pro=${p.slug}` }, 'Describe the job'),

    p.reviews.length ? frag(
      el('h2', { style: 'margin-top:2rem' }, 'Reviews'),
      el('p', { class: 'muted' }, 'Only left by customers with a completed, invoiced job on Foxers.'),
      el('div', { class: 'stack' }, p.reviews.map((r) => el('div', { class: 'card' },
        el('div', { class: 'row between' },
          stars(r.rating),
          el('small', {}, dateOnly(r.at))),
        r.text ? el('p', { style: 'margin:.5rem 0 0' }, r.text) : null)))) : null,
  ));
}

/* ---- booking --------------------------------------------------------- */

export async function book(mount, ctx) {
  if (needsAccount(ctx)) return;
  clear(mount).append(loading('Checking availability'));
  const { slug, serviceId } = ctx.params;

  let pro, avail;
  try {
    [pro, avail] = await Promise.all([
      api.get(`/api/v1/pros/${encodeURIComponent(slug)}`),
      api.get(`/api/v1/pros/${encodeURIComponent(slug)}/slots?serviceId=${encodeURIComponent(serviceId)}&days=21`),
    ]);
  } catch (err) {
    return clear(mount).append(notice('err', err.message));
  }

  if (!avail.days.length) {
    return clear(mount).append(frag(
      el('h1', {}, avail.service.name),
      notice('info', `${pro.business} has nothing free in the next three weeks. Ask for a quote and they will come back with a date.`),
      el('a', { class: 'btn primary', href: `/ask?pro=${pro.slug}` }, 'Describe the job')));
  }

  let dayIndex = 0;
  let chosen = null;

  const slotWrap = el('div', { class: 'slots' });
  const dayStrip = el('div', { class: 'daystrip' });
  const confirmBtn = el('button', { class: 'btn primary block', disabled: true }, 'Confirm booking');
  const errBox = el('div');

  const renderSlots = () => {
    clear(slotWrap);
    for (const s of avail.days[dayIndex].slots) {
      slotWrap.append(el('button', {
        class: `slot${chosen === s.start ? ' on' : ''}`, type: 'button',
        onclick: () => { chosen = s.start; renderSlots(); confirmBtn.disabled = false; },
      }, s.label));
    }
  };

  const renderDays = () => {
    clear(dayStrip);
    avail.days.forEach((d, i) => {
      dayStrip.append(el('button', {
        class: `daybtn${i === dayIndex ? ' on' : ''}`, type: 'button',
        onclick: () => { dayIndex = i; chosen = null; confirmBtn.disabled = true; renderDays(); renderSlots(); },
      }, d.label, ' ', el('small', {}, `${d.slots.length}`)));
    });
  };

  const me = session.customer;
  const form = el('form', { class: 'card', onsubmit: (e) => e.preventDefault() },
    el('div', { class: 'row between' },
      el('h3', { style: 'margin:0' }, 'Where and anything they should know'),
      el('small', {}, `${me.name} · ${me.phone} · `, el('a', { href: '/me/account' }, 'change'))),
    field('Address of the job', input({ name: 'address', required: true, value: me.address || '', autocomplete: 'street-address' }),
      'Defaults to the address on your account.'),
    field('Anything they should know', el('textarea', { name: 'notes', placeholder: 'Make and age of the boiler, where the fuse board is, parking…' })));

  confirmBtn.addEventListener('click', async () => {
    clear(errBox);
    const v = values(form);
    if (!v.address) {
      return errBox.append(notice('err', 'An address is needed before anyone can come out.'));
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Confirming…';
    try {
      const r = await api.post('/api/v1/bookings', {
        proSlug: pro.slug, serviceId, start: chosen,
        address: v.address, notes: v.notes,
      });
      // The token is the customer's only credential for this job, so it goes
      // into the URL they are about to land on and nowhere else.
      ctx.navigate(`/j/${r.ref}?t=${encodeURIComponent(r.token)}&new=1`);
    } catch (err) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm booking';
      errBox.append(notice('err', err.code === 'slot_gone'
        ? 'Someone just took that time. Pick another and try again.'
        : err.message));
      if (err.code === 'slot_gone') {
        avail = await api.get(`/api/v1/pros/${encodeURIComponent(slug)}/slots?serviceId=${encodeURIComponent(serviceId)}&days=21`);
        chosen = null; dayIndex = 0; renderDays(); renderSlots();
      }
    }
  });

  renderDays();
  renderSlots();

  clear(mount).append(frag(
    el('a', { href: `/pro/${pro.slug}`, class: 'muted' }, `← ${pro.business}`),
    el('h1', { style: 'margin-top:.6rem' }, avail.service.name),
    el('div', { class: 'row' },
      el('span', { class: 'chip amber' }, money(avail.service.price, pro.region)),
      el('span', { class: 'chip' }, `${avail.service.minutes} min`),
      el('small', { class: 'muted' }, `Times shown in ${avail.tz.replace('_', ' ')}`)),
    el('div', { class: 'card', style: 'margin-top:1rem' },
      el('h3', {}, 'Pick a day'),
      dayStrip,
      slotWrap),
    form,
    errBox,
    el('div', { style: 'margin-top:.8rem' }, confirmBtn),
    el('p', { class: 'muted', style: 'margin-top:.6rem;font-size:.85rem' },
      'No payment now. The price above is fixed unless the job turns out to be something else, in which case they will quote you before doing anything.'),
  ));
}

/* ---- quote request --------------------------------------------------- */

export async function ask(mount, ctx) {
  if (needsAccount(ctx)) return;
  const m = await meta();
  const proSlug = ctx.query.get('pro');
  let pro = null;
  if (proSlug) {
    try { pro = await api.get(`/api/v1/pros/${encodeURIComponent(proSlug)}`); } catch { /* open request */ }
  }

  const errBox = el('div');
  const form = el('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); submit(); } },
    el('div', { class: 'inline-fields' },
      field('Trade', select({ name: 'trade' },
        m.trades.map((t) => ({ value: t.key, label: t.name })),
        ctx.query.get('trade') || pro?.trades?.[0] || 'electrician')),
      field('County', select({ name: 'area' },
        [{ value: '', label: 'Pick your county' }, ...m.areas.map((a) => ({ value: a.key, label: a.name }))],
        ctx.query.get('area') || ''))),
    field('How soon?', select({ name: 'urgency' },
      m.urgency.map((u) => ({ value: u.key, label: `${u.name} — ${u.note}` })),
      ctx.query.get('emergency') === '1' ? 'emergency' : 'week')),
    field('What needs doing?', el('textarea', {
      name: 'description', required: true, minlength: 10,
      placeholder: 'Half the sockets in the kitchen are dead and the board trips when the kettle goes on. 1970s semi, board is under the stairs.',
    }), 'The more detail, the closer the quote will be to the final price.'),
    el('hr', { class: 'hr' }),
    field('Address of the job', input({
      name: 'address', required: true, value: session.customer.address || '',
      autocomplete: 'street-address',
    })),
    depositNote(m, pro),
    el('button', { class: 'btn primary block', type: 'submit', style: 'margin-top:.9rem' },
      pro ? `Send to ${pro.business}` : 'Send to matching tradespeople'));

  async function submit() {
    clear(errBox);
    const v = values(form);
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Sending…';
    try {
      const r = await api.post('/api/v1/requests', {
        trade: v.trade, area: v.area, urgency: v.urgency, description: v.description,
        proId: pro ? pro.id : null, address: v.address,
      });
      ctx.navigate(`/j/${r.ref}?t=${encodeURIComponent(r.token)}&new=1`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      errBox.append(notice('err', err.message));
    }
  }

  clear(mount).append(frag(
    el('h1', {}, pro ? `Ask ${pro.business} for a quote` : 'Describe the job'),
    el('p', { class: 'lede' }, pro
      ? 'They will come back with a written quote. Nothing is agreed until you accept it.'
      : 'It goes to tradespeople in your county who do this work. You will get written quotes back and can accept whichever you want.'),
    errBox, form));
}

/*
 * Say what the €5 is for, in the place where it is about to be taken. It is
 * the difference between "why am I being charged to ask a question" and "fair
 * enough" — and the honest answer is that it costs nothing if you go ahead.
 */
function depositNote(m, pro) {
  const region = pro?.region || 'IE';
  const amount = m.deposit?.[region] ?? 5;
  return el('div', { class: 'notice info', style: 'margin:1rem 0 0' },
    el('strong', {}, `${money(amount, region)} to send this. `),
    'It comes straight off the price if you go ahead with the quote. ',
    'If you turn the quote down, the tradesperson keeps it for the time spent pricing your job.');
}

/* ---- the customer's job --------------------------------------------- */

export async function job(mount, ctx) {
  const ref = ctx.params.ref;
  const token = ctx.query.get('t');
  if (!token) return clear(mount).append(notice('err', 'That link is missing its access code. Use the full link you were sent.'));

  clear(mount).append(loading());
  let data;
  try {
    data = await jobs.get(ref, token);
  } catch (err) {
    return clear(mount).append(notice('err', err.message));
  }

  const region = data.pro?.region || 'IE';
  const isNew = ctx.query.get('new') === '1';
  const shareUrl = `${location.origin}/j/${ref}?t=${encodeURIComponent(token)}`;

  const render = () => {
    const quote = data.quotes.find((q) => q.status === 'sent') || data.quotes[0] || null;
    const invoice = data.invoices[0] || null;

    clear(mount).append(frag(
      isNew ? notice('ok', data.kind === 'booking'
        ? 'Booked. Save this page — it is the only way back to this job.'
        : 'Sent. Save this page — the quote will appear here.') : null,

      el('div', { class: 'row between' },
        el('div', {},
          el('h1', { style: 'margin:0' }, data.request ? 'Your job' : 'Your booking'),
          el('div', { class: 'mono muted' }, ref)),
        copyButton(shareUrl, 'Copy link to this job')),

      progress(data),

      data.pro ? el('div', { class: 'card' },
        el('div', { class: 'row between' },
          el('div', {},
            el('h3', { style: 'margin:0' }, el('a', { href: `/pro/${data.pro.slug}` }, data.pro.business)),
            el('small', {}, data.pro.name)),
          data.pro.acceptsEmergency ? el('span', { class: 'chip amber' }, 'Emergency callouts') : null)) : null,

      data.booking ? el('div', { class: 'card' },
        el('div', { class: 'row between' },
          el('h3', { style: 'margin:0' }, data.booking.service.name),
          statusChip(data.booking.status)),
        el('table', {}, el('tbody', {},
          tr('When', `${dateTime(data.booking.start)} · ${data.booking.minutes} min`),
          tr('Where', data.booking.address),
          tr('Price agreed', money(data.booking.price, region)),
          data.booking.notes ? tr('Your notes', data.booking.notes) : null))) : null,

      data.request ? el('div', { class: 'card' },
        el('div', { class: 'row between' },
          el('h3', { style: 'margin:0' }, data.request.tradeName),
          statusChip(data.request.status)),
        el('p', { style: 'margin:.5rem 0' }, data.request.description),
        el('div', { class: 'row' },
          el('span', { class: 'chip' }, data.request.address),
          el('span', { class: 'chip amber' }, data.request.urgency),
          el('small', { class: 'muted' }, `Sent ${relative(data.request.at)}`))) : null,

      data.deposit ? depositCard(data.deposit, region) : null,

      quote ? quoteCard(quote, region, onAccept, onDecline) : null,
      data.quotes.length > 1 ? el('p', { class: 'muted' }, `${data.quotes.length - 1} earlier quote(s) on this job.`) : null,

      data.receipt ? receiptCard(data.receipt) : invoice ? invoiceCard(invoice, region) : null,

      !quote && !invoice && data.request ? el('div', { class: 'card' },
        el('h3', {}, 'Waiting on a quote'),
        el('p', { class: 'muted', style: 'margin:0' },
          'Nothing to do yet. When a quote arrives it will show up on this page, and you can accept or decline it here.')) : null,
    ));
  };

  async function onAccept(quoteId, btn, start) {
    btn.disabled = true;
    btn.textContent = 'Accepting…';
    try {
      data = await jobs.accept(ref, token, quoteId, start);
      render();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Accept and book this time';
      mount.prepend(notice('err', err.code === 'slot_gone'
        ? 'Someone just took that time. Ask them for new times.'
        : err.message));
    }
  }

  async function onDecline(quoteId, btn) {
    const reason = prompt('Anything you want to tell them? (optional)') ?? '';
    btn.disabled = true;
    try {
      data = await jobs.decline(ref, token, quoteId, reason);
      render();
    } catch (err) {
      btn.disabled = false;
      mount.prepend(notice('err', err.message));
    }
  }

  render();
}

function tr(k, v) {
  return el('tr', {}, el('th', { style: 'width:170px' }, k), el('td', {}, v));
}

/*
 * Which story this job is telling. A job that began as a request and was
 * quoted keeps that history even after accepting turned it into a booking —
 * the customer asked, got a price, agreed it. Showing them "Booked" as step
 * one would erase the part they actually did.
 */
function progress(data) {
  const askedFirst = !!data.request;
  const steps = askedFirst
    ? ['Asked', 'Quoted', 'Accepted', 'Done', 'Invoiced', 'Paid']
    : ['Booked', 'Scheduled', 'Done', 'Invoiced', 'Paid'];

  const bookingStatus = data.booking?.status;
  const inv = data.invoices[0];
  let at;

  if (askedFirst) {
    // Once accepted, the booking's own status is the more advanced signal.
    at = { open: 0, quoted: 1, accepted: 2, declined: 1 }[data.request.status] ?? 0;
    const fromBooking = { confirmed: 2, scheduled: 2, done: 3, invoiced: 4, paid: 5 }[bookingStatus];
    if (fromBooking != null) at = Math.max(at, fromBooking);
  } else {
    at = { confirmed: 0, scheduled: 1, done: 2, invoiced: 3, paid: 4 }[bookingStatus] ?? 0;
  }
  if (inv) at = Math.max(at, steps.length - 2);
  if (inv?.status === 'paid') at = steps.length - 1;

  return el('div', { class: 'steps' }, steps.map((s, i) =>
    el('div', { class: `step ${i < at ? 'done' : i === at ? 'now' : ''}` }, s)));
}

function quoteCard(q, region, onAccept, onDecline) {
  const t = q.totals;
  const expired = Date.parse(q.validUntil) < Date.now() && q.status === 'sent';
  const offers = q.slots || [];

  /*
   * Accepting a price without agreeing a date is how a job ends up agreed and
   * never done, so the two are one action here: the button stays dead until a
   * time is picked, and pressing it books that hour.
   */
  let picked = offers.length === 1 ? offers[0] : null;
  const acceptBtn = el('button', {
    class: 'btn primary',
    disabled: offers.length > 1 && !picked,
  }, offers.length ? 'Accept and book this time' : 'Accept this quote');

  // Wider than the booking grid: these carry a full date, not just a time.
  const slotWrap = el('div', {
    class: 'slots',
    style: 'grid-template-columns:repeat(auto-fill,minmax(190px,1fr))',
  });
  const drawSlots = () => {
    clear(slotWrap);
    for (const iso of offers) {
      const btn = el('button', {
        class: `slot${iso === picked ? ' on' : ''}`, type: 'button',
      }, dateTime(iso));
      btn.addEventListener('click', () => { picked = iso; acceptBtn.disabled = false; drawSlots(); });
      slotWrap.append(btn);
    }
  };
  if (offers.length) drawSlots();

  const declineBtn = el('button', { class: 'btn ghost' }, 'Decline');
  acceptBtn.addEventListener('click', () => onAccept(q.id, acceptBtn, picked));
  declineBtn.addEventListener('click', () => onDecline(q.id, declineBtn));

  return el('div', { class: 'card' },
    el('div', { class: 'row between' },
      el('h3', { style: 'margin:0' }, q.title),
      statusChip(expired ? 'expired' : q.status)),
    q.notes ? el('p', { class: 'muted' }, q.notes) : null,

    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Item'), el('th', {}, ''), el('th', { class: 'right' }, 'Qty'),
        el('th', { class: 'right' }, 'Unit'), el('th', { class: 'right' }, 'Net'))),
      el('tbody', {}, q.lines.map((l) => el('tr', {},
        el('td', {}, l.description || '—'),
        el('td', {}, el('span', { class: 'chip' }, l.kind)),
        el('td', { class: 'right mono' }, l.qty),
        el('td', { class: 'right mono' }, money(l.unitPrice, region)),
        el('td', { class: 'right mono' }, money(l.net, region))))))),

    totalsBlock(t, region),

    q.terms ? frag(el('hr', { class: 'hr' }), el('small', { class: 'muted' }, q.terms)) : null,

    q.status === 'sent' && !expired ? frag(
      el('hr', { class: 'hr' }),
      offers.length ? frag(
        el('h3', {}, offers.length === 1 ? 'The time they are offering' : 'Pick a time that suits'),
        el('p', { class: 'muted', style: 'margin:.2rem 0 .5rem' },
          `${q.minutes ? `About ${Math.round(q.minutes / 60 * 10) / 10} hours on site. ` : ''}`
          + 'Whichever you pick is booked into their diary there and then.'),
        slotWrap) : null,
      el('p', { class: 'muted', style: 'margin:.8rem 0 .6rem' },
        `Valid until ${dateOnly(q.validUntil)}. Accepting records the date and time, and this is what the invoice will be based on.`),
      el('div', { class: 'row' }, acceptBtn, declineBtn)) : null,

    q.acceptedAt ? el('p', { class: 'muted', style: 'margin:.6rem 0 0' },
      `Accepted ${dateTime(q.acceptedAt)}`,
      q.acceptedSlot ? `, booked for ${dateTime(q.acceptedSlot)}.` : '.') : null);
}

function depositCard(d, region) {
  const tone = { held: '', credited: 'good', captured: 'amber', refunded: '' }[d.status] || '';
  return el('div', { class: 'card' },
    el('div', { class: 'row between' },
      el('div', {},
        el('h3', { style: 'margin:0' }, 'Deposit ', money(d.amount, region)),
        el('small', {}, d.note)),
      el('span', { class: `chip ${tone}` }, d.status)),
    d.settled ? null : el('small', { class: 'muted' },
      'No card has been charged — this instance has no payment provider connected.'));
}

/*
 * The receipt, not a rendering of the invoice. It is a snapshot taken at the
 * moment the money was taken, so it keeps saying what was actually charged
 * even if the invoice behind it is corrected afterwards.
 */
function receiptCard(r) {
  const region = r.region || 'IE';
  return el('div', { class: 'card' },
    el('div', { class: 'row between' },
      el('div', {},
        el('h3', { style: 'margin:0' }, 'Receipt ', el('span', { class: 'mono' }, r.number)),
        el('small', {}, `${r.business} · ${dateTime(r.issuedAt)}`)),
      el('span', { class: 'chip good' }, 'paid')),
    r.vatRegistered && r.vatNumber
      ? el('small', { class: 'muted' }, `VAT number ${r.vatNumber}`)
      : el('small', { class: 'muted' }, 'Not registered for VAT'),

    el('div', { class: 'table-wrap', style: 'margin-top:.7rem' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Item'), el('th', { class: 'right' }, 'Qty'),
        el('th', { class: 'right' }, 'Net'), el('th', { class: 'right' }, 'VAT'))),
      el('tbody', {}, r.lines.map((l) => el('tr', {},
        el('td', {}, l.description || '—'),
        el('td', { class: 'right mono' }, l.qty),
        el('td', { class: 'right mono' }, money(l.net, region)),
        el('td', { class: 'right mono' }, money(l.vatCharged, region))))))),

    totalsBlock(r.totals, region),

    el('div', { class: 'totals' },
      r.depositCredit ? el('div', { class: 'line' },
        el('span', {}, 'Less deposit already paid'),
        el('span', { class: 'mono' }, `− ${money(r.depositCredit, region)}`)) : null,
      el('div', { class: 'line sum' },
        el('span', {}, `Paid by ${r.methodName}`),
        el('span', { class: 'mono' }, money(r.paid, region)))),

    el('hr', { class: 'hr' }),
    el('small', { class: 'muted' },
      r.settled
        ? `Payment reference ${r.providerRef}.`
        : 'Recorded against this job. No card was charged — this instance has no payment provider connected.'));
}

function invoiceCard(i, region) {
  const overdue = i.status === 'issued' && Date.parse(i.dueAt) < Date.now();
  return el('div', { class: 'card' },
    el('div', { class: 'row between' },
      el('div', {},
        el('h3', { style: 'margin:0' }, 'Invoice ', el('span', { class: 'mono' }, i.number)),
        el('small', {}, `Issued ${dateOnly(i.issuedAt)} · due ${dateOnly(i.dueAt)}`)),
      statusChip(overdue ? 'overdue' : i.status)),
    i.vatNumber ? el('small', { class: 'muted' }, `VAT number ${i.vatNumber}`) : null,
    totalsBlock(i.totals, region),
    i.status === 'paid'
      ? notice('ok', `Paid ${dateOnly(i.paidAt)}. Nothing further to do.`)
      : i.paymentLink
        ? el('a', { class: 'btn primary block', href: i.paymentLink, rel: 'noopener' }, `Pay ${money(i.totals.payable, region)}`)
        : el('p', { class: 'muted', style: 'margin:.6rem 0 0' },
            'Pay by bank transfer using the reference above, or ask for a card link.'));
}

/* ---- the customer's account ------------------------------------------ */

export async function signin(mount, ctx) {
  const next = ctx.query.get('next') || '/me';
  const form = el('form', { class: 'card', style: 'max-width:420px' });
  const emailIn = input({ name: 'email', type: 'email', required: true, autocomplete: 'username' });
  const passIn = input({ name: 'password', type: 'password', required: true, autocomplete: 'current-password' });
  const btn = el('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');

  form.append(field('Email', emailIn), field('Password', passIn),
    el('div', { style: 'margin-top:1rem' }, btn));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      await customerLogin(emailIn.value.trim(), passIn.value);
      ctx.navigate(next, { replace: true });
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Sign in';
      form.prepend(notice('err', err.message));
    }
  });

  clear(mount).append(
    el('h1', {}, 'Sign in'),
    el('p', { class: 'lede' }, 'To book, ask for a quote, and keep track of what is happening.'),
    form,
    el('p', { class: 'muted', style: 'margin-top:1rem' },
      'New here? ', el('a', { href: `/join?next=${encodeURIComponent(next)}` }, 'Create an account'), '.'),
    el('p', { class: 'muted' },
      'On the tools? ', el('a', { href: '/login' }, 'Sign in as a tradesperson'), '.'));
}

export async function join(mount, ctx) {
  const m = await meta();
  const next = ctx.query.get('next') || '/me';
  const form = el('form', { class: 'card', style: 'max-width:520px' });
  const btn = el('button', { class: 'btn primary block', type: 'submit' }, 'Create my account');

  form.append(
    el('div', { class: 'inline-fields' },
      field('Your name', input({ name: 'name', required: true, autocomplete: 'name' })),
      field('Mobile', input({ name: 'phone', required: true, type: 'tel', autocomplete: 'tel' }),
        'So a tradesperson can ring you if they are running late.')),
    field('Email', input({ name: 'email', type: 'email', required: true, autocomplete: 'email' })),
    field('Password', input({ name: 'password', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }),
      'At least 10 characters.'),
    el('hr', { class: 'hr' }),
    field('Your county', select({ name: 'area' },
      [{ value: '', label: 'Pick your county' }, ...m.areas.map((a) => ({ value: a.key, label: a.name }))], ''),
      'Where your searches start. You can look anywhere.'),
    field('Address', input({ name: 'address', autocomplete: 'street-address' }),
      'Filled in for you when you book. You can change it per job.'),
    el('div', { style: 'margin-top:1rem' }, btn));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      await customerSignup(values(form));
      ctx.navigate(next, { replace: true });
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Create my account';
      form.prepend(notice('err', err.message));
    }
  });

  clear(mount).append(
    el('h1', {}, 'Create an account'),
    el('p', { class: 'lede' },
      'So your jobs, quotes and receipts are all in one place instead of scattered through a text thread.'),
    form);
}

/*
 * Everything the customer has going on. Sorted newest first, with whatever
 * needs them next called out — a quote sitting unanswered is the one thing on
 * this page that costs them something to ignore.
 */
export async function myJobsView(mount, ctx) {
  if (needsAccount(ctx)) return;
  clear(mount).append(loading('Fetching your jobs'));
  const d = await myJobs();

  const waiting = d.jobs.filter((j) => j.awaitingYou);
  const live = d.jobs.filter((j) => !j.awaitingYou && !['paid', 'declined', 'cancelled'].includes(j.status));
  const done = d.jobs.filter((j) => !j.awaitingYou && ['paid', 'declined', 'cancelled'].includes(j.status));

  clear(mount).append(frag(
    el('div', { class: 'row between', style: 'margin-bottom:1rem' },
      el('div', {},
        el('h1', { style: 'margin:0' }, `Hello ${firstName(session.customer.name)}`),
        el('small', {}, d.count ? `${d.count} job${d.count === 1 ? '' : 's'}` : 'Nothing on yet')),
      el('a', { class: 'btn sm', href: '/find' }, 'Find someone')),

    waiting.length ? frag(
      el('h2', {}, 'Waiting on you'),
      el('div', { class: 'stack', style: 'margin-bottom:1.6rem' }, waiting.map(jobRow))) : null,

    el('h2', {}, 'On the go'),
    live.length ? el('div', { class: 'stack' }, live.map(jobRow))
      : empty('Nothing in progress.',
          el('a', { class: 'btn primary', href: '/find' }, 'Find a tradesperson')),

    done.length ? frag(
      el('h2', { style: 'margin-top:1.6rem' }, 'Finished'),
      el('div', { class: 'stack' }, done.map(jobRow))) : null));
}

function jobRow(j) {
  const region = j.pro?.region || 'IE';
  const href = `/j/${j.ref}?t=${encodeURIComponent(j.token)}`;
  return el('a', { class: 'card', href, style: 'display:block;color:inherit' },
    el('div', { class: 'row between' },
      el('div', {},
        el('h3', { style: 'margin:0' }, j.service || j.tradeName || 'Job'),
        el('small', {}, j.pro ? j.pro.business : 'Open to matching tradespeople',
          ' · ', el('span', { class: 'mono' }, j.ref))),
      el('div', { class: 'row' },
        j.awaitingYou ? el('span', { class: 'chip amber' }, 'quote to answer') : null,
        statusChip(j.status))),
    el('div', { class: 'row', style: 'margin-top:.6rem' },
      j.at ? el('span', { class: 'chip' }, dateTime(j.at)) : null,
      j.address ? el('span', { class: 'chip' }, j.address) : null,
      j.invoice ? el('span', { class: `chip ${j.invoice.status === 'paid' ? 'good' : 'amber'}` },
        `${j.invoice.number} · ${money(j.invoice.payable, region)}`) : null));
}

export async function account(mount, ctx) {
  if (needsAccount(ctx)) return;
  const m = await meta();
  const me = session.customer;

  const form = el('form', { class: 'card', style: 'max-width:520px' });
  const nameIn = input({ name: 'name', value: me.name, required: true });
  const phoneIn = input({ name: 'phone', value: me.phone, required: true, type: 'tel' });
  const addressIn = input({ name: 'address', value: me.address || '' });
  const areaSel = select({ name: 'area' },
    [{ value: '', label: 'No county set' }, ...m.areas.map((a) => ({ value: a.key, label: a.name }))],
    me.area || '');
  const btn = el('button', { class: 'btn primary' }, 'Save');

  form.append(
    field('Your name', nameIn),
    field('Mobile', phoneIn),
    field('Address', addressIn),
    field('Your county', areaSel),
    el('div', { class: 'row', style: 'margin-top:1rem' }, btn));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await saveMe({
        name: nameIn.value, phone: phoneIn.value,
        address: addressIn.value, area: areaSel.value,
      });
      session.customer = r.customer;
      btn.disabled = false; btn.textContent = 'Save';
      form.prepend(notice('ok', 'Saved.'));
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Save';
      form.prepend(notice('err', err.message));
    }
  });

  clear(mount).append(
    el('a', { href: '/me', class: 'muted' }, '← My jobs'),
    el('h1', { style: 'margin-top:.6rem' }, 'Your details'),
    el('p', { class: 'lede' }, 'What a tradesperson sees when you book, and where your search starts.'),
    form,
    el('p', { class: 'muted', style: 'margin-top:1rem' }, `Signed in as ${me.email}.`));
}
