// Picture Day is open, so it never lands on a date the calendar closes
// (review F16: seeded on 2026-09-06, it fell on Labor Day). Checked
// for a creation date on every day of a year.

import { expect, test } from 'vitest';
import { seed } from '../../../src/seed';

test('Picture Day never falls on a closed date', () => {
  const clashes: string[] = [];
  for (let day = 0; day < 366; day++) {
    const now = new Date(Date.UTC(2026, 0, 1, 18) + day * 86_400_000);
    const calendar = seed(now).structured.calendar;
    const picture = calendar.find((e) => e.id === 'picture-day')!;
    const closed = calendar.filter((e) => e.status === 'closed' && e.date === picture.date);
    if (closed.length > 0) clashes.push(`${now.toISOString()}: ${picture.date} (${closed.map((e) => e.name).join(', ')})`);
  }
  expect(clashes).toEqual([]);
});
