// The reviewed case set in evals/cases/: every file is a JSON array of cases.
// Each check first requires the set to exist and be non-empty, so an empty
// directory can never pass a "no case does X" check.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { seed } from '../../app/src/seed/index';
import {
  CASES_DIR,
  type Case,
  DATA_SECTION_IDS,
  SPLIT,
  STRATA_MINIMUMS,
  addDays,
  denverWallClock,
  fallBackDate,
  latestSnapshot,
} from './support';

const EMPTY = 'evals/cases/ has no cases yet';

function caseFiles(): string[] {
  if (!existsSync(CASES_DIR)) return [];
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

function realCases(): Case[] {
  return caseFiles().flatMap((f) => JSON.parse(readFileSync(path.join(CASES_DIR, f), 'utf8')) as Case[]);
}

// Every case file parses and every case passes the harness's own validation:
// the reviewed set loads with no problems.
describe('case validation: the reviewed set', () => {
  test('every case file parses and every case is valid', async () => {
    const files = caseFiles();
    expect(files.length, EMPTY).toBeGreaterThan(0);
    const { loadCases } = await import('../src/cases');
    const { cases, problems } = loadCases(CASES_DIR);
    expect(problems, 'problems found in evals/cases/').toEqual([]);
    expect(cases.length).toBe(realCases().length);
  });
});

// The set has at least 45 cases and meets every stratum's minimum.
describe('case coverage', () => {
  test('at least 45 cases in total', () => {
    expect(realCases().length, EMPTY).toBeGreaterThanOrEqual(45);
  });

  test.each(Object.entries(STRATA_MINIMUMS))('stratum %s has at least %i cases', (stratum, min) => {
    const count = realCases().filter((c) => c.stratum === stratum).length;
    expect(count, `${stratum} has ${count} cases`).toBeGreaterThanOrEqual(min);
  });
});

// Every case is labeled as agent-drafted and author-reviewed; none claims to be
// held out from the author.
describe('case split', () => {
  test(`every split is exactly ${SPLIT}`, () => {
    const cases = realCases();
    expect(cases.length, EMPTY).toBeGreaterThan(0);
    const wrong = cases.filter((c) => c.split !== SPLIT).map((c) => `${c.id}: ${JSON.stringify(c.split)}`);
    expect(wrong).toEqual([]);
  });
});

// Every expected citation names a parent-visible section of the snapshot the
// case's own `now` seeds, or one of the six data sections; none names a
// staff-visible section.
describe('case citations', () => {
  test('every expected citation is a parent-visible or data section', () => {
    const cases = realCases();
    expect(cases.length, EMPTY).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const c of cases) {
      const sections = latestSnapshot(c.now).sections;
      const allowed = new Set([
        ...sections.filter((s) => s.visibility === 'parent').map((s) => s.id),
        ...DATA_SECTION_IDS,
      ]);
      for (const id of c.expectedCitations ?? []) if (!allowed.has(id)) bad.push(`${c.id}: ${id}`);
    }
    expect(bad).toEqual([]);
  });

  test('no expected citation names a staff-visible section', () => {
    const cases = realCases();
    expect(cases.length, EMPTY).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const c of cases) {
      const staff = new Set(
        latestSnapshot(c.now)
          .sections.filter((s) => s.visibility === 'staff')
          .map((s) => s.id),
      );
      expect(staff.size, 'the seed snapshot has a staff section').toBeGreaterThan(0);
      for (const id of c.expectedCitations ?? []) if (staff.has(id)) bad.push(`${c.id}: ${id}`);
    }
    expect(bad).toEqual([]);
  });
});

// Every gap_filing case expects one of the open gaps its own `now` seeds.
describe('case gap labels', () => {
  test('every gap_filing case names an open seeded gap', () => {
    const gapCases = realCases().filter((c) => c.stratum === 'gap_filing');
    expect(gapCases.length, 'evals/cases/ has no gap_filing cases yet').toBeGreaterThan(0);
    const bad: string[] = [];
    for (const c of gapCases) {
      const open = seed(new Date(c.now))
        .gaps.filter((g) => g.status === 'open')
        .map((g) => g.label);
      if (!open.includes(c.expectedGapLabel as string)) bad.push(`${c.id}: ${JSON.stringify(c.expectedGapLabel)}`);
    }
    expect(bad).toEqual([]);
  });
});

// No case's `now` is 23:00 to 23:59 Denver time on any of the seven days that
// start on that year's US fall-back date (the first Sunday of November).
describe('case clock', () => {
  test('no case is set in the late evening of fall-back week', () => {
    const cases = realCases();
    expect(cases.length, EMPTY).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const c of cases) {
      const local = denverWallClock(new Date(c.now));
      const start = fallBackDate(local.year);
      const week = Array.from({ length: 7 }, (_, i) => addDays(start, i));
      if (local.hour === 23 && week.includes(local.date)) bad.push(`${c.id}: ${c.now}`);
    }
    expect(bad).toEqual([]);
  });
});
