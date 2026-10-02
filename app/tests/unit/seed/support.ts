// Shared helpers for the demo center seed tests and the sandbox database
// tests. Nothing here imports application code statically: `loadSeed` checks
// that the seed module exists and only then imports it, so a missing module
// is an assertion failure inside a test, never a collection error.
//
// Assumed interface (app/src/seed/index.ts):
//
//   export function seed(now: Date): Seed
//
// `seed` is a pure function of `now`: the same `now` always yields deeply
// equal output, and the system clock is never read. All calendar dates are
// `YYYY-MM-DD` strings in the center's timezone, America/Denver. All instants
// are ISO 8601 strings in `Date.prototype.toISOString()` form. Money amounts
// are in dollars. IDs are chosen by the seed, never by a database.
//
//   type Visibility = 'parent' | 'staff';
//   type Section = {
//     id: string;            // stable
//     title: string;
//     visibility: Visibility;
//     updatedOn: string;     // YYYY-MM-DD, the section's last-updated date
//     text: string;          // the section body
//   };
//   type Citation = { sectionId: string };
//   type Outcome = 'answer' | 'handoff' | 'urgent';
//   type Reason = 'answered' | 'grounding_failed' | 'not_in_source' | 'sensitive'
//     | 'unsupported_language' | 'system_error' | 'emergency' | 'safety';
//   type Reply = {
//     text: string;
//     outcome: Outcome;
//     reason: Reason;
//     snapshotVersion: number;
//     citations: Citation[];
//   };
//   type Question = { id: string; text: string; askedAt: string; reply: Reply };
//   type Gap = { id: string; label: string; status: 'open'; questionIds: string[] };
//   type CalendarEntry = {
//     id: string;
//     date: string;          // YYYY-MM-DD; one entry per date, ranges are spelled out day by day
//     name: string;
//     status: 'open' | 'closed';
//     time: string | null;   // time of day, e.g. "9:00 AM", when the entry has one
//   };
//   type Menu = { date: string; items: string[] };
//   type Alert = { id: string; text: string; startsAt: string; expiresAt: string };
//   type Program = {
//     id: string;            // 'infant-toddler' | 'preschool' | 'prek'
//     name: string;
//     ages: string;          // the age range as the center states it
//     hours: string;         // days and hours as the center states them
//     weeklyTuition: string; // tuition as the center states it
//   };
//   type Seed = {
//     structured: {
//       center: {
//         name: string; city: string; timezone: string; phone: string;
//         email: string; director: string; officeHours: string;
//       };
//       programs: Program[];
//       registrationFee: string;
//       calendar: CalendarEntry[];
//       menus: Menu[];
//       alerts: Alert[];
//     };
//     snapshots: { version: number; sections: Section[] }[];
//     draft: { sections: Section[] };
//     questions: Question[];
//     gaps: Gap[];
//   };
//
// Free-text facts are found by searching the serialized object they belong
// to, so extra fields are allowed anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SEED_MODULE = 'src/seed/index.ts';
export const TZ = 'America/Denver';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnySeed = any;

export async function loadSeedModule(): Promise<{ seed: (now: Date) => AnySeed }> {
  expect(fs.existsSync(path.join(APP, SEED_MODULE)), `app/${SEED_MODULE} does not exist`).toBe(true);
  const mod = await import('../../../src/seed/index');
  expect(typeof mod.seed, `app/${SEED_MODULE} does not export a seed function`).toBe('function');
  return mod as { seed: (now: Date) => AnySeed };
}

export async function seedAt(now: Date): Promise<AnySeed> {
  const { seed } = await loadSeedModule();
  const out = seed(now);
  expect(out, 'seed(now) returned nothing').toBeTruthy();
  return out;
}

// Calendar arithmetic. Every function here works on `YYYY-MM-DD` strings in
// UTC so the machine's own timezone can never leak in.

const DATE_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

function partsOf(instant: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of DATE_PARTS.formatToParts(instant)) out[p.type] = p.value;
  return out;
}

// The calendar date of an instant in the center's timezone.
export function denverDate(instant: Date): string {
  const p = partsOf(instant);
  return `${p.year}-${p.month}-${p.day}`;
}

// The wall-clock reading of an instant in the center's timezone, `YYYY-MM-DD HH:MM`.
export function denverWallClock(instant: Date): string {
  const p = partsOf(instant);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 0 is Sunday, 6 is Saturday.
export function weekdayOf(ymd: string): number {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

export function isWeekday(ymd: string): boolean {
  const w = weekdayOf(ymd);
  return w >= 1 && w <= 5;
}

export function ymd(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

// The nth given weekday of a month (n = -1 for the last one).
export function nthWeekday(y: number, m: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return ymd(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return ymd(y, m, lastDay - ((last - weekday + 7) % 7));
}

// Moments the seed must handle. Each label is computed, never typed by hand.
const NOW_INSTANTS = [
  '2026-10-14T22:30:00-06:00', // late evening in Denver, already the next day in UTC
  '2026-10-17T09:15:00-06:00', // a Saturday
  '2026-10-18T13:00:00-06:00', // a Sunday
  '2026-10-30T10:00:00-06:00', // days before daylight saving time ends on 2026-11-01
  '2026-11-01T01:30:00-07:00', // the repeated hour after daylight saving time ends
  '2027-03-12T12:00:00-07:00', // days before daylight saving time starts on 2027-03-14
  '2026-12-22T12:00:00-07:00', // the generated windows reach into the December 24 to January 1 closure
  '2026-12-31T21:45:00-07:00', // inside the closure, late evening, next year in UTC
  '2019-03-12T07:00:00-06:00', // years before the real clock
  '2033-06-18T20:30:00-06:00', // years after the real clock, late evening
];

export const NOWS: { label: string; now: Date }[] = NOW_INSTANTS.map((iso) => {
  const now = new Date(iso);
  const p = partsOf(now);
  return { label: `${now.toISOString()} (Denver ${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute})`, now };
});

export const ONE_NOW = NOWS[0];

// Every string and number leaf of a value, so a search never depends on the
// shape that holds it or on how JSON escapes it.
export function leaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number' || typeof value === 'bigint') out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) leaves(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) leaves(v, out);
  return out;
}

// Collapses wrapping and typographic variation so prose that wraps or quotes
// differently still matches.
export function normalize(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A literal value (`$15`, `9:00 AM`, `100.4`, `18`) as a case-insensitive
// pattern that refuses to match inside a longer number: `$15` does not match
// `$150`, `18` does not match `2018`.
export function literal(token: string): RegExp {
  const before = /^[\d$]/.test(token) ? '(?<![\\d.$])' : '';
  const after = /\d$/.test(token) ? '(?![\\d])' : '';
  const body = escapeRegExp(token).replace(/ /g, '\\s*');
  return new RegExp(`${before}${body}${after}`, 'i');
}

// A time of day as the center states it ("7:30 AM") or in 24-hour form ("07:30").
export function timeOfDay(twelveHour: string): RegExp {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(twelveHour);
  if (!m) throw new Error(`not a 12-hour time: ${twelveHour}`);
  let h = Number(m[1]) % 12;
  if (m[3] === 'PM') h += 12;
  const hh = String(h).padStart(2, '0');
  return new RegExp(`(?<![\\d:])(${m[1]}:${m[2]}\\s*${m[3]}|${hh}:${m[2]}(?!\\s*[ap]m))`, 'i');
}

// Order-insensitive deep form: arrays are sorted by the canonical JSON of
// their elements, object keys are sorted, and undefined fields are dropped.
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical).sort((a, b) => {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonical(v);
    }
    return out;
  }
  return value;
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
