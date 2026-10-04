// Idle sandboxes, seen from the database and the routes.
//
// idle sandboxes: a sandbox whose last activity is more than 7 days before
// the current server time is deleted with all its data, so no row in any
// table names its ID; a sandbox active within the last 7 days keeps every
// row it had. At the boundary, a sandbox last active 7 days and 1 minute
// ago is deleted and one last active 6 days and 23 hours ago is kept. The
// tables are listed from the schema at run time, and the listing must reach
// every table known today. Markers written only into the deleted sandboxes
// (a question, a section title) are found nowhere afterwards.
//
// daily deletion: the deletion runs once at once and then again at least
// once in every 24 hours while the server runs, with no visitor request; a
// run that fails does not end it, and stopping it ends it. Running it when
// the server starts is checked against a running server in
// ../e2e/demo/production.spec.ts.
//
// deleted sandboxes: a request to an operator route or to Send to front desk
// naming a sandbox the idle deletion removed gets a fixed answer: the same
// body for any deleted sandbox, holding no sandbox ID, stack trace or SQL.
// A parent message naming one gets a new sandbox, as before, and its body
// holds none of those either. A browser whose cookie names such a sandbox
// gets a new sandbox, and a working view, on its next load of either view,
// from a running server of the test's own.
//
// The current server time is injected as the real time, so the sandboxes
// other tests are using stay well inside the 7 days.
//
// Assumed interface: see ./support.ts.

import { afterAll, afterEach, describe, expect, test } from 'vitest';
import {
  DAY,
  HOUR,
  MINUTE,
  SQL,
  STACK,
  benignModel,
  call,
  fakeClock,
  idleDeletion,
  letters,
  loadRoutes,
  moduleExists,
  startDevServer,
  unload,
} from './support';
import { KNOWN_TABLES, closeSql, idColumns, rowsHolding, rowsNaming, rowsOf, setLastSeen, sql, tablesOf } from './tables';

afterEach(unload);
afterAll(closeSql);

// Writes a question and a draft section that only this sandbox holds, and
// returns their texts.
async function mark(id: string): Promise<string[]> {
  const question = `Is there a pottery class on Saturday? Ref ${letters(12)}`;
  const title = `Pottery class ${letters(12)}`;
  await sql().query(
    `insert into turns (sandbox_id, id, message, created_at, answer_text, outcome, reason, snapshot_version, citations, source)
     values ($1, $2, $3, now(), 'Please call the front desk.', 'handoff', 'not_in_source', 1, '[]'::jsonb, 'live')`,
    [id, `live-${letters(16)}`, question],
  );
  const { rows } = await sql().query('select sections from drafts where sandbox_id = $1', [id]);
  const sections = [...(rows[0].sections as object[]), { id: `pottery-${letters(8)}`, title, visibility: 'parent', updatedOn: '2026-10-01', text: 'Saturdays at 10:00 AM.' }];
  await sql().query('update drafts set sections = $2::jsonb where sandbox_id = $1', [id, JSON.stringify(sections)]);
  await sql().query(`insert into usage_sandbox (sandbox_id, bucket, count) values ($1, 'd:2026-10-01', 3)`, [id]);
  await sql().query(
    `insert into replays (sandbox_id, snapshot_version, status, completed, total, results, created_at) values ($1, 1, 'done', 0, 0, '[]'::jsonb, now())`,
    [id],
  );
  return [question, title];
}

