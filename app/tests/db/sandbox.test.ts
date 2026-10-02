// sandbox storage: `createSandbox(now)` stores a fresh copy of `seed(now)` in
// Postgres and returns the new sandbox's ID, and reading that sandbox back
// through its scoped access returns the same content `seed(now)` produced.
//
// isolation: nothing written through one sandbox's scoped access is visible
// through another's, and no read through one sandbox's scoped access returns
// another sandbox's data. Checked for every kind of sandbox data, in both
// directions, by writing distinguishable content into one sandbox and
// reading both.
//
// Assumed interface (app/src/db/sandbox.ts), the only database entry point
// these tests use:
//
//   export function migrate(): Promise<void>
//     Creates or updates the schema. Idempotent, and safe to run concurrently
//     from several processes against one database (other test files and the
//     clean-clone copy may run it at the same time).
//   export function createSandbox(now: Date): Promise<string>
//     Creates a sandbox holding `seed(now)` and returns its ID. Equivalent to
//     a new ID followed by `forSandbox(id).write(seed(now))`.
//   export function forSandbox(sandboxId: string): {
//     read(): Promise<Seed>;
//     write(content: Seed): Promise<void>;
//   }
//     The scoped data-access for one sandbox. `read` returns everything the
//     sandbox holds in the Seed shape from tests/unit/seed/support.ts, with
//     instants as `toISOString()` strings. `write` replaces everything the
//     sandbox holds with `content`. Array order is not significant.
//   export function closeDb(): Promise<void>
//     Releases the connection pool.
//
// The module reads the database location from `process.env.DATABASE_URL`.
// These tests fail, never skip, when it is unset. Every test creates its own
// sandboxes and touches no other sandbox, so the file is safe to run beside
// other database tests against the same database.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { APP, canonical, clone, leaves, loadSeedModule } from '../unit/seed/support';

const DB_MODULE = 'src/db/sandbox.ts';
const TIMEOUT = 60_000;

type Section = { id: string; title: string; visibility: string; updatedOn: string; text: string };
type Access = { read(): Promise<any>; write(content: any): Promise<void> };
type DbModule = {
  migrate(): Promise<void>;
  createSandbox(now: Date): Promise<string>;
  forSandbox(id: string): Access;
  closeDb(): Promise<void>;
};

let loaded: DbModule | null = null;
let migrated: Promise<void> | null = null;

async function db(): Promise<DbModule> {
  expect(fs.existsSync(path.join(APP, DB_MODULE)), `app/${DB_MODULE} does not exist`).toBe(true);
  expect(process.env.DATABASE_URL, 'DATABASE_URL is not set; the database tests need a reachable Postgres').toBeTruthy();
  const mod = (await import('../../src/db/sandbox')) as unknown as DbModule;
  for (const name of ['migrate', 'createSandbox', 'forSandbox', 'closeDb'] as const) {
    expect(typeof mod[name], `app/${DB_MODULE} does not export ${name}`).toBe('function');
  }
  loaded = mod;
  migrated ??= mod.migrate();
  await migrated;
  return mod;
}

afterAll(async () => {
  if (loaded) await loaded.closeDb();
});

const NOW = new Date('2026-10-14T22:30:00-06:00');
const OTHER_NOW = new Date('2019-03-12T07:00:00-06:00');

async function seedOf(now: Date) {
  const { seed } = await loadSeedModule();
  return seed(now);
}

describe('sandbox storage', () => {
  test(
    'sandbox storage: createSandbox returns a new ID and the sandbox reads back as seed(now)',
    async () => {
      const m = await db();
      const id = await m.createSandbox(NOW);
      expect(typeof id === 'string' && id.length > 0, 'createSandbox did not return an ID').toBe(true);
      const content = await m.forSandbox(id).read();
      expect(canonical(content)).toEqual(canonical(await seedOf(NOW)));
    },
    TIMEOUT,
  );

  test(
    'sandbox storage: two sandboxes get distinct IDs and each reads back as the seed for its own now',
    async () => {
      const m = await db();
      const a = await m.createSandbox(NOW);
      const b = await m.createSandbox(OTHER_NOW);
      expect(a).not.toBe(b);
      const [ra, rb] = await Promise.all([m.forSandbox(a).read(), m.forSandbox(b).read()]);
      expect(canonical(ra)).toEqual(canonical(await seedOf(NOW)));
      expect(canonical(rb)).toEqual(canonical(await seedOf(OTHER_NOW)));
    },
    TIMEOUT,
  );

  test(
    'sandbox storage: write replaces the sandbox content and read returns what was written',
    async () => {
      const m = await db();
      const id = await m.createSandbox(NOW);
      const other = await seedOf(OTHER_NOW);
      await m.forSandbox(id).write(other);
      expect(canonical(await m.forSandbox(id).read())).toEqual(canonical(other));
    },
    TIMEOUT,
  );
});

// One mutation per kind of sandbox data. Each takes a fresh copy of the seed
// and a marker string, changes only that kind, and returns the copy.
type Seed = any;
const parentSections = (s: Seed): Section[] => s.snapshots.find((x: { version: number }) => x.version === 1).sections.filter((x: Section) => x.visibility === 'parent');

