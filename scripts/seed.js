#!/usr/bin/env node
'use strict';
/*
 * Demo data. Run against an empty data dir to get a marketplace with enough
 * in it to be worth looking at — a search that returns results, profiles with
 * real slots, and a job part-way through the invoice cycle.
 *
 *   FOXXERS_DATA=./data node scripts/seed.js
 */

const path = require('path');
const fs = require('fs');
const { Store } = require('../server/lib/store');
const auth = require('../server/lib/auth');
const D = require('../server/lib/domain');
const { BY_KEY } = require('../server/lib/trades');
const { slotsFor } = require('../server/lib/schedule');

const DATA_DIR = process.env.FOXXERS_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(path.join(DATA_DIR, 'foxxers.json'));

if (store.all('pros').length && !process.argv.includes('--force')) {
  console.error('Data already present. Pass --force to add the demo set anyway.');
  process.exit(1);
}

const PASSWORD = process.env.FOXXERS_SEED_PASSWORD || 'foxxers-demo-2026';

const PROS = [
  {
    name: 'Declan Byrne', business: 'Byrne Electrical', trades: ['electrician'],
    areas: ['dublin', 'wicklow', 'kildare'], phone: '087 555 0142',
    bio: 'RECI registered. Domestic and light commercial across south Dublin and Wicklow. EV chargers, board upgrades, periodic inspection.',
    vatRegistered: true, vatNumber: 'IE1234567X', withholdingRate: 20, hourlyRate: 65, calloutFee: 60,
    services: [
      { name: 'EV charger site survey', minutes: 45, price: 75, bookable: true },
      { name: 'Fuse board inspection', minutes: 60, price: 120, bookable: true },
      { name: 'Socket or light fitting install', minutes: 60, price: 95, bookable: true },
      { name: 'Periodic inspection report', minutes: 180, price: 320, bookable: true },
      { name: 'Full rewire', minutes: 480, price: 0, bookable: false, description: 'Quoted after a site visit.' },
    ],
  },
  {
    name: 'Marek Nowak', business: 'Nowak Plumbing & Heating', trades: ['plumber', 'gas'],
    areas: ['dublin', 'meath', 'louth'], phone: '086 555 0198',
    bio: 'RGI registered gas installer. Boiler service and replacement, bathrooms, leak callouts. 24 hour emergency cover in north Dublin.',
    vatRegistered: true, vatNumber: 'IE7654321Y', withholdingRate: 0, hourlyRate: 70, calloutFee: 85,
    services: [
      { name: 'Annual boiler service', minutes: 60, price: 110, bookable: true },
      { name: 'Gas safety inspection (landlord)', minutes: 60, price: 95, bookable: true },
      { name: 'Tap or mixer replacement', minutes: 45, price: 85, bookable: true },
      { name: 'Outside tap install', minutes: 60, price: 140, bookable: true },
      { name: 'Leak — emergency callout', minutes: 90, price: 0, bookable: false, description: 'Same day where possible.' },
      { name: 'Bathroom refit', minutes: 480, price: 0, bookable: false },
    ],
  },
  {
    name: 'Aoife Kelleher', business: 'Kelleher Carpentry', trades: ['carpenter'],
    areas: ['cork', 'kerry'], phone: '085 555 0177', region: 'IE',
    bio: 'Second fix, fitted furniture and kitchens. Cork city and county. Fifteen years on the tools.',
    vatRegistered: true, vatNumber: 'IE2468013Z', withholdingRate: 35, hourlyRate: 55,
    services: [
      { name: 'Internal door hang (per door)', minutes: 90, price: 130, bookable: true },
      { name: 'Flat-pack assembly (per hour)', minutes: 60, price: 55, bookable: true },
      { name: 'Shelving install', minutes: 120, price: 180, bookable: true },
      { name: 'Fitted wardrobes', minutes: 480, price: 0, bookable: false },
    ],
  },
  {
    name: 'Tomás Ó Riain', business: 'Ó Riain Roofing', trades: ['roofer'],
    areas: ['galway', 'mayo', 'clare'], phone: '083 555 0121',
    bio: 'Re-roofs, storm damage and gutters. Fully insured, working out of Galway city.',
    vatRegistered: false, withholdingRate: 20, hourlyRate: 50,
    services: [
      { name: 'Roof inspection and report', minutes: 60, price: 90, bookable: true },
      { name: 'Gutter clean (semi-d)', minutes: 90, price: 120, bookable: true },
      { name: 'Slate replacement (up to 5)', minutes: 120, price: 190, bookable: true },
      { name: 'Storm damage — emergency', minutes: 240, price: 0, bookable: false },
    ],
  },
  {
    name: 'Sarah McAllister', business: 'McAllister Electrical NI', trades: ['electrician', 'appliance'],
    areas: ['belfast', 'antrim', 'down'], phone: '07700 900142', region: 'UK',
    bio: 'NICEIC approved. Belfast and greater Antrim. Domestic rewires, EICRs and EV charge points.',
    vatRegistered: true, vatNumber: 'GB123456789', withholdingRate: 20, hourlyRate: 55,
    services: [
      { name: 'EICR — 3 bed semi', minutes: 180, price: 220, bookable: true },
      { name: 'EV charge point survey', minutes: 45, price: 60, bookable: true },
      { name: 'Consumer unit inspection', minutes: 60, price: 90, bookable: true },
      { name: 'Full rewire', minutes: 480, price: 0, bookable: false },
    ],
  },
  {
    name: 'Liam Fitzgerald', business: 'Fitz Painting & Decorating', trades: ['painter', 'plasterer'],
    areas: ['dublin', 'kildare'], phone: '089 555 0166',
    bio: 'Interiors and exteriors, domestic only. Dust sheets down, everything back where it was.',
    vatRegistered: false, withholdingRate: 0, hourlyRate: 40,
    services: [
      { name: 'Colour consultation and measure', minutes: 45, price: 40, bookable: true },
      { name: 'Patch repair — single wall', minutes: 180, price: 160, bookable: true },
      { name: 'Whole house interior', minutes: 480, price: 0, bookable: false },
    ],
  },
];

