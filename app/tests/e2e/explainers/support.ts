// Shared helpers for the demo explainer browser tests. Not a test file:
// Playwright collects only *.spec.ts. The contracts in ../support.ts,
// ../operator/support.ts and ../demo/support.ts hold here too (the fd_sandbox
// cookie, the fixture model, the operator view's areas and editor, the Try
// this strip with its dismiss control, and Reset demo).
//
// Assumed interface. The tests hold the implementation to these contracts.
//
// 1. The demo section. On each view (/ and /operator) the demo section is the
//    innermost element that holds the Reset demo button and, while it is
//    shown, the Try this region; once the strip is dismissed, the innermost
//    element that holds Reset demo and the explainer control (see 2). It
//    holds none of the view's own content: on the parent view the Today
//    card, the conversation (role log) and the message input; on the
//    operator view the summary strip and the Questions area control.
//
// 2. The explainer. Inside the demo section and outside the Try this region,
//    the explainer control is a `summary` element, or a button (or
//    role=button) with aria-expanded. The first one found is the explainer.
//    Its text is, for a `summary`, the content of its `details` element other
//    than the summary; for a button, the element(s) its aria-controls names,
//    or else its next element sibling. The control's open or closed state is
//    read from the browser's accessibility tree (the `expanded` property),
//    so a native `details`/`summary` or a button with aria-expanded both
//    qualify. Its accessible name is read from the same tree.
//
// 3. "How this demo works". The parent view has one link whose accessible
//    name is "How this demo works" (case-insensitive). Its href ends in a
//    fragment `#<id>`; the element with that id holds the demo section (it
//    may be the demo section itself) and none of the view's own content.
//    Activating the link leaves document.activeElement on that element or
//    inside it (for example, the element carries tabindex="-1").
//
// 4. Visibility. In the section editor the visibility radios are named
//    exactly "Parent (the front desk answers from it)" and "Staff only
//    (never shown to parents)". In Center info each policy section's item
//    (one with an Edit control) shows "Parent" or "Staff only".
//
// 5. The gap note. In the editor opened by a gap's "Answer this", while Staff
//    only is chosen, an element with role `status` is visible whose text
//    mentions the gap, says it stays open, and mentions parents. While
//    Parent is chosen, or in an editor opened from "Add section" or a
//    section's "Edit", no such element is visible.
//
// Elements are found by marking them with data-oracle-* attributes; the marks
// are cleared each time a helper looks again.

import { expect, type Locator, type Page } from '@playwright/test';
import { conversation, messageInput, normalize, todayCard } from '../support';
import { area, control, summary } from '../operator/support';
import { resetButton, strip } from '../demo/support';

export { normalize, todayCard, conversation, messageInput } from '../support';
export { answerThis, draftOf, editControls, gapItem, itemTitled, showArea, titleField } from '../operator/support';
export { cookieOf, dismiss, expectTarget, horizontalOverflow, openView, resetButton, strip, tabTo, warmUp, zoomText } from '../demo/support';
export { area, control, summary };

export type ViewName = 'parent' | 'operator';
export type View = { name: ViewName; path: '/' | '/operator' };
export const VIEWS: View[] = [
  { name: 'parent', path: '/' },
  { name: 'operator', path: '/operator' },
];

export const PARENT_LABEL = 'Parent (the front desk answers from it)';
export const STAFF_LABEL = 'Staff only (never shown to parents)';

const MARKS = ['data-oracle-reset', 'data-oracle-strip', 'data-oracle-content', 'data-oracle-demo', 'data-oracle-panel', 'data-oracle-target'];

async function clearMarks(page: Page): Promise<void> {
  await page.evaluate((marks) => {
    for (const m of marks) document.querySelectorAll(`[${m}]`).forEach((el) => el.removeAttribute(m));
  }, MARKS);
}

// Marks every element a locator matches; returns how many.
async function mark(locator: Locator, attr: string): Promise<number> {
  return locator.evaluateAll((els, a) => {
    els.forEach((el) => el.setAttribute(a, ''));
    return els.length;
  }, attr);
}

