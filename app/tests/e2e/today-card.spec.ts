// The Today card in the browser.
//
// today card: the card on the page shows what todayCard() computes from the
// sandbox's structured data at the server's current time, in America/Denver,
// whatever the device's time zone. The expired water alert never shows.
//
// The date and calendar cases at fixed instants are in
// ../parent/today-card.test.ts, against the same function.
//
// Assumed interface: see ./support.ts, and todayCard() in
// ../parent/today-card.test.ts.

import { expect, test } from '@playwright/test';
import * as today from '../../src/core/today';
import { normalize, open, sandboxId, structuredOf, todayCard } from './support';

test.describe.configure({ timeout: 120_000 });
// Far from Denver: a card that reads the device's clock shows another date.
test.use({ actionTimeout: 10_000, timezoneId: 'Pacific/Kiritimati' });

type Card = { date: string; open: boolean; status: string; hours: string[]; menu: string[]; alerts: string[] };

test.describe('today card', () => {
  test("shows the center's day in Denver, as computed from the sandbox's data at server time", async ({ page, context }) => {
    await open(page);
    const shown = normalize(await todayCard(page).innerText());
    const structured = await structuredOf(await sandboxId(context));

    const todayCard_ = (today as Record<string, unknown>).todayCard;
    expect(typeof todayCard_, 'app/src/core/today.ts does not export todayCard').toBe('function');
    const card = (todayCard_ as (s: unknown, now: Date) => Card)(structured, new Date());

    for (const line of [card.date, card.status, ...card.hours, ...card.menu, ...card.alerts]) {
      expect(shown, `the Today card does not show "${line}"`).toContain(normalize(line));
    }
    expect(shown, 'the Today card shows the expired water alert').not.toMatch(/water service/i);
  });
});
