// Shared helpers for the demo environment's browser tests. Not a test file:
// Playwright collects only *.spec.ts. The contracts in ../support.ts and
// ../operator/support.ts hold here too (the fd_sandbox cookie, the fixture
// model and its `fixture:<reason> ` prefixes, the operator view's areas,
// editor, Publish and version).
//
// Assumed interface. The tests hold the implementation to these contracts.
//
// 1. Try this. Both views (/ and /operator) show, while the sandbox has not
//    dismissed it, a strip that is a region (or complementary landmark)
//    whose accessible name contains "Try this". Its first list holds the
//    five steps as its list items, in order:
//      1. ask a gap question as a parent      (text mentions asking and "parent")
//      2. switch to Operator, then Gaps       (mentions "Operator" and "Gaps")
//      3. answer the gap and publish          (mentions "answer" and "publish")
//      4. watch the replay                    (mentions "replay")
//      5. ask again as a parent               (mentions "ask", "again", "parent")
//    The first step holds a button named exactly
//    "Do you offer a discount for siblings?". Activating it sends that
//    question as a parent message through POST /api/ask; activated on
//    /operator, it brings the browser to / with the message and its reply
//    shown. The strip's dismiss control is a button inside it named with
//    "Dismiss", "Close" or "Hide". Dismissal is stored for the sandbox on the
//    server, so it holds across reloads, views and browsers with the same
//    cookie; a new sandbox shows the strip again.
//
// 2. Reset demo. Both views show a button named "Reset demo". Activating it
//    opens a confirmation in the page (role dialog or alertdialog, never
//    window.confirm) holding a cancel button (named with "Cancel", "Keep",
//    "Don't", "No" or "Back") and a confirm button (named with "Reset",
//    "Confirm", "Yes" or "Start over", and with none of the cancel words).
//    Cancelling closes it and sends nothing that changes the sandbox.
//    Confirming, in one request, deletes the old sandbox with every row
//    that names it, creates a new one, and sets the fd_sandbox cookie to the
//    new ID; the view then shows the new sandbox without a further action.
//
// 3. Requests. Reset demo and dismissing the strip are fetch or XHR requests
//    from the page (a server action counts), never document navigations.
//    When one fails, the view shows a message in an element with role
//    `alert`, keeps its content, and shows no stack trace, error text, SQL,
//    internal ID or sandbox ID.
//
// 4. Activity. A sandbox's last activity is sandboxes.last_seen_at; every
//    request carrying the cookie sets it to that request's time.
//
// 5. Operator copy. Publish is a button named "Publish" whose accessible
//    description (aria-describedby) is a line shown beside it, visible
//    without hovering, saying that parents get the new text and the open
//    gaps' questions are checked again (it mentions parents and gaps). The
//    version reads "Center info version <n>, published <Month D, YYYY>", the
//    date being the latest snapshot's published_at in America/Denver.

import { type Browser, type BrowserContext, type Locator, type Page, expect } from '@playwright/test';
import { normalize } from '../support';
import { closeSql, sql } from '../../demo/tables';

export { closeSql, sql };
export { ask, conversation, messageInput, normalize, open as openParent, sendButton, todayCard } from '../support';
export {
  answerGap,
  answerThis,
  bodyField,
  control,
  expectResults,
  gapItem,
  itemTitled,
  publish,
  publishButton,
  save,
  saveButton,
  showArea,
  titleField,
  version,
} from '../operator/support';

export const COOKIE = 'fd_sandbox';
export const QUESTION = 'Do you offer a discount for siblings?';
export const DAY = 86_400_000;
export const BOOM = 'demo-boom';

export const STACK = /\bat\s+\S+\s+\(?[^\s()]+:\d+:\d+\)?|\b(?:Type|Reference|Syntax|Range)?Error\b|ECONNREFUSED|ECONNRESET|node_modules|\.tsx?:\d+/;
export const SQL = /\binsert\s+into\b|\bupdate\s+"?\w+"?\s+set\b|\bselect\b[\s\S]{0,200}\bfrom\b|\bdelete\s+from\b|\bviolates\b|\brelation\s+"/i;
export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export const SEEDED_GAPS: Record<string, string[]> = {
  'Sibling discount': [
    'Do you offer a discount for siblings?',
    'Is there a sibling discount if both my kids enroll?',
    'My twins start next month. Is there a family rate?',
    'Does the second child get reduced tuition?',
    'Do brothers and sisters get a price break on tuition?',
    'We have a toddler and a preschooler. Any discount for having two kids there?',
    'Is tuition cheaper for the second kid in the same family?',
  ],
  'Part-time schedules': [
    'Can my daughter come just Tuesdays and Thursdays?',
    'Do you have a part-time option?',
    'Is there a 3 day a week schedule for preschool?',
    'Can I pay for half days only?',
    'Do you prorate tuition if he only comes Mondays, Wednesdays, and Fridays?',
  ],
  'Summer program': [
    'Is there a summer program for kids who finish Pre-K?',
    'What does the summer schedule look like?',
    'Do you run a summer camp?',
    'Are you open in the summer for school-age kids?',
  ],
};

