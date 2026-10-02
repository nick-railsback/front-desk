// The calendar, menus, and alerts, all relative to the creation date (the
// Denver calendar date of `now`).

import { addDays, denverInstant, isWeekday, weekday } from './dates';
import type { Alert, CalendarEntry, Menu } from './index';

function ymd(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

// The nth given weekday (0 is Sunday) of a month; n = -1 is the last one.
function nthWeekday(year: number, month: number, day: number, n: number): string {
  if (n > 0) {
    const first = weekday(ymd(year, month, 1));
    return ymd(year, month, 1 + ((day - first + 7) % 7) + (n - 1) * 7);
  }
  const last = ymd(year, month + 1, 0);
  return addDays(last, -((weekday(last) - day + 7) % 7));
}

const MONDAY = 1;
const THURSDAY = 4;

function holidaysIn(year: number): CalendarEntry[] {
  const thanksgiving = nthWeekday(year, 11, THURSDAY, 4);
  const days: [string, string, 'open' | 'closed'][] = [
    [ymd(year, 1, 1), "New Year's Day", 'closed'],
    [nthWeekday(year, 1, MONDAY, 3), 'Martin Luther King Jr. Day', 'open'],
    [nthWeekday(year, 2, MONDAY, 3), "Presidents' Day", 'open'],
    [nthWeekday(year, 5, MONDAY, -1), 'Memorial Day', 'closed'],
    [ymd(year, 6, 19), 'Juneteenth', 'open'],
    [ymd(year, 7, 4), 'Independence Day', 'closed'],
    [nthWeekday(year, 9, MONDAY, 1), 'Labor Day', 'closed'],
    [nthWeekday(year, 10, MONDAY, 2), "Columbus Day / Indigenous Peoples' Day", 'open'],
    [ymd(year, 11, 11), 'Veterans Day', 'open'],
    [thanksgiving, 'Thanksgiving Day', 'closed'],
    [addDays(thanksgiving, 1), 'Day after Thanksgiving', 'closed'],
  ];
  for (let d = 24; d <= 31; d++) days.push([ymd(year, 12, d), 'Winter closure', 'closed']);
  return days.map(([date, name, status]) => ({ id: `holiday-${date}`, date, name, status, time: null }));
}

// The first weekday on or after a date.
function weekdayFrom(date: string): string {
  let d = date;
  while (!isWeekday(d)) d = addDays(d, 1);
  return d;
}

export function calendar(creation: string): CalendarEntry[] {
  const year = Number(creation.slice(0, 4));
  const last = addDays(creation, 365);
  const holidays = [...holidaysIn(year), ...holidaysIn(year + 1)].filter((h) => h.date >= creation && h.date <= last);
  return [
    ...holidays,
    { id: 'staff-development-day', date: weekdayFrom(addDays(creation, 6)), name: 'Staff development day', status: 'closed', time: null },
    { id: 'picture-day', date: weekdayFrom(addDays(creation, 1)), name: 'Picture Day', status: 'open', time: '9:00 AM' },
    { id: 'fall-family-night', date: addDays(creation, -1), name: 'Fall Family Night', status: 'open', time: '5:30 PM' },
  ];
}

// Breakfast and afternoon snack only: families pack lunch (Meals policy).
const DAY_MENUS: string[][] = [
  ['Breakfast: oatmeal with sliced bananas', 'Afternoon snack: apple slices and cheese'],
  ['Breakfast: whole wheat toast with scrambled eggs', 'Afternoon snack: carrot sticks and hummus'],
  ['Breakfast: yogurt with berries', 'Afternoon snack: whole grain crackers and pears'],
  ['Breakfast: whole grain cereal with milk', 'Afternoon snack: cucumber slices and cheese cubes'],
  ['Breakfast: pancakes with applesauce', 'Afternoon snack: orange wedges and graham crackers'],
];

export function menus(creation: string): Menu[] {
  const out: Menu[] = [];
  for (let i = 0; i <= 10; i++) {
    const date = addDays(creation, i);
    if (isWeekday(date)) out.push({ date, items: [...DAY_MENUS[weekday(date) - 1]] });
  }
  return out;
}

export function alerts(creation: string): Alert[] {
  const yesterday = addDays(creation, -1);
  return [
    {
      id: 'alert-parking',
      text: 'North parking lot repaving today. Please use the Elm Street entrance.',
      startsAt: denverInstant(creation, '06:00').toISOString(),
      expiresAt: denverInstant(creation, '18:00').toISOString(),
    },
    {
      id: 'alert-water',
      text: 'Water service interruption',
      startsAt: denverInstant(yesterday, '08:00').toISOString(),
      expiresAt: denverInstant(yesterday, '12:00').toISOString(),
    },
  ];
}
