// Accessibility.
//
// automated check: no serious or critical violations on the empty parent
// view, or with a reply for every reason and an expanded citation chip. The
// limit notice is checked in ./limits-and-failures.spec.ts.
//
// keyboard: after sending by the send control or by Enter, focus is back in
// the message input. Every control is reached by Tab, shows a visible focus
// indicator, and works from the keyboard.
//
// target size: every interactive target is at least 44 by 44 CSS pixels,
// empty and with a reply for each outcome.
//
// reduced motion: with reduced motion preferred, nothing animates or
// transitions, including the typing indicator while a reply is pending.
//
// Next's development overlay (<nextjs-portal>) is not part of the parent view
// and is left out of every check.
//
// Assumed interface: see ./support.ts.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  ALL_REASONS,
  SENT_TEXT,
  TRIGGER,
  ask,
  chips,
  conversation,
  messageInput,
  newConversation,
  open,
  sendButton,
  sendToFrontDesk,
  showMore,
  suggestions,
  todayCard,
  typingIndicator,
} from './support';

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 10_000 });

const INTERACTIVE =
  'a[href], button, input, textarea, select, summary, [role=button], [role=link], [tabindex]:not([tabindex="-1"])';

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).exclude('nextjs-portal').analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

async function askEveryReason(page: Page): Promise<void> {
  for (const reason of ALL_REASONS) await ask(page, TRIGGER[reason]);
}

test.describe('automated check', () => {
  test('the empty parent view has no serious or critical violations', async ({ page }) => {
    await open(page);
    await expect(messageInput(page)).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('a reply for every reason and an expanded chip have no serious or critical violations', async ({ page }) => {
    await open(page);
    await askEveryReason(page);
    const chip = chips(conversation(page)).first();
    await chip.click();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(await seriousViolations(page)).toEqual([]);
  });
});

// Targets smaller than 44 by 44, described.
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (el.closest('nextjs-portal') || r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (r.width < 43.99 || r.height < 43.99) {
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
        out.push(`${el.tagName.toLowerCase()} "${name}" is ${r.width.toFixed(1)} x ${r.height.toFixed(1)}`);
      }
    }
    return out;
  }, INTERACTIVE);
}

test.describe('target size', () => {
  test('every interactive target is at least 44 by 44, empty and with each outcome', async ({ page }) => {
    await open(page);
    await expect(suggestions(page).first(), 'the empty view shows no suggested questions to measure').toBeVisible();
    await messageInput(page).fill('Do you have a swimming pool?');
    expect(await smallTargets(page), 'empty conversation').toEqual([]);

    await messageInput(page).fill('');
    await askEveryReason(page);
    await chips(conversation(page)).first().click();
    await messageInput(page).fill('Do you have a garden?');
    expect(await smallTargets(page), 'with a reply for each outcome').toEqual([]);
  });
});

// Every visible, enabled interactive element gets a mark; Tab visits the page
// twice over, and every mark must be reached with a visible focus indicator.
async function tabThrough(page: Page): Promise<{ missed: string[]; noIndicator: string[] }> {
  const total = await page.evaluate((selector) => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((el) => {
      const r = el.getBoundingClientRect();
      return !el.closest('nextjs-portal') && r.width > 0 && r.height > 0 && !(el as HTMLButtonElement).disabled && getComputedStyle(el).visibility !== 'hidden';
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
  return { missed, noIndicator: [...noIndicator] };
}

test.describe('keyboard', () => {
  test('focus returns to the input after sending by the button and by Enter', async ({ page }) => {
    await open(page);
    await ask(page, 'Do you have a swimming pool?');
    await expect(messageInput(page), 'focus did not return to the input after the send control').toBeFocused();

    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/ask');
    await messageInput(page).fill('Do you have a garden?');
    await messageInput(page).press('Enter');
    await answered;
    await expect(conversation(page)).toContainText('Do you have a garden?');
    await expect(messageInput(page), 'focus did not return to the input after Enter').toBeFocused();
  });

  test('every control is reached by Tab with a visible focus indicator', async ({ page }) => {
    await open(page);
    await expect(suggestions(page).first()).toBeVisible();
    await messageInput(page).fill('Do you have a swimming pool?');
    const empty = await tabThrough(page);
    expect(empty.missed, 'empty: controls Tab never reaches').toEqual([]);
    expect(empty.noIndicator, 'empty: controls with no visible focus indicator').toEqual([]);

    await messageInput(page).fill('');
    await askEveryReason(page);
    await chips(conversation(page)).first().click();
    await messageInput(page).fill('Do you have a garden?');
    const full = await tabThrough(page);
    expect(full.missed, 'with replies: controls Tab never reaches').toEqual([]);
    expect(full.noIndicator, 'with replies: controls with no visible focus indicator').toEqual([]);
  });

  test('suggestions, chips, Show more, Send to front desk and New conversation work from the keyboard', async ({ page }) => {
    await open(page);
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/ask');
    await suggestions(page).first().focus();
    await page.keyboard.press('Enter');
    await answered;

    await ask(page, TRIGGER.answered);
    const log = conversation(page);
    const chip = chips(log).first();
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(chip, 'Enter does not expand a chip').toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(chip, 'Space does not collapse a chip').toHaveAttribute('aria-expanded', 'false');

    await ask(page, TRIGGER.grounding_failed);
    const before = await showMore(log).count();
    await showMore(log).first().focus();
    await page.keyboard.press('Enter');
    await expect(showMore(log), 'Enter does not operate Show more').toHaveCount(before - 1);

    const send = sendToFrontDesk(log).last();
    await send.focus();
    await page.keyboard.press('Enter');
    await expect(log.getByText(SENT_TEXT).first(), 'Enter does not operate Send to front desk').toBeVisible();

    await newConversation(page).focus();
    await page.keyboard.press('Enter');
    await expect(suggestions(page).first(), 'Enter does not operate New conversation').toBeVisible();

    const operator = page.getByRole('link', { name: /^operator$/i }).or(page.getByRole('button', { name: /^operator$/i }));
    await operator.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/operator\/?$/);
  });
});

// What moves: running animations in the document and any element, or its
// ::before or ::after, with an animation or transition longer than 0.01 ms.
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
  test('nothing animates, including the typing indicator while a reply is pending', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/ask', async (route) => {
      await held;
      await route.continue();
    });
    await open(page);
    await expect(todayCard(page)).toBeVisible();
    expect(await motion(page), 'empty view').toEqual([]);

    await messageInput(page).fill(TRIGGER.answered);
    await sendButton(page).click();
    await expect(typingIndicator(page).first(), 'no typing indicator while the reply is pending').toBeVisible();
    expect(await motion(page), 'while a reply is pending').toEqual([]);

    release();
    await expect(typingIndicator(page)).toHaveCount(0);
    await page.unroute('**/api/ask');
    for (const reason of ALL_REASONS.filter((r) => r !== 'answered')) await ask(page, TRIGGER[reason]);
    await chips(conversation(page)).first().click();
    expect(await motion(page), 'with a reply for each outcome').toEqual([]);
  });
});
