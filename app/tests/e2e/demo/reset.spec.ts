// Reset demo.
//
// cancel: both views offer a "Reset demo" control; activating it asks for
// confirmation, and cancelling changes nothing: the cookie names the same
// sandbox, every row of the sandbox is as it was, and the view keeps what it
// showed.
//
// confirm: confirming Reset demo gives the browser a new sandbox (the cookie
// names a different sandbox ID) and the view shows a fresh copy of the demo
// center: the parent conversation is empty, a question asked before the
// reset is not in Questions, a section saved or published before the reset
// is gone, the version is the seed's (1), and the seeded gaps are open
// again. In the same request the old sandbox and all its data are deleted:
// by the time the browser holds the new cookie, no row in any table names
// the old sandbox's ID, and markers written only into it (a question, a
// section title, a published section's text) are stored nowhere. Another
// sandbox's rows are unchanged.
//
// The tables are listed from the schema at run time (../../demo/tables.ts).
// Last activity (sandboxes.last_seen_at) is not demo data, so it is left out
// of "unchanged".
//
// Assumed interface: see ./support.ts.

import { expect, test, type Page } from '@playwright/test';
import { KNOWN_TABLES, idColumns, rowsHolding, rowsNaming, rowsOf, tablesOf } from '../../demo/tables';
import {
  SEEDED_GAPS,
  VIEWS,
  answerGap,
  answerThis,
  ask,
  bodyField,
  cancelButton,
  closeSql,
  confirmation,
  conversation,
  cookieOf,
  expectResults,
  gapItem,
  letters,
  normalize,
  openConfirmation,
  openView,
  publish,
  resetDemo,
  save,
  showArea,
  titleField,
  version,
  warmUp,
} from './support';

test.describe.configure({ timeout: 15 * 60_000 });
test.use({ actionTimeout: 15_000 });
test.afterAll(closeSql);
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await warmUp(browser);
});

const ACTIVITY = ['last_seen_at'];

async function addSection(page: Page, title: string, body: string): Promise<void> {
  const info = await showArea(page, 'Center info');
  const add = info.getByRole('button', { name: /add/i }).or(info.getByRole('link', { name: /add/i })).first();
  await add.click();
  await expect(titleField(page), 'the add control opened no editor').toBeVisible();
  await titleField(page).fill(title);
  await bodyField(page).fill(body);
  const saved = await save(page);
  expect(saved.ok(), `the save failed with ${saved.status()}`).toBe(true);
}

test.describe('cancel', () => {
  for (const view of VIEWS) {
    test(`on the ${view.name} view, Reset demo asks for confirmation and cancelling changes nothing`, async ({ page, context }) => {
      await openView(page, view.path);
      const asked = `Is there a pottery class on Saturday? Ref ${letters(10)}`;
      if (view.name === 'parent') await ask(page, asked);
      const id = await cookieOf(context);
      const before = await rowsOf(id, ACTIVITY);

      await openConfirmation(page);
      await cancelButton(page).click();
      await expect(confirmation(page), 'cancelling left the confirmation open').toBeHidden();
      await page.waitForTimeout(1500);

      expect(await cookieOf(context), 'cancelling changed the sandbox').toBe(id);
      expect(await rowsOf(id, ACTIVITY), 'cancelling changed the sandbox data').toEqual(before);
      if (view.name === 'parent') await expect(conversation(page), 'cancelling cleared the conversation').toContainText(asked);
    });
  }
});

