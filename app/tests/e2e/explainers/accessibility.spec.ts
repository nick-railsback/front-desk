// Accessibility and layout of the explainers, the demo link and the gap note.
//
// automated check: no serious or critical violations on either view with the
// explainer open, and on the operator view with the editor opened from a gap
// and the gap note shown.
//
// focus: the "How this demo works" link and each view's explainer control
// are reached with Tab and show a visible focus indicator. On the parent view
// each is at least 44 by 44 CSS pixels.
//
// layout: at 320 px, and at 375 px with text at 200%, neither view scrolls
// horizontally with the explainer open, and the explainer's text lies within
// the page's width.
//
// Next's development overlay (<nextjs-portal>) is left out of every check.
//
// Assumed interface: see ./support.ts.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  STAFF_LABEL,
  VIEWS,
  answerThis,
  demoLink,
  expectTarget,
  explainer,
  gapItem,
  gapNote,
  horizontalOverflow,
  openExplainer,
  openView,
  showArea,
  staffRadio,
  tabTo,
  titleField,
  warmUp,
  zoomText,
} from './support';

test.describe.configure({ timeout: 120_000 });
test.use({ actionTimeout: 10_000 });
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
    test(`the ${view.name} view with the explainer open`, async ({ page }) => {
      await openView(page, view.path);
      await openExplainer(page, view.name);
      expect(await seriousViolations(page)).toEqual([]);
    });
  }

  test('the operator view with the editor opened from a gap and the gap note shown', async ({ page }) => {
    await openView(page, '/operator');
    await answerThis(gapItem(await showArea(page, 'Gaps'), 'Sibling discount')).first().click();
    await expect(titleField(page), 'Answer this opened no editor').toBeVisible();
    await expect(staffRadio(page), `no radio named exactly "${STAFF_LABEL}"`).toBeVisible();
    await staffRadio(page).check();
    await expect(gapNote(page).first(), 'the gap note is not shown').toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
});

test.describe('focus', () => {
  test('on the parent view, the demo link and the explainer control are reached with Tab, show focus, and are 44 by 44', async ({ page }) => {
    await openView(page, '/');
    await expect(demoLink(page), 'the parent view has no "How this demo works" link').toBeVisible();
    await expectTarget(demoLink(page), 'the "How this demo works" link');
    await tabTo(page, demoLink(page), 'the "How this demo works" link');

    const { control } = await explainer(page, 'parent');
    await control.scrollIntoViewIfNeeded();
    await expectTarget(control, 'the parent explainer control');
    await tabTo(page, control, 'the parent explainer control');
  });

  test('on the operator view, the explainer control is reached with Tab and shows focus', async ({ page }) => {
    await openView(page, '/operator');
    const { control } = await explainer(page, 'operator');
    await tabTo(page, control, 'the operator explainer control');
  });
});

const WIDTHS = [
  { name: '320 px', width: 320, zoom: false },
  { name: '375 px with text at 200%', width: 375, zoom: true },
];

test.describe('layout', () => {
  for (const view of VIEWS) {
    for (const w of WIDTHS) {
      test(`the ${view.name} view at ${w.name} fits its width with the explainer open`, async ({ page }) => {
        await page.setViewportSize({ width: w.width, height: 800 });
        await openView(page, view.path);
        if (w.zoom) await zoomText(page);
        const { panel } = await openExplainer(page, view.name);

        // layout: no horizontal scroll with the explainer open.
        expect(await horizontalOverflow(page), 'the page scrolls horizontally with the explainer open').toBeLessThanOrEqual(0);

        // layout: the explainer's text stays within the width.
        for (const part of await panel.filter({ visible: true }).all()) {
          await part.scrollIntoViewIfNeeded();
          const box = await part.boundingBox();
          expect(box, "the explainer's text has no size").toBeTruthy();
          expect(box!.x, "the explainer's text starts off screen").toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width, `the explainer's text runs past the ${w.width} px width`).toBeLessThanOrEqual(w.width + 0.5);
        }
      });
    }
  }
});
