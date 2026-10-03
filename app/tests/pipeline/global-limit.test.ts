// The global daily cap. The cap comes from GLOBAL_DAILY_MODEL_CALLS, set
// small here before any module loads; this file runs in its own worker, so no
// other test sees the small cap.
//
// global cap: once the day's model calls across all sandboxes reach the cap,
// a message in a fresh sandbox gets the fixed system_error notice, neither
// stored nor filed, and no model call; the next day reaches the model again.
// The day is drawn at random from years no other test uses, so calls left in
// the database by earlier runs or other test files never count toward it.
//
// Assumed interface: see ./support.ts.

import { afterAll, describe, expect, test } from 'vitest';
import { addDays, closeLoadedDb, denver, expectNotice, loadPipeline, overLimit, send, ymd } from './support';

const SAVED_CAP = process.env.GLOBAL_DAILY_MODEL_CALLS;
const CAP = 5;
process.env.GLOBAL_DAILY_MODEL_CALLS = String(CAP);

afterAll(async () => {
  if (SAVED_CAP === undefined) delete process.env.GLOBAL_DAILY_MODEL_CALLS;
  else process.env.GLOBAL_DAILY_MODEL_CALLS = SAVED_CAP;
  await closeLoadedDb();
});

describe('global cap', () => {
  test(
    'global cap: after the day\'s cap of model calls across sandboxes, a message in a fresh sandbox gets the fixed system_error notice, neither stored nor filed, and no model call; the next day reaches the model',
    async () => {
      const { ask, db } = await loadPipeline();
      const year = 3000 + Math.floor(Math.random() * 6000);
      const day = ymd(year, 1 + Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28));
      const start = denver(day, '10:00');

      // 5 calls over 2 sandboxes, within every per-sandbox limit.
      let calls = 0;
      for (const [sandbox, count] of [[0, 3], [1, 2]] as const) {
        const id = await db.createSandbox(start);
        for (let i = 0; i < count; i++) {
          const o = await send(ask, id, `Global question ${sandbox}-${i}?`, new Date(start.getTime() + i * 1000));
          if (o.called) calls += 1;
        }
      }
      expect(calls, 'calls under the global cap were refused').toBe(CAP);

      const now = new Date(start.getTime() + 60_000);
      const over = [];
      for (const message of ['Global question six?', 'Global question seven?']) {
        const id = await db.createSandbox(start);
        over.push(await overLimit(ask, db, id, message, now));
      }
      expectNotice(over, ['Global question six?', 'Global question seven?']);

      const id = await db.createSandbox(start);
      const tomorrow = await send(ask, id, 'A question the next day?', denver(addDays(day, 1), '10:00'));
      expect(tomorrow.called, 'a message the next day did not reach the model').toBe(true);
    },
    60_000,
  );
});
