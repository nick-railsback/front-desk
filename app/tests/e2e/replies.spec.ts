// Replies by outcome.
//
// citation chips: an answered reply shows its text, one chip per citation and
// Send to front desk. A policy chip reads the section title and "Updated" with
// its date; a data chip reads the title and "From center records". Each chip
// is a button that exposes its expanded state and shows or hides the
// section's verbatim text.
//
// degraded answer: "Here's what our handbook says:" and the verbatim text of
// each cited section, with no generated text. A cited section over 600
// characters shows at most its first 600 and its own Show more control. Send
// to front desk is offered.
//
// handoff replies: not_in_source, sensitive, unsupported_language and
// system_error each show their fixed text, the phone link, Send to front desk
// and exactly one expectation line, with no generated text.
// unsupported_language reads in English and Spanish.
//
// urgent replies: emergency and safety show their fixed text and the phone
// link, no Send to front desk and no generated text. emergency says to call
// 911 first; safety never mentions 911.
//
// Assumed interface: see ./support.ts.

import { expect, test, type Page } from '@playwright/test';
import { DEGRADED_PREFACE } from '../../src/core/copy';
import { renderDataSections } from '../../src/core/assemble';
import { expectationLine } from '../../src/core/today';
import {
  ANSWERED_TEXT,
  HANDOFF_REASONS,
  MARKER,
  TRIGGER,
  URGENT_REASONS,
  type Section,
  ask,
  chips,
  conversation,
  datePattern,
  expectFragments,
  expectPhoneLink,
  expectationLines,
  fixedTextOf,
  normalize,
  open,
  publishedSections,
  sandboxId,
  sendToFrontDesk,
  showMore,
  structuredOf,
  visibleText,
} from './support';

test.describe.configure({ timeout: 120_000 });
test.use({ actionTimeout: 10_000 });

const TRUNCATE_AT = 600;

// The sections a reply in this page's sandbox cites, as the pipeline renders
// them now: published policy sections, then the data sections.
async function sectionsNow(page: Page): Promise<Section[]> {
  const id = await sandboxId(page.context());
  const structured = await structuredOf(id);
  return [...(await publishedSections(id)), ...(renderDataSections(structured as never, new Date()) as Section[])];
}

async function expectNoGeneratedText(page: Page, what: string): Promise<void> {
  expect((await page.locator('body').innerText()).toLowerCase(), `${what}: generated text is shown`).not.toContain(MARKER);
}

test.describe('citation chips', () => {
  test('an answer shows its text, a chip per citation, and Send to front desk', async ({ page }) => {
    await open(page);
    await ask(page, TRIGGER.answered);
    const log = conversation(page);
    await expect(log, 'the answer text is not shown').toContainText(ANSWERED_TEXT);
    await expect(sendToFrontDesk(log), 'the answer offers no Send to front desk').toBeVisible();

    const sections = await sectionsNow(page);
    const meals = sections.find((s) => s.id === 'meals')!;
    const hours = sections.find((s) => s.id === 'hours')!;
    const all = chips(log);
    await expect(all, 'the answer does not show one chip per citation').toHaveCount(2);

    const mealsChip = all.filter({ hasText: meals.title });
    await expect(mealsChip, 'no chip is labeled with the Meals title').toHaveCount(1);
    const mealsLabel = normalize(await mealsChip.innerText());
    expect(mealsLabel, 'the policy chip does not say "Updated"').toMatch(/updated/i);
    expect(mealsLabel, `the policy chip does not show its last-updated date ${meals.updatedOn}`).toMatch(datePattern(meals.updatedOn));
    expect(mealsLabel).not.toMatch(/from center records/i);

    const hoursChip = all.filter({ hasText: hours.title });
    await expect(hoursChip, 'no chip is labeled with the Hours title').toHaveCount(1);
    expect(normalize(await hoursChip.innerText()), 'the data chip does not say "From center records"').toMatch(/from center records/i);

    for (const [chip, section] of [
      [mealsChip, meals],
      [hoursChip, hours],
    ] as const) {
      await expect(chip, `the ${section.title} chip is not a collapsed button`).toHaveAttribute('aria-expanded', 'false');
      await chip.click();
      await expect(chip).toHaveAttribute('aria-expanded', 'true');
      expect(await visibleText(log), `the ${section.title} chip does not show the section's verbatim text`).toContain(normalize(section.text));
      await chip.click();
      await expect(chip).toHaveAttribute('aria-expanded', 'false');
      const lastLine = normalize(section.text.split('\n').filter(Boolean).at(-1)!);
      expect(await visibleText(log), `the ${section.title} chip did not hide the section's text`).not.toContain(lastLine);
    }
  });
});

