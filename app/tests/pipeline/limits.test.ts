// Limits. Over a limit, the reply is a fixed notice and no model call
// happens: more than 20 messages in a minute or 200 in a day for one sandbox,
// more than the global daily cap of model calls across all sandboxes (checked
// in global-limit.test.ts), or a message over 500 characters. Every model call asks for at most 400 output tokens.
//
// notices: a notice is a reply with outcome handoff and reason system_error,
// so it carries what every handoff carries: the center's phone number, no
// generated text, no email address, and one expectation line. Two messages
// over the limit at the same moment get the same text. A notice is not
// stored as a reply and is never filed into a gap.
//
// Each check is paired with the same traffic under the limit, which must
// reach the model, so a pipeline that refuses everything fails too.
//
// Assumed interface: see ./support.ts.

import { afterAll, describe, expect, test } from 'vitest';
import {
  GROUNDED,
  RUN_YEAR,
  USAGE,
  addDays,
  closeLoadedDb,
  denver,
  expectNotice,
  loadPipeline,
  overLimit,
  returns,
  send,
  type ModelRequest,
  ymd,
} from './support';

afterAll(async () => {
  await closeLoadedDb();
});

describe('limits', () => {
  test(
    'limits: the 21st message in a minute for one sandbox gets the fixed system_error notice, neither stored nor filed, and no model call; the same sandbox reaches the model again later',
    async () => {
      const { ask, db } = await loadPipeline();
      const start = denver(ymd(RUN_YEAR, 1, 20), '10:00');
      const id = await db.createSandbox(start);
      for (let i = 0; i < 20; i++) {
        const o = await send(ask, id, `Minute question number ${i}?`, new Date(start.getTime() + i * 1000));
        expect(o.called, `message ${i + 1} of 20 did not reach the model`).toBe(true);
      }
      const over = [
        await overLimit(ask, db, id, 'Minute question twenty-one?', new Date(start.getTime() + 30_000)),
        await overLimit(ask, db, id, 'Minute question twenty-two?', new Date(start.getTime() + 30_000)),
      ];
      expectNotice(over, ['Minute question twenty-one?', 'Minute question twenty-two?']);
      const later = await send(ask, id, 'A question after the minute?', new Date(start.getTime() + 100_000));
      expect(later.called, 'a message after the minute did not reach the model').toBe(true);
    },
    300_000,
  );

  test(
    'limits: the 201st message in a day for one sandbox gets the fixed system_error notice, neither stored nor filed, and no model call; the next day reaches the model',
    async () => {
      const { ask, db } = await loadPipeline();
      const day = ymd(RUN_YEAR, 2, 24);
      const start = denver(day, '06:00');
      const id = await db.createSandbox(start);
      // 10 messages a minute, so the per-minute limit never fires.
      for (let i = 0; i < 200; i++) {
        const o = await send(ask, id, `Daily question number ${i}?`, new Date(start.getTime() + i * 6000));
        expect(o.called, `message ${i + 1} of 200 did not reach the model`).toBe(true);
      }
      const over = [
        await overLimit(ask, db, id, 'Daily question two hundred one?', new Date(start.getTime() + 1_300_000)),
        await overLimit(ask, db, id, 'Daily question two hundred two?', new Date(start.getTime() + 1_300_000)),
      ];
      expectNotice(over, ['Daily question two hundred one?', 'Daily question two hundred two?']);
      const tomorrow = await send(ask, id, 'A question the next day?', denver(addDays(day, 1), '07:00'));
      expect(tomorrow.called, 'a message the next day did not reach the model').toBe(true);
    },
    600_000,
  );

  test(
    'limits: a message over 500 characters gets the fixed system_error notice, neither stored nor filed, and no model call; one of exactly 500 reaches the model',
    async () => {
      const { ask, db } = await loadPipeline();
      const now = denver(ymd(RUN_YEAR, 3, 17), '10:00');
      const id = await db.createSandbox(now);
      const base = 'Could you tell me more about breakfast and snacks at the center? ';
      const long = (n: number, tag: string) => (tag + base.repeat(20)).slice(0, n);
      const a = long(501, 'First. ');
      const b = long(800, 'Second. ');
      expect([a.length, b.length]).toEqual([501, 800]);
      const over = [await overLimit(ask, db, id, a, now), await overLimit(ask, db, id, b, now)];
      expectNotice(over, [a, b]);
      const fits = long(500, 'Third. ');
      expect(fits.length).toBe(500);
      const ok = await send(ask, id, fits, new Date(now.getTime() + 122_000));
      expect(ok.called, 'a 500 character message did not reach the model').toBe(true);
    },
    120_000,
  );

  test(
    'limits: every model call asks for at most 400 output tokens, retries and follow-ups included',
    async () => {
      const { ask, db } = await loadPipeline();
      const now = denver(ymd(RUN_YEAR, 4, 21), '10:00');
      const id = await db.createSandbox(now);
      const requests: ModelRequest[] = [];
      const plain = await send(ask, id, 'What time is breakfast?', now);
      requests.push(...plain.requests);
      const followUp = await send(ask, id, 'What about Friday?', new Date(now.getTime() + 61_000), returns(GROUNDED), [
        { role: 'parent', text: 'What time is breakfast?' },
        { role: 'front_desk', text: 'Breakfast is served until 8:30 AM.' },
      ]);
      requests.push(...followUp.requests);
      const retried = await send(ask, id, 'Is there a late fee?', new Date(now.getTime() + 122_000), (_req, n) => {
        if (n === 0) {
          const err = new Error('Rate exceeded');
          err.name = 'ThrottlingException';
          throw err;
        }
        return { output: GROUNDED, usage: USAGE };
      });
      requests.push(...retried.requests);
      expect(requests.length, 'too few model calls were made').toBeGreaterThanOrEqual(4);
      const caps = requests.map((r) => r.maxOutputTokens);
      expect(caps.filter((c) => !(typeof c === 'number' && c > 0 && c <= 400)), `output caps: ${JSON.stringify(caps)}`).toEqual([]);
    },
    120_000,
  );
});
