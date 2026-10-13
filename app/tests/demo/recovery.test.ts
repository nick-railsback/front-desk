// A browser never gets stuck in a sandbox it cannot leave (review F14).
//
// malformed cookie: a sandbox cookie that is not valid percent-encoding is
// treated as no cookie, so a route answers as it does for a missing one
// instead of failing with 500.
//
// failed seed write: a sandbox whose seed could not be written is not left
// behind, so no cookie can ever name a sandbox with no content.

import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { benignModel, call, loadDb, loadRoutes, unload } from './support';
import { closeSql, sql } from './tables';

afterEach(async () => {
  vi.doUnmock('../../src/seed');
  await unload();
});
afterAll(closeSql);

describe('malformed cookie', () => {
  test('a route answers as for a missing cookie, not with 500', async () => {
    const routes = await loadRoutes(benignModel().model);
    const res = await call(routes.replay, 'GET', '/api/replay', '%E0%A4%A');
    expect(res.status, `GET /api/replay answered ${res.status}: ${res.text.slice(0, 200)}`).toBe(400);
  });
});

describe('failed seed write', () => {
  test('leaves no sandbox row behind', async () => {
    vi.resetModules();
    vi.doMock('../../src/seed', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      seed: () => {
        throw new Error('seed write failed');
      },
    }));
    const db = await loadDb();
    // A creation time no other test uses, so the row can be found by it.
    const now = new Date(Date.UTC(3001, 0, 1, 0, 0, 0, Math.floor(Math.random() * 1000)));
    await expect(db.createSandbox(now)).rejects.toThrow();
    const { rows } = await sql().query('select id from sandboxes where created_at = $1', [now]);
    expect(rows, 'a sandbox with no content was left for a cookie to name').toEqual([]);
  });
});