function viewContent(page: Page, view: ViewName): { what: string; locator: Locator }[] {
  if (view === 'parent') {
    return [
      { what: 'the Today card', locator: todayCard(page) },
      { what: 'the conversation', locator: conversation(page) },
      { what: 'the message input', locator: messageInput(page) },
    ];
  }
  return [
    { what: 'the summary strip', locator: summary(page) },
    { what: 'the Questions control', locator: control(page.locator('body'), 'Questions') },
  ];
}

// Finds the demo section (contract 1), marks it, and returns it.
export async function demoSection(page: Page, view: ViewName): Promise<Locator> {
  await clearMarks(page);
  await expect(resetButton(page), `${view} view: no Reset demo button`).toBeVisible();
  await mark(resetButton(page), 'data-oracle-reset');
  if (await strip(page).isVisible()) await mark(strip(page), 'data-oracle-strip');
  for (const c of viewContent(page, view)) {
    expect(await mark(c.locator, 'data-oracle-content'), `${view} view: ${c.what} is not shown`).toBeGreaterThan(0);
  }
  const found = await page.evaluate(() => {
    const reset = document.querySelector('[data-oracle-reset]');
    if (!reset) return 'no Reset demo button';
    const stripEl = document.querySelector('[data-oracle-strip]');
    const isExplainer = (el: Element): boolean =>
      el.matches('summary, button[aria-expanded], [role=button][aria-expanded]') &&
      el !== reset &&
      !el.closest('[data-oracle-strip], dialog, [role=dialog], [role=alertdialog]');
    for (let el = reset.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      const holds = stripEl ? el.contains(stripEl) : Array.from(el.querySelectorAll('*')).some(isExplainer);
      if (!holds) continue;
      if (el.matches('[data-oracle-content]') || el.querySelector('[data-oracle-content]')) {
        return stripEl
          ? 'the element holding Reset demo and the Try this strip also holds the view\'s own content'
          : 'no element holds Reset demo and an explainer control without also holding the view\'s own content';
      }
      el.setAttribute('data-oracle-demo', '');
      return '';
    }
    return stripEl ? 'no element holds both Reset demo and the Try this strip' : 'no element holds Reset demo and an explainer control';
  });
  expect(found, `${view} view: the demo section is not found`).toBe('');
  return page.locator('[data-oracle-demo]');
}

// The explainer control (contract 2) inside a demo section.
export function explainerControl(section: Locator): Locator {
  return section
    .locator(':is(summary, button[aria-expanded], [role=button][aria-expanded]):not([data-oracle-strip] *):not(dialog *):not([role=dialog] *):not([role=alertdialog] *)')
    .first();
}

// Finds the demo section and its explainer control, and expects the control
// to be shown.
export async function explainer(page: Page, view: ViewName): Promise<{ section: Locator; control: Locator }> {
  const section = await demoSection(page, view);
  const c = explainerControl(section);
  await expect(c, `${view} view: the demo section holds no explainer control (a summary, or a button with aria-expanded)`).toBeVisible();
  return { section, control: c };
}

// The element(s) holding the explainer's text (contract 2), marked.
export async function panelOf(c: Locator): Promise<Locator> {
  const page = c.page();
  await page.evaluate(() => document.querySelectorAll('[data-oracle-panel]').forEach((el) => el.removeAttribute('data-oracle-panel')));
  const n = await c.evaluate((el) => {
    let targets: Element[] = [];
    if (el.tagName === 'SUMMARY') {
      const details = el.closest('details');
      if (details) targets = Array.from(details.children).filter((child) => child !== el);
    } else {
      const ids = (el.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean);
      targets = ids.map((id) => document.getElementById(id)).filter((t): t is HTMLElement => t !== null);
      if (targets.length === 0 && el.nextElementSibling) targets = [el.nextElementSibling];
    }
    targets.forEach((t) => t.setAttribute('data-oracle-panel', ''));
    return targets.length;
  });
  expect(n, 'the explainer control reveals no element').toBeGreaterThan(0);
  return page.locator('[data-oracle-panel]');
}

export async function panelText(panel: Locator): Promise<string> {
  return normalize((await panel.allInnerTexts()).join(' '));
}

export async function expectClosed(panel: Locator, what: string): Promise<void> {
  await expect(panel.filter({ visible: true }), `${what}: the explainer's text is visible while it is closed`).toHaveCount(0);
}

