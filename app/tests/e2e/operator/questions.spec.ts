// Questions.
//
// question rows: the sandbox's questions are listed newest first. Each row
// shows its message, how long ago it was asked, its outcome, its reason and
// the titles of the sections it cites. Rows whose reply was sent to the
// front desk show "Sent to front desk"; no other row does.
//
// outcome filter: filtering to answer, handoff or urgent shows exactly the
// questions with that outcome, and All shows every question again.
//
// as the parent saw it: opening a question shows the reply the parent view
// showed: an answer's text with a citation chip per cited section, and a
// handoff's fixed text with the phone link. Chips are buttons exposing
// aria-expanded. After the cited section is edited and the edit published,
// the earlier answer's chip still shows the section's title and text as they
// were in the snapshot version the reply recorded.
//
// Assumed interface: see ./support.ts and ../support.ts.

import { expect, test, type Page } from '@playwright/test';
import { ANSWERED_TEXT, PHONE, TRIGGER, expectFragments, expectPhoneLink, fixedTextOf } from '../support';
import {
  type TurnSpec,
  agoPattern,
  ask,
  bodyField,
  chips,
  editControls,
  itemTitled,
  itemWith,
  letters,
  normalize,
  openOperator,
  openParent,
  openedQuestion,
  opener,
  publish,
  sandboxId,
  save,
  setHistory,
  showArea,
  titleField,
  unique,
  version,
} from './support';

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 10_000 });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function reasonPattern(reason: string): RegExp {
  return new RegExp(`\\b${reason.replace(/_/g, '[ _-]?')}\\b`, 'i');
}

async function rows(page: Page): Promise<{ id: string; turns: (TurnSpec & { ago: RegExp; citesTitles: string[] })[] }> {
  await openOperator(page);
  const id = await sandboxId(page.context());
  const turns = [
    { message: unique('Oracle sensitive question'), agoMs: 30 * MINUTE, outcome: 'handoff', reason: 'sensitive', sent: true, ago: agoPattern(30, 'minute'), citesTitles: [] },
    { message: unique('Oracle answered question'), agoMs: 2 * HOUR, outcome: 'answer', reason: 'answered', cites: ['meals', 'late-pickup'], sent: true, ago: agoPattern(2, 'hour'), citesTitles: ['Meals', 'Late pickup'] },
    { message: unique('Oracle unanswered question'), agoMs: 3 * DAY, outcome: 'handoff', reason: 'not_in_source', source: 'seed', ago: agoPattern(3, 'day'), citesTitles: [] },
    { message: unique('Oracle urgent question'), agoMs: 5 * DAY, outcome: 'urgent', reason: 'emergency', ago: agoPattern(5, 'day'), citesTitles: [] },
  ] as (TurnSpec & { ago: RegExp; citesTitles: string[] })[];
  // Stored oldest first, so storage order is not display order.
  await setHistory(id, [...turns].reverse());
  await page.reload();
  return { id, turns };
}

async function filterTo(page: Page, outcome: 'All' | 'Answer' | 'Handoff' | 'Urgent'): Promise<void> {
  const questions = await showArea(page, 'Questions');
  const select = questions.getByRole('combobox', { name: /outcome|filter/i });
  if ((await select.count()) > 0) {
    const options = await select.first().locator('option').allInnerTexts();
    const label = options.find((o) => new RegExp(`^${outcome}s?$`, 'i').test(o.trim()));
    expect(label, `the outcome filter has no ${outcome} option (${options.join(', ')})`).toBeTruthy();
    await select.first().selectOption({ label: label! });
    return;
  }
  const name = new RegExp(`^${outcome}s?$`, 'i');
  const option = questions.getByRole('radio', { name }).or(questions.getByRole('button', { name })).or(questions.getByRole('tab', { name })).first();
  await expect(option, `no outcome filter control named ${outcome}`).toBeVisible();
  await option.click();
}

