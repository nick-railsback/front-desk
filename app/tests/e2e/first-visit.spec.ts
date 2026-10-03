// First visit and layout.
//
// first visit: loading the parent view with no sandbox cookie creates a
// sandbox and sets an HttpOnly cookie naming it. The Today card is computed
// from that sandbox's data, a message sent from the page is answered in that
// sandbox, and reloading keeps it.
//
// role switcher: Parent / Operator is visible, marks Parent as current, and
// Operator navigates to /operator. A note says the center, the people and the
// questions are fictional.
//
// layout: at 375 px the Today card, the conversation and the message input
// stack top to bottom with no horizontal scroll. At 320 px, and at 375 px with
// text at 200%, nothing scrolls horizontally and every reply's text, phone
// link and controls stay on screen. Checked empty and with a reply for each
// outcome.
//
// Assumed interface: see ./support.ts.

import { expect, test, type Page } from '@playwright/test';
import {
  COOKIE,
  TRIGGER,
  ask,
  conversation,
  db,
  horizontalOverflow,
  messageInput,
  open,
  sandboxId,
  todayCard,
  turnsWith,
  unique,
} from './support';

test.describe.configure({ timeout: 120_000 });
test.use({ actionTimeout: 10_000 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test.describe('first visit', () => {
  test('creates one sandbox, names it in an HttpOnly cookie, and answers in it', async ({ page, context }) => {
    expect(await context.cookies(), 'the browser starts with cookies').toEqual([]);
    const response = await page.goto('/');
    expect(response?.status(), 'the parent view did not load').toBe(200);

    const cookie = (await context.cookies()).find((c) => c.name === COOKIE);
    expect(cookie, `loading the page set no ${COOKIE} cookie`).toBeTruthy();
    expect(cookie!.httpOnly, 'the sandbox cookie is not HttpOnly').toBe(true);
    expect(cookie!.value).toMatch(UUID);
    const id = cookie!.value;
    const { rows } = await db().query('select 1 from sandboxes where id = $1', [id]);
    expect(rows.length, 'the cookie names no sandbox').toBe(1);

    // The card reads this sandbox: an alert written into it shows on reload.
    const alertText = unique('Oracle notice for this sandbox only');
    const now = Date.now();
    await db().query(
      `update structured_data
          set content = jsonb_set(content, '{alerts}', (content->'alerts') || $2::jsonb)
        where sandbox_id = $1`,
      [id, JSON.stringify([{ id: 'oracle-alert', text: alertText, startsAt: new Date(now - 3_600_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() }])],
    );
    await page.reload();
    await expect(todayCard(page), "the Today card does not show the sandbox's own alert").toContainText(alertText);
    expect(await sandboxId(context), 'reloading changed the sandbox').toBe(id);

    const message = unique('Do you have a swimming pool?');
    await ask(page, message);
    expect(await sandboxId(context), 'sending a message changed the sandbox').toBe(id);
    const stored = await turnsWith(message);
    expect(stored.map((t) => t.sandbox_id), 'the message was not answered in the sandbox the page created').toEqual([id]);

    await page.reload();
    await expect(todayCard(page)).toBeVisible();
    expect(await sandboxId(context), 'reloading changed the sandbox').toBe(id);
  });
});

test.describe('role switcher', () => {
  test('marks Parent as current, links to Operator, and shows the fictional-data note', async ({ page }) => {
    await open(page);

    const parent = page
      .getByRole('link', { name: /^parent$/i })
      .or(page.getByRole('button', { name: /^parent$/i }))
      .or(page.getByRole('tab', { name: /^parent$/i }));
    await expect(parent, 'no Parent control in the role switcher').toBeVisible();
    const current = await parent.evaluate(
      (el) =>
        ['page', 'true'].includes(el.getAttribute('aria-current') ?? '') ||
        el.getAttribute('aria-selected') === 'true' ||
        el.getAttribute('aria-pressed') === 'true',
    );
    expect(current, 'the Parent control is not marked as the current view').toBe(true);

    const note = page.getByText(/fictional/i).first();
    await expect(note, 'no note says the data is fictional').toBeVisible();
    const said = await note.innerText();
    expect(said, 'the note does not name the center').toMatch(/cent(er|re)|juniper hill/i);
    expect(said, 'the note does not name the people').toMatch(/people|staff|famil|names|person/i);
    expect(said, 'the note does not name the questions').toMatch(/question/i);

    const operator = page
      .getByRole('link', { name: /^operator$/i })
      .or(page.getByRole('button', { name: /^operator$/i }))
      .or(page.getByRole('tab', { name: /^operator$/i }));
    await expect(operator, 'no Operator control in the role switcher').toBeVisible();
    await operator.click();
    await expect(page).toHaveURL(/\/operator\/?$/);
  });
});

// Every reply's text, links and controls lie inside the viewport horizontally.
async function expectOnScreen(page: Page, what: string): Promise<void> {
  expect(await horizontalOverflow(page), `${what}: the page scrolls horizontally`).toBeLessThanOrEqual(0);
  const width = page.viewportSize()!.width;
  const outside = await conversation(page).evaluate((log, vw) => {
    const out: string[] = [];
    for (const el of Array.from(log.querySelectorAll('a, button, input, textarea, select, summary, [role=button], [role=link], [tabindex]'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -1 || r.right > vw + 1) out.push(`control "${(el.textContent ?? '').trim().slice(0, 40)}" at ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width > 0 && (r.left < -1 || r.right > vw + 1)) {
          out.push(`text "${n.textContent.trim().slice(0, 40)}" at ${Math.round(r.left)}..${Math.round(r.right)}`);
          break;
        }
      }
    }
    return out;
  }, width);
  expect(outside, `${what}: content lies off screen horizontally`).toEqual([]);
}

async function zoomText(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
}

test.describe('layout', () => {
  test('stacks the Today card, the conversation and the input at 375 px without horizontal scroll', async ({ page }) => {
    await open(page);
    const card = await todayCard(page).boundingBox();
    const log = await conversation(page).boundingBox();
    const input = await messageInput(page).boundingBox();
    expect(card && log && input, 'the Today card, conversation or input is not rendered').toBeTruthy();
    expect(card!.y, 'the Today card is not above the conversation').toBeLessThan(log!.y);
    expect(log!.y, 'the conversation is not above the message input').toBeLessThan(input!.y);
    expect(await horizontalOverflow(page), 'the empty page scrolls horizontally at 375 px').toBeLessThanOrEqual(0);

    for (const reason of ['answered', 'not_in_source', 'emergency'] as const) await ask(page, TRIGGER[reason]);
    await expectOnScreen(page, '375 px with an answer, a handoff and an urgent reply');
  });

  for (const view of [
    { name: '320 px', width: 320, zoom: false },
    { name: '375 px with text at 200%', width: 375, zoom: true },
  ]) {
    test(`keeps every reply on screen at ${view.name}`, async ({ page }) => {
      await page.setViewportSize({ width: view.width, height: 812 });
      await open(page);
      if (view.zoom) await zoomText(page);
      await expect(messageInput(page)).toBeVisible();
      await expectOnScreen(page, `${view.name}, empty`);

      for (const reason of ['answered', 'grounding_failed', 'not_in_source', 'emergency'] as const) await ask(page, TRIGGER[reason]);
      await expectOnScreen(page, `${view.name}, with a reply for each outcome`);
      const controls = conversation(page).locator('a, button').filter({ visible: true });
      expect(await controls.count(), 'the replies hold no links or controls').toBeGreaterThan(0);
      for (const control of await controls.all()) {
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport();
      }
    });
  }
});