describe('idle sandboxes', () => {
  test(
    'a sandbox idle more than 7 days is deleted with all its data; one active within 7 days keeps every row; 7 days and 1 minute is deleted, 6 days and 23 hours is kept',
    async () => {
      const { db, deleteIdle } = await idleDeletion();
      const columns = await idColumns();
      const reached = tablesOf(columns);
      for (const t of KNOWN_TABLES) expect(reached, `the schema listing does not reach the ${t} table`).toContain(t);

      // Created now, so a sweep another server runs meanwhile leaves them be
      // until their last activity is set back below.
      const stale = await db.createSandbox(new Date());
      const justOver = await db.createSandbox(new Date());
      const justUnder = await db.createSandbox(new Date());
      const recent = await db.createSandbox(new Date());
      const markers = [...(await mark(stale)), ...(await mark(justOver))];
      const keptMarkers = [...(await mark(justUnder)), ...(await mark(recent))];
      for (const id of [stale, justOver]) expect(await rowsNaming(id, columns), `sandbox ${id} holds no rows to delete`).not.toEqual([]);

      const now = new Date();
      await setLastSeen(stale, new Date(now.getTime() - 8 * DAY));
      await setLastSeen(justOver, new Date(now.getTime() - 7 * DAY - MINUTE));
      await setLastSeen(justUnder, new Date(now.getTime() - 6 * DAY - 23 * HOUR));
      await setLastSeen(recent, new Date(now.getTime() - HOUR));
      const keptBefore = { justUnder: await rowsOf(justUnder), recent: await rowsOf(recent) };
      expect(Object.keys(keptBefore.justUnder).length, 'the kept sandbox holds rows in too few tables').toBeGreaterThanOrEqual(KNOWN_TABLES.length);

      await deleteIdle(now);

      expect(await rowsNaming(stale), 'rows still name the sandbox idle for 8 days').toEqual([]);
      expect(await rowsNaming(justOver), 'rows still name the sandbox idle for 7 days and 1 minute').toEqual([]);
      for (const m of markers) expect(await rowsHolding(m), `"${m}", written only into a deleted sandbox, is still stored`).toEqual([]);
      expect(await rowsOf(justUnder), 'the sandbox idle for 6 days and 23 hours lost or changed rows').toEqual(keptBefore.justUnder);
      expect(await rowsOf(recent), 'the sandbox active an hour ago lost or changed rows').toEqual(keptBefore.recent);
      for (const m of keptMarkers) expect(await rowsHolding(m), `"${m}", in a kept sandbox, is gone`).not.toEqual([]);
    },
    600_000,
  );
});

describe('daily deletion', () => {
  test('runs at once, then at least once in every 24 hours on the injected clock; a failed run does not end it; stop ends it', async () => {
    moduleExists('src/server/idle.ts');
    const idle = (await import('../../src/server/idle')) as Record<string, unknown>;
    expect(typeof idle.scheduleIdleDeletion, 'app/src/server/idle.ts does not export scheduleIdleDeletion').toBe('function');
    const schedule = idle.scheduleIdleDeletion as (deps: { clock: unknown; deleteIdle: (now: Date) => Promise<unknown> }) => { stop(): void };

    const start = Date.parse('2026-10-03T12:00:00Z');
    const { clock, advance, settle, requested } = fakeClock(start);
    const runs: number[] = [];
    const deleteIdle = async (now: Date) => {
      runs.push(now.getTime());
      // The first run fails, as a database outage would make it.
      if (runs.length === 1) throw new Error('database unavailable');
    };
    const run = schedule({ clock, deleteIdle });
    expect(typeof run?.stop, 'scheduleIdleDeletion returns nothing with stop()').toBe('function');
    await settle();
    expect(runs, 'the deletion did not run at once').toEqual([start]);

    await advance(4 * DAY);
    const times = [start, ...runs.slice(1)];
    expect(runs.length, `the deletion ran ${runs.length} times in 4 days`).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1], `${times[i] - times[i - 1]} ms passed between two runs`).toBeLessThanOrEqual(DAY);
    }
    expect(start + 4 * DAY - times[times.length - 1], 'no run in the last 24 hours').toBeLessThanOrEqual(DAY);
    expect(requested.length, 'the run never waited on clock.sleep').toBeGreaterThan(0);
    for (const ms of requested) expect(ms, `a wait of ${ms} ms`).toBeGreaterThan(0);

    run.stop();
    const after = runs.length;
    await advance(3 * DAY);
    expect(runs.length, 'the deletion ran after stop()').toBe(after);
  });
});

