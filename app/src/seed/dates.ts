// Calendar dates and instants in the center's timezone. Dates are
// `YYYY-MM-DD` strings; arithmetic on them runs in UTC so the machine's own
// timezone never enters.

export const TIMEZONE = 'America/Denver';

const WALL_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function wallClock(instant: Date): { date: string; minutes: number } {
  const p: Record<string, string> = {};
  for (const part of WALL_CLOCK.formatToParts(instant)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The calendar date of an instant in Denver.
export function denverDate(instant: Date): string {
  return wallClock(instant).date;
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

// 0 is Sunday, 6 is Saturday.
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isWeekday(date: string): boolean {
  const w = weekday(date);
  return w >= 1 && w <= 5;
}

// The instant at a Denver wall-clock time on a date. Starts from the time read
// as UTC, then corrects by the difference between the wall clock wanted and
// the one that instant shows in Denver. The second pass makes it exact when
// the first guess lands across a daylight saving change.
export function denverInstant(date: string, hhmm: string): Date {
  const want = Date.parse(`${date}T${hhmm}:00Z`);
  let guess = want;
  for (let pass = 0; pass < 2; pass++) {
    const seen = wallClock(new Date(guess));
    guess += want - (Date.parse(`${seen.date}T00:00:00Z`) + seen.minutes * 60 * 1000);
  }
  return new Date(guess);
}

export function startOfDenverDay(date: string): Date {
  return denverInstant(date, '00:00');
}
