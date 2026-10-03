// Small screens and large text.
//
// no horizontal scroll: at 320 px, and at 375 px with text at 200%, neither
// the page nor any element in the operator view scrolls horizontally, in
// Questions, Gaps, Center info and the editor. Every question's message,
// every gap's label and phrasings, the editor's fields and the publish
// control lie inside the viewport horizontally and can be scrolled into
// view.
//
// Next's development overlay (<nextjs-portal>) is left out.
//
// Assumed interface: see ./support.ts.

import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  SEEDED_GAPS,
  answerThis,
  bodyField,
  db,
  gapItem,
  horizontalOverflow,
  openOperator,
  publishButton,
  sandboxId,
  showArea,
  titleField,
} from './support';

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 10_000 });

// Elements that scroll horizontally, and text or controls that lie outside
// the viewport horizontally.
async function offScreen(page: Page): Promise<string[]> {
  return page.evaluate((vw) => {
    const out: string[] = [];
    const label = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}"`;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (el.closest('nextjs-portal')) continue;
      const s = getComputedStyle(el);
      if (['auto', 'scroll'].includes(s.overflowX) && el.scrollWidth > el.clientWidth + 1) out.push(`${label(el)} scrolls horizontally`);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim() || n.parentElement?.closest('nextjs-portal, script, style')) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width > 0 && (r.left < -1 || r.right > vw + 1)) {
          out.push(`text "${n.textContent.trim().slice(0, 40)}" at ${Math.round(r.left)}..${Math.round(r.right)}`);
          break;
        }
      }
    }
    for (const el of Array.from(document.querySelectorAll('a, button, input, textarea, select, summary, [role=button], [role=link], [role=tab]'))) {
      if (el.closest('nextjs-portal')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -1 || r.right > vw + 1) out.push(`control ${label(el)} at ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    return out;
  }, page.viewportSize()!.width);
}

async function expectFits(page: Page, what: string): Promise<void> {
  expect(await horizontalOverflow(page), `${what}: the page scrolls horizontally`).toBeLessThanOrEqual(0);
  expect(await offScreen(page), `${what}: content scrolls or lies off screen horizontally`).toEqual([]);
}

async function expectReachable(locator: Locator, what: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator, `${what} cannot be scrolled into view`).toBeInViewport();
}

async function zoomText(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
}

// Shows an area and, in the zoomed view, zooms again in case showing it
// loaded a new document.
async function show(page: Page, name: 'Questions' | 'Gaps' | 'Center info', zoom: boolean) {
  const a = await showArea(page, name);
  if (zoom) await zoomText(page);
  return a;
}

for (const view of [
  { name: '320 px', width: 320, zoom: false },
  { name: '375 px with text at 200%', width: 375, zoom: true },
]) {
  test.describe(`layout at ${view.name}`, () => {
    test('no area scrolls horizontally and every message, gap, field and Publish is reachable', async ({ page, context }) => {
      await page.setViewportSize({ width: view.width, height: 812 });
      await openOperator(page);
      if (view.zoom) await zoomText(page);
      const id = await sandboxId(context);
      const { rows } = await db().query('select message from turns where sandbox_id = $1', [id]);
      expect(rows.length, 'the sandbox has no questions to lay out').toBeGreaterThan(0);

      const questions = await show(page, 'Questions', view.zoom);
      await expectFits(page, `${view.name}, Questions`);
      for (const { message } of rows) await expectReachable(questions.getByText(message, { exact: false }).first(), `${view.name}: the question "${message}"`);

      const gaps = await show(page, 'Gaps', view.zoom);
      await expectFits(page, `${view.name}, Gaps`);
      for (const [label, phrasings] of Object.entries(SEEDED_GAPS)) {
        const item = gapItem(gaps, label);
        await expectReachable(item.getByText(label, { exact: true }).first(), `${view.name}: the gap label ${label}`);
        for (const p of phrasings.slice(0, 3)) await expectReachable(item.getByText(p).first(), `${view.name}: the phrasing "${p}"`);
      }

      await show(page, 'Center info', view.zoom);
      await expectFits(page, `${view.name}, Center info`);

      await answerThis(gapItem(await show(page, 'Gaps', view.zoom), 'Sibling discount')).first().click();
      await expect(titleField(page)).toBeVisible();
      if (view.zoom) await zoomText(page);
      await expectFits(page, `${view.name}, the editor`);
      await expectReachable(titleField(page), `${view.name}: the title field`);
      await expectReachable(bodyField(page), `${view.name}: the body field`);
      for (const p of SEEDED_GAPS['Sibling discount']) await expectReachable(page.getByText(p).filter({ visible: true }).first(), `${view.name}: the phrasing "${p}" beside the editor`);
      if (!(await publishButton(page).first().isVisible())) await show(page, 'Center info', view.zoom);
      await expectFits(page, `${view.name}, with Publish shown`);
      await expectReachable(publishButton(page).first(), `${view.name}: Publish`);
    });
  });
}
