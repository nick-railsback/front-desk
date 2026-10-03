// Limits and failures.
//
// rate limit: the 21st message in a minute shows the limit notice's fixed
// text and the phone link, and no Send to front desk.
//
// failed requests: when /api/ask fails (a network error, or a response that is
// not a reply), the conversation shows the system_error handoff text with the
// phone link and no Send to front desk, since nothing was stored. The page is
// never blank and shows no stack trace, error message or sandbox ID.
//
// The database failing while the page loads is in
// ../parent/server.test.ts: it needs a server whose database goes away.
//
// Assumed interface: see ./support.ts.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import {
  COOKIE,
  ask,
  conversation,
  expectFragments,
  expectPhoneLink,
  fixedTextOf,
  limitNotice,
  messageInput,
  normalize,
  open,
  sendButton,
  sendToFrontDesk,
} from './support';

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 10_000 });

const PER_MINUTE = 20;

test.describe('rate limit', () => {
  test('the 21st message in a minute shows the limit notice with the phone link and no Send', async ({ page }) => {
    await open(page);
    // All 21 must land in one minute: start early in one.
    while (new Date().getSeconds() > 20) await page.waitForTimeout(1000);
    for (let i = 0; i < PER_MINUTE; i++) {
      const r = await page.request.post('/api/ask', { data: { message: `Do you have a swimming pool? Try ${i + 1}.`, priorTurns: [] } });
      expect(r.status()).toBe(200);
    }
    await ask(page, 'Do you have a garden?');
    const log = conversation(page);
    await expectFragments(log, limitNotice(), 'limit notice');
    await expectPhoneLink(log, 'limit notice');
    await expect(sendToFrontDesk(page), 'the limit notice offers Send to front desk').toHaveCount(0);

    const results = await new AxeBuilder({ page }).exclude('nextjs-portal').analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.help}`), 'accessibility violations with the limit notice').toEqual([]);
  });
});

const STACK = /\bat\s+\S+\s+\(?[^\s()]+:\d+:\d+\)?|\bTypeError\b|\bReferenceError\b|\bSyntaxError\b|ECONNREFUSED|Failed to fetch|NetworkError|Unexpected token|oracle-boom|node_modules/;

async function expectClean(page: Page, what: string): Promise<void> {
  const body = normalize(await page.locator('body').innerText());
  expect(body.length, `${what}: the page is blank`).toBeGreaterThan(0);
  expect(body, `${what}: the page shows an error or a stack trace`).not.toMatch(STACK);
  const sandbox = (await page.context().cookies()).find((c) => c.name === COOKIE)?.value;
  if (sandbox) expect(body, `${what}: the page shows the sandbox ID`).not.toContain(sandbox);
}

const FAILURES: { name: string; handle: (route: Route) => Promise<void> }[] = [
  { name: 'a network error', handle: (route) => route.abort('failed') },
  {
    name: 'a response that is not a reply',
    handle: (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'TypeError: oracle-boom\n    at handler (/srv/app/route.js:12:5)' }),
      }),
  },
  {
    name: 'a server error page',
    handle: (route) => route.fulfill({ status: 500, contentType: 'text/html', body: '<pre>Error: oracle-boom\n    at handler (/srv/app/route.js:12:5)</pre>' }),
  },
];

test.describe('failed requests', () => {
  for (const failure of FAILURES) {
    test(`${failure.name} shows the system_error handoff with the phone link and no Send`, async ({ page }) => {
      await page.route('**/api/ask', failure.handle);
      await open(page);
      await messageInput(page).fill('Do you have a swimming pool?');
      await sendButton(page).click();
      const log = conversation(page);
      await expect(log).toContainText(normalize(fixedTextOf('system_error').split('Please')[0]));
      await expectFragments(log, fixedTextOf('system_error'), failure.name);
      await expectPhoneLink(log, failure.name);
      await expect(sendToFrontDesk(page), `${failure.name}: an unstored reply offers Send to front desk`).toHaveCount(0);
      await expectClean(page, failure.name);
    });
  }
});
