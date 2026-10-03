// Replay time with the fixture model.
//
// replay of 60: with three open gaps of 20 questions each, the whole replay,
// measured from pressing Publish to the last gap showing its result,
// finishes within 7 minutes; progress reaches "60 of 60" and every gap shows
// its own result. The published section holds all 20 phrasings of the first
// gap and 10 of the second, so the results are 20 of 20, 10 of 20 and
// 0 of 20 (see ./support.ts for the fixture model's rule).
//
// Assumed interface: see ./support.ts.

import { expect, test } from '@playwright/test';
import { answerGap, expectResults, openOperator, publish, recordUpdates, sandboxId, setHistory, unique, updates } from './support';

const LIMIT_MS = 7 * 60_000;

test.use({ actionTimeout: 10_000 });

test.describe('replay of 60', () => {
  test('three open gaps of 20 replay within 7 minutes of publishing, with progress reaching 60 of 60', async ({ page, context }) => {
    test.setTimeout(10 * 60_000);
    await recordUpdates(context);
    await openOperator(page);
    const id = await sandboxId(context);
    const topics = ['oracle bus route', 'oracle swim lessons', 'oracle music class'];
    const gaps = topics.map((topic, g) => ({
      label: `Oracle ${topic.split(' ').slice(1).join(' ')}`,
      turns: Array.from({ length: 20 }, (_, i) => ({
        message: unique(`Is there an ${topic} for my child, case ${String.fromCharCode(97 + i)}?`),
        agoMs: (g * 20 + i + 1) * 60_000,
        outcome: 'handoff' as const,
        reason: 'not_in_source',
      })),
    }));
    await setHistory(
      id,
      gaps.flatMap((g) => g.turns),
      gaps.map((g) => ({ label: g.label, messages: g.turns.map((t) => t.message) })),
    );
    await page.reload();

    const body = [...gaps[0].turns, ...gaps[1].turns.slice(0, 10)].map((t) => t.message).join('\n');
    await answerGap(page, gaps[0].label, body);

    const started = Date.now();
    expect((await publish(page)).ok(), 'the publish failed').toBe(true);
    await expectResults(page, { [gaps[0].label]: '20 of 20', [gaps[1].label]: '10 of 20', [gaps[2].label]: '0 of 20' }, LIMIT_MS);
    const elapsed = Date.now() - started;
    expect(elapsed, `the replay of 60 took ${Math.round(elapsed / 1000)} s from Publish to the last result`).toBeLessThanOrEqual(LIMIT_MS);

    const seen = (await updates(page)).all;
    expect(seen.some((t) => /\b60 of 60\b(?!\s*now answered)/i.test(t)), 'progress never reached "60 of 60"').toBe(true);
  });
});
