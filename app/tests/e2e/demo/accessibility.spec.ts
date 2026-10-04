// Accessibility and layout of the Try this strip and Reset demo.
//
// automated check: no serious or critical violations on either view with
// the Try this strip shown, and with the Reset demo confirmation open.
//
// keyboard: the strip's first step and its dismiss control, Reset demo, and
// the confirmation's cancel and confirm controls are each reached with Tab,
// show a visible focus indicator, and work from the keyboard alone. On the
// parent view each is at least 44 by 44 CSS pixels.
//
// layout: at 320 px, and at 375 px with text at 200%, neither view scrolls
// horizontally with the strip shown, and every step of the strip lies
// within the page's width.
//
// Next's development overlay (<nextjs-portal>) is left out of every check.
//
// Assumed interface: see ./support.ts.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  QUESTION,
  VIEWS,
  type View,
  cancelButton,
  closeSql,
  confirmButton,
  confirmation,
  conversation,
  cookieOf,
  dismiss,
  expectTarget,
  firstStep,
  horizontalOverflow,
  newCookie,
  openConfirmation,
  openView,
  resetButton,
  steps,
  strip,
  tabTo,
  zoomText,
  warmUp,
} from './support';

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 15_000 });
test.afterAll(closeSql);
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await warmUp(browser);
});

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).exclude('nextjs-portal').analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

test.describe('automated check', () => {
  for (const view of VIEWS) {
    test(`the ${view.name} view with the Try this strip shown`, async ({ page }) => {
      await openView(page, view.path);
      await expect(strip(page), 'no Try this strip').toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });

    test(`the ${view.name} view with the Reset demo confirmation open`, async ({ page }) => {
      await openView(page, view.path);
      await openConfirmation(page);
      expect(await seriousViolations(page)).toEqual([]);
    });
  }
});

async function strictTargets(view: View, page: Page, which: 'strip' | 'reset'): Promise<void> {
  if (view.name !== 'parent') return;
  if (which === 'strip') {
    await expectTarget(firstStep(page), 'the first step');
    await expectTarget(dismiss(page), 'the dismiss control');
  } else {
    await expectTarget(resetButton(page), 'Reset demo');
  }
}

test.describe('keyboard', () => {
  for (const view of VIEWS) {
    test(`on the ${view.name} view, the strip's first step and dismiss control are reached with Tab, show focus, and work from the keyboard`, async ({ page }) => {
      await openView(page, view.path);
      await expect(strip(page), 'no Try this strip').toBeVisible();
      await strictTargets(view, page, 'strip');

      await tabTo(page, firstStep(page), 'the first step');
      const sent = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/ask' && r.request().method() === 'POST', { timeout: 30_000 });
      await page.keyboard.press('Enter');
      await sent;
      if (view.name === 'operator') await expect(page).toHaveURL(/\/(\?.*)?$/, { timeout: 30_000 });
      await expect(conversation(page), 'Enter on the first step sent no question').toContainText(QUESTION, { timeout: 30_000 });

      await openView(page, view.path);
      await expect(strip(page), 'no Try this strip').toBeVisible();
      await tabTo(page, dismiss(page), 'the dismiss control');
      await page.keyboard.press('Enter');
      await expect(strip(page), 'Enter on the dismiss control did not hide the strip').toBeHidden();
    });

    test(`on the ${view.name} view, Reset demo and its cancel and confirm controls are reached with Tab, show focus, and work from the keyboard`, async ({ page, context }) => {
      await openView(page, view.path);
      const old = await cookieOf(context);
      await expect(resetButton(page), 'no Reset demo control').toBeVisible();
      await strictTargets(view, page, 'reset');

      await tabTo(page, resetButton(page), 'Reset demo');
      await page.keyboard.press('Enter');
      await expect(confirmation(page), 'Enter on Reset demo opened no confirmation').toBeVisible();
      if (view.name === 'parent') {
        await expectTarget(cancelButton(page), 'the cancel control');
        await expectTarget(confirmButton(page), 'the confirm control');
      }
      await tabTo(page, cancelButton(page), 'the cancel control');
      await page.keyboard.press('Enter');
      await expect(confirmation(page), 'Enter on cancel left the confirmation open').toBeHidden();
      expect(await cookieOf(context), 'cancelling from the keyboard reset the demo').toBe(old);

      await tabTo(page, resetButton(page), 'Reset demo');
      await page.keyboard.press('Enter');
      await expect(confirmation(page)).toBeVisible();
      await tabTo(page, confirmButton(page), 'the confirm control');
      await page.keyboard.press('Enter');
      await newCookie(context, old);
    });
  }
});

const WIDTHS = [
  { name: '320 px', width: 320, zoom: false },
  { name: '375 px with text at 200%', width: 375, zoom: true },
];

test.describe('layout', () => {
  for (const view of VIEWS) {
    for (const w of WIDTHS) {
      test(`the ${view.name} view at ${w.name} fits its width with the strip shown, every step within it`, async ({ page }) => {
        await page.setViewportSize({ width: w.width, height: 800 });
        await openView(page, view.path);
        if (w.zoom) await zoomText(page);
        await expect(strip(page), 'no Try this strip').toBeVisible();
        await expect(steps(page)).toHaveCount(5);
        expect(await horizontalOverflow(page), 'the page scrolls horizontally').toBeLessThanOrEqual(0);
        for (let i = 0; i < 5; i++) {
          const step = steps(page).nth(i);
          await step.scrollIntoViewIfNeeded();
          await expect(step, `step ${i + 1} is not visible`).toBeVisible();
          const box = await step.boundingBox();
          expect(box, `step ${i + 1} has no size`).toBeTruthy();
          expect(box!.x, `step ${i + 1} starts off screen`).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width, `step ${i + 1} runs past the ${w.width} px width`).toBeLessThanOrEqual(w.width + 0.5);
        }
      });
    }
  }
});
