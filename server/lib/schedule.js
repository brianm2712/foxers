'use strict';
/*
 * Availability and slot generation.
 *
 * This is the machinery that makes instant booking possible: a pro's working
 * week, minus what is already booked, minus the buffer they need to get from
 * one address to the next, minus anything inside their lead time — sliced
 * into offerable start times for a service of known duration.
 *
 * Times are stored two ways on purpose. The working week is LOCAL wall time
 * ("Tuesday 08:00"), because that is what the pro means and it must survive a
 * clock change. Bookings are UTC instants, because that is what a calendar
 * comparison needs. The conversion between them is the only tricky code here
 * and lives in zonedToUtc/tzOffset.
 */

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Offset of `tz` from UTC, in ms, at a given instant. DST-correct. */
function tzOffset(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) p[type] = value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - utcMs;
}

/** Local wall time in `tz` -> UTC ms. */
function zonedToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // One correction pass is enough everywhere except the hour that does not
  // exist on a spring-forward morning, which lands on the following hour.
  let utc = guess - tzOffset(guess, tz);
  utc = guess - tzOffset(utc, tz);
  return utc;
}

/** Calendar date parts for an instant, as seen in `tz`. */
function zonedParts(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute,
    weekday: p.weekday.toLowerCase().slice(0, 3),
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const hh = +m[1], mm = +m[2];
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

function defaultAvailability(proId) {
  return {
    proId,
    tz: 'Europe/Dublin',
    weekly: {
      mon: [{ start: '08:00', end: '17:00' }],
      tue: [{ start: '08:00', end: '17:00' }],
      wed: [{ start: '08:00', end: '17:00' }],
      thu: [{ start: '08:00', end: '17:00' }],
      fri: [{ start: '08:00', end: '16:00' }],
      sat: [],
      sun: [],
    },
    blocks: [],            // { start, end, reason } — holidays, existing commitments
    leadTimeHours: 12,     // nothing bookable inside this
    bufferMinutes: 30,     // travel between addresses
    maxDaysAhead: 60,
    slotStepMinutes: 30,   // offered start times land on the half hour
    emergencyCallouts: true,
  };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Free start times for a service of `durationMinutes`.
 *
 * busy = [{ start: ISO, end: ISO }] — confirmed bookings and manual blocks.
 * Returns [{ start: ISO, end: ISO, label, date }] in chronological order.
 */
function slotsFor(availability, durationMinutes, opts = {}) {
  const av = availability;
  const tz = av.tz || 'Europe/Dublin';
  const now = opts.now ?? Date.now();
  const days = Math.min(Number(opts.days || 14), Number(av.maxDaysAhead || 60));
  const step = Number(av.slotStepMinutes || 30) * 60000;
  const buffer = Number(av.bufferMinutes || 0) * 60000;
  const duration = Number(durationMinutes) * 60000;
  const earliest = now + Number(av.leadTimeHours || 0) * 3600000;
  const limit = Number(opts.limit || 400);

  if (!Number.isFinite(duration) || duration <= 0) return [];

  const busy = (opts.busy || []).map((b) => ({
    start: Date.parse(b.start), end: Date.parse(b.end),
  })).filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end));

  for (const b of av.blocks || []) {
    const s = Date.parse(b.start), e = Date.parse(b.end);
    if (Number.isFinite(s) && Number.isFinite(e)) busy.push({ start: s, end: e });
  }

  const out = [];
  const startFrom = opts.from ? Date.parse(opts.from) : now;
  const cursor = zonedParts(Math.max(startFrom, now), tz);
  let dayUtc = zonedToUtc(cursor.year, cursor.month, cursor.day, 12, 0, tz); // midday anchor avoids DST edges

  for (let d = 0; d < days && out.length < limit; d++) {
    const p = zonedParts(dayUtc, tz);
    const windows = (av.weekly && av.weekly[p.weekday]) || [];

    for (const w of windows) {
      const s = parseHm(w.start), e = parseHm(w.end);
      if (!s || !e) continue;
      const winStart = zonedToUtc(p.year, p.month, p.day, s.hh, s.mm, tz);
      const winEnd = zonedToUtc(p.year, p.month, p.day, e.hh, e.mm, tz);
      if (winEnd <= winStart) continue;

      // Align the first candidate to the step grid rather than the window
      // start, so a 08:00–17:00 day offers 08:00, 08:30, … not 08:07.
      let t = Math.max(winStart, Math.ceil(earliest / step) * step);
      t = Math.ceil(t / step) * step;

      for (; t + duration <= winEnd && out.length < limit; t += step) {
        const end = t + duration;
        // The buffer applies on both sides: the pro needs to travel to this
        // job and away from it.
        const clash = busy.some((b) => overlaps(t - buffer, end + buffer, b.start, b.end));
        if (clash) continue;
        const lp = zonedParts(t, tz);
        out.push({
          start: new Date(t).toISOString(),
          end: new Date(end).toISOString(),
          date: lp.date,
          label: `${String(lp.hour).padStart(2, '0')}:${String(lp.minute).padStart(2, '0')}`,
        });
      }
    }
    dayUtc += 24 * 3600000;
  }

  return out;
}

/** Group slots into days for rendering. */
function groupByDay(slots, tz = 'Europe/Dublin') {
  const map = new Map();
  for (const s of slots) {
    if (!map.has(s.date)) {
      const p = zonedParts(Date.parse(s.start), tz);
      map.set(s.date, {
        date: s.date,
        weekday: p.weekday,
        label: new Intl.DateTimeFormat('en-IE', {
          timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
        }).format(new Date(s.start)),
        slots: [],
      });
    }
    map.get(s.date).slots.push(s);
  }
  return [...map.values()];
}

module.exports = { DAYS, tzOffset, zonedToUtc, zonedParts, parseHm, defaultAvailability, slotsFor, groupByDay };
