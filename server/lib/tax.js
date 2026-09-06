'use strict';
/*
 * Construction tax for Ireland and the UK.
 *
 * This is the part generic invoicing tools get wrong, so it lives in one
 * module with one set of tests rather than being sprinkled through the
 * invoice renderer. Rates are data, not literals in the calculation, so a
 * budget change is an edit to RATES and nothing else.
 *
 * NOT tax advice. The rates below are the published ones as of 2026-09;
 * an accountant signs them off before a real invoice goes out.
 */

const RATES = {
  IE: {
    vat: {
      reduced:  { rate: 13.5, label: 'VAT 13.5%',  note: 'Reduced rate — most construction services' },
      standard: { rate: 23.0, label: 'VAT 23%',    note: 'Standard rate — supply-only goods, some services' },
      second:   { rate: 9.0,  label: 'VAT 9%',     note: 'Second reduced rate' },
      zero:     { rate: 0.0,  label: 'VAT 0%',     note: 'Zero rated' },
      exempt:   { rate: 0.0,  label: 'Exempt',     note: 'Exempt from VAT' },
    },
    // Relevant Contracts Tax. A principal contractor withholds this from
    // payments to a subcontractor. Revenue sets the rate per subcontractor.
    withholding: {
      name: 'RCT',
      rates: [0, 20, 35],
      label: (r) => `RCT ${r}%`,
      note: 'Withheld by the principal contractor and paid to Revenue',
    },
    reverseChargeNote:
      'VAT on this supply is to be accounted for by the Principal Contractor ' +
      'under the VAT reverse charge for construction services (VAT Act 1972, s.16(3)).',
  },
  UK: {
    vat: {
      reduced:  { rate: 5.0,  label: 'VAT 5%',  note: 'Reduced rate — qualifying conversions and energy saving' },
      standard: { rate: 20.0, label: 'VAT 20%', note: 'Standard rate' },
      second:   { rate: 5.0,  label: 'VAT 5%',  note: 'Reduced rate' },
      zero:     { rate: 0.0,  label: 'VAT 0%',  note: 'Zero rated — new build' },
      exempt:   { rate: 0.0,  label: 'Exempt',  note: 'Exempt from VAT' },
    },
    // Construction Industry Scheme. Same shape as RCT, different rates, and
    // it is withheld from the LABOUR element only — materials are excluded.
    withholding: {
      name: 'CIS',
      rates: [0, 20, 30],
      label: (r) => `CIS ${r}%`,
      note: 'Deducted from the labour element only and paid to HMRC',
      labourOnly: true,
    },
    reverseChargeNote:
      'Reverse charge: VAT Act 1994 s.55A applies. Customer to account to HMRC ' +
      'for the reverse charge output tax on the VAT-exclusive price of these items.',
  },
};

/** Round to cents, away from zero, without the float drift of toFixed. */
function cents(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function regionOf(code) {
  const r = RATES[String(code || 'IE').toUpperCase()];
  if (!r) throw new Error(`unknown tax region: ${code}`);
  return r;
}

/**
 * Price a set of line items.
 *
 * line = { kind: 'labour'|'materials', description, qty, unitPrice, vatClass }
 * opts = {
 *   region: 'IE'|'UK',
 *   reverseCharge: bool,     // B2B construction — supplier does not charge VAT
 *   withholdingRate: 0|20|35 // RCT/CIS rate the principal will withhold
 * }
 *
 * Order matters and is the thing tools get wrong:
 *   1. VAT is computed on the net, per line, at that line's own rate.
 *   2. Reverse charge zeroes the VAT charged but still reports it.
 *   3. Withholding is computed on the NET, never on the VAT, and under CIS
 *      on the labour element only.
 */
function priceLines(lines, opts = {}) {
  const region = regionOf(opts.region);
  const reverseCharge = !!opts.reverseCharge;
  const withholdingRate = Number(opts.withholdingRate || 0);

  if (!region.withholding.rates.includes(withholdingRate)) {
    throw new Error(
      `${region.withholding.name} rate must be one of ${region.withholding.rates.join('/')}`
    );
  }

  const priced = [];
  let netLabour = 0;
  let netMaterials = 0;
  const vatByRate = new Map();

  for (const line of lines) {
    const qty = Number(line.qty ?? 1);
    const unit = Number(line.unitPrice ?? 0);
    if (!Number.isFinite(qty) || !Number.isFinite(unit)) {
      throw new Error(`line "${line.description}" has a non-numeric qty or price`);
    }
    const vatClass = line.vatClass || 'reduced';
    const band = region.vat[vatClass];
    if (!band) throw new Error(`unknown VAT class: ${vatClass}`);

    const net = cents(qty * unit);
    const kind = line.kind === 'materials' ? 'materials' : 'labour';
    if (kind === 'materials') netMaterials = cents(netMaterials + net);
    else netLabour = cents(netLabour + net);

    // Reverse charge: the rate still applies notionally and must be shown,
    // but nothing is charged. Keep both numbers.
    const vatDue = cents(net * (band.rate / 100));
    const vatCharged = reverseCharge ? 0 : vatDue;

    const key = String(band.rate);
    const acc = vatByRate.get(key) || { rate: band.rate, label: band.label, net: 0, vat: 0 };
    acc.net = cents(acc.net + net);
    acc.vat = cents(acc.vat + vatDue);
    vatByRate.set(key, acc);

    priced.push({ ...line, kind, qty, unitPrice: unit, vatClass, vatRate: band.rate, net, vatDue, vatCharged });
  }

  const net = cents(netLabour + netMaterials);
  const vat = reverseCharge ? 0 : cents([...vatByRate.values()].reduce((s, b) => s + b.vat, 0));
  const gross = cents(net + vat);

  // The base the principal withholds from.
  const withholdingBase = region.withholding.labourOnly ? netLabour : net;
  const withheld = cents(withholdingBase * (withholdingRate / 100));
  const payable = cents(gross - withheld);

  return {
    region: opts.region || 'IE',
    lines: priced,
    netLabour,
    netMaterials,
    net,
    vat,
    gross,
    reverseCharge,
    reverseChargeNote: reverseCharge ? region.reverseChargeNote : null,
    vatBreakdown: [...vatByRate.values()].sort((a, b) => b.rate - a.rate),
    withholding: {
      scheme: region.withholding.name,
      rate: withholdingRate,
      base: withholdingBase,
      amount: withheld,
      note: withholdingRate > 0 ? region.withholding.note : null,
    },
    payable,
  };
}

/**
 * Sequential invoice numbers, per pro, with no gaps.
 *
 * Revenue requires a sequence. A number derived from a timestamp or a random
 * id is not one, and neither is a number that skips when a draft is deleted —
 * which is why the counter only advances at issue, never at draft.
 */
function nextInvoiceNumber(pro) {
  const year = new Date().getUTCFullYear();
  const seq = (pro.invoiceSeq && pro.invoiceSeq.year === year) ? pro.invoiceSeq.n + 1 : 1;
  return {
    number: `${pro.invoicePrefix || 'INV'}-${year}-${String(seq).padStart(4, '0')}`,
    seq: { year, n: seq },
  };
}

function vatClasses(regionCode) {
  const region = regionOf(regionCode);
  return Object.entries(region.vat).map(([key, b]) => ({ key, ...b }));
}

function withholdingRates(regionCode) {
  const region = regionOf(regionCode);
  return { scheme: region.withholding.name, rates: region.withholding.rates };
}

module.exports = { RATES, cents, priceLines, nextInvoiceNumber, vatClasses, withholdingRates, regionOf };
