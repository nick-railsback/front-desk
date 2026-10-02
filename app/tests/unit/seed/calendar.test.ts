// holiday calendar: for every date from the creation date (the calendar date
// of `now` in America/Denver) through 365 days after it, each center holiday
// on that date is in the calendar with its date and its status. Holidays are
// expected on their actual dates, not on a weekday they might be observed on.
//
// generated entries: one staff development day closure on a weekday 6 to 10
// days after the creation date; Picture Day 1 to 7 days after it, with a time
// of day; Fall Family Night dated the day before it; a menu for every weekday
// from the creation date through 10 days after it.
//
// alerts: exactly two. One is active from 6:00 AM to 6:00 PM on the creation
// date with the parking lot text; "Water service interruption" expired on the
// day before the creation date.
//
// All of this holds for any `now`; each check runs against every moment in
// NOWS (late evening, weekend, daylight saving changes, the winter closure,
// and years away from the real clock).
//
// Assumed interface: `seed(now)` from app/src/seed/index.ts, with the Seed
// shape documented in ./support.ts: `structured.calendar[]` as
// `{ id, date, name, status: 'open' | 'closed', time }` with one entry per
// date, `structured.menus[]` as `{ date, items }`, and `structured.alerts[]`
// as `{ id, text, startsAt, expiresAt }` with ISO 8601 instants.

import { describe, expect, test } from 'vitest';
import { NOWS, addDays, denverDate, denverWallClock, isWeekday, nthWeekday, seedAt, weekdayOf, ymd } from './support';

type Entry = { id: string; date: string; name: string; status: string; time: string | null };
type Expected = { date: string; status: 'open' | 'closed'; name: RegExp | null; what: string };

const MON = 1;
const THU = 4;

// Every center holiday in a calendar year, on its actual date.
function holidaysIn(y: number): Expected[] {
  const out: Expected[] = [
    { date: ymd(y, 1, 1), status: 'closed', name: /new\s+year/i, what: "New Year's Day" },
    { date: nthWeekday(y, 5, MON, -1), status: 'closed', name: /memorial/i, what: 'Memorial Day' },
    { date: ymd(y, 7, 4), status: 'closed', name: /independence|fourth of july|july 4/i, what: 'Independence Day' },
    { date: nthWeekday(y, 9, MON, 1), status: 'closed', name: /labor/i, what: 'Labor Day' },
    { date: nthWeekday(y, 11, THU, 4), status: 'closed', name: /thanksgiving/i, what: 'Thanksgiving Day' },
    { date: addDays(nthWeekday(y, 11, THU, 4), 1), status: 'closed', name: null, what: 'the Friday after Thanksgiving' },
    { date: nthWeekday(y, 1, MON, 3), status: 'open', name: /martin luther king|\bmlk\b/i, what: 'Martin Luther King Jr. Day' },
    { date: nthWeekday(y, 2, MON, 3), status: 'open', name: /president/i, what: "Presidents' Day" },
    { date: ymd(y, 6, 19), status: 'open', name: /juneteenth/i, what: 'Juneteenth' },
    { date: nthWeekday(y, 10, MON, 2), status: 'open', name: /columbus|indigenous/i, what: "Columbus Day / Indigenous Peoples' Day" },
    { date: ymd(y, 11, 11), status: 'open', name: /veteran/i, what: 'Veterans Day' },
  ];
  // December 24 through December 31; January 1 is New Year's Day above.
  for (let d = 24; d <= 31; d++) out.push({ date: ymd(y, 12, d), status: 'closed', name: null, what: `winter closure ${ymd(y, 12, d)}` });
  return out;
}

function expectedHolidays(creation: string): Expected[] {
  const last = addDays(creation, 365);
  const y = Number(creation.slice(0, 4));
  return [...holidaysIn(y), ...holidaysIn(y + 1)].filter((h) => h.date >= creation && h.date <= last);
}

function calendarOf(s: { structured?: { calendar?: Entry[] } }): Entry[] {
  const cal = s.structured?.calendar;
  expect(Array.isArray(cal), 'structured.calendar is not an array').toBe(true);
  return cal!;
}

describe('holiday calendar', () => {
  for (const { label, now } of NOWS) {
    test(`holiday calendar: every holiday in the next 365 days has its date and status, now ${label}`, async () => {
      const s = await seedAt(now);
      const cal = calendarOf(s);
      const creation = denverDate(now);
      const expected = expectedHolidays(creation);
      expect(expected.length).toBeGreaterThan(15);
      const missing = expected
        .filter((h) => !cal.some((e) => e.date === h.date && e.status === h.status && (h.name === null || h.name.test(e.name ?? ''))))
        .map((h) => `${h.what} on ${h.date} (${h.status})`);
      expect(missing, `creation date ${creation}`).toEqual([]);
    });
  }
});

