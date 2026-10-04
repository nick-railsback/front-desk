// The emergency floor for blue lips and troubled breathing, seen through
// POST /api/ask with a model that proposes a calm, grounded answer.
//
// emergency floor: a message describing blue lips, or slow, shallow or
// stopped breathing happening now, gets outcome `urgent` with reason
// `emergency` whatever the model proposes, and its text tells the parent to
// call 911. Each listed phrasing is checked on its own.
//
// no distress: a message that mentions blue or breathing with no child in
// distress keeps the floor it had: the model's answer stands, and no floor
// fires for it. It sits beside a blue-lips message in the same sandbox, which
// is floored.
//
// Assumed interface: see ./support.ts. Each reply is stored as a turns row
// whose floors_fired lists the floors that fired, as today.

import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { type Routes, benignModel, call, loadDb, loadRoutes, unload } from './support';
import { closeSql, sql } from './tables';

afterEach(unload);
afterAll(closeSql);

async function ask(r: Routes, sandboxId: string, message: string) {
  const res = await call(r.ask, 'POST', '/api/ask', sandboxId, { message, priorTurns: [] });
  expect(res.status, `POST /api/ask answered ${res.status}: ${res.text.slice(0, 200)}`).toBe(200);
  const reply = res.json?.reply;
  expect(typeof reply?.outcome, `POST /api/ask returned no reply: ${res.text.slice(0, 200)}`).toBe('string');
  return reply as { outcome: string; reason: string; text: string };
}

async function floorsFired(sandboxId: string, message: string): Promise<unknown> {
  const { rows } = await sql().query('select floors_fired from turns where sandbox_id = $1 and message = $2', [sandboxId, message]);
  expect(rows.length, `no stored reply for "${message}"`).toBe(1);
  return rows[0].floors_fired;
}

const EMERGENCIES = [
  'his lips look a little blue and his breathing is kind of slow',
  'her lips are turning blue',
  "he's breathing really shallow",
];

describe('emergency floor', () => {
  for (const message of EMERGENCIES) {
    test(`"${message}" is urgent with reason emergency and says to call 911, though the model proposes an answer`, async () => {
      const r = await loadRoutes(benignModel().model);
      const db = await loadDb();
      const id = await db.createSandbox(new Date());
      const reply = await ask(r, id, message);
      expect({ outcome: reply.outcome, reason: reply.reason }).toEqual({ outcome: 'urgent', reason: 'emergency' });
      expect(reply.text, 'the reply does not tell the parent to call 911').toMatch(/\b911\b/);
    });
  }
});

describe('no distress', () => {
  test('a message about the blue room or breathing exercises keeps its floor, while blue lips beside it are floored', async () => {
    const r = await loadRoutes(benignModel().model);
    const db = await loadDb();
    const id = await db.createSandbox(new Date());
    for (const message of ['Is the blue room open on Friday?', 'We practice breathing exercises at home']) {
      const reply = await ask(r, id, message);
      expect({ outcome: reply.outcome, reason: reply.reason }, `"${message}" lost the model's answer`).toEqual({ outcome: 'answer', reason: 'answered' });
      expect(await floorsFired(id, message), `a floor fired for "${message}"`).toEqual([]);
    }
    const urgent = await ask(r, id, 'her lips are turning blue');
    expect({ outcome: urgent.outcome, reason: urgent.reason }, 'blue lips beside them were not floored').toEqual({ outcome: 'urgent', reason: 'emergency' });
  });
});
