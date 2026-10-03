// The Today card's content at fixed instants, from the sandbox's structured
// data and an injected `now`. The browser test (../e2e/today-card.spec.ts)
// checks the page shows the same computation at server time.
//
// open day: the date in America/Denver, that the center is open, each
// program's hours, today's menu, and every alert active now. The expired
// water alert never shows, and an alert shows only while it is active.
//
// closed day: that the center is closed, the reason (the calendar entry's
// name, or the weekend), and the next open day. With no menu for today it
// reads "Today's menu isn't posted yet". Thanksgiving Day 2026's next open day
// is Monday, November 30, 2026.
//
// time zone: at 2026-11-27T05:30:00Z it is still Thursday, November 26 in
// Denver: the card shows that day, closed for Thanksgiving Day, even on a host
// whose own zone is already on Friday.
//
// Assumed interface, app/src/core/today.ts (pure: no clock, no I/O):
//
//   export function todayCard(structured: Seed['structured'], now: Date): {
//     date: string;     // today in America/Denver, "Thursday, November 26, 2026"
//     open: boolean;    // whether the center is open today
//     status: string;   // what the card says about open or closed; when closed
//                       // it names the reason and the next open day's date in
//                       // the same long form as `date`
//     hours: string[];  // open: one line per program with its name and its
//                       // hours today; closed: []
//     menu: string[];   // today's menu items, or exactly
//                       // ["Today's menu isn't posted yet"] when there is none
//     alerts: string[]; // the text of every alert active at `now`
//   }
//
// Every string is shown on the card as is.

process.env.TZ = 'Pacific/Kiritimati';

import { describe, expect, test } from 'vitest';
import * as today from '../../src/core/today';
import { seed } from '../../src/seed';
import { denverInstant } from '../../src/seed/dates';

type Card = { date: string; open: boolean; status: string; hours: string[]; menu: string[]; alerts: string[] };
type Structured = ReturnType<typeof seed>['structured'];

const NO_MENU = "Today's menu isn't posted yet";
const PARKING = 'North parking lot repaving today. Please use the Elm Street entrance.';

function normalize(text: string): string {
  return String(text ?? '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[  ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cardAt(now: Date, structured: Structured = seed(now).structured): Card {
  expect(new Date('2026-06-01T00:00:00Z').getTimezoneOffset(), 'the host time zone is not Pacific/Kiritimati').toBe(-14 * 60);
  const fn = (today as Record<string, unknown>).todayCard;
  expect(typeof fn, 'app/src/core/today.ts does not export todayCard').toBe('function');
  const card = (fn as (s: Structured, n: Date) => Card)(structured, now);
  for (const key of ['date', 'status'] as const) expect(typeof card[key], `card.${key} is not a string`).toBe('string');
  for (const key of ['hours', 'menu', 'alerts'] as const) expect(Array.isArray(card[key]), `card.${key} is not a list`).toBe(true);
  return card;
}

function everything(card: Card): string {
  return normalize([card.date, card.status, ...card.hours, ...card.menu, ...card.alerts].join('\n'));
}

// "7:30 AM" as written, or as "7:30 a.m.".
function time(t: string): RegExp {
  const [hm, ap] = t.split(' ');
  return new RegExp(`(?<![\\d:])${hm}\\s*${ap[0]}\\.?\\s?${ap[1]}\\.?`, 'i');
}

function lineFor(card: Card, program: string): string {
  const line = card.hours.find((l) => normalize(l).includes(program));
  expect(line, `no hours line names ${program}`).toBeDefined();
  return normalize(line!);
}

describe('open day', () => {
  // Wednesday, November 4, 2026, mid-morning: an ordinary open day.
  const now = denverInstant('2026-11-04', '10:00');

  test("shows the date, open, each program's hours, the menu and the active alert", () => {
    const structured = seed(now).structured;
    const card = cardAt(now, structured);
    expect(normalize(card.date)).toBe('Wednesday, November 4, 2026');
    expect(card.open).toBe(true);
    expect(card.status, 'the status does not say the center is open').toMatch(/open/i);
    expect(card.status).not.toMatch(/closed/i);

    const infants = lineFor(card, 'Infants & Toddlers');
    for (const t of ['7:30 AM', '5:30 PM']) expect(infants).toMatch(time(t));
    const preschool = lineFor(card, 'Preschool');
    for (const t of ['7:00 AM', '5:30 PM']) expect(preschool).toMatch(time(t));
    const prek = lineFor(card, 'Pre-K');
    expect(prek).toMatch(/core day/i);
    expect(prek).toMatch(/extended care/i);
    for (const t of ['8:00 AM', '2:30 PM', '5:30 PM']) expect(prek).toMatch(time(t));

    const menu = structured.menus.find((m) => m.date === '2026-11-04');
    expect(menu, 'the seed has no menu for the day').toBeDefined();
    for (const item of menu!.items) expect(normalize(card.menu.join('\n')), `the menu does not show "${item}"`).toContain(normalize(item));
    expect(card.menu.join(' ')).not.toContain(NO_MENU);

    expect(card.alerts.map(normalize)).toEqual([PARKING]);
    expect(everything(card), 'the expired water alert shows').not.toMatch(/water service/i);
  });

  test('shows an alert only while it is active', () => {
    const structured = seed(now).structured;
    for (const hhmm of ['05:59', '18:00', '21:30']) {
      const card = cardAt(denverInstant('2026-11-04', hhmm), structured);
      expect(card.alerts, `an alert shows at ${hhmm}, outside its 6:00 AM to 6:00 PM window`).toEqual([]);
      expect(everything(card)).not.toMatch(/water service/i);
    }
    expect(cardAt(denverInstant('2026-11-04', '06:00'), structured).alerts.map(normalize)).toEqual([PARKING]);
  });
});

describe('closed day', () => {
  test('a weekend: closed, the weekend, the next open day, and no menu yet', () => {
    // Saturday, October 3, 2026; the seed's first menu is Monday's.
    const card = cardAt(denverInstant('2026-10-03', '12:00'));
    expect(normalize(card.date)).toBe('Saturday, October 3, 2026');
    expect(card.open).toBe(false);
    expect(card.status).toMatch(/closed/i);
    expect(card.status, 'the status does not give the weekend as the reason').toMatch(/weekend/i);
    expect(normalize(card.status), 'the status does not name the next open day').toContain('Monday, October 5, 2026');
    expect(card.hours).toEqual([]);
    expect(card.menu.map(normalize)).toEqual([NO_MENU]);
  });

  test('Thanksgiving Day: closed for Thanksgiving Day, next open Monday, November 30, 2026', () => {
    const card = cardAt(denverInstant('2026-11-26', '12:00'));
    expect(normalize(card.date)).toBe('Thursday, November 26, 2026');
    expect(card.open).toBe(false);
    expect(card.status).toMatch(/closed/i);
    expect(card.status).toContain('Thanksgiving Day');
    expect(normalize(card.status)).toContain('Monday, November 30, 2026');
    expect(card.hours).toEqual([]);
  });
});

describe('time zone', () => {
  test('at 2026-11-27T05:30:00Z the card is still Thursday, November 26 in Denver', () => {
    const now = new Date('2026-11-27T05:30:00Z');
    const card = cardAt(now);
    expect(normalize(card.date)).toBe('Thursday, November 26, 2026');
    expect(card.open).toBe(false);
    expect(card.status).toContain('Thanksgiving Day');
    expect(card.status).not.toMatch(/day after thanksgiving/i);
    expect(normalize(card.status)).toContain('Monday, November 30, 2026');
  });
});
