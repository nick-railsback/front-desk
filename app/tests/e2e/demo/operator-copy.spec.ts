// What the operator view says about publishing.
//
// publish line: beside the Publish control, visible without hovering or
// tapping, a line says what publishing does (parents get the new text, and
// the open gaps' questions are checked again), and that line is the Publish
// control's accessible description.
//
// version label: the current version is shown as the published version of
// the center info with the date it was published, as a calendar date in the
// center's timezone: "Center info version <n>, published <Month D, YYYY>".
// After a publish, the number and the date both update. A snapshot
// published at 00:30 and at 23:30 in Denver reads that Denver date: any
// server or browser clock more than 30 minutes from Denver's gets one of
// them wrong. The browser runs in Pacific/Honolulu.
//
// Assumed interface: see ./support.ts (5).

import { expect, test, type Page } from '@playwright/test';
import { closeSql, cookieOf, normalize, openView, publish, publishButton, sql } from './support';

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 15_000, timezoneId: 'Pacific/Honolulu' });
test.afterAll(closeSql);

const LABEL = /center info version\s+(\d+)\s*,?\s*published\s+([A-Z][a-z]+ \d{1,2}, \d{4})/i;

function denverLong(at: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: 'long', day: 'numeric' }).format(at);
}

async function label(page: Page): Promise<{ version: number; date: string }> {
  const el = page.getByText(/center info version\s+\d+/i).first();
  await expect(el, 'no "Center info version <n>" label').toBeVisible();
  const text = normalize(await el.innerText());
  const m = LABEL.exec(text);
  expect(m, `the version label "${text}" does not read "Center info version <n>, published <Month D, YYYY>"`).toBeTruthy();
  return { version: Number(m![1]), date: m![2] };
}

async function latest(id: string): Promise<{ version: number; publishedAt: Date }> {
  const { rows } = await sql().query('select version, published_at from snapshots where sandbox_id = $1 order by version desc limit 1', [id]);
  expect(rows.length, 'the sandbox holds no snapshot').toBe(1);
  return { version: Number(rows[0].version), publishedAt: rows[0].published_at as Date };
}

test.describe('publish line', () => {
  test("Publish's accessible description is a line beside it, visible without hovering, about parents and the open gaps", async ({ page }) => {
    await openView(page, '/operator');
    const button = publishButton(page).first();
    await expect(button, 'no Publish control').toBeVisible();
    await expect(button, 'Publish has no accessible description about parents').toHaveAccessibleDescription(/parent/i);
    await expect(button, 'Publish has no accessible description about the open gaps').toHaveAccessibleDescription(/\bgaps?\b/i);
    const ids = ((await button.getAttribute('aria-describedby')) ?? '').split(/\s+/).filter(Boolean);
    expect(ids.length, 'the description does not come from a line on the page (aria-describedby)').toBeGreaterThan(0);
    const line = page.locator(ids.map((id) => `[id="${id}"]`).join(', ')).first();
    await page.mouse.move(0, 0);
    await expect(line, 'the line describing Publish is not visible without hovering').toBeVisible();
    const [b, l] = [await button.boundingBox(), await line.boundingBox()];
    expect(b && l, 'Publish or its line has no size').toBeTruthy();
    const gap = Math.max(0, l!.y - (b!.y + b!.height), b!.y - (l!.y + l!.height));
    expect(gap, `the line sits ${gap} px from Publish, not beside it`).toBeLessThanOrEqual(120);
  });
});

test.describe('version label', () => {
  test('reads the published version and its Denver date, and both update after a publish', async ({ page, context }) => {
    await openView(page, '/operator');
    const id = await cookieOf(context);
    const first = await latest(id);
    expect(await label(page), 'the label does not show the seed snapshot').toEqual({ version: first.version, date: denverLong(first.publishedAt) });

    // Both dates of the published snapshot, moved so a wrong time zone shows.
    const { rows } = await sql().query('select version from snapshots where sandbox_id = $1 order by version desc limit 1', [id]);
    for (const at of ['2026-07-15T00:30:00-06:00', '2026-07-15T23:30:00-06:00']) {
      await sql().query('update snapshots set published_at = $3 where sandbox_id = $1 and version = $2', [id, rows[0].version, at]);
      await page.reload();
      expect(await label(page), `a snapshot published at ${at} does not read July 15, 2026`).toEqual({ version: first.version, date: 'July 15, 2026' });
    }

    expect((await publish(page)).ok(), 'the publish failed').toBe(true);
    await expect.poll(async () => (await label(page)).version, { timeout: 30_000, message: 'the version did not update after a publish' }).toBe(first.version + 1);
    const second = await latest(id);
    expect(second.version).toBe(first.version + 1);
    expect((await label(page)).date, 'the date did not update after a publish').toBe(denverLong(second.publishedAt));
  });
});