export function letters(n: number): string {
  return Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
}

export type View = { name: 'parent' | 'operator'; path: '/' | '/operator' };
export const VIEWS: View[] = [
  { name: 'parent', path: '/' },
  { name: 'operator', path: '/operator' },
];

// Loads a view and waits until it shows its own content.
export async function openView(page: Page, path: '/' | '/operator'): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status(), `${path} did not load`).toBe(200);
  if (path === '/') await expect(page.getByRole('region', { name: /today/i }), 'the parent view shows no Today card').toBeVisible();
  else await expect(page.getByRole('button', { name: 'Questions', exact: true }).or(page.getByRole('tab', { name: 'Questions', exact: true })).first(), 'the operator view shows no Questions control').toBeVisible();
}

// Loads both views and asks one question once, so `next dev` has compiled
// them before a test relies on what a page holds: a first compile can reload
// an open page, which clears the conversation.
export async function warmUp(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openView(page, '/');
  await page.request.post('/api/ask', { data: { message: 'When is breakfast served?', priorTurns: [] } });
  await openView(page, '/operator');
  await openView(page, '/');
  await context.close();
}

export async function cookieOf(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((c) => c.name === COOKIE);
  expect(cookie, `no ${COOKIE} cookie is set`).toBeTruthy();
  return cookie!.value;
}

// Waits until the cookie names a sandbox other than `old`, and returns it.
export async function newCookie(context: BrowserContext, old: string, timeout = 30_000): Promise<string> {
  await expect
    .poll(async () => (await context.cookies()).find((c) => c.name === COOKIE)?.value ?? null, { timeout, message: 'the cookie still names the old sandbox' })
    .not.toBe(old);
  return cookieOf(context);
}

// ---------------------------------------------------------------------------
// Try this.

export function strip(page: Page): Locator {
  return page.getByRole('region', { name: /try this/i }).or(page.getByRole('complementary', { name: /try this/i })).first();
}

export function steps(page: Page): Locator {
  return strip(page).getByRole('list').first().locator(':scope > li');
}

export function firstStep(page: Page): Locator {
  return strip(page).getByRole('button', { name: QUESTION, exact: true });
}

export function dismiss(page: Page): Locator {
  return strip(page).getByRole('button', { name: /dismiss|close|hide/i }).first();
}

export const STEP_PATTERNS: RegExp[][] = [
  [/\bask/i, /\bparent/i],
  [/\boperator\b/i, /\bgaps?\b/i],
  [/\banswer/i, /\bpublish/i],
  [/\breplay/i],
  [/\bask/i, /\bagain\b/i, /\bparent/i],
];

export async function expectStrip(page: Page, what: string): Promise<void> {
  await expect(strip(page), `${what}: no Try this strip`).toBeVisible();
  await expect(steps(page), `${what}: the strip does not list five steps`).toHaveCount(5);
  const texts = (await steps(page).allInnerTexts()).map(normalize);
  STEP_PATTERNS.forEach((patterns, i) => {
    for (const p of patterns) expect(texts[i], `${what}: step ${i + 1} ("${texts[i]}") does not match ${p}`).toMatch(p);
  });
  await expect(steps(page).first().getByRole('button', { name: QUESTION, exact: true }), `${what}: the first step holds no "${QUESTION}" button`).toBeVisible();
}

// ---------------------------------------------------------------------------
// Reset demo.

const CANCEL = /cancel|keep|don.?t|\bno\b|back/i;
const CONFIRM = /reset|confirm|yes|start over/i;

// The Reset demo control on the view, not a button of the same name inside
// the confirmation.
export function resetButton(page: Page): Locator {
  return page
    .getByRole('button', { name: /^reset demo$/i })
    .and(page.locator(':not(dialog *):not([role=dialog] *):not([role=alertdialog] *)'))
    .first();
}

export function confirmation(page: Page): Locator {
  return page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ visible: true }).first();
}

