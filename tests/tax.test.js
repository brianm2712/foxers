'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { priceLines, nextInvoiceNumber } = require('../server/lib/tax');

const LINES = [
  { kind: 'labour', description: 'Labour', qty: 8, unitPrice: 65, vatClass: 'reduced' },
  { kind: 'materials', description: 'Cable', qty: 1, unitPrice: 120, vatClass: 'reduced' },
];

test('Irish reduced rate applies at 13.5% on the net', () => {
  const t = priceLines(LINES, { region: 'IE' });
  assert.strictEqual(t.netLabour, 520);
  assert.strictEqual(t.netMaterials, 120);
  assert.strictEqual(t.net, 640);
  assert.strictEqual(t.vat, 86.4);
  assert.strictEqual(t.gross, 726.4);
});

test('RCT is withheld from the net, never from the VAT', () => {
  const t = priceLines(LINES, { region: 'IE', withholdingRate: 20 });
  assert.strictEqual(t.withholding.scheme, 'RCT');
  assert.strictEqual(t.withholding.base, 640, 'RCT base is the whole net, labour and materials');
  assert.strictEqual(t.withholding.amount, 128);
  assert.strictEqual(t.payable, 726.4 - 128);
});

test('CIS is withheld from labour only', () => {
  const t = priceLines(LINES, { region: 'UK', withholdingRate: 20 });
  assert.strictEqual(t.withholding.scheme, 'CIS');
  assert.strictEqual(t.withholding.base, 520, 'materials are excluded under CIS');
  assert.strictEqual(t.withholding.amount, 104);
});

test('reverse charge zeroes the VAT charged but still reports the rate', () => {
  const t = priceLines(LINES, { region: 'IE', reverseCharge: true });
  assert.strictEqual(t.vat, 0);
  assert.strictEqual(t.gross, t.net, 'nothing is added to the net');
  assert.match(t.reverseChargeNote, /Principal Contractor/);
  assert.strictEqual(t.vatBreakdown[0].rate, 13.5, 'the 13.5% band is still declared');
  assert.strictEqual(t.vatBreakdown[0].vat, 86.4, 'and the amount the customer must account for is shown');
});

test('reverse charge and RCT compose', () => {
  const t = priceLines(LINES, { region: 'IE', reverseCharge: true, withholdingRate: 35 });
  assert.strictEqual(t.gross, 640);
  assert.strictEqual(t.withholding.amount, 224);
  assert.strictEqual(t.payable, 416);
});

test('mixed VAT rates are banded separately', () => {
  const t = priceLines([
    { kind: 'labour', qty: 1, unitPrice: 100, vatClass: 'reduced' },
    { kind: 'materials', qty: 1, unitPrice: 100, vatClass: 'standard' },
  ], { region: 'IE' });
  assert.strictEqual(t.vat, 13.5 + 23);
  assert.strictEqual(t.vatBreakdown.length, 2);
  assert.deepStrictEqual(t.vatBreakdown.map((b) => b.rate), [23, 13.5]);
});

test('an off-scheme withholding rate is refused', () => {
  assert.throws(() => priceLines(LINES, { region: 'IE', withholdingRate: 30 }), /20\/35/);
  assert.throws(() => priceLines(LINES, { region: 'UK', withholdingRate: 35 }), /20\/30/);
});

test('invoice numbers are sequential within the year and restart on rollover', () => {
  const pro = { invoicePrefix: 'BE', invoiceSeq: null };
  const a = nextInvoiceNumber(pro);
  const year = new Date().getUTCFullYear();
  assert.strictEqual(a.number, `BE-${year}-0001`);
  pro.invoiceSeq = a.seq;
  assert.strictEqual(nextInvoiceNumber(pro).number, `BE-${year}-0002`);
  pro.invoiceSeq = { year: year - 1, n: 97 };
  assert.strictEqual(nextInvoiceNumber(pro).number, `BE-${year}-0001`);
});

test('cent rounding does not drift on awkward quantities', () => {
  const t = priceLines([{ kind: 'labour', qty: 3, unitPrice: 33.33, vatClass: 'reduced' }], { region: 'IE' });
  assert.strictEqual(t.net, 99.99);
  assert.strictEqual(t.vat, 13.5);
  assert.strictEqual(t.gross, 113.49);
});
