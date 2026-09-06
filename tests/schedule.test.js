'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../server/lib/schedule');

const MON_0600Z = Date.parse('2026-09-07T06:00:00Z'); // a Monday

test('local wall time survives a DST change', () => {
  // Ireland leaves summer time at 02:00 on 2026-10-25. "Tuesday 08:00" must
  // stay 08:00 on both sides of it, which is the whole reason the working
  // week is stored as wall time rather than as instants.
  const before = S.zonedToUtc(2026, 10, 20, 8, 0, 'Europe/Dublin');
  const after = S.zonedToUtc(2026, 11, 3, 8, 0, 'Europe/Dublin');
  assert.strictEqual(new Date(before).toISOString(), '2026-10-20T07:00:00.000Z', 'IST is UTC+1');
  assert.strictEqual(new Date(after).toISOString(), '2026-11-03T08:00:00.000Z', 'GMT is UTC+0');
  assert.strictEqual(S.zonedParts(before, 'Europe/Dublin').hour, 8);
  assert.strictEqual(S.zonedParts(after, 'Europe/Dublin').hour, 8);
});

test('lead time keeps the next hour off the board', () => {
  const av = { ...S.defaultAvailability('p'), leadTimeHours: 12 };
  const slots = S.slotsFor(av, 60, { now: MON_0600Z, days: 3 });
  assert.ok(slots.length > 0);
  assert.ok(Date.parse(slots[0].start) - MON_0600Z >= 12 * 3600000);
});

test('a booking blocks its own time plus the travel buffer on both sides', () => {
  const av = { ...S.defaultAvailability('p'), bufferMinutes: 30, leadTimeHours: 0 };
  const busy = [{ start: '2026-09-08T10:00:00Z', end: '2026-09-08T11:00:00Z' }];
  const labels = S.slotsFor(av, 60, { now: MON_0600Z, days: 2, busy })
    .filter((s) => s.date === '2026-09-08').map((s) => s.label);
  // 10:00-11:00Z is 11:00-12:00 local. A 60 minute job must therefore finish
  // by 10:30 local and cannot restart before 12:30 — one buffer of travel on
  // each side of the booking, not one shared between them.
  assert.ok(labels.includes('09:30'), 'a job finishing exactly on the buffer edge is allowed');
  assert.ok(!labels.includes('10:00'), 'a job finishing inside the buffer is refused');
  assert.ok(!labels.includes('11:30'), 'a job starting inside the booking is refused');
  assert.ok(!labels.includes('12:00'), 'a job starting inside the trailing buffer is refused');
  assert.ok(labels.includes('12:30'), 'the first start clear of the buffer is offered');
});

test('offered start times sit on the step grid, not the window edge', () => {
  const av = { ...S.defaultAvailability('p'), leadTimeHours: 0, slotStepMinutes: 30 };
  av.weekly.tue = [{ start: '08:15', end: '17:00' }];
  const slots = S.slotsFor(av, 60, { now: MON_0600Z, days: 2 }).filter((s) => s.date === '2026-09-08');
  assert.ok(slots.every((s) => ['00', '30'].includes(s.label.slice(3))), 'every start is on the half hour');
});

test('a day with no working window offers nothing', () => {
  const av = S.defaultAvailability('p');           // sat and sun are empty
  const slots = S.slotsFor(av, 60, { now: Date.parse('2026-09-11T06:00:00Z'), days: 2 });
  assert.ok(slots.every((s) => !['2026-09-12', '2026-09-13'].includes(s.date)));
});

test('a job longer than the working day is never offered', () => {
  const av = { ...S.defaultAvailability('p'), leadTimeHours: 0 };
  assert.strictEqual(S.slotsFor(av, 10 * 60, { now: MON_0600Z, days: 7 }).length, 0);
});

test('manual blocks are honoured alongside bookings', () => {
  const av = { ...S.defaultAvailability('p'), leadTimeHours: 0, bufferMinutes: 0 };
  av.blocks = [{ start: '2026-09-08T07:00:00Z', end: '2026-09-08T16:00:00Z', reason: 'Holiday' }];
  const slots = S.slotsFor(av, 60, { now: MON_0600Z, days: 2 });
  assert.ok(!slots.some((s) => s.date === '2026-09-08'), 'the blocked day is gone entirely');
});
