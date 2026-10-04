// Replay against the model and the database: what it calls, what it counts,
// and what it never touches.
//
// replay tally: after a publish, each open gap's questions are re-run once
// each against the new snapshot, and only those: the model sees each seeded
// gap question exactly once. A gap whose replayed questions are all
// answered gets a status other than open; a gap with any other replayed
// reply stays open. The replay route ends with completed equal to total,
// the number of questions re-run.
//
// replay changes no count: replay stores no question, files nothing into a
// gap, opens no gap, and counts no message against the sandbox's per-minute
// or per-day limits: the sandbox's turns, gap membership, gap IDs and
// message counts are exactly what they were.
//
// global limit: each replayed question that calls the model counts toward
// the global daily model-call record, so the day's count rises by at least
// the number of calls. Once the limit is reached, the remaining replayed
// questions make no model call and count as not answered: with the limit
// already reached nothing is called and every gap stays open, and with room
// for 3 calls at most 3 are made and every gap stays open, though the model
// would answer every question.
//
// sandbox isolation: saving, publishing and replay in one sandbox leave
// every other sandbox's draft, snapshots, gaps, questions, structured data
// and message counts exactly as they were.
//
// Assumed interface: see ./support.ts.

import { afterAll, afterEach, describe, expect, test } from 'vitest';
import {
  SEEDED_GAPS,
  SEEDED_GAP_QUESTIONS,
  answeringModel,
  call,
  closeSql,
  globalCalls,
  letters,
  loadRoutes,
  publishDraft,
  replayFinished,
  saveSection,
  sql,
  stateOf,
  today,
  unload,
} from './support';

const MINUTES = 60_000;
const SAVED_CAP = process.env.GLOBAL_DAILY_MODEL_CALLS;

afterEach(async () => {
  if (SAVED_CAP === undefined) delete process.env.GLOBAL_DAILY_MODEL_CALLS;
  else process.env.GLOBAL_DAILY_MODEL_CALLS = SAVED_CAP;
  await unload();
});
afterAll(closeSql);

async function gapStatuses(id: string): Promise<Record<string, string>> {
  const { rows } = await sql().query('select label, status from gaps where sandbox_id = $1', [id]);
  return Object.fromEntries(rows.map((g) => [g.label, g.status]));
}

// What replay may not change in its own sandbox.
async function counted(id: string): Promise<Record<string, unknown>> {
  const s = await stateOf(id);
  const { rows } = await sql().query('select id from gaps where sandbox_id = $1 order by id', [id]);
  return { turns: s.turns, members: s.members, usage: s.usage, gapIds: rows.map((g) => g.id) };
}

describe('replay tally', () => {
  test(
    're-runs each open gap question once, resolves the fully answered gap, and changes no question or count',
    async () => {
      const recorded = answeringModel();
      const r = await loadRoutes(recorded.model);
      const id = await r.db.createSandbox(new Date());
      const day = today();
      const partTime = SEEDED_GAPS['Part-time schedules'];
      const body = [...SEEDED_GAPS['Sibling discount'], partTime[0], partTime[1]].join('\n');
      const saved = await saveSection(r, id, { id: null, title: 'Sibling discount', visibility: 'parent', text: body });
      expect(saved.status, `the save failed: ${saved.text.slice(0, 200)}`).toBeLessThan(300);

      const before = await counted(id);
      const globalBefore = await globalCalls(day);
      const published = await publishDraft(r, id);
      expect(published.status, `the publish failed: ${published.text.slice(0, 200)}`).toBeLessThan(300);
      const progress = await replayFinished(r, id, 8 * MINUTES);
      expect(progress.total, 'the replay did not re-run the 16 open gap questions').toBe(16);
      expect(progress.completed).toBe(16);

      const replayed = recorded.requests.map((q) => q.message.trim()).sort();
      expect(replayed, 'the model did not see each open gap question exactly once').toEqual([...SEEDED_GAP_QUESTIONS].sort());
      expect(await globalCalls(day), "replay's model calls are not on the global daily record").toBeGreaterThanOrEqual(globalBefore + replayed.length);

      const statuses = await gapStatuses(id);
      expect(statuses['Sibling discount'], 'the fully answered gap is still open').not.toBe('open');
      expect(statuses['Part-time schedules'], 'a gap with 2 of 5 answered left the open list').toBe('open');
      expect(statuses['Summer program'], 'a gap with 0 of 4 answered left the open list').toBe('open');

      expect(await counted(id), 'replay stored a question, filed into a gap, opened a gap, or counted a message').toEqual(before);
    },
    10 * MINUTES,
  );
});