test.describe('confirm', () => {
  test('confirming on the parent view gives a new sandbox with a fresh center, deletes the old one and all its data in the same request, and leaves another sandbox alone', async ({ page, context, browser }) => {
    const columns = await idColumns();
    for (const t of KNOWN_TABLES) expect(tablesOf(columns), `the schema listing does not reach the ${t} table`).toContain(t);

    // A question, an unpublished section and a published section, each
    // carrying a marker no other sandbox holds; the sibling gap resolved.
    const asked = `Is there a pottery class on Saturday? Ref ${letters(12)}`;
    const savedTitle = `Pottery class ${letters(12)}`;
    const publishedMarker = `Ref ${letters(12)}`;
    await openView(page, '/');
    await ask(page, asked);
    const old = await cookieOf(context);
    const operator = await context.newPage();
    await openView(operator, '/operator');
    await answerGap(operator, 'Sibling discount', `${SEEDED_GAPS['Sibling discount'].join('\n')}\n${publishedMarker}`);
    expect((await publish(operator)).ok(), 'the publish failed').toBe(true);
    await expectResults(operator, { 'Sibling discount': '7 of 7' }, 8 * 60_000);
    await addSection(operator, savedTitle, 'Saturdays at 10:00 AM.');
    for (const m of [asked, savedTitle, publishedMarker]) expect(await rowsHolding(m), `"${m}" was never stored`).not.toEqual([]);

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await openView(otherPage, '/');
    const other = await cookieOf(otherContext);
    const otherBefore = await rowsOf(other, ACTIVITY);

    const fresh = await resetDemo(page, old);
    expect(fresh, 'the new sandbox has the old ID').not.toBe(old);
    expect(await rowsNaming(old, columns), 'rows still name the old sandbox once the browser holds the new cookie').toEqual([]);
    for (const m of [asked, savedTitle, publishedMarker]) expect(await rowsHolding(m), `"${m}", written only into the old sandbox, is still stored`).toEqual([]);
    expect(await rowsOf(other, ACTIVITY), "Reset demo changed another sandbox's rows").toEqual(otherBefore);
    expect(await rowsNaming(fresh, columns), 'the new sandbox holds no data').not.toEqual([]);
    await otherContext.close();

    await expect(page.getByRole('region', { name: /today/i }), 'the parent view is not shown after the reset').toBeVisible({ timeout: 30_000 });
    expect(normalize(await conversation(page).innerText()), 'the parent conversation is not empty after the reset').toBe('');

    await openView(operator, '/operator');
    expect(await version(operator), 'the version is not the seed version').toBe(1);
    const questions = await showArea(operator, 'Questions');
    await expect(questions, 'a question asked before the reset is in Questions').not.toContainText(asked);
    const info = await showArea(operator, 'Center info');
    await expect(info, 'a section saved before the reset is still there').not.toContainText(savedTitle);
    await expect(info.getByText('Sibling discount', { exact: true }), 'a section published before the reset is still there').toHaveCount(0);
    const gaps = await showArea(operator, 'Gaps');
    for (const label of Object.keys(SEEDED_GAPS)) {
      await expect(answerThis(gapItem(gaps, label)).first(), `the seeded gap ${label} is not open`).toBeVisible();
    }
    await expect(gaps, 'a gap shows as resolved after the reset').not.toContainText(/resolved/i);
  });

  test('confirming on the operator view gives a new sandbox at the seed version and deletes the old one', async ({ page, context }) => {
    await openView(page, '/operator');
    const old = await cookieOf(context);
    await editAndPublish(page);
    const fresh = await resetDemo(page, old);
    expect(fresh).not.toBe(old);
    expect(await rowsNaming(old), 'rows still name the old sandbox once the browser holds the new cookie').toEqual([]);
    await openView(page, '/operator');
    expect(await version(page), 'the version is not the seed version').toBe(1);
  });
});

// Publishes once, so the old sandbox is at version 2.
async function editAndPublish(page: Page): Promise<void> {
  await answerThis(gapItem(await showArea(page, 'Gaps'), 'Summer program')).first().click();
  await expect(titleField(page)).toBeVisible();
  await bodyField(page).fill(`We run no summer program. Ref ${letters(8)}.`);
  expect((await save(page)).ok(), 'the save failed').toBe(true);
  expect((await publish(page)).ok(), 'the publish failed').toBe(true);
  await expect.poll(() => version(page), { timeout: 30_000 }).toBe(2);
}
