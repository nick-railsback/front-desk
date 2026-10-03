// A case set with any invalid case is refused before any trial runs: the
// runner exits non-zero, never calls the answer function, and prints the
// offending case's id. Each fixture holds one valid case and one bad case.

import { describe, expect, test } from 'vitest';
import { makeCase, runScripted, trial, writeCaseSet } from './support';

const GOOD = makeCase({ id: 'fixture-good' });

async function expectRefused(files: Record<string, unknown>, id: string | null) {
  const casesDir = writeCaseSet(files);
  let calls = 0;
  const result = await runScripted({
    casesDir,
    answer: async () => {
      calls += 1;
      return trial({ outcome: 'answer', reason: 'answered', citations: [{ sectionId: 'illness' }] });
    },
  });
  expect(result.exitCode, 'exit code').not.toBe(0);
  expect(calls, 'answer function calls before validation failed').toBe(0);
  if (id !== null) expect(result.lines.join('\n'), 'printed output').toContain(id);
}

function bad(id: string, overrides: Record<string, unknown>) {
  return { 'cases.json': [GOOD, makeCase({ id, ...overrides })] };
}

const REQUIRED = [
  'stratum',
  'split',
  'now',
  'message',
  'expectedOutcome',
  'expectedCitations',
  'requiredFacts',
  'forbiddenStrings',
  'rationale',
];

describe('case validation: missing fields', () => {
  test.each(REQUIRED)('a case without %s is refused and its id printed', async (field) => {
    const id = `fixture-missing-${field}`;
    await expectRefused(bad(id, { [field]: undefined }), id);
  });

  test('a case without an id is refused', async () => {
    await expectRefused({ 'cases.json': [GOOD, makeCase({ id: undefined })] }, null);
  });

  test('a gap_filing case without an expected gap label is refused', async () => {
    const id = 'fixture-gap-without-label';
    await expectRefused(
      bad(id, {
        stratum: 'gap_filing',
        expectedOutcome: 'handoff',
        expectedReason: 'not_in_source',
        expectedCitations: [],
        requiredFacts: [],
        message: 'Is there a discount for a second child?',
      }),
      id,
    );
  });
});

describe('case validation: values outside their allowed set', () => {
  const CASES: [string, Record<string, unknown>][] = [
    ['an unknown stratum', { stratum: 'everyday' }],
    ['a held-out split (test)', { split: 'test' }],
    ['a held-out split (holdout)', { split: 'holdout' }],
    ['a split other than agent-drafted-author-reviewed', { split: 'author-written' }],
    ['a now without an offset', { now: '2026-10-05T09:00:00' }],
    ['a now that is not an ISO timestamp', { now: 'next Monday at 9' }],
    ['an unknown expected outcome', { expectedOutcome: 'escalate', expectedReason: undefined }],
    ['an unknown acceptable alternative', { acceptableOutcomes: ['maybe'] }],
    ['an unknown expected reason', { expectedReason: 'unclear' }],
    ['a reason that belongs to another outcome (answer, sensitive)', { expectedOutcome: 'answer', expectedReason: 'sensitive' }],
    ['a reason that belongs to another outcome (handoff, emergency)', { expectedOutcome: 'handoff', expectedReason: 'emergency' }],
    ['a reason that belongs to another outcome (urgent, answered)', { expectedOutcome: 'urgent', expectedReason: 'answered' }],
    ['an expected gap label on a case outside gap_filing', { expectedGapLabel: 'Sibling discount' }],
    ['an empty rationale', { rationale: '' }],
  ];

  test.each(CASES)('a case with %s is refused and its id printed', async (what, overrides) => {
    const id = `fixture-bad-${what.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    await expectRefused(bad(id, overrides), id);
  });

  test('two cases sharing an id across files are refused and the id printed', async () => {
    const id = 'fixture-duplicate';
    await expectRefused(
      {
        'a.json': [GOOD, makeCase({ id })],
        'b.json': [makeCase({ id, message: 'What time does breakfast end?', expectedCitations: ['meals'] })],
      },
      id,
    );
  });

  test('a case file that does not parse is refused', async () => {
    await expectRefused({ 'a.json': [GOOD], 'b.json': '[{"id": "fixture-broken",' }, null);
  });
});
