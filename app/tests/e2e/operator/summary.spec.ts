// The summary strip.
//
// summary window: the strip counts the sandbox's questions, seeded and live,
// asked in the 7 days ending now: questions asked; percent answered (outcome
// answer with reason answered, as a share of questions asked, rounded to a
// whole percent); handoffs; urgent replies. It also shows the number of open
// gaps. A question asked 8 days ago is not counted, and a grounding_failed
// reply counts as asked and not as answered. With no question in the
// window, percent answered reads 0%.
//
// Assumed interface: see ./support.ts.

import { expect, test } from '@playwright/test';
import { type TurnSpec, openOperator, sandboxId, setHistory, stats, unique } from './support';

test.describe.configure({ timeout: 120_000 });
test.use({ actionTimeout: 10_000 });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test.describe('summary window', () => {
  test('counts the last 7 days only, and rounds percent answered to a whole percent', async ({ page, context }) => {
    await openOperator(page);
    const id = await sandboxId(context);
    const turn = (agoMs: number, outcome: TurnSpec['outcome'], reason: string, source: TurnSpec['source'] = 'live'): TurnSpec => ({
      message: unique('Oracle question'),
      agoMs,
      outcome,
      reason,
      source,
    });
    const inWindow: TurnSpec[] = [
      // 8 answered of 12 asked: 66.7%, shown as 67%.
      turn(HOUR, 'answer', 'answered'),
      turn(5 * HOUR, 'answer', 'answered', 'seed'),
      turn(DAY, 'answer', 'answered'),
      turn(2 * DAY, 'answer', 'answered', 'seed'),
      turn(3 * DAY, 'answer', 'answered'),
      turn(4 * DAY, 'answer', 'answered', 'seed'),
      turn(5 * DAY, 'answer', 'answered'),
      turn(7 * DAY - 2 * HOUR, 'answer', 'answered', 'seed'),
      turn(2 * HOUR, 'answer', 'grounding_failed'),
      turn(3 * HOUR, 'handoff', 'not_in_source', 'seed'),
      turn(6 * DAY, 'handoff', 'sensitive'),
      turn(30 * 60_000, 'urgent', 'emergency'),
    ];
    const outside: TurnSpec[] = [
      turn(8 * DAY, 'answer', 'answered', 'seed'),
      turn(8 * DAY, 'handoff', 'not_in_source'),
      turn(9 * DAY, 'urgent', 'safety'),
      turn(8 * DAY + HOUR, 'answer', 'answered'),
    ];
    await setHistory(id, [...inWindow, ...outside], [
      { label: 'Oracle open gap one', messages: [inWindow[9].message] },
      { label: 'Oracle open gap two', messages: [inWindow[10].message, outside[1].message] },
    ]);

    await page.reload();
    expect(await stats(page)).toEqual({ asked: '12', answered: '67%', handoffs: '2', urgent: '1', openGaps: '2' });
  });

  test('reads 0% answered with no question in the window', async ({ page, context }) => {
    await openOperator(page);
    const id = await sandboxId(context);
    await setHistory(id, [{ message: unique('Oracle old question'), agoMs: 8 * DAY, outcome: 'answer', reason: 'answered' }]);
    await page.reload();
    expect(await stats(page)).toEqual({ asked: '0', answered: '0%', handoffs: '0', urgent: '0', openGaps: '0' });
  });
});
