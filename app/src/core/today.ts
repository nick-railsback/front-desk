// Open days, office hours, and the expectation line, all in America/Denver
// from the injected `now`. Pure.

import type { Alert, CalendarEntry, Seed } from '../seed';
import { TIMEZONE, addDays, denverDate, isWeekday } from '../seed/dates';
import { NO_MENU, OFFICE_OPEN_LINE, TODAY, officeClosedLine } from './copy';

// The office is staffed Monday to Friday, 7:00 AM to 5:30 PM, on open days.
const OFFICE_OPENS_MIN = 7 * 60;
const OFFICE_CLOSES_MIN = 17 * 60 + 30;
const OFFICE_OPENING_TIME = '7:00 AM';

const MINUTES = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const CLOCK_TIME = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit' });
const LONG_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

// Minutes since midnight on the Denver wall clock.
export function denverMinutes(now: Date): number {
  const p: Record<string, string> = {};
  for (const part of MINUTES.formatToParts(now)) p[part.type] = part.value;
  return Number(p.hour) * 60 + Number(p.minute);
}

// "Thursday, November 26, 2026" for a YYYY-MM-DD date.
export function longDate(date: string): string {
  return LONG_DATE.format(new Date(`${date}T12:00:00Z`));
}

// "10:30 PM" in Denver.
export function clockTime(now: Date): string {
  // ICU puts a narrow no-break space before AM/PM; the copy uses a plain one.
  return CLOCK_TIME.format(now).replace(/ /g, ' ');
}

export function isOpenDay(date: string, calendar: CalendarEntry[]): boolean {
  return isWeekday(date) && !calendar.some((e) => e.status === 'closed' && e.date === date);
}

export function nextOpenDay(date: string, calendar: CalendarEntry[]): string {
  let d = addDays(date, 1);
  while (!isOpenDay(d, calendar)) d = addDays(d, 1);
  return d;
}

// When a handoff will be seen: today during office hours, otherwise the next
// office opening on an open day.
export function expectationLine(now: Date, calendar: CalendarEntry[]): string {
  const today = denverDate(now);
  const minutes = denverMinutes(now);
  const openToday = isOpenDay(today, calendar);
  if (openToday && minutes >= OFFICE_OPENS_MIN && minutes < OFFICE_CLOSES_MIN) return OFFICE_OPEN_LINE;
  const day = openToday && minutes < OFFICE_OPENS_MIN ? today : nextOpenDay(today, calendar);
  return officeClosedLine(OFFICE_OPENING_TIME, longDate(day));
}

// The alerts active at `now`: started, and not yet expired.
export function activeAlerts(alerts: Alert[], now: Date): Alert[] {
  return alerts.filter((a) => Date.parse(a.startsAt) <= now.getTime() && now.getTime() < Date.parse(a.expiresAt));
}

export type TodayCard = { date: string; open: boolean; status: string; hours: string[]; menu: string[]; alerts: string[] };

// The parent view's Today card (PRD P2): the day in Denver, whether the
// center is open, each program's hours, the menu, and the active alerts.
export function todayCard(structured: Seed['structured'], now: Date): TodayCard {
  const { calendar, programs, menus, alerts } = structured;
  const today = denverDate(now);
  const open = isOpenDay(today, calendar);
  const closedFor = calendar.find((e) => e.status === 'closed' && e.date === today)?.name ?? TODAY.weekend;
  const items = menus.find((m) => m.date === today)?.items ?? [];
  return {
    date: longDate(today),
    open,
    status: open ? TODAY.open : TODAY.closed(closedFor, longDate(nextOpenDay(today, calendar))),
    hours: open ? programs.map((p) => `${p.name}: ${p.hours.replace(/^Monday to Friday, /, '')}`) : [],
    menu: items.length > 0 ? items : [NO_MENU],
    alerts: activeAlerts(alerts, now).map((a) => a.text),
  };
}