test.describe('question rows', () => {
  test('are newest first with message, time, outcome, reason, cited titles, and the sent badge only when sent', async ({ page }) => {
    const { turns } = await rows(page);
    const questions = await showArea(page, 'Questions');
    const tops: number[] = [];
    for (const t of turns) {
      const row = itemWith(questions, t.message);
      await expect(row, `no row for "${t.message}"`).toBeVisible();
      const text = normalize(await row.innerText());
      expect(text, `${t.reason}: the row does not say how long ago`).toMatch(t.ago);
      expect(text, `${t.reason}: the row does not show its outcome`).toMatch(new RegExp(`\\b${t.outcome}\\b`, 'i'));
      expect(text, `${t.reason}: the row does not show its reason`).toMatch(reasonPattern(t.reason));
      for (const title of t.citesTitles) expect(text, `${t.reason}: the row does not show the cited title ${title}`).toContain(title);
      if (t.sent) expect(text, `${t.reason}: a sent reply has no badge`).toMatch(/sent to front desk/i);
      else expect(text, `${t.reason}: a reply never sent shows the badge`).not.toMatch(/sent to front desk/i);
      tops.push((await row.boundingBox())!.y);
    }
    expect(tops, 'the questions are not newest first').toEqual([...tops].sort((a, b) => a - b));
  });
});

test.describe('outcome filter', () => {
  test('shows exactly the questions with one outcome, then all again', async ({ page }) => {
    const { turns } = await rows(page);
    for (const outcome of ['Answer', 'Handoff', 'Urgent', 'All'] as const) {
      await filterTo(page, outcome);
      const questions = await showArea(page, 'Questions');
      for (const t of turns) {
        const shown = outcome === 'All' || t.outcome === outcome.toLowerCase();
        if (shown) await expect(itemWith(questions, t.message), `${outcome}: "${t.message}" is not shown`).toBeVisible();
        else await expect(questions.getByText(t.message), `${outcome}: "${t.message}" is shown`).toHaveCount(0);
      }
    }
  });
});

test.describe('as the parent saw it', () => {
  test("shows the parent's reply, and chips from the reply's own snapshot version after a publish", async ({ page }) => {
    await openParent(page);
    await ask(page, TRIGGER.answered);
    await ask(page, TRIGGER.not_in_source);

    await openOperator(page);
    let questions = await showArea(page, 'Questions');
    await opener(itemWith(questions, TRIGGER.answered)).click();
    let reply = openedQuestion(page);
    await expect(reply, 'opening a question shows no reply').toBeVisible();
    await expect(reply, "the opened reply is not the parent's text").toContainText(normalize(ANSWERED_TEXT));
    const meals = chips(reply).filter({ hasText: /^\s*Meals\b/ });
    await expect(meals, 'no Meals citation chip').toHaveCount(1);
    await expect(chips(reply).filter({ hasText: /^\s*Hours\b/ }), 'no Hours citation chip').toHaveCount(1);
    await expect(meals).toHaveAttribute('aria-expanded', 'false');
    await meals.click();
    await expect(meals, 'the chip does not expose its expanded state').toHaveAttribute('aria-expanded', 'true');
    await expect(reply, 'the expanded chip does not show the section text').toContainText('Breakfast is served until 8:30 AM.');
    await page.keyboard.press('Escape');

    await openOperator(page);
    questions = await showArea(page, 'Questions');
    await opener(itemWith(questions, TRIGGER.not_in_source)).click();
    reply = openedQuestion(page);
    await expect(reply).toBeVisible();
    await expectFragments(reply, fixedTextOf('not_in_source'), 'the opened handoff');
    await expectPhoneLink(reply, `the opened handoff (${PHONE})`);

    // Edit the cited section and publish.
    await openOperator(page);
    const newTitle = `Meals and snacks ${letters(6)}`;
    const newText = `Oracle meals text ${letters(10)}.`;
    const info = await showArea(page, 'Center info');
    await editControls(itemTitled(info, 'Meals')).first().click();
    await titleField(page).fill(newTitle);
    await bodyField(page).fill(newText);
    expect((await save(page)).ok(), 'saving the edit failed').toBe(true);
    expect((await publish(page)).ok(), 'publishing failed').toBe(true);
    await expect.poll(() => version(page), { message: 'the version did not become 2' }).toBe(2);

    await openOperator(page);
    questions = await showArea(page, 'Questions');
    await opener(itemWith(questions, TRIGGER.answered)).click();
    reply = openedQuestion(page);
    await expect(reply).toBeVisible();
    const old = chips(reply).filter({ hasText: /^\s*Meals\b/ });
    await expect(old, 'the chip does not show the title of the version the reply recorded').toHaveCount(1);
    await expect(old, 'the chip shows the newly published title').not.toContainText(newTitle);
    await old.click();
    await expect(reply, 'the chip does not show the text of the version the reply recorded').toContainText('Breakfast is served until 8:30 AM.');
    await expect(reply, 'the chip shows the newly published text').not.toContainText(newText);
  });
});