export async function expectOpen(panel: Locator, what: string): Promise<void> {
  await expect(panel.filter({ visible: true }).first(), `${what}: the explainer's text is not shown`).toBeVisible();
  expect((await panelText(panel)).length, `${what}: the explainer shows no text`).toBeGreaterThan(0);
}

// What the browser's accessibility tree says about an element.
export async function axNode(target: Locator): Promise<{ name: string; expanded: boolean | undefined }> {
  const page = target.page();
  await page.evaluate(() => document.querySelectorAll('[data-oracle-target]').forEach((el) => el.removeAttribute('data-oracle-target')));
  await target.evaluate((el) => el.setAttribute('data-oracle-target', ''));
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-oracle-target]' });
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    const node = nodes[0];
    const expanded = node?.properties?.find((p) => p.name === 'expanded');
    return { name: String(node?.name?.value ?? ''), expanded: expanded ? Boolean(expanded.value.value) : undefined };
  } finally {
    await cdp.detach();
  }
}

export async function expectExpanded(c: Locator, open: boolean, what: string): Promise<void> {
  await expect.poll(async () => (await axNode(c)).expanded, { message: `${what}: the explainer control does not expose ${open ? 'open' : 'closed'} to assistive technology` }).toBe(open);
}

// Opens a closed explainer with a click and returns its text.
export async function openExplainer(page: Page, view: ViewName): Promise<{ section: Locator; control: Locator; panel: Locator; text: string }> {
  const { section, control: c } = await explainer(page, view);
  const panel = await panelOf(c);
  await c.click();
  await expectOpen(panel, `${view} view`);
  return { section, control: c, panel, text: await panelText(panel) };
}

// ---------------------------------------------------------------------------
// "How this demo works".

export function demoLink(page: Page): Locator {
  return page.getByRole('link', { name: /^\s*how this demo works\s*$/i });
}

// The element the link's fragment names, marked, or a failed expectation.
export async function linkTarget(page: Page): Promise<Locator> {
  await expect(demoLink(page), 'the parent view has no "How this demo works" link').toHaveCount(1);
  const href = (await demoLink(page).getAttribute('href')) ?? '';
  const id = decodeURIComponent(href.includes('#') ? href.slice(href.indexOf('#') + 1) : '');
  expect(id, `the "How this demo works" link's href (${href}) names no fragment`).not.toBe('');
  const target = page.locator(`[id="${id.replace(/"/g, '\\"')}"]`);
  await expect(target, `no element has the id "${id}" the link names`).toHaveCount(1);
  return target;
}

// Whether `inner` is `outer` or inside it.
export async function within(outer: Locator, inner: Locator): Promise<boolean> {
  const handle = await inner.elementHandle();
  return outer.evaluate((o, i) => o === i || o.contains(i as Node), handle);
}

export async function activeWithin(target: Locator): Promise<boolean> {
  return target.evaluate((el) => {
    const a = document.activeElement;
    return a !== null && a !== document.body && (el === a || el.contains(a));
  });
}

// a precedes b in document order.
export async function precedes(a: Locator, b: Locator): Promise<boolean> {
  const handle = await b.elementHandle();
  return a.evaluate((x, y) => Boolean(x.compareDocumentPosition(y as Node) & Node.DOCUMENT_POSITION_FOLLOWING) && !x.contains(y as Node), handle);
}

// An element's box in page coordinates.
export async function pageBox(locator: Locator): Promise<{ top: number; bottom: number; left: number; right: number }> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY, left: r.left + window.scrollX, right: r.right + window.scrollX };
  });
}

// ---------------------------------------------------------------------------
// The section editor.

export function parentRadio(page: Page): Locator {
  return page.getByRole('radio', { name: PARENT_LABEL, exact: true });
}

export function staffRadio(page: Page): Locator {
  return page.getByRole('radio', { name: STAFF_LABEL, exact: true });
}

// The note that a gap stays open while its section is staff only (contract 5).
export function gapNote(page: Page): Locator {
  return page
    .getByRole('status')
    .filter({ hasText: /\bgaps?\b/i })
    .filter({ hasText: /\bopen\b/i })
    .filter({ visible: true });
}

export function cancelButton(page: Page): Locator {
  return page.getByRole('button', { name: /^cancel$/i });
}