const KINDS: [string, (s: Seed, marker: string) => Seed][] = [
  [
    'center details',
    (s, mk) => {
      s.structured.center.name = `${s.structured.center.name} ${mk}`;
      return s;
    },
  ],
  [
    'programs',
    (s, mk) => {
      s.structured.programs[0].name = `${s.structured.programs[0].name} ${mk}`;
      return s;
    },
  ],
  [
    'registration fee',
    (s, mk) => {
      s.structured.registrationFee = `${s.structured.registrationFee} ${mk}`;
      return s;
    },
  ],
  [
    'calendar entries',
    (s, mk) => {
      s.structured.calendar.push({ id: `cal-${mk}`, date: '2026-11-20', name: mk, status: 'open', time: '10:00 AM' });
      return s;
    },
  ],
  [
    'menus',
    (s, mk) => {
      s.structured.menus[0].items.push(mk);
      return s;
    },
  ],
  [
    'alerts',
    (s, mk) => {
      s.structured.alerts.push({ id: `alert-${mk}`, text: mk, startsAt: '2026-10-15T12:00:00.000Z', expiresAt: '2026-10-16T00:00:00.000Z' });
      return s;
    },
  ],
  [
    'published sections',
    (s, mk) => {
      const sec = s.snapshots[0].sections[0];
      sec.text = `${sec.text} ${mk}`;
      return s;
    },
  ],
  [
    'snapshots',
    (s, mk) => {
      const sections = clone(s.snapshots[0].sections);
      sections[0].title = `${sections[0].title} ${mk}`;
      s.snapshots.push({ version: 2, sections });
      return s;
    },
  ],
  [
    'draft sections',
    (s, mk) => {
      s.draft.sections[0].text = `${s.draft.sections[0].text} ${mk}`;
      s.draft.sections.push({ id: `section-${mk}`, title: mk, visibility: 'parent', updatedOn: '2026-10-14', text: mk });
      return s;
    },
  ],
  [
    'questions',
    (s, mk) => {
      s.questions.push({
        id: `question-${mk}`,
        text: mk,
        askedAt: '2026-10-14T18:00:00.000Z',
        reply: { text: mk, outcome: 'answer', reason: 'answered', snapshotVersion: 1, citations: [{ sectionId: parentSections(s)[0].id }] },
      });
      return s;
    },
  ],
  [
    'replies',
    (s, mk) => {
      s.questions[0].reply.text = `${s.questions[0].reply.text} ${mk}`;
      return s;
    },
  ],
  [
    'citations',
    (s, mk) => {
      // Cite a parent section the reply does not cite yet, a different one for
      // each side; the change is seen through equality, since a citation holds
      // only a section ID.
      const q = s.questions.find((x: { reply: { reason: string } }) => x.reply.reason === 'answered');
      const cited = new Set(q.reply.citations.map((c: { sectionId: string }) => c.sectionId));
      const uncited = parentSections(s).filter((x) => !cited.has(x.id));
      const extra = mk.startsWith('isolation-a-') ? uncited[0] : uncited[uncited.length - 1];
      q.reply.citations.push({ sectionId: extra.id });
      return s;
    },
  ],
  [
    'gaps',
    (s, mk) => {
      const moved = s.gaps[0].questionIds.shift();
      s.gaps.push({ id: `gap-${mk}`, label: mk, status: 'open', questionIds: [moved] });
      return s;
    },
  ],
];

function marker(side: string): string {
  return `isolation-${side}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('isolation', () => {
  for (const [kind, mutate] of KINDS) {
    test(
      `isolation: ${kind} written through one sandbox are not visible through another, in both directions`,
      async () => {
        const m = await db();
        const fresh = await seedOf(NOW);
        const a = await m.createSandbox(NOW);
        const b = await m.createSandbox(NOW);
        expect(a).not.toBe(b);

        const markA = marker('a');
        const writtenA = mutate(clone(fresh), markA);
        expect(canonical(writtenA), `the ${kind} change is not observable`).not.toEqual(canonical(fresh));
        await m.forSandbox(a).write(writtenA);

        const readA = await m.forSandbox(a).read();
        const readB = await m.forSandbox(b).read();
        expect(canonical(readA), `sandbox A does not hold the ${kind} written to it`).toEqual(canonical(writtenA));
        expect(canonical(readB), `sandbox B changed when ${kind} were written to A`).toEqual(canonical(fresh));
        expect(leaves(readB).filter((v) => v.includes(markA)), `sandbox B returns A's ${kind}`).toEqual([]);

        const markB = marker('b');
        const writtenB = mutate(clone(fresh), markB);
        await m.forSandbox(b).write(writtenB);

        const readA2 = await m.forSandbox(a).read();
        const readB2 = await m.forSandbox(b).read();
        expect(canonical(readB2), `sandbox B does not hold the ${kind} written to it`).toEqual(canonical(writtenB));
        expect(canonical(readA2), `sandbox A changed when ${kind} were written to B`).toEqual(canonical(writtenA));
        expect(leaves(readA2).filter((v) => v.includes(markB)), `sandbox A returns B's ${kind}`).toEqual([]);
      },
      TIMEOUT,
    );
  }
});
