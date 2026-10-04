// Where the demo section sits on the parent view, and the link that leads to
// it.
//
// parent view order: top to bottom, the Today card, the conversation, the
// message input, then the demo section (Try this and Reset demo), in
// document order and as rendered.
//
// demo link: a link named "How this demo works" comes before the Today card.
// Activating it by click or by Enter brings the demo section into the
// viewport at 375 by 812 and leaves keyboard focus on or inside it.
//
// Next's development overlay (<nextjs-portal>) plays no part in these checks.
//
// Assumed interface: see ./support.ts.

import { expect, test, type Page } from '@playwright/test';
import {
  activeWithin,
  conversation,
  demoLink,
  demoSection,
  linkTarget,
  messageInput,
  openView,
  pageBox,
  precedes,
  resetButton,
  strip,
  todayCard,
  warmUp,
  within,
} from './support';

test.describe.configure({ timeout: 120_000 });
test.use({ actionTimeout: 10_000, viewport: { width: 375, height: 812 } });
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await warmUp(browser);
});

test.describe('parent view order', () => {
  test('the Today card, the conversation and the message input come first, and the demo section after the input', async ({ page }) => {
    await openView(page, '/');
    await expect(strip(page), 'no Try this strip').toBeVisible();
    const section = await demoSection(page, 'parent');

    // parent view order: in the document.
    expect(await precedes(todayCard(page), conversation(page)), 'the Today card does not come before the conversation').toBe(true);
    expect(await precedes(conversation(page), messageInput(page)), 'the conversation does not come before the message input').toBe(true);
    expect(await precedes(messageInput(page), section), 'the demo section does not come after the message input in the document').toBe(true);

    // parent view order: as rendered.
    const card = await pageBox(todayCard(page));
    const log = await pageBox(conversation(page));
    const input = await pageBox(messageInput(page));
    const demo = await pageBox(section);
    expect(card.top, 'the Today card is not above the conversation').toBeLessThan(log.top);
    expect(log.top, 'the conversation is not above the message input').toBeLessThan(input.top);
    expect(demo.top, 'the demo section is not rendered below the message input').toBeGreaterThanOrEqual(input.bottom - 1);
  });
});

async function expectLinkLeadsToDemo(page: Page, how: 'click' | 'Enter'): Promise<void> {
  const section = await demoSection(page, 'parent');
  const target = await linkTarget(page);

  // demo link: its fragment names the element holding the demo section,
  // which holds none of the view's own content.
  expect(await within(target, section), "the link's target does not hold the demo section").toBe(true);
  for (const [what, el] of [
    ['the Today card', todayCard(page)],
    ['the conversation', conversation(page)],
    ['the message input', messageInput(page)],
  ] as const) {
    expect(await within(target, el), `the link's target holds ${what}`).toBe(false);
  }
  expect(await within(target, resetButton(page)), "the link's target does not hold Reset demo").toBe(true);

  if (how === 'click') {
    await demoLink(page).click();
  } else {
    await demoLink(page).focus();
    await page.keyboard.press('Enter');
  }

  // demo link: activating it scrolls the demo section into view and moves
  // keyboard focus onto it or into it.
  await expect(section, `after ${how} on the link, the demo section is not in the viewport`).toBeInViewport();
  await expect.poll(() => activeWithin(target), { message: `after ${how} on the link, keyboard focus is not on or inside the demo section` }).toBe(true);
}

test.describe('demo link', () => {
  test('"How this demo works" comes before the Today card', async ({ page }) => {
    await openView(page, '/');
    await expect(demoLink(page), 'the parent view has no "How this demo works" link').toBeVisible();
    expect(await precedes(demoLink(page), todayCard(page)), 'the link does not come before the Today card').toBe(true);
  });

  test('a click on "How this demo works" brings the demo section into view and focus', async ({ page }) => {
    await openView(page, '/');
    await expectLinkLeadsToDemo(page, 'click');
  });

  test('Enter on "How this demo works" brings the demo section into view and focus', async ({ page }) => {
    await openView(page, '/');
    await expectLinkLeadsToDemo(page, 'Enter');
  });
});
