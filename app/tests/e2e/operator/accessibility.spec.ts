// Accessibility of the operator view.
//
// automated check: no serious or critical violations in Questions with a
// question opened and a citation chip expanded, in Gaps showing replay
// results and a Resolved gap, in Center info, in the editor opened from
// Answer this, while a replay is in progress, and after a refused save.
//
// focus: every control is reached by Tab and shows a visible focus
// indicator, in each area, with a question and a chip open, and with the
// editor open. While a modal is open, only its controls count.
//
// keyboard operation: the role switcher, each area's control, the outcome
// filter, a question row, a citation chip, Answer this, the edit and add
// controls, the editor's fields, Save and Publish all work from the
// keyboard alone.
//
// reduced motion: with reduced motion preferred, nothing in the operator
// view animates or transitions, including the replay progress.
//
// The replay in progress is shown by answering the view's progress requests
// with { running: true, completed: 3, total: 16 } (see ./support.ts).
// Next's development overlay (<nextjs-portal>) is left out of every check.
//
// Assumed interface: see ./support.ts.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  AREAS,
  SEEDED_GAPS,
  alertMessage,
  answerGap,
  answerThis,
  bodyField,
  chips,
  control,
  editControls,
  expectResults,
  gapItem,
  itemTitled,
  itemWith,
  letters,
  openOperator,
  openedQuestion,
  opener,
  publish,
  publishButton,
  saveButton,
  showArea,
  titleField,
  version,
  visibilityOf,
} from './support';

test.describe.configure({ timeout: 12 * 60_000 });
test.use({ actionTimeout: 10_000 });

const INTERACTIVE =
  'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=radio], [tabindex]:not([tabindex="-1"])';
const SEEDED_ANSWER = 'How much is the late pickup fee?';
const SEEDED_URGENT = 'My son is having an allergic reaction right now and his lips are swelling. What do I do?';
const SEEDED_HANDOFF = 'I want to dispute the late fee from last week. It was not my fault.';

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).exclude('nextjs-portal').analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

async function openSeededAnswer(page: Page): Promise<void> {
  const questions = await showArea(page, 'Questions');
  await opener(itemWith(questions, SEEDED_ANSWER)).click();
  await expect(openedQuestion(page), 'opening a question shows no reply').toBeVisible();
  const chip = chips(openedQuestion(page)).first();
  await chip.click();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
}

async function holdReplayInProgress(page: Page): Promise<void> {
  await page.route('**/api/replay*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ running: true, completed: 3, total: 16 }) }),
  );
  await answerGap(page, 'Summer program', `We run no summer program. Oracle ${letters(8)}.`);
  expect((await publish(page)).ok(), 'the publish failed').toBe(true);
  await expect(page.getByText(/\b3 of 16\b/).first(), 'the view shows no replay progress').toBeVisible({ timeout: 30_000 });
}

async function resolveSibling(page: Page): Promise<void> {
  await answerGap(page, 'Sibling discount', SEEDED_GAPS['Sibling discount'].join('\n'));
  expect((await publish(page)).ok(), 'the publish failed').toBe(true);
  await expectResults(page, { 'Sibling discount': '7 of 7', 'Part-time schedules': '0 of 5', 'Summer program': '0 of 4' }, 8 * 60_000);
  await expect(gapItem(await showArea(page, 'Gaps'), 'Sibling discount')).toContainText(/resolved/i);
}