describe('deleted sandboxes', () => {
  test(
    'a request naming a sandbox the idle deletion removed gets a fixed answer with no sandbox ID, stack trace or SQL',
    async () => {
      const { db, deleteIdle } = await idleDeletion();
      const gone = [await db.createSandbox(new Date()), await db.createSandbox(new Date())];
      const now = new Date();
      for (const id of gone) await setLastSeen(id, new Date(now.getTime() - 8 * DAY));
      await deleteIdle(now);
      for (const id of gone) expect(await rowsNaming(id), `sandbox ${id} was not deleted`).toEqual([]);

      const r = await loadRoutes(benignModel().model);
      const requests = [
        ['POST /api/send', (id: string) => call(r.send, 'POST', '/api/send', id, { replyId: 'live-0' })],
        ['POST /api/sections', (id: string) => call(r.sections, 'POST', '/api/sections', id, { id: null, title: 'Pottery class', visibility: 'parent', text: 'Saturdays.' })],
        ['POST /api/publish', (id: string) => call(r.publish, 'POST', '/api/publish', id)],
        ['GET /api/replay', (id: string) => call(r.replay, 'GET', '/api/replay', id)],
      ] as const;
      for (const [what, send] of requests) {
        const [a, b] = [await send(gone[0]), await send(gone[1])];
        for (const [res, id] of [
          [a, gone[0]],
          [b, gone[1]],
        ] as const) {
          expect(res.text, `${what}: the body holds the sandbox ID`).not.toContain(id);
          expect(res.text, `${what}: the body holds a stack trace or error`).not.toMatch(STACK);
          expect(res.text, `${what}: the body holds SQL`).not.toMatch(SQL);
        }
        expect({ status: b.status, body: b.text }, `${what}: two deleted sandboxes get different answers`).toEqual({ status: a.status, body: a.text });
      }
      const asked = await call(r.ask, 'POST', '/api/ask', gone[0], { message: 'When is breakfast served?', priorTurns: [] });
      expect(asked.text, 'POST /api/ask: the body holds the deleted sandbox ID').not.toContain(gone[0]);
      expect(asked.text, 'POST /api/ask: the body holds a stack trace or error').not.toMatch(STACK);
      expect(asked.text, 'POST /api/ask: the body holds SQL').not.toMatch(SQL);
    },
    600_000,
  );

  test(
    'a browser whose cookie names a sandbox the idle deletion removed gets a new sandbox on its next load of either view',
    async () => {
      const { deleteIdle } = await idleDeletion();
      const server = await startDevServer();
      try {
        for (const [path, shows] of [
          ['/', /Today at /],
          ['/operator', /Questions/],
        ] as const) {
          const first = await fetch(`${server.base}${path}`);
          expect(first.status, `${path} did not load:\n${server.output().slice(-1500)}`).toBe(200);
          const cookie = first.headers.getSetCookie().find((c) => c.startsWith('fd_sandbox='));
          expect(cookie, `${path} set no sandbox cookie`).toBeTruthy();
          const id = cookie!.split(';')[0].split('=')[1];
          const now = new Date();
          await setLastSeen(id, new Date(now.getTime() - 8 * DAY));
          await deleteIdle(now);
          expect(await rowsNaming(id), `sandbox ${id} was not deleted`).toEqual([]);

          const next = await fetch(`${server.base}${path}`, { headers: { cookie: `fd_sandbox=${id}` } });
          expect(next.status, `${path} did not load for a deleted sandbox`).toBe(200);
          const renewed = next.headers.getSetCookie().find((c) => c.startsWith('fd_sandbox='));
          expect(renewed, `${path} gave the browser of a deleted sandbox no new cookie`).toBeTruthy();
          const fresh = renewed!.split(';')[0].split('=')[1];
          expect(fresh, `${path} kept the deleted sandbox`).not.toBe(id);
          expect(await rowsNaming(fresh), 'the new sandbox holds no data').not.toEqual([]);
          const html = await next.text();
          expect(html, `${path} does not show the view for the new sandbox`).toMatch(shows);
          expect(html, `${path} shows the deleted sandbox ID`).not.toContain(id);
        }
      } finally {
        await server.stop();
      }
    },
    600_000,
  );
});