// A deploy restarts the app mid-replay and leaves its row running, with no
// process left to finish it (feature-close F7).
describe('a replay left running', () => {
  async function leaveRunning(id: string, startedAgo: string): Promise<void> {
    await sql().query(
      `insert into replays (sandbox_id, snapshot_version, status, completed, total, results, created_at)
       values ($1, 2, 'running', 2, 16, '[]', now() - $2::interval)`,
      [id, startedAgo],
    );
  }

  test('reads as failed once it has made no progress for minutes, and as running before that', async () => {
    const r = await loadRoutes(answeringModel().model);
    const orphaned = await r.db.createSandbox(new Date());
    const live = await r.db.createSandbox(new Date());
    await leaveRunning(orphaned, '10 minutes');
    await leaveRunning(live, '5 seconds');

    const stale = await call(r.replay, 'GET', '/api/replay', orphaned);
    expect(stale.json, 'a replay no process is running still reads as running, so Publish stays disabled').toMatchObject({ running: false, failed: true });
    const running = await call(r.replay, 'GET', '/api/replay', live);
    expect(running.json, 'a replay that just made progress reads as stopped').toMatchObject({ running: true, failed: false });
  });
});

describe('global limit', () => {
  test(
    'with the limit reached, replay makes no model call and every gap stays open',
    async () => {
      // Set before the routes load, so it holds whether the cap is read at load or per call.
      process.env.GLOBAL_DAILY_MODEL_CALLS = '0';
      const recorded = answeringModel();
      const r = await loadRoutes(recorded.model);
      const id = await r.db.createSandbox(new Date());
      const saved = await saveSection(r, id, { id: null, title: 'Every gap', visibility: 'parent', text: SEEDED_GAP_QUESTIONS.join('\n') });
      expect(saved.status, `the save failed: ${saved.text.slice(0, 200)}`).toBeLessThan(300);

      const published = await publishDraft(r, id);
      expect(published.status, `the publish failed: ${published.text.slice(0, 200)}`).toBeLessThan(300);
      const progress = await replayFinished(r, id, 8 * MINUTES);
      expect(progress.total, 'the replay did not take in the 16 open gap questions').toBe(16);
      expect(recorded.requests.length, 'replay called the model past the global limit').toBe(0);
      expect(Object.values(await gapStatuses(id)), 'a gap left the open list with no question answered').toEqual(['open', 'open', 'open']);
    },
    10 * MINUTES,
  );

  test(
    'with room for 3 calls, replay makes at most 3 and every gap stays open',
    async () => {
      // Set before the routes load, so it holds whether the cap is read at load or per call.
      process.env.GLOBAL_DAILY_MODEL_CALLS = String((await globalCalls(today())) + 3);
      const recorded = answeringModel();
      const r = await loadRoutes(recorded.model);
      const id = await r.db.createSandbox(new Date());
      const saved = await saveSection(r, id, { id: null, title: 'Every gap', visibility: 'parent', text: SEEDED_GAP_QUESTIONS.join('\n') });
      expect(saved.status, `the save failed: ${saved.text.slice(0, 200)}`).toBeLessThan(300);

      const published = await publishDraft(r, id);
      expect(published.status, `the publish failed: ${published.text.slice(0, 200)}`).toBeLessThan(300);
      const progress = await replayFinished(r, id, 8 * MINUTES);
      expect(progress.total).toBe(16);
      expect(progress.completed).toBe(16);
      expect(recorded.requests.length, 'replay made more model calls than the global limit had room for').toBeLessThanOrEqual(3);
      expect(Object.values(await gapStatuses(id)), 'a gap whose questions were not all called left the open list').toEqual(['open', 'open', 'open']);
    },
    10 * MINUTES,
  );
});

describe('sandbox isolation', () => {
  test(
    "saving, publishing and replay in one sandbox leave every other sandbox's content unchanged",
    async () => {
      const r = await loadRoutes(answeringModel().model);
      const acting = await r.db.createSandbox(new Date());
      const others = [await r.db.createSandbox(new Date()), await r.db.createSandbox(new Date())];
      const before = await Promise.all(others.map(stateOf));

      const meals = { id: 'meals', title: 'Meals', visibility: 'parent', text: `Oracle meals ${letters(10)}.` };
      expect((await saveSection(r, acting, meals)).status).toBeLessThan(300);
      const added = { id: null, title: 'Sibling discount', visibility: 'parent', text: SEEDED_GAPS['Sibling discount'].join('\n') };
      expect((await saveSection(r, acting, added)).status).toBeLessThan(300);
      expect((await publishDraft(r, acting)).status).toBeLessThan(300);
      await replayFinished(r, acting, 8 * MINUTES);
      expect((await gapStatuses(acting))['Sibling discount'], 'the replay did not run in the acting sandbox').not.toBe('open');

      const after = await Promise.all(others.map(stateOf));
      expect(after[0], 'another sandbox changed').toEqual(before[0]);
      expect(after[1], 'another sandbox changed').toEqual(before[1]);
    },
    10 * MINUTES,
  );
});