/* Fold accents before stripping, or "Ó Riain" becomes ".riain". */
function slugEmail(business) {
  return business.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

const passwordHash = auth.hashPassword(PASSWORD);
const created = [];

for (const spec of PROS) {
  const pro = D.createPro(store, {
    ...spec,
    email: `${slugEmail(spec.business)}@example.com`,
    passwordHash,
    invoicePrefix: spec.business.split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 3),
  });
  store.update('pros', pro.id, { verified: true });
  for (const s of spec.services) D.addService(store, pro.id, s);
  created.push(pro);
}

async function main() {
  /*
   * A customer account, so the other half of the app can be signed into with
   * the same demo password. Every job below belongs to her.
   */
  const ciara = D.createCustomerAccount(store, {
    name: 'Ciara Doyle', email: 'ciara@example.com', phone: '087 555 0303',
    address: '14 Grange Road, Rathfarnham, Dublin 16', area: 'dublin',
    passwordHash,
  });

  /* One job all the way through, so the money screen is not empty. */
  const declan = created[0];
  const { request } = await D.createRequest(store, () => 'seed', {
    trade: 'electrician', area: 'dublin', urgency: 'week',
    description: 'Kitchen sockets keep tripping the board. Two double sockets and the oven circuit. House is a 1970s semi in Rathfarnham.',
    proId: declan.id,
    customerId: ciara.id,
  });

  const quote = D.createQuote(store, declan.id, {
    requestId: request.id,
    title: 'Kitchen circuit repair and socket replacement',
    lines: [
      { kind: 'labour', description: 'Fault finding and testing', qty: 3, unitPrice: 65, vatClass: 'reduced' },
      { kind: 'labour', description: 'Replace two double sockets', qty: 1.5, unitPrice: 65, vatClass: 'reduced' },
      { kind: 'materials', description: 'MK double sockets', qty: 2, unitPrice: 18.5, vatClass: 'reduced' },
      { kind: 'materials', description: '2.5mm T&E cable (25m)', qty: 1, unitPrice: 42, vatClass: 'reduced' },
    ],
    withholdingRate: 20,
    notes: 'Price assumes the existing run is reusable. If the cable has to be pulled back to the board that is a variation.',
    terms: 'Payment within 14 days of invoice. Materials remain the property of Byrne Electrical until paid in full.',
  });
  await D.acceptQuote(store, quote.id, 'customer');
  const invoice = D.createInvoice(store, declan.id, {
    quoteId: quote.id,
    variations: [{ kind: 'labour', description: 'Additional cable run to board (agreed on site)', qty: 1, unitPrice: 85, vatClass: 'reduced' }],
    withholdingRate: 20,
    dueDays: 14,
  });
  /* Backdate it so the chase engine has something to say. */
  store.update('invoices', invoice.id, {
    issuedAt: new Date(Date.now() - 24 * 86400000).toISOString(),
    dueAt: new Date(Date.now() - 10 * 86400000).toISOString(),
  });

  /*
   * A quote sitting with the customer, with real times on it — this is the one
   * that shows the part that matters: accepting it books the hour.
   */
  const { request: waiting } = await D.createRequest(store, () => 'seed', {
    trade: 'electrician', area: 'dublin', urgency: 'flexible',
    description: 'Want an EV charger on the gable wall. Board is in the hall, car sits on the drive about eight metres away.',
    proId: declan.id,
    customerId: ciara.id,
  });
  const offered = slotsFor(D.availabilityFor(store, declan.id), 180, {
    days: 21, busy: D.busyFor(store, declan.id),
  }).filter((_, i) => i % 7 === 0).slice(0, 3).map((sl) => sl.start);
  D.createQuote(store, declan.id, {
    requestId: waiting.id,
    title: 'EV charger supply and install — 7.4kW',
    minutes: 180,
    slots: offered,
    lines: [
      { kind: 'labour', description: 'Install and commission charge point', qty: 4, unitPrice: 65, vatClass: 'reduced' },
      { kind: 'materials', description: '7.4kW charge point', qty: 1, unitPrice: 690, vatClass: 'reduced' },
      { kind: 'materials', description: 'Type A RCBO, cable and containment', qty: 1, unitPrice: 145, vatClass: 'reduced' },
    ],
    withholdingRate: 20,
    notes: 'Assumes the board has a free way and the run is surface-clipped. Chasing the wall is extra.',
    terms: 'Payment on completion by card, wallet or transfer.',
  });

  /*
   * And one that was turned down, so the foxxer's earned deposits are not zero.
   */
  const { request: turned } = await D.createRequest(store, () => 'seed', {
    trade: 'electrician', area: 'dublin', urgency: 'planning',
    description: 'Thinking about rewiring the whole house next year, wondering roughly what it would run to.',
    proId: declan.id,
    customerId: ciara.id,
  });
  const rejected = D.createQuote(store, declan.id, {
    requestId: turned.id,
    title: 'Full rewire — three bed semi',
    lines: [
      { kind: 'labour', description: 'Rewire, first and second fix', qty: 60, unitPrice: 65, vatClass: 'reduced' },
      { kind: 'materials', description: 'Cable, boxes, accessories, board', qty: 1, unitPrice: 2400, vatClass: 'reduced' },
    ],
    withholdingRate: 20,
  });
  await D.declineQuote(store, rejected.id, 'Leaving it until next year.');

  /*
   * One job all the way to the door: quoted with times, accepted into the
   * diary, invoiced and tapped on the card reader — which is what produces a
   * receipt, and the receipt is the thing the customer keeps.
   */
  const { request: finished } = await D.createRequest(store, () => 'seed', {
    trade: 'electrician', area: 'dublin', urgency: 'week',
    description: 'Outside light at the back door is dead and the switch feels warm to touch.',
    proId: declan.id,
    customerId: ciara.id,
  });
  const doneSlots = slotsFor(D.availabilityFor(store, declan.id), 60, {
    days: 21, busy: D.busyFor(store, declan.id),
  }).slice(0, 2).map((sl) => sl.start);
  const doneQuote = D.createQuote(store, declan.id, {
    requestId: finished.id,
    title: 'Outside light — replace fitting and switch',
    minutes: 60,
    slots: doneSlots,
    lines: [
      { kind: 'labour', description: 'Diagnose and replace', qty: 1, unitPrice: 65, vatClass: 'reduced' },
      { kind: 'materials', description: 'IP65 bulkhead fitting and switch', qty: 1, unitPrice: 48, vatClass: 'reduced' },
    ],
    withholdingRate: 0,
  });
  await D.acceptQuote(store, doneQuote.id, 'customer', { start: doneSlots[0] });
  const doneInvoice = D.createInvoice(store, declan.id, { quoteId: doneQuote.id, dueDays: 14 });
  await D.settleInvoice(store, doneInvoice.id, { method: 'card_reader' });

  /* And one still waiting to be priced, so the Requests screen is not empty. */
  await D.createRequest(store, () => 'seed', {
    trade: 'electrician', area: 'dublin', urgency: 'week',
    description: 'Immersion trips the RCD every time it goes on. Two-storey house in Terenure, cylinder in the hot press upstairs.',
    proId: declan.id,
    customerId: ciara.id,
  });

  /* A couple of straightforward bookings, and reviews behind them. */
  const marek = created[1];
  const boilerService = store.find('services', (s) => s.proId === marek.id && s.bookable);
  const past = new Date(Date.now() - 9 * 86400000);
  past.setUTCHours(9, 0, 0, 0);
  const pastBooking = store.insert('bookings', {
    ref: 'HJKL-2347', proId: marek.id, serviceId: boilerService.id,
    customerId: D.upsertCustomer(store, { name: 'Eoin Walsh', phone: '086 555 0404', address: '7 Seapark, Malahide, Co. Dublin' }).id,
    kind: 'booking', status: 'done',
    start: past.toISOString(), end: new Date(past.getTime() + boilerService.minutes * 60000).toISOString(),
    minutes: boilerService.minutes, price: boilerService.price,
    address: '7 Seapark, Malahide, Co. Dublin', notes: 'Vaillant, about 8 years old.',
    acceptedAt: past.toISOString(), doneAt: past.toISOString(),
  });
  D.addReview(store, { bookingId: pastBooking.id, rating: 5, text: 'Arrived when he said he would, serviced the boiler and sent the cert the same evening. Booked the next one already.' });

  for (const [pro, rating, text] of [
    [created[0], 5, 'Straight answer on the phone and a written quote the same day. No messing.'],
    [created[0], 4, 'Good work on the board. Took a day longer than planned but he told me up front.'],
    [created[2], 5, 'Beautiful job on the wardrobes. Tidied up better than she found it.'],
    [created[3], 4, 'Fixed the ridge tiles after the storm. Fair price for an emergency.'],
  ]) {
    const svc = store.find('services', (s) => s.proId === pro.id);
    const b = store.insert('bookings', {
      ref: require('../server/lib/store').newRef(), proId: pro.id, serviceId: svc.id,
      customerId: D.upsertCustomer(store, { name: 'Past customer', phone: `08${Math.floor(Math.random() * 9)} 555 0${Math.floor(Math.random() * 900 + 100)}` }).id,
      kind: 'booking', status: 'done',
      start: new Date(Date.now() - 30 * 86400000).toISOString(),
      end: new Date(Date.now() - 30 * 86400000 + 3600000).toISOString(),
      minutes: svc.minutes, price: svc.price, address: '', notes: '',
    });
    D.addReview(store, { bookingId: b.id, rating, text });
  }

  store.saveNow();

  console.log(`Seeded ${created.length} tradespeople, ${store.all('services').length} services, ${store.all('reviews').length} reviews.`);
  console.log(`Sign in with any of:`);
  for (const p of created) console.log(`  ${p.email}  (${p.business})`);
  console.log(`Password: ${PASSWORD}`);
  console.log(`\nOr as a customer: ciara@example.com  (same password)`);

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