test.describe('automated check', () => {
  test('Questions with a question opened and a chip expanded', async ({ page }) => {
    await openOperator(page);
    await openSeededAnswer(page);
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('Gaps with replay results and a Resolved gap', async ({ page }) => {
    await openOperator(page);
    await resolveSibling(page);
    await showArea(page, 'Gaps');
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('Center info', async ({ page }) => {
    await openOperator(page);
    await showArea(page, 'Center info');
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('the editor opened from Answer this', async ({ page }) => {
    await openOperator(page);
    await answerThis(gapItem(await showArea(page, 'Gaps'), 'Sibling discount')).first().click();
    await expect(titleField(page)).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('a replay in progress', async ({ page }) => {
    await openOperator(page);
    await holdReplayInProgress(page);
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('a refused save', async ({ page }) => {
    await openOperator(page);
    await editControls(itemTitled(await showArea(page, 'Center info'), 'Meals')).first().click();
    await titleField(page).evaluate((el) => el.removeAttribute('maxlength'));
    await titleField(page).fill(`T${letters(80)}`);
    await saveButton(page).click();
    await expect(alertMessage(page).first(), 'a refused save shows no message').toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
});

// Every visible, enabled interactive element gets a mark (only those inside
// an open modal when there is one; one per radio group or tab list); Tab visits the page twice over, and every
// mark must be reached with a visible focus indicator.
async function tabThrough(page: Page): Promise<{ total: number; missed: string[]; noIndicator: string[] }> {
  const total = await page.evaluate((selector) => {
    document.querySelectorAll('[data-oracle-tab]').forEach((el) => el.removeAttribute('data-oracle-tab'));
    const modal = document.querySelector<HTMLElement>('dialog:modal, [aria-modal="true"]');
    const els = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((el) => {
      const r = el.getBoundingClientRect();
      return (
        !el.closest('nextjs-portal') &&
        !el.closest('[inert]') &&
        (!modal || modal.contains(el)) &&
        r.width > 0 &&
        r.height > 0 &&
        !(el as HTMLButtonElement).disabled &&
        getComputedStyle(el).visibility !== 'hidden' &&
        // One stop per radio group and per tab list: the unchecked radios and
        // unselected tabs are reached by arrow keys.
        !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked && document.querySelector(`input[type=radio][name="${el.name}"]:checked`)) &&
        !(el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') !== 'true' && el.closest('[role=tablist]')?.querySelector('[role=tab][aria-selected=true]'))
      );
    });
    els.forEach((el, i) => {
      el.dataset.oracleTab = String(i);
      const s = getComputedStyle(el);
      el.dataset.oracleRest = [s.outlineStyle, s.outlineWidth, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join('|');
    });
    (document.activeElement as HTMLElement | null)?.blur();
    return els.length;
  }, INTERACTIVE);

  const reached = new Set<string>();
  const noIndicator = new Set<string>();
  for (let i = 0; i < 2 * total + 10; i++) {
    await page.keyboard.press('Tab');
    const seen = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el?.dataset?.oracleTab) return null;
      const s = getComputedStyle(el);
      const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
      const shadow = s.boxShadow !== 'none';
      const now = [s.outlineStyle, s.outlineWidth, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join('|');
      const name = `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`;
      return { id: el.dataset.oracleTab, name, indicated: outline || shadow || now !== el.dataset.oracleRest };
    });
    if (!seen) continue;
    reached.add(seen.id);
    if (!seen.indicated) noIndicator.add(seen.name);
  }
  const missed = await page.evaluate((ids) => {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-oracle-tab]'))
      .filter((el) => !ids.includes(el.dataset.oracleTab!))
      .map((el) => `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`);
  }, [...reached]);
  return { total, missed, noIndicator: [...noIndicator] };
}

async function expectAllReached(page: Page, what: string): Promise<void> {
  const r = await tabThrough(page);
  expect(r.total, `${what}: no controls to reach`).toBeGreaterThan(0);
  expect(r.missed, `${what}: controls Tab never reaches`).toEqual([]);
  expect(r.noIndicator, `${what}: controls with no visible focus indicator`).toEqual([]);
}

test.describe('focus', () => {
  test('every control is reached by Tab with a visible focus indicator', async ({ page }) => {
    await openOperator(page);
    for (const name of AREAS) {
      await showArea(page, name);
      await expectAllReached(page, name);
    }
    await openSeededAnswer(page);
    await expectAllReached(page, 'an opened question with a chip expanded');
    await openOperator(page);
    await answerThis(gapItem(await showArea(page, 'Gaps'), 'Sibling discount')).first().click();
    await expect(titleField(page)).toBeVisible();
    await expectAllReached(page, 'the editor');
  });
});

async function pressOn(page: Page, locator: Locator, key = 'Enter'): Promise<void> {
  await locator.focus();
  await expect(locator, 'the control cannot take focus').toBeFocused();
  await page.keyboard.press(key);
}

async function filterByKeyboard(page: Page, outcome: 'All' | 'Urgent'): Promise<void> {
  const questions = await showArea(page, 'Questions');
  const select = questions.getByRole('combobox', { name: /outcome|filter/i });
  if ((await select.count()) > 0) {
    await select.first().focus();
    await page.keyboard.type(outcome);
    return;
  }
  const name = new RegExp(`^${outcome}s?$`, 'i');
  await pressOn(page, questions.getByRole('radio', { name }).or(questions.getByRole('button', { name })).or(questions.getByRole('tab', { name })).first(), 'Space');
}

test.describe('keyboard operation', () => {
  test('every kind of control works from the keyboard alone', async ({ page }) => {
    await openOperator(page);
    const body = page.locator('body');

    await pressOn(page, control(body, 'Gaps').first());
    const gaps = page.getByRole('tabpanel', { name: 'Gaps', exact: true }).or(page.getByRole('region', { name: 'Gaps', exact: true })).first();
    await expect(gaps, 'Enter does not open Gaps').toBeVisible();

    await pressOn(page, answerThis(gapItem(gaps, 'Summer program')).first());
    await expect(titleField(page), 'Enter does not operate Answer this').toHaveValue('Summer program');
    await pressOn(page, titleField(page), 'End');
    await page.keyboard.type(' and camps');
    await expect(titleField(page)).toHaveValue('Summer program and camps');
    await bodyField(page).focus();
    await page.keyboard.type(`We run no summer program. Oracle ${letters(8)}.`);
    const select = page.getByRole('combobox', { name: /visibility/i });
    if ((await select.count()) > 0) {
      await select.first().focus();
      await page.keyboard.type('staff');
      expect(await visibilityOf(page), 'the keyboard does not change visibility').toBe('staff');
      await page.keyboard.type('parent');
    } else {
      await pressOn(page, page.getByRole('radio', { name: /^staff\b/i }).first(), 'Space');
      expect(await visibilityOf(page), 'the keyboard does not change visibility').toBe('staff');
      await pressOn(page, page.getByRole('radio', { name: /^parent\b/i }).first(), 'Space');
    }
    expect(await visibilityOf(page)).toBe('parent');
    const saved = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/sections' && r.request().method() === 'POST');
    await pressOn(page, saveButton(page));
    expect((await saved).ok(), 'Enter on Save did not save').toBe(true);

    if (!(await publishButton(page).first().isVisible())) await pressOn(page, control(body, 'Center info').first());
    const published = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/publish' && r.request().method() === 'POST');
    await pressOn(page, publishButton(page).first());
    expect((await published).ok(), 'Enter on Publish did not publish').toBe(true);
    await expect.poll(() => version(page)).toBe(2);

    await openOperator(page);
    await pressOn(page, control(body, 'Questions').first());
    await filterByKeyboard(page, 'Urgent');
    const questions = await showArea(page, 'Questions');
    await expect(itemWith(questions, SEEDED_URGENT), 'the keyboard filter does not show urgent questions').toBeVisible();
    await expect(questions.getByText(SEEDED_HANDOFF), 'the keyboard filter does not hide handoffs').toHaveCount(0);
    await filterByKeyboard(page, 'All');
    await expect(itemWith(questions, SEEDED_HANDOFF), 'the keyboard filter does not return to all').toBeVisible();

    await pressOn(page, opener(itemWith(questions, SEEDED_ANSWER)));
    await expect(openedQuestion(page), 'Enter does not open a question').toBeVisible();
    const chip = chips(openedQuestion(page)).first();
    await pressOn(page, chip);
    await expect(chip, 'Enter does not expand a chip').toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(chip, 'Space does not collapse a chip').toHaveAttribute('aria-expanded', 'false');

    await openOperator(page);
    await pressOn(page, control(body, 'Center info').first());
    const info = await showArea(page, 'Center info');
    await pressOn(page, editControls(itemTitled(info, 'Meals')).first());
    await expect(titleField(page), 'Enter does not operate an edit control').toHaveValue('Meals');
    await openOperator(page);
    const info2 = await showArea(page, 'Center info');
    await pressOn(page, info2.getByRole('button', { name: /add/i }).or(info2.getByRole('link', { name: /add/i })).first());
    await expect(titleField(page), 'Enter does not operate the add control').toHaveValue('');

    await openOperator(page);
    await pressOn(page, control(body, /^parent$/i).first());
    await expect(page, 'Enter on Parent does not go to the parent view').toHaveURL(/\/$/);
  });
});

// What moves: running animations and any element, or its ::before or
// ::after, with an animation or transition longer than 0.01 ms.
async function motion(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const ms = (v: string) => (v.trim().endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000);
    const label = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${(el.textContent ?? '').trim().slice(0, 30)}"`;
    for (const a of document.getAnimations()) {
      const target = (a.effect as KeyframeEffect | null)?.target;
      if (target && target.getRootNode() !== document) continue;
      out.push(`running ${a.constructor.name} on ${target ? label(target) : 'the document'}`);
    }
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (el.closest('nextjs-portal')) continue;
      for (const pseudo of [null, '::before', '::after']) {
        const s = getComputedStyle(el, pseudo);
        if (s.animationName !== 'none' && s.animationDuration.split(',').some((d) => ms(d) > 0.01)) out.push(`animation ${s.animationName} on ${label(el)}${pseudo ?? ''}`);
        if (s.transitionDuration.split(',').some((d) => ms(d) > 0.01)) out.push(`transition ${s.transitionProperty} on ${label(el)}${pseudo ?? ''}`);
      }
    }
    return out;
  });
}

test.describe('reduced motion', () => {
  test('nothing animates in any area, an opened question, the editor, or the replay progress', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openOperator(page);
    for (const name of AREAS) {
      await showArea(page, name);
      expect(await motion(page), name).toEqual([]);
    }
    await openSeededAnswer(page);
    expect(await motion(page), 'an opened question with a chip expanded').toEqual([]);
    await openOperator(page);
    await answerThis(gapItem(await showArea(page, 'Gaps'), 'Sibling discount')).first().click();
    await expect(titleField(page)).toBeVisible();
    expect(await motion(page), 'the editor').toEqual([]);
    await openOperator(page);
    await holdReplayInProgress(page);
    expect(await motion(page), 'the replay progress').toEqual([]);
  });

  test('nothing animates when replay results and a Resolved gap are shown', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openOperator(page);
    await resolveSibling(page);
    expect(await motion(page), 'replay results').toEqual([]);
  });
});
