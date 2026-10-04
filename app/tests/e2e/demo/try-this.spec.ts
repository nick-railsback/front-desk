// The Try this strip.
//
// steps: on a sandbox that has not dismissed it, both views show a "Try
// this" strip listing five steps in order: ask a gap question as a parent;
// switch to Operator, then Gaps; answer the gap and publish; watch the
// replay; ask again as a parent. The first step is the question "Do you
// offer a discount for siblings?" as a control.
//
// first step: activating it, from either view, sends that question as a
// parent message: the parent view shows the message and its reply, and the
// question joins the operator view's Questions (beside the seeded copy of
// the same question, so Questions holds it twice).
//
// dismissal: dismissing the strip hides it on both views for that sandbox,
// through a reload and a switch of view, while another sandbox still shows
// it; Reset demo shows it again.
//
// Assumed interface: see ./support.ts.

import { expect, test, type Page } from '@playwright/test';
import {
  QUESTION,
  VIEWS,
  closeSql,
  conversation,
  cookieOf,
  dismiss,
  expectStrip,
  firstStep,
  normalize,
  openView,
  resetDemo,
  showArea,
  sql,
  strip,
  warmUp,
} from './support';

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 15_000 });
test.afterAll(closeSql);
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await warmUp(browser);
});

// The reply stored for the question in the sandbox, as the parent saw it.
async function storedReply(id: string): Promise<string> {
  await expect
    .poll(async () => (await sql().query(`select count(*)::int as n from turns where sandbox_id = $1 and message = $2 and source <> 'seed'`, [id, QUESTION])).rows[0].n, {
      timeout: 30_000,
      message: 'the question was not sent as a parent message',
    })
    .toBe(1);
  const { rows } = await sql().query(`select answer_text from turns where sandbox_id = $1 and message = $2 and source <> 'seed'`, [id, QUESTION]);
  return rows[0].answer_text as string;
}

async function expectExchange(page: Page, id: string): Promise<void> {
  const reply = await storedReply(id);
  const log = conversation(page);
  await expect(log, 'the parent view does not show the question').toContainText(QUESTION, { timeout: 30_000 });
  const opening = normalize(reply.split('(505)')[0]).slice(0, 40);
  expect(opening.length, 'the stored reply has no text').toBeGreaterThan(5);
  await expect(log, 'the parent view does not show the reply').toContainText(opening, { timeout: 30_000 });
}

async function expectInQuestions(page: Page): Promise<void> {
  await openView(page, '/operator');
  const questions = await showArea(page, 'Questions');
  await expect(questions.getByText(QUESTION, { exact: true }), 'the question did not join Questions beside its seeded copy').toHaveCount(2);
}

test.describe('steps', () => {
  for (const view of VIEWS) {
    test(`the ${view.name} view lists the five steps in order, the first being the sibling discount question`, async ({ page }) => {
      await openView(page, view.path);
      await expectStrip(page, `the ${view.name} view`);
    });
  }
});

test.describe('first step', () => {
  test('activated on the parent view, it sends the question: the message and its reply show, and it joins Questions', async ({ page, context }) => {
    await openView(page, '/');
    const id = await cookieOf(context);
    await expect(firstStep(page), 'no first step control').toBeVisible();
    await firstStep(page).click();
    await expectExchange(page, id);
    await expectInQuestions(page);
  });

  test('activated on the operator view, it sends the question: the parent view shows the message and its reply, and it joins Questions', async ({ page, context }) => {
    await openView(page, '/operator');
    const id = await cookieOf(context);
    await expect(firstStep(page), 'no first step control').toBeVisible();
    await firstStep(page).click();
    await expect(page, 'activating the first step on the operator view did not bring the parent view').toHaveURL(/\/(\?.*)?$/, { timeout: 30_000 });
    await expectExchange(page, id);
    await expectInQuestions(page);
  });
});

test.describe('dismissal', () => {
  test('dismissed on the parent view, the strip stays hidden through a reload and on the operator view, other sandboxes still show it, and Reset demo shows it again', async ({ page, context, browser }) => {
    await openView(page, '/');
    const id = await cookieOf(context);
    await expect(strip(page), 'no Try this strip to dismiss').toBeVisible();
    await dismiss(page).click();
    await expect(strip(page), 'dismissing did not hide the strip').toBeHidden();
    await page.reload();
    await expect(page.getByRole('region', { name: /today/i })).toBeVisible();
    await expect(strip(page), 'the strip is back after a reload').toBeHidden();
    await openView(page, '/operator');
    await expect(strip(page), 'the strip shows on the operator view after it was dismissed').toBeHidden();

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await openView(otherPage, '/');
    await expect(strip(otherPage), 'dismissing in one sandbox hid the strip in another').toBeVisible();
    await other.close();

    await resetDemo(page, id);
    await openView(page, '/operator');
    await expect(strip(page), 'the strip does not show on the operator view after Reset demo').toBeVisible();
    await openView(page, '/');
    await expect(strip(page), 'the strip does not show on the parent view after Reset demo').toBeVisible();
  });

  test('dismissed on the operator view, the strip is hidden on the parent view', async ({ page }) => {
    await openView(page, '/operator');
    await expect(strip(page), 'no Try this strip to dismiss').toBeVisible();
    await dismiss(page).click();
    await expect(strip(page), 'dismissing did not hide the strip').toBeHidden();
    await openView(page, '/');
    await expect(strip(page), 'the strip shows on the parent view after it was dismissed').toBeHidden();
  });
});