describe('generated entries', () => {
  for (const { label, now } of NOWS) {
    test(`generated entries: one staff development day closure on a weekday 6 to 10 days ahead, now ${label}`, async () => {
      const cal = calendarOf(await seedAt(now));
      const creation = denverDate(now);
      const sdd = cal.filter((e) => /staff development/i.test(e.name ?? ''));
      expect(sdd.length, 'staff development day entries').toBe(1);
      expect(sdd[0].status).toBe('closed');
      expect(sdd[0].date >= addDays(creation, 6) && sdd[0].date <= addDays(creation, 10), `${sdd[0].date} vs creation ${creation}`).toBe(true);
      expect(isWeekday(sdd[0].date), `${sdd[0].date} is a weekend day`).toBe(true);
    });

    test(`generated entries: Picture Day 1 to 7 days ahead with a time of day, now ${label}`, async () => {
      const cal = calendarOf(await seedAt(now));
      const creation = denverDate(now);
      const pics = cal.filter((e) => /picture day/i.test(e.name ?? ''));
      expect(pics.length, 'Picture Day entries').toBe(1);
      expect(pics[0].date >= addDays(creation, 1) && pics[0].date <= addDays(creation, 7), `${pics[0].date} vs creation ${creation}`).toBe(true);
      expect(String(pics[0].time ?? ''), 'Picture Day has no time of day').toMatch(/\b\d{1,2}:\d{2}\b/);
    });

    test(`generated entries: Fall Family Night ended the day before the creation date, now ${label}`, async () => {
      const cal = calendarOf(await seedAt(now));
      const creation = denverDate(now);
      const ffn = cal.filter((e) => /fall family night/i.test(e.name ?? ''));
      expect(ffn.length, 'Fall Family Night entries').toBe(1);
      expect(ffn[0].date, `creation ${creation}`).toBe(addDays(creation, -1));
    });

    test(`generated entries: a menu for every weekday from the creation date through 10 days ahead, now ${label}`, async () => {
      const s = await seedAt(now);
      const menus = s.structured?.menus;
      expect(Array.isArray(menus), 'structured.menus is not an array').toBe(true);
      const creation = denverDate(now);
      const want: string[] = [];
      for (let i = 0; i <= 10; i++) if (isWeekday(addDays(creation, i))) want.push(addDays(creation, i));
      const have = new Set(menus.map((m: { date: string }) => m.date));
      expect(want.filter((d) => !have.has(d)), `creation ${creation}`).toEqual([]);
      for (const m of menus.filter((x: { date: string }) => want.includes(x.date))) {
        expect(JSON.stringify(m.items ?? []).replace(/[\s"[\],]/g, '').length, `the menu for ${m.date} is empty`).toBeGreaterThan(0);
      }
    });
  }
});

describe('alerts', () => {
  for (const { label, now } of NOWS) {
    test(`alerts: exactly two, the parking lot alert active 6:00 AM to 6:00 PM on the creation date, now ${label}`, async () => {
      const s = await seedAt(now);
      const alerts = s.structured?.alerts;
      expect(Array.isArray(alerts), 'structured.alerts is not an array').toBe(true);
      expect(alerts.length, 'number of alerts').toBe(2);
      const creation = denverDate(now);
      const active = alerts.filter((a: { text: string }) => a.text === 'North parking lot repaving today. Please use the Elm Street entrance.');
      expect(active.length, 'alerts with the parking lot text').toBe(1);
      expect(denverWallClock(new Date(active[0].startsAt))).toBe(`${creation} 06:00`);
      expect(denverWallClock(new Date(active[0].expiresAt))).toBe(`${creation} 18:00`);
    });

    test(`alerts: Water service interruption expired on the day before the creation date, now ${label}`, async () => {
      const s = await seedAt(now);
      const alerts = s.structured?.alerts;
      expect(Array.isArray(alerts), 'structured.alerts is not an array').toBe(true);
      const creation = denverDate(now);
      const water = alerts.filter((a: { text: string }) => /water service interruption/i.test(a.text ?? ''));
      expect(water.length, 'Water service interruption alerts').toBe(1);
      const starts = new Date(water[0].startsAt);
      const expires = new Date(water[0].expiresAt);
      expect(Number.isNaN(starts.getTime()) || Number.isNaN(expires.getTime()), 'start or expiry is not an instant').toBe(false);
      expect(denverDate(expires), `creation ${creation}`).toBe(addDays(creation, -1));
      expect(starts.getTime() <= expires.getTime(), 'the alert starts after it expires').toBe(true);
    });
  }
});

describe('time zone', () => {
  test('time zone: dates follow America/Denver even when the UTC date is already the next day', async () => {
    // 22:30 in Denver on a Wednesday is 04:30 UTC on Thursday.
    const now = new Date('2026-10-14T22:30:00-06:00');
    const s = await seedAt(now);
    expect(denverDate(now)).toBe('2026-10-14');
    expect(weekdayOf('2026-10-14')).toBe(3);
    const alerts = s.structured?.alerts ?? [];
    const active = alerts.find((a: { text: string }) => /parking lot/i.test(a.text ?? ''));
    expect(active, 'no parking lot alert').toBeTruthy();
    expect(denverWallClock(new Date(active.startsAt))).toBe('2026-10-14 06:00');
  });
});
