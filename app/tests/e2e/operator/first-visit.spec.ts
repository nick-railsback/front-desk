// First visit and layout of the operator view.
//
// first visit: loading the operator view with no sandbox cookie creates a
// sandbox and sets an HttpOnly cookie naming it. Switching to the parent
// view keeps that sandbox: the cookie is unchanged and the parent page sets
// no new one. A question asked there is listed in the operator view's
// Questions, and reloading the operator view keeps the sandbox.
//
// layout: the operator view shows a summary strip, the Questions, Gaps and
// Center info areas, and the current snapshot version. The role switcher
// marks Operator as the current view, not Parent, and its Parent control
// goes to /. A note says the center, the people and the questions are
// fictional.
//
// Assumed interface: see ./support.ts and ../support.ts.

import { expect, test } from '@playwright/test';
import { AREAS, COOKIE, area, ask, control, db, itemWith, openOperator, openParent, showArea, summary, unique, version } from './support';

test.describe.configure({ timeout: 120_000 });
test.use({ actionTimeout: 10_000 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test.describe('first visit', () => {
  test('creates one sandbox, keeps it in the parent view, and lists a question asked there', async ({ page, context }) => {
    expect(await context.cookies(), 'the browser starts with cookies').toEqual([]);
    const response = await page.goto('/operator');
    expect(response?.status(), 'the operator view did not load').toBe(200);
    const cookie = (await context.cookies()).find((c) => c.name === COOKIE);
    expect(cookie, `loading the operator view set no ${COOKIE} cookie`).toBeTruthy();
    expect(cookie!.httpOnly, 'the sandbox cookie is not HttpOnly').toBe(true);
    expect(cookie!.value).toMatch(UUID);
    const id = cookie!.value;
    const { rows } = await db().query('select 1 from sandboxes where id = $1', [id]);
    expect(rows.length, 'the cookie names no sandbox').toBe(1);
    await expect(control(page.locator('body'), 'Questions').first()).toBeVisible();

    const parent = await page.goto('/');
    expect((await parent!.allHeaders())['set-cookie'] ?? '', 'the parent view set a new sandbox cookie').not.toContain(`${COOKIE}=`);
    expect((await context.cookies()).find((c) => c.name === COOKIE)?.value, 'the parent view changed the sandbox').toBe(id);
    await openParent(page);
    const message = unique('Do you have a swimming pool?');
    await ask(page, message);
    expect((await context.cookies()).find((c) => c.name === COOKIE)?.value, 'asking changed the sandbox').toBe(id);

    await openOperator(page);
    const questions = await showArea(page, 'Questions');
    await expect(itemWith(questions, message), 'the question asked as a parent is not in Questions').toBeVisible();

    await page.reload();
    await expect(control(page.locator('body'), 'Questions').first()).toBeVisible();
    expect((await context.cookies()).find((c) => c.name === COOKIE)?.value, 'reloading changed the sandbox').toBe(id);
  });
});

test.describe('layout', () => {
  test('shows the summary strip, the three areas, the version, the role switcher and the fictional-data note', async ({ page }) => {
    await openOperator(page);
    await expect(summary(page), 'no summary strip').toBeVisible();
    for (const name of AREAS) await showArea(page, name);
    expect(await version(page), 'the version shown is not the seeded snapshot').toBe(1);

    const operator = control(page.locator('body'), /^operator$/i).first();
    const parent = control(page.locator('body'), /^parent$/i).first();
    const current = (el: Element) =>
      ['page', 'true'].includes(el.getAttribute('aria-current') ?? '') || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true';
    expect(await operator.evaluate(current), 'the Operator control is not marked as the current view').toBe(true);
    expect(await parent.evaluate(current), 'the Parent control is marked as the current view').toBe(false);

    const note = page.getByText(/fictional/i).first();
    await expect(note, 'no note says the data is fictional').toBeVisible();
    const said = await note.innerText();
    expect(said, 'the note does not name the center').toMatch(/cent(er|re)|juniper hill/i);
    expect(said, 'the note does not name the people').toMatch(/people|staff|famil|names|person/i);
    expect(said, 'the note does not name the questions').toMatch(/question/i);

    await expect(area(page, 'Center info')).toBeVisible();
    await parent.click();
    await expect(page).toHaveURL(/\/$/);
  });
});
