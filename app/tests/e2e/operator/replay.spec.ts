// Publishing and replay in the operator view.
//
// The fixture model answers a replayed question when the published
// snapshot holds a parent-visible section whose body contains the question
// word for word, and hands it off otherwise (see ./support.ts). So a section
// holding all 7 Sibling discount phrasings and 2 of the 5 Part-time
// schedules phrasings makes the replay answer 7 of 7, 2 of 5 and 0 of 4.
//
// replay progress: while a replay runs, the view shows its progress as
// questions completed out of the total, here "<n> of 16". When it ends,
// each replayed gap shows "N of M now answered", and still does after a
// reload.
//
// resolution: a gap whose replayed questions were all answered is marked
// Resolved and leaves the open list (no Answer this, and the strip's open
// gaps drop by one). A gap with any other replayed reply stays open.
//
// replay changes no count: replayed replies never appear in Questions (each
// gap phrasing is listed exactly as often as before), never change the
// strip's questions asked, percent answered, handoffs or urgent replies,
// are never filed into a gap, and do not count against the sandbox's
// message limits.
//
// no generated text: the replayed answers carry the fixture model's marker,
// and the marker shows in no area of the operator view.
//
// replay window: a gap's 20 most recent questions are replayed, not more,
// and not older ones: a gap of 22 whose 20 newest phrasings are in the
// published section reads 20 of 20 and resolves.
//
// Assumed interface: see ./support.ts and ../support.ts.

import { expect, test } from '@playwright/test';
import {
  AREAS,
  MARKER,
  SEEDED_GAPS,
  answerGap,
  answerThis,
  db,
  everything,
  expectResults,
  gapItem,
  normalize,
  openOperator,
  publish,
  recordUpdates,
  sandboxId,
  setHistory,
  showArea,
  stats,
  unique,
  updates,
} from './support';

test.describe.configure({ timeout: 12 * 60_000 });
test.use({ actionTimeout: 10_000 });

const REPLAY_TIMEOUT = 8 * 60_000;

async function occurrences(page: import('@playwright/test').Page, phrasings: string[]): Promise<Record<string, number>> {
  const questions = await showArea(page, 'Questions');
  const text = normalize(await questions.innerText());
  return Object.fromEntries(phrasings.map((p) => [p, text.split(p).length - 1]));
}

async function counts(id: string): Promise<unknown> {
  const q = async (text: string) => (await db().query(text, [id])).rows;
  return {
    turns: await q('select id from turns where sandbox_id = $1 order by id'),
    members: await q('select gap_id, turn_id from gap_members where sandbox_id = $1 order by gap_id, turn_id'),
    gaps: await q('select id from gaps where sandbox_id = $1 order by id'),
    usage: await q('select bucket, count from usage_sandbox where sandbox_id = $1 order by bucket'),
  };
}

test.describe('replay', () => {
  test('shows progress and N of M, resolves the fully answered gap, and changes no question or count', async ({ page, context }) => {
    await recordUpdates(context);
    await openOperator(page);
    const id = await sandboxId(context);
    const all = Object.values(SEEDED_GAPS).flat();
    const partTime = SEEDED_GAPS['Part-time schedules'];
    const statsBefore = await stats(page);
    expect(statsBefore.openGaps, 'the seeded sandbox does not have 3 open gaps').toBe('3');
    const listedBefore = await occurrences(page, all);
    const before = await counts(id);

    await answerGap(page, 'Sibling discount', [...SEEDED_GAPS['Sibling discount'], partTime[0], partTime[1]].join('\n'));
    expect((await publish(page)).ok(), 'the publish failed').toBe(true);
    await expectResults(page, { 'Sibling discount': '7 of 7', 'Part-time schedules': '2 of 5', 'Summer program': '0 of 4' }, REPLAY_TIMEOUT);

    const seen = (await updates(page)).all;
    expect(
      seen.some((t) => /\b\d{1,2} of 16\b(?!\s*now answered)/i.test(t)),
      'the view never showed replay progress as "<n> of 16"',
    ).toBe(true);

    for (const reloaded of [false, true]) {
      if (reloaded) await page.reload();
      const when = reloaded ? 'after a reload' : 'when the replay ends';
      const gaps = await showArea(page, 'Gaps');
      const sibling = gapItem(gaps, 'Sibling discount');
      await expect(sibling, `${when}: the resolved gap does not show its result`).toContainText(/7 of 7\s+now answered/i);
      await expect(sibling, `${when}: the fully answered gap is not marked Resolved`).toContainText(/resolved/i);
      await expect(answerThis(sibling), `${when}: the resolved gap is still in the open list`).toHaveCount(0);
      for (const [label, result] of [['Part-time schedules', '2 of 5'], ['Summer program', '0 of 4']]) {
        const item = gapItem(gaps, label);
        await expect(item, `${when}: ${label} does not show ${result}`).toContainText(new RegExp(`${result}\\s+now answered`, 'i'));
        await expect(answerThis(item), `${when}: ${label} left the open list`).not.toHaveCount(0);
      }
      const after = await stats(page);
      expect(after.openGaps, `${when}: the strip's open gaps did not drop to 2`).toBe('2');
      expect({ ...after, openGaps: statsBefore.openGaps }, `${when}: replay changed the summary strip's question counts`).toEqual(statsBefore);
      expect(await occurrences(page, all), `${when}: replayed replies appear in Questions`).toEqual(listedBefore);
      for (const name of AREAS) {
        await showArea(page, name);
        expect(await everything(page), `${when}: the ${name} area shows generated text`).not.toContain(MARKER);
      }
    }
    expect(await counts(id), 'replay stored a question, filed into a gap, opened a gap, or counted a message').toEqual(before);
  });

  test("replays a gap's 20 most recent questions only", async ({ page, context }) => {
    await openOperator(page);
    const id = await sandboxId(context);
    const turns = Array.from({ length: 22 }, (_, i) => ({
      message: unique(`Can my child join the oracle chess club, question ${String.fromCharCode(97 + i)}?`),
      agoMs: (i + 1) * 3_600_000,
      outcome: 'handoff' as const,
      reason: 'not_in_source',
    }));
    await setHistory(id, turns, [{ label: 'Oracle chess club', messages: turns.map((t) => t.message) }]);
    await page.reload();

    await answerGap(page, 'Oracle chess club', turns.slice(0, 20).map((t) => t.message).join('\n'));
    expect((await publish(page)).ok(), 'the publish failed').toBe(true);
    await expectResults(page, { 'Oracle chess club': '20 of 20' }, REPLAY_TIMEOUT);
    const gaps = await showArea(page, 'Gaps');
    await expect(gapItem(gaps, 'Oracle chess club')).toContainText(/resolved/i);
  });
});
