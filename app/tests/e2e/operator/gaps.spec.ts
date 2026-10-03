// Gaps and Answer this.
//
// gap list: open gaps are listed by question count, highest first. Each
// shows its label, its question count, how long ago its newest question was
// asked, and its 3 most recent phrasings, or all of them when it has fewer.
//
// answer this: "Answer this" opens the editor on a new section whose title
// is the gap's label, whose body is empty and whose visibility is parent,
// with every one of the gap's phrasings displayed beside it, not only 3.
//
// operator-written text: a section saved from Answer this holds exactly the
// title and body the operator entered, with parent visibility. No generated
// text appears in the operator view: with a live answer in the sandbox whose
// reply carries the fixture model's marker, the marker is in no area, no
// gap, the editor's fields or the saved section.
//
// Assumed interface: see ./support.ts and ../support.ts.

import { expect, test } from '@playwright/test';
import {
  AREAS,
  MARKER,
  SEEDED_GAPS,
  TRIGGER,
  agoPattern,
  answerThis,
  ask,
  bodyField,
  draftOf,
  everything,
  gapItem,
  letters,
  normalize,
  openOperator,
  openParent,
  sandboxId,
  save,
  setHistory,
  showArea,
  titleField,
  unique,
  visibilityOf,
} from './support';

test.describe.configure({ timeout: 120_000 });
test.use({ actionTimeout: 10_000 });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test.describe('gap list', () => {
  test('sorts open gaps by count and shows label, count, last asked and the 3 most recent phrasings', async ({ page, context }) => {
    await openOperator(page);
    const id = await sandboxId(context);
    const q = (label: string, agoMs: number) => ({ message: unique(`Oracle ${label} question`), agoMs, outcome: 'handoff' as const, reason: 'not_in_source' });
    const swim = [q('swim', 2 * HOUR), q('swim', DAY + 2 * HOUR), q('swim', 2 * DAY), q('swim', 3 * DAY)];
    const bus = [q('bus', 5 * HOUR), q('bus', 4 * DAY)];
    const piano = [3, 4, 5, 6, 7, 8].map((h) => q('piano', h * DAY));
    // Stored in an order that is neither count order nor recency order.
    await setHistory(id, [...bus, ...swim.slice().reverse(), ...piano], [
      { label: 'Oracle bus service', messages: bus.map((t) => t.message) },
      { label: 'Oracle swim lessons', messages: swim.map((t) => t.message) },
      { label: 'Oracle piano lessons', messages: piano.map((t) => t.message) },
    ]);
    await page.reload();

    const gaps = await showArea(page, 'Gaps');
    const expected = [
      { label: 'Oracle piano lessons', count: 6, newest: agoPattern(3, 'day'), shown: piano.slice(0, 3), hidden: piano.slice(3) },
      { label: 'Oracle swim lessons', count: 4, newest: agoPattern(2, 'hour'), shown: swim.slice(0, 3), hidden: swim.slice(3) },
      { label: 'Oracle bus service', count: 2, newest: agoPattern(5, 'hour'), shown: bus, hidden: [] },
    ];
    const tops: number[] = [];
    for (const g of expected) {
      const item = gapItem(gaps, g.label);
      await expect(item, `the ${g.label} gap is not listed`).toBeVisible();
      const text = normalize(await item.innerText());
      expect(text, `${g.label}: no question count`).toMatch(new RegExp(`\\b${g.count}\\s+questions?\\b`, 'i'));
      expect(text, `${g.label}: does not say when it was last asked`).toMatch(g.newest);
      for (const t of g.shown) expect(text, `${g.label}: a recent phrasing is missing`).toContain(t.message);
      for (const t of g.hidden) expect(text, `${g.label}: shows more than the 3 most recent phrasings`).not.toContain(t.message);
      tops.push((await item.boundingBox())!.y);
    }
    expect(tops, 'the gaps are not sorted by question count, highest first').toEqual([...tops].sort((a, b) => a - b));
  });
});

test.describe('answer this', () => {
  test('opens the editor prefilled with the label, an empty body and parent visibility, beside every phrasing', async ({ page }) => {
    await openOperator(page);
    const gaps = await showArea(page, 'Gaps');
    await answerThis(gapItem(gaps, 'Sibling discount')).first().click();
    await expect(titleField(page), 'Answer this opened no editor').toBeVisible();
    await expect(titleField(page)).toHaveValue('Sibling discount');
    await expect(bodyField(page)).toHaveValue('');
    expect(await visibilityOf(page), 'the new section is not parent-visible').toBe('parent');
    for (const phrasing of SEEDED_GAPS['Sibling discount']) {
      await expect(page.getByText(phrasing, { exact: false }).filter({ visible: true }).first(), `the phrasing "${phrasing}" is not shown beside the editor`).toBeVisible();
    }
  });
});

test.describe('operator-written text', () => {
  test('a section saved from Answer this holds exactly what was entered, and no generated text shows anywhere', async ({ page, context }) => {
    await openParent(page);
    await ask(page, TRIGGER.answered);
    await openOperator(page);
    const id = await sandboxId(context);

    for (const name of AREAS) {
      await showArea(page, name);
      expect(await everything(page), `the ${name} area shows generated text`).not.toContain(MARKER);
    }

    const gaps = await showArea(page, 'Gaps');
    await answerThis(gapItem(gaps, 'Part-time schedules')).first().click();
    await expect(titleField(page)).toBeVisible();
    expect(await everything(page), 'the editor holds generated text').not.toContain(MARKER);
    const title = `Part-time schedules ${letters(6)}`;
    const body = `We offer full-time enrollment only.\n\nPlease ask the director about ${letters(8)}.`;
    await titleField(page).fill(title);
    await bodyField(page).fill(body);
    expect((await save(page)).ok(), 'the save failed').toBe(true);

    const saved = (await draftOf(id)).filter((s) => s.title === title);
    expect(saved.length, 'the draft does not hold the saved section once').toBe(1);
    expect(saved[0].text, 'the saved body is not exactly what was entered').toBe(body);
    expect(saved[0].visibility).toBe('parent');
    expect(JSON.stringify(await draftOf(id)), 'the draft holds generated text').not.toContain(MARKER);

    for (const name of AREAS) {
      await showArea(page, name);
      expect(await everything(page), `after the save, the ${name} area shows generated text`).not.toContain(MARKER);
    }
  });
});