export function cancelButton(page: Page): Locator {
  return confirmation(page).getByRole('button', { name: CANCEL }).first();
}

export function confirmButton(page: Page): Locator {
  return confirmation(page)
    .getByRole('button', { name: CONFIRM })
    .filter({ hasNotText: CANCEL })
    .first();
}

export async function openConfirmation(page: Page): Promise<void> {
  await expect(resetButton(page), 'no Reset demo control').toBeVisible();
  await resetButton(page).click();
  await expect(confirmation(page), 'Reset demo asks for no confirmation').toBeVisible();
  await expect(cancelButton(page), 'the confirmation has no cancel control').toBeVisible();
  await expect(confirmButton(page), 'the confirmation has no confirm control').toBeVisible();
}

// Resets the demo from the current view and returns the new sandbox ID.
export async function resetDemo(page: Page, old: string): Promise<string> {
  await openConfirmation(page);
  await confirmButton(page).click();
  const id = await newCookie(page.context(), old);
  await expect(confirmation(page), 'the confirmation stays open after the reset').toBeHidden();
  return id;
}

// ---------------------------------------------------------------------------
// Failures.

// Answers every write request the page makes (fetch or XHR, not GET) with a
// server error whose body holds a stack trace, SQL and the sandbox ID.
export async function failWritesWithDetail(page: Page, id: string): Promise<() => Promise<void>> {
  const body = JSON.stringify({
    error: `${BOOM}: TypeError: Cannot read properties of undefined\n    at reset (/srv/app/.next/server/app/api/reset.js:12:34)`,
    sql: `delete from "sandboxes" where "id" = '${id}'`,
    sandboxId: id,
  });
  const handler = async (route: import('@playwright/test').Route) => {
    const r = route.request();
    if (['fetch', 'xhr'].includes(r.resourceType()) && r.method() !== 'GET') {
      await route.fulfill({ status: 500, contentType: 'application/json', body });
    } else {
      await route.fallback();
    }
  };
  await page.route('**/*', handler);
  return () => page.unroute('**/*', handler);
}

export function alertMessage(page: Page): Locator {
  return page.getByRole('alert').filter({ hasText: /[A-Za-z]{3}/ }).filter({ visible: true });
}

export async function expectClean(page: Page, id: string, what: string): Promise<void> {
  const text = await page.locator('body').innerText();
  expect(normalize(text).length, `${what}: the page is blank`).toBeGreaterThan(0);
  expect(text, `${what}: the page shows a stack trace or error`).not.toMatch(STACK);
  expect(text, `${what}: the page shows SQL or a database error`).not.toMatch(SQL);
  expect(text, `${what}: the page shows the failure's own text`).not.toContain(BOOM);
  expect(text, `${what}: the page shows an internal ID`).not.toMatch(UUID);
  expect(text, `${what}: the page shows the sandbox ID`).not.toContain(id);
}

// ---------------------------------------------------------------------------
// Layout and keyboard.

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

export async function zoomText(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
}

// Presses Tab until `target` has focus, and reports whether it showed a
// visible focus indicator then: an outline, a box shadow, or any change of
// border, background, color or underline from its resting style.
export async function tabTo(page: Page, target: Locator, what: string): Promise<void> {
  await expect(target, `${what} is not shown`).toBeVisible();
  const rest = await target.evaluate((el) => {
    const s = getComputedStyle(el);
    el.setAttribute('data-demo-target', '1');
    return [s.outlineStyle, s.outlineWidth, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join('|');
  });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  let reached = false;
  for (let i = 0; i < 120 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement?.getAttribute('data-demo-target') === '1');
  }
  expect(reached, `${what} is never reached with Tab`).toBe(true);
  const indicated = await target.evaluate((el, before) => {
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
    const shadow = s.boxShadow !== 'none';
    const now = [s.outlineStyle, s.outlineWidth, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join('|');
    return outline || shadow || now !== before;
  }, rest);
  await target.evaluate((el) => el.removeAttribute('data-demo-target'));
  expect(indicated, `${what} shows no visible focus indicator`).toBe(true);
}

export async function expectTarget(target: Locator, what: string): Promise<void> {
  const box = await target.boundingBox();
  expect(box, `${what} has no size`).toBeTruthy();
  expect(box!.width, `${what} is ${box!.width} px wide`).toBeGreaterThanOrEqual(44);
  expect(box!.height, `${what} is ${box!.height} px tall`).toBeGreaterThanOrEqual(44);
}
