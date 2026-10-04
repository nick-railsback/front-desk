// The tap-to-open explainer in each view's demo section.
//
// explainer toggle: on both views the demo section holds an explainer
// control, closed on load with its text not visible. A click, Enter or Space
// opens it and shows the text; the same again closes it and hides the text.
// The control exposes its open or closed state to assistive technology.
//
// explainer after dismissal: dismissing the Try this strip leaves the
// explainer in the demo section, at once, after a reload, and on the other
// view.
//
// parent explainer: the control's accessible name mentions gaps; the text
// says the front desk answers only from the center's information operators
// write, and what a gap is. It contains "gap" and "operator".
//
// operator explainer: the text differs from the parent view's and walks the
// operator from gap to Answer this to Publish to replay. It contains "gap",
// "publish" and "replay".
//
// The wording beyond those words is for a human reviewer.
//
// Assumed interface: see ./support.ts.

import { expect, test, type Page } from '@playwright/test';
import {
  VIEWS,
  axNode,
  dismiss,
  expectClosed,
  expectExpanded,
  expectOpen,
  explainer,
  openExplainer,
  openView,
  panelOf,
  strip,
  warmUp,
  type View,
} from './support';

test.describe.configure({ timeout: 120_000 });
test.use({ actionTimeout: 10_000 });
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await warmUp(browser);
});

async function toggleTwice(page: Page, view: View, how: 'click' | 'Enter' | 'Space'): Promise<void> {
  await openView(page, view.path);
  const { control } = await explainer(page, view.name);
  const panel = await panelOf(control);
  const what = `${view.name} view, ${how}`;

  // explainer toggle: closed on load.
  await expectClosed(panel, `${what}, on load`);
  await expectExpanded(control, false, `${what}, on load`);

  const activate = async () => {
    if (how === 'click') {
      await control.click();
    } else {
      await control.focus();
      await page.keyboard.press(how);
    }
  };

  // explainer toggle: activating it opens it.
  await activate();
  await expectOpen(panel, `${what}, after activating once`);
  await expectExpanded(control, true, `${what}, after activating once`);

  // explainer toggle: activating it again closes it.
  await activate();
  await expectClosed(panel, `${what}, after activating twice`);
  await expectExpanded(control, false, `${what}, after activating twice`);
}

test.describe('explainer toggle', () => {
  for (const view of VIEWS) {
    for (const how of ['click', 'Enter', 'Space'] as const) {
      test(`on the ${view.name} view, ${how} opens and closes the explainer`, async ({ page }) => {
        await toggleTwice(page, view, how);
      });
    }
  }
});

async function expectExplainerPresent(page: Page, view: View, what: string): Promise<void> {
  await expect(strip(page), `${what}: the Try this strip is still shown`).toBeHidden();
  const { control } = await explainer(page, view.name);
  const panel = await panelOf(control);
  await expectClosed(panel, what);
  await control.click();
  await expectOpen(panel, what);
}

test.describe('explainer after dismissal', () => {
  for (const view of VIEWS) {
    const other = VIEWS.find((v) => v !== view)!;
    test(`dismissing Try this on the ${view.name} view leaves the explainer on both views, before and after a reload`, async ({ page }) => {
      await openView(page, view.path);
      await expect(strip(page), 'no Try this strip').toBeVisible();
      await dismiss(page).click();
      await expect(strip(page), 'the dismiss control did not hide the strip').toBeHidden();

      // explainer after dismissal: still in the demo section at once.
      await expectExplainerPresent(page, view, `${view.name} view, right after dismissing`);

      // explainer after dismissal: still there after a reload.
      await page.reload();
      await expectExplainerPresent(page, view, `${view.name} view, after a reload`);

      // explainer after dismissal: and on the other view.
      await openView(page, other.path);
      await expectExplainerPresent(page, other, `${other.name} view, after dismissing on the ${view.name} view`);
    });
  }
});

test.describe('explainer text', () => {
  test('the parent explainer is named for gaps and says what the front desk answers from and what a gap is', async ({ page }) => {
    await openView(page, '/');
    const { control } = await explainer(page, 'parent');

    // parent explainer: its accessible name mentions gaps.
    const { name } = await axNode(control);
    expect(name, `the parent explainer control's accessible name ("${name}") does not contain "gap"`).toMatch(/gap/i);

    // parent explainer: its text uses the words gap and operator.
    const { text } = await openExplainer(page, 'parent');
    expect(text, `the parent explainer ("${text}") does not say "gap"`).toMatch(/\bgaps?\b/i);
    expect(text, `the parent explainer ("${text}") does not say "operator"`).toMatch(/\boperators?\b/i);
  });

  test('the operator explainer is its own text and covers gaps, publishing and the replay', async ({ page }) => {
    await openView(page, '/');
    const parent = (await openExplainer(page, 'parent')).text;

    await openView(page, '/operator');
    const { text } = await openExplainer(page, 'operator');

    // operator explainer: written for the operator, not the parent's text.
    expect(text, 'the operator explainer repeats the parent explainer').not.toBe(parent);
    expect(text, `the operator explainer ("${text}") does not say "gap"`).toMatch(/\bgaps?\b/i);
    expect(text, `the operator explainer ("${text}") does not say "publish"`).toMatch(/\bpublish/i);
    expect(text, `the operator explainer ("${text}") does not say "replay"`).toMatch(/\breplay/i);
  });
});
