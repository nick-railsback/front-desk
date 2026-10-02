// policy sections: the published snapshot holds one parent-visible section
// per center policy, each with a stable ID, a title, a last-updated date, and
// body text that states the policy's facts. Every money amount, time of day,
// temperature, age, count, duration, and URL the center gives for a policy
// appears literally in that policy's text.
//
// staff-only section: exactly one staff-visible section, Lockdown procedure,
// holds the door code `4417#`, and that string appears nowhere else.
//
// snapshot and draft: exactly one snapshot, version 1, holds every seeded
// section, and the starting draft holds the same sections, so a fresh
// sandbox has no unpublished changes.
//
// Assumed interface: `seed(now)` from app/src/seed/index.ts, with the Seed
// shape documented in ./support.ts (`snapshots[].sections[]` and
// `draft.sections[]`, each `{ id, title, visibility, updatedOn, text }`).
//
// Text matching is wrap-normalized (whitespace runs collapse to one space)
// and case-insensitive. Literal values must appear as given; non-numeric
// facts are checked by short word stems, never by sentence wording.

import { describe, expect, test } from 'vitest';
import { POLICIES, missingFacts } from './policy-facts';
import { ONE_NOW, canonical, leaves, normalize, seedAt } from './support';

type Section = { id: string; title: string; visibility: string; updatedOn: string; text: string };

function sameTitle(a: string, b: string): boolean {
  return normalize(a).toLowerCase() === normalize(b).toLowerCase();
}

function snapshotOne(s: { snapshots?: { version: number; sections: Section[] }[] }): Section[] {
  const snap = (s.snapshots ?? []).find((x) => x.version === 1);
  expect(snap, 'the seed has no snapshot with version 1').toBeTruthy();
  expect(Array.isArray(snap!.sections), 'snapshot 1 has no sections array').toBe(true);
  return snap!.sections;
}

describe('policy sections', () => {
  for (const policy of POLICIES) {
    test(`policy sections: exactly one parent-visible "${policy.title}" section states its facts`, async () => {
      const s = await seedAt(ONE_NOW.now);
      const matches = snapshotOne(s).filter((x) => x.visibility === 'parent' && sameTitle(x.title, policy.title));
      expect(matches.length, `parent-visible sections titled ${policy.title}`).toBe(1);
      const missing = missingFacts(policy, matches[0].text ?? '');
      expect(missing, `${policy.title} text: ${matches[0].text}`).toEqual([]);
    });
  }

  test('policy sections: every section has a stable ID, a title, and a last-updated date', async () => {
    const s = await seedAt(ONE_NOW.now);
    const sections = snapshotOne(s);
    expect(sections.length, 'snapshot 1 holds at least the 13 policy sections and the staff-only section').toBeGreaterThanOrEqual(14);
    for (const x of sections) {
      expect(typeof x.id === 'string' && x.id.length > 0, `section without an ID: ${x.title}`).toBe(true);
      expect(typeof x.title === 'string' && x.title.trim().length > 0, `section ${x.id} has no title`).toBe(true);
      expect(x.updatedOn, `section ${x.id} has no YYYY-MM-DD last-updated date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${x.updatedOn}T00:00:00Z`)), `section ${x.id} has an invalid date`).toBe(false);
      expect(['parent', 'staff'], `section ${x.id} visibility`).toContain(x.visibility);
    }
    const ids = sections.map((x) => x.id);
    expect(new Set(ids).size, 'section IDs are not unique').toBe(ids.length);
  });

  test('policy sections: section IDs do not depend on now', async () => {
    const a = snapshotOne(await seedAt(ONE_NOW.now)).map((x) => [x.title, x.id]);
    const b = snapshotOne(await seedAt(new Date('2031-02-03T15:00:00Z'))).map((x) => [x.title, x.id]);
    expect(a.length).toBeGreaterThan(0);
    expect(canonical(b)).toEqual(canonical(a));
  });
});

describe('staff-only section', () => {
  test('staff-only section: exactly one staff-visible section, Lockdown procedure, holds 4417#', async () => {
    const s = await seedAt(ONE_NOW.now);
    const staff = snapshotOne(s).filter((x) => x.visibility === 'staff');
    expect(staff.length, 'staff-visible sections in snapshot 1').toBe(1);
    expect(sameTitle(staff[0].title, 'Lockdown procedure'), `staff section title: ${staff[0].title}`).toBe(true);
    expect(staff[0].text).toContain('4417#');
  });

  test('staff-only section: 4417# appears nowhere outside the staff-visible section', async () => {
    const s = await seedAt(ONE_NOW.now);
    const staff = snapshotOne(s).filter((x) => x.visibility === 'staff');
    expect(staff.length, 'there is no staff-visible section to hold the code').toBe(1);
    expect(staff[0].text).toContain('4417#');

    // Everything else in the seed: structured data, parent-visible sections in
    // every snapshot and in the draft, questions, replies, citations, and gaps.
    const rest = JSON.parse(JSON.stringify(s));
    for (const snap of rest.snapshots ?? []) snap.sections = (snap.sections ?? []).filter((x: Section) => x.visibility !== 'staff');
    if (rest.draft) rest.draft.sections = (rest.draft.sections ?? []).filter((x: Section) => x.visibility !== 'staff');
    const leaked = leaves(rest).filter((v) => /4417\s*#/.test(v));
    expect(leaked).toEqual([]);
  });
});

describe('snapshot and draft', () => {
  test('snapshot and draft: exactly one snapshot, version 1, holding every policy section and the staff-only section', async () => {
    const s = await seedAt(ONE_NOW.now);
    expect(Array.isArray(s.snapshots), 'snapshots is not an array').toBe(true);
    expect(s.snapshots.length, 'number of seeded snapshots').toBe(1);
    expect(s.snapshots[0].version).toBe(1);
    const sections: Section[] = s.snapshots[0].sections;
    for (const p of POLICIES) {
      expect(sections.some((x) => x.visibility === 'parent' && sameTitle(x.title, p.title)), `snapshot 1 lacks ${p.title}`).toBe(true);
    }
    expect(sections.some((x) => x.visibility === 'staff' && sameTitle(x.title, 'Lockdown procedure')), 'snapshot 1 lacks Lockdown procedure').toBe(true);
  });

  test('snapshot and draft: the starting draft holds the same sections as snapshot 1', async () => {
    const s = await seedAt(ONE_NOW.now);
    const published = snapshotOne(s);
    expect(published.length).toBeGreaterThanOrEqual(14);
    expect(Array.isArray(s.draft?.sections), 'draft.sections is not an array').toBe(true);
    expect(canonical(s.draft.sections)).toEqual(canonical(published));
  });
});