test.describe('degraded answer', () => {
  test("shows the handbook's verbatim text, truncating each long section on its own", async ({ page }) => {
    await open(page);
    await ask(page, TRIGGER.grounding_failed);
    const log = conversation(page);
    await expect(log, 'the degraded answer does not open with the handbook preface').toContainText(DEGRADED_PREFACE);
    await expectNoGeneratedText(page, 'degraded answer');
    await expect(sendToFrontDesk(log), 'the degraded answer offers no Send to front desk').toBeVisible();

    const sections = await sectionsNow(page);
    const cited = ['meals', 'calendar', 'menu'].map((id) => sections.find((s) => s.id === id)!);
    const long = cited.filter((s) => s.text.length > TRUNCATE_AT);
    expect(long.map((s) => s.id), 'the menu section is no longer over 600 characters').toContain('menu');

    let text = await visibleText(log);
    for (const s of cited) {
      if (s.text.length <= TRUNCATE_AT) {
        expect(text, `the ${s.title} section is not shown whole`).toContain(normalize(s.text));
      } else {
        expect(text, `the ${s.title} section does not show its own first characters`).toContain(normalize(s.text.slice(0, 500)));
        expect(text, `the ${s.title} section shows more than its first 600 characters`).not.toContain(normalize(s.text.slice(0, TRUNCATE_AT + 20)));
      }
    }

    const controls = showMore(log);
    await expect(controls, 'each section over 600 characters needs its own Show more').toHaveCount(long.length);
    const each = await controls.elementHandles();
    for (let i = 1; i <= each.length; i++) {
      await each[i - 1].click();
      text = await visibleText(log);
      const whole = long.filter((s) => text.includes(normalize(s.text)));
      expect(whole.length, 'one Show more did not reveal exactly one more section').toBe(i);
    }
    await expectNoGeneratedText(page, 'degraded answer, expanded');
  });
});

test.describe('handoff replies', () => {
  for (const reason of HANDOFF_REASONS) {
    test(`${reason}: fixed text, phone link, Send to front desk and one expectation line`, async ({ page }) => {
      await open(page);
      await ask(page, TRIGGER[reason]);
      const log = conversation(page);
      await expectFragments(log, fixedTextOf(reason), reason);
      await expectPhoneLink(log, reason);
      await expect(log.getByRole('button', { name: /send to front desk/i }), `${reason}: no Send to front desk button`).toBeVisible();

      const lines = expectationLines(await visibleText(log));
      expect(lines.open + lines.closed.length, `${reason}: not exactly one expectation line`).toBe(1);
      const structured = await structuredOf(await sandboxId(page.context()));
      const expected = expectationLine(new Date(), structured.calendar);
      expect(await visibleText(log), `${reason}: the expectation line is not "${expected}"`).toContain(expected);

      await expectNoGeneratedText(page, reason);
      if (reason === 'unsupported_language') {
        const text = await visibleText(log);
        expect(text, 'the reply has no English').toMatch(/We can only answer questions in English/);
        expect(text, 'the reply has no Spanish').toMatch(/Por ahora solo podemos responder/);
      }
    });
  }
});

test.describe('urgent replies', () => {
  for (const reason of URGENT_REASONS) {
    test(`${reason}: fixed text and phone link, no Send to front desk`, async ({ page }) => {
      await open(page);
      await ask(page, TRIGGER[reason]);
      const log = conversation(page);
      await expectFragments(log, fixedTextOf(reason), reason);
      await expectPhoneLink(log, reason);
      await expect(sendToFrontDesk(page), `${reason}: an urgent reply offers Send to front desk`).toHaveCount(0);
      await expectNoGeneratedText(page, reason);

      const text = await visibleText(log);
      if (reason === 'emergency') {
        expect(text, 'the emergency reply does not say to call 911').toMatch(/call 911/i);
        expect(text.indexOf('911'), 'the emergency reply does not put 911 before calling the center').toBeLessThan(text.search(/call the center/i));
      } else {
        expect(text, 'the safety reply mentions 911').not.toContain('911');
      }
    });
  }
});
