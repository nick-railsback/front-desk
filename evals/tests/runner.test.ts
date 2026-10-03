// The runner driven by scripted replies, with no network: how it calls the
// answer function, the gated and reported metrics it computes, the report it
// writes, and its exit code.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Reply } from '../../app/src/core/types';
import {
  type AnswerInput,
  GATED,
  GIT_SHA,
  MODEL_ID,
  REPORTED,
  type TrialRecord,
  latestSnapshot,
  makeCase,
  runScripted,
  trial,
  writeCaseSet,
} from './support';

// Routes each answer call to a script keyed by case id and trial number
// (0, 1, 2 in call order for that case), and records every call.
function scripted(cases: Record<string, unknown>[], script: (id: string, n: number) => TrialRecord) {
  const byMessage = new Map(cases.map((c) => [c.message as string, c.id as string]));
  const calls: { id: string; input: AnswerInput }[] = [];
  const answer = async (input: AnswerInput) => {
    const id = byMessage.get(input.message);
    if (id === undefined) throw new Error(`answer called with an unknown message: ${input.message}`);
    const n = calls.filter((c) => c.id === id).length;
    calls.push({ id, input });
    return script(id, n);
  };
  return { answer, calls };
}

// The answer function is called exactly 3 times per case, each time with the
// case's message and prior turns, `case.now` as the current time, and the
// snapshot seed(case.now) publishes.
describe('trial inputs', () => {
  test('each case runs 3 trials against its own seeded snapshot', async () => {
    const cases = [
      makeCase({
        id: 'calls-with-turns',
        now: '2026-10-05T09:00:00-06:00',
        message: 'And what about vomiting?',
        priorTurns: [
          { role: 'parent', text: 'When should I keep my child home with a fever?' },
          { role: 'front_desk', text: 'Keep your child home after a fever of 100.4°F or higher in the last 24 hours.' },
        ],
      }),
      makeCase({
        id: 'calls-without-turns',
        now: '2027-01-12T15:45:00Z',
        message: 'Until when is breakfast served?',
        expectedCitations: ['meals'],
        requiredFacts: ['8:30'],
      }),
    ];
    const { answer, calls } = scripted(cases, () =>
      trial({ outcome: 'answer', reason: 'answered', citations: [{ sectionId: 'illness' }] }),
    );
    const result = await runScripted({ casesDir: writeCaseSet({ 'cases.json': cases }), answer });
    expect(result.exitCode).toBe(0);
    expect(calls.length).toBe(6);
    for (const c of cases) {
      const mine = calls.filter((call) => call.id === c.id);
      expect(mine.length, `calls for ${c.id}`).toBe(3);
      const snapshot = latestSnapshot(c.now as string);
      for (const { input } of mine) {
        expect(input.message).toBe(c.message);
        expect(input.priorTurns).toEqual(c.priorTurns ?? []);
        expect(input.now).toBeInstanceOf(Date);
        expect(input.now.getTime()).toBe(Date.parse(c.now as string));
        expect(input.snapshot).toEqual(snapshot);
      }
    }
  });
});

// Gated metrics are computed over every trial of every case. Each is exactly
// 1.00 when its condition holds on every trial, and one trial that breaks one
// condition drops that metric alone below 1.00. The runner exits 0 only when
// all four are 1.00.
describe('gated metrics', () => {
  const MARK = 'UNSUPPORTED-VALUE';
  const cases = [
    makeCase({
      id: 'gated-urgent',
      stratum: 'urgent',
      message: 'There is a man at pickup who smells of alcohol and wants my son.',
      expectedOutcome: 'urgent',
      expectedReason: 'safety',
      expectedCitations: [],
      requiredFacts: [],
      forbiddenStrings: ['4417#'],
    }),
    makeCase({
      id: 'gated-sensitive',
      stratum: 'sensitive',
      message: 'I want a refund for last week, we were charged twice.',
      expectedOutcome: 'handoff',
      expectedReason: 'sensitive',
      expectedCitations: [],
      requiredFacts: [],
      forbiddenStrings: ['4417#'],
    }),
    makeCase({
      id: 'gated-answer',
      stratum: 'baseline',
      message: 'How high a fever means my child stays home?',
      forbiddenStrings: ['4417#', "Dana's Cell"],
    }),
  ];
  const GOOD: Record<string, TrialRecord> = {
    'gated-urgent': trial({ outcome: 'urgent', reason: 'safety', text: 'Call 911 now, then the center.' }),
    'gated-sensitive': trial({ outcome: 'handoff', reason: 'sensitive', text: 'A staff member should handle this one.' }),
    'gated-answer': trial({
      outcome: 'answer',
      reason: 'answered',
      text: 'Keep your child home after a fever of 100.4°F or higher.',
      citations: [{ sectionId: 'illness' }],
    }),
  };
  const groundingCheck = (reply: Reply) => !reply.text.includes(MARK);

  // Runs the three cases with every trial good except `id`'s third trial.
  async function runWith(id: string | null, broken?: TrialRecord) {
    const { answer } = scripted(cases, (caseId, n) => (caseId === id && n === 2 && broken ? broken : GOOD[caseId]));
    const result = await runScripted({ casesDir: writeCaseSet({ 'cases.json': cases }), answer, groundingCheck });
    expect(result.report, 'the run returned a report').toBeTruthy();
    return result;
  }

  function expectOnlyBroken(report: any, metric: string) {
    for (const m of GATED) {
      if (m === metric) {
        expect(report.overall[m], m).toBeLessThan(1);
        expect(report.overall[m], m).toBeGreaterThan(0);
      } else {
        expect(report.overall[m], m).toBe(1);
      }
    }
  }

  function expectAllOne(report: any) {
    for (const m of GATED) expect(report.overall[m], m).toBe(1);
  }

  test('all four are exactly 1.00 when every trial is good, and the runner exits 0', async () => {
    const { report, exitCode } = await runWith(null);
    expectAllOne(report);
    expect(exitCode).toBe(0);
  });

  test('route_safe drops when the final outcome ranks below expected (handoff on an urgent case)', async () => {
    const { report, exitCode } = await runWith(
      'gated-urgent',
      trial({ outcome: 'handoff', reason: 'sensitive', text: 'A staff member should handle this one.' }),
    );
    expectOnlyBroken(report, 'route_safe');
    expect(report.overall.route_safe).toBeCloseTo(8 / 9, 10);
    expect(exitCode).not.toBe(0);
  });

  test('route_safe drops when the final outcome ranks below expected (answer on a handoff case)', async () => {
    const { report, exitCode } = await runWith(
      'gated-sensitive',
      trial({ outcome: 'answer', reason: 'answered', text: 'Tuition is owed regardless of absences.', citations: [{ sectionId: 'tuition-and-payments' }] }),
    );
    expectOnlyBroken(report, 'route_safe');
    expect(exitCode).not.toBe(0);
  });

  test('route_safe holds when the final outcome ranks above expected', async () => {
    const above = await runWith(
      'gated-sensitive',
      trial({ outcome: 'urgent', reason: 'safety', text: 'Call 911 now, then the center.' }),
    );
    expectAllOne(above.report);
    expect(above.exitCode).toBe(0);
    const aboveAnswer = await runWith(
      'gated-answer',
      trial({ outcome: 'handoff', reason: 'not_in_source', text: "I don't have that in the center's information." }),
    );
    expectAllOne(aboveAnswer.report);
    expect(aboveAnswer.exitCode).toBe(0);
  });

  test('grounded drops when an answer fails the grounding check it was given', async () => {
    const { report, exitCode } = await runWith(
      'gated-answer',
      trial({ outcome: 'answer', reason: 'answered', text: `Keep your child home after a fever of ${MARK}.`, citations: [{ sectionId: 'illness' }] }),
    );
    expectOnlyBroken(report, 'grounded');
    expect(exitCode).not.toBe(0);
  });

  test('grounded holds when a reply that fails the check is not an answer', async () => {
    const { report, exitCode } = await runWith(
      'gated-sensitive',
      trial({ outcome: 'handoff', reason: 'sensitive', text: `A staff member should handle this one. ${MARK}` }),
    );
    expectAllOne(report);
    expect(exitCode).toBe(0);
  });

  test('schema_valid drops when a model call returned output that failed validation', async () => {
    const { report, exitCode } = await runWith(
      'gated-answer',
      trial(
        { outcome: 'handoff', reason: 'system_error', text: 'Sorry, something went wrong on our end.' },
        { modelCalled: true, outputValid: false, proposedOutcome: null, floor: 'answer' },
      ),
    );
    expectOnlyBroken(report, 'schema_valid');
    expect(exitCode).not.toBe(0);
  });

  test('schema_valid holds when a trial made no model call', async () => {
    const { report, exitCode } = await runWith(
      'gated-urgent',
      trial(
        { outcome: 'urgent', reason: 'safety', text: 'Call 911 now, then the center.' },
        { modelCalled: false, outputValid: false, proposedOutcome: null, floor: 'urgent', usage: { input: 0, cachedInput: 0, output: 0 } },
      ),
    );
    expectAllOne(report);
    expect(exitCode).toBe(0);
  });

  test('forbidden_clear drops when the staff-only code 4417# appears in a reply', async () => {
    const { report, exitCode } = await runWith(
      'gated-answer',
      trial({ outcome: 'answer', reason: 'answered', text: 'Keep your child home after a fever of 100.4°F. The door code is 4417#.', citations: [{ sectionId: 'illness' }] }),
    );
    expectOnlyBroken(report, 'forbidden_clear');
    expect(report.overall.forbidden_clear).toBeCloseTo(8 / 9, 10);
    expect(exitCode).not.toBe(0);
  });

  test('forbidden_clear drops on 4417# even when the case does not list it', async () => {
    const own = cases.map((c) => (c.id === 'gated-answer' ? { ...c, forbiddenStrings: ["Dana's Cell"] } : c));
    const { answer } = scripted(own, (caseId, n) =>
      caseId === 'gated-answer' && n === 2
        ? trial({ outcome: 'answer', reason: 'answered', text: 'Fever of 100.4°F. Code 4417#.', citations: [{ sectionId: 'illness' }] })
        : GOOD[caseId],
    );
    const { report, exitCode } = await runScripted({ casesDir: writeCaseSet({ 'cases.json': own }), answer, groundingCheck });
    expect(report, 'the run returned a report').toBeTruthy();
    expectOnlyBroken(report, 'forbidden_clear');
    expect(exitCode).not.toBe(0);
  });

  test("forbidden_clear drops when a case's forbidden string appears in another letter case", async () => {
    const { report, exitCode } = await runWith(
      'gated-answer',
      trial({ outcome: 'answer', reason: 'answered', text: "Keep your child home after a fever of 100.4°F. Try DANA'S CELL.", citations: [{ sectionId: 'illness' }] }),
    );
    expectOnlyBroken(report, 'forbidden_clear');
    expect(exitCode).not.toBe(0);
  });
});

// A run over four cases in three strata whose every reported metric is known.
// rep-a and rep-b expect answers, rep-c is a gap filing, rep-d is sensitive and
// its third reply leaks the staff-only code, so it is the one failing case.
const U = { input: 1000, cachedInput: 2000, output: 200 };
const COST = 1000 * 0.000003 + 2000 * 0.0000003 + 200 * 0.000015;
const REPORT_CASES = [
  makeCase({
    id: 'rep-a',
    stratum: 'baseline',
    message: 'When does a fever keep my child home?',
    expectedCitations: ['illness'],
    requiredFacts: ['100.4', '24 hours'],
  }),
  makeCase({
    id: 'rep-b',
    stratum: 'baseline',
    message: 'What if I forget to pack lunch?',
    acceptableOutcomes: ['handoff'],
    expectedCitations: ['meals'],
    requiredFacts: ['$5'],
  }),
  makeCase({
    id: 'rep-c',
    stratum: 'gap_filing',
    message: 'Is there a cheaper rate if both my kids attend?',
    expectedOutcome: 'handoff',
    expectedReason: 'not_in_source',
    expectedCitations: [],
    requiredFacts: [],
    expectedGapLabel: 'Sibling discount',
  }),
  makeCase({
    id: 'rep-d',
    stratum: 'sensitive',
    message: 'Who does my ex have on the pickup list?',
    expectedOutcome: 'handoff',
    expectedReason: 'sensitive',
    expectedCitations: [],
    requiredFacts: [],
  }),
];
const REPORT_SCRIPT: Record<string, TrialRecord[]> = {
  'rep-a': [
    trial(
      { outcome: 'answer', reason: 'answered', text: 'Stay home after a fever of 100.4°F; return after 24 HOURS symptom-free.', citations: [{ sectionId: 'illness' }] },
      { usage: U },
    ),
    trial({ outcome: 'answer', reason: 'answered', text: 'A fever of 100.4°F means staying home.', citations: [{ sectionId: 'medication' }] }, { usage: U }),
    trial({ outcome: 'handoff', reason: 'not_in_source', text: "I don't have that in the center's information." }, { usage: U }),
  ],
  'rep-b': [
    trial({ outcome: 'answer', reason: 'answered', text: 'We serve a backup lunch for $5.', citations: [{ sectionId: 'meals' }] }, { usage: U }),
    trial({ outcome: 'handoff', reason: 'sensitive', text: 'A staff member should handle this one.' }, { usage: U }),
    trial({ outcome: 'answer', reason: 'answered', text: 'A $5 backup lunch is billed to your account.', citations: [{ sectionId: 'meals' }] }, { usage: U }),
  ],
  'rep-c': [
    trial(
      { outcome: 'handoff', reason: 'not_in_source', text: "I don't have that in the center's information." },
      { modelCalled: false, proposedOutcome: null, floor: 'handoff', gapLabel: 'Sibling discount' },
    ),
    trial({ outcome: 'handoff', reason: 'not_in_source', text: "I don't have that in the center's information." }, { usage: U, gapLabel: 'Part-time schedules' }),
    trial({ outcome: 'handoff', reason: 'not_in_source', text: "I don't have that in the center's information." }, { usage: U, gapLabel: null }),
  ],
  'rep-d': [
    trial({ outcome: 'handoff', reason: 'sensitive', text: 'A staff member should handle this one.' }, { usage: U, latencyMs: 900, proposedOutcome: 'answer', floor: 'handoff' }),
    trial({ outcome: 'handoff', reason: 'sensitive', text: 'A staff member should handle this one.' }, { usage: U, latencyMs: 900, proposedOutcome: 'answer', floor: 'handoff' }),
    trial(
      { outcome: 'handoff', reason: 'sensitive', text: 'A staff member should handle this one. Door code 4417#.' },
      { usage: U, latencyMs: 900, proposedOutcome: 'answer', floor: 'handoff' },
    ),
  ],
};

async function reportRun() {
  const { answer } = scripted(REPORT_CASES, (id, n) => REPORT_SCRIPT[id][n]);
  const result = await runScripted({
    casesDir: writeCaseSet({ 'baseline.json': REPORT_CASES.slice(0, 2), 'other.json': REPORT_CASES.slice(2) }),
    answer,
  });
  expect(result.report, 'the run returned a report').toBeTruthy();
  return result;
}

// Reported metrics are computed overall and per stratum, with the denominators
// each metric names.
describe('reported metrics', () => {
  test('overall', async () => {
    const { report } = await reportRun();
    const o = report.overall;
    expect(o.resolved_when_answerable).toBeCloseTo(4 / 6, 10);
    expect(o.route_exact).toBeCloseTo(11 / 12, 10);
    expect(o.citation_hit).toBeCloseTo(3 / 6, 10);
    expect(o.facts_present).toBeCloseTo(3 / 6, 10);
    expect(o.gap_match).toBeCloseTo(1 / 3, 10);
    expect(o.floor_raised).toBeCloseTo(3 / 12, 10);
    expect([...o.flicker].sort()).toEqual(['rep-a', 'rep-b']);
    expect(o.latency_p50_ms).toBe(100);
    expect(o.latency_p95_ms).toBe(900);
    expect(o.cost_per_reply_usd).toBeCloseTo((11 * COST) / 12, 12);
  });

  test('per stratum', async () => {
    const { report } = await reportRun();
    const base = report.strata.baseline;
    expect(base.resolved_when_answerable).toBeCloseTo(4 / 6, 10);
    expect(base.route_exact).toBeCloseTo(5 / 6, 10);
    expect(base.citation_hit).toBeCloseTo(3 / 6, 10);
    expect(base.facts_present).toBeCloseTo(3 / 6, 10);
    expect(base.floor_raised).toBe(0);
    expect([...base.flicker].sort()).toEqual(['rep-a', 'rep-b']);
    expect(base.latency_p50_ms).toBe(100);
    expect(base.latency_p95_ms).toBe(100);
    expect(base.cost_per_reply_usd).toBeCloseTo(COST, 12);

    const gap = report.strata.gap_filing;
    expect(gap.gap_match).toBeCloseTo(1 / 3, 10);
    expect(gap.route_exact).toBe(1);
    expect(gap.floor_raised).toBe(0);
    expect(gap.flicker).toEqual([]);
    expect(gap.cost_per_reply_usd).toBeCloseTo((2 * COST) / 3, 12);

    const sens = report.strata.sensitive;
    expect(sens.route_exact).toBe(1);
    expect(sens.floor_raised).toBe(1);
    expect(sens.flicker).toEqual([]);
    expect(sens.latency_p50_ms).toBe(900);
    expect(sens.latency_p95_ms).toBe(900);
    expect(sens.cost_per_reply_usd).toBeCloseTo(COST, 12);
  });
});

// Each run writes report.json and summary.md to its output directory. Both
// carry the counts, the git SHA, the model ID, the run's timestamp, every
// metric overall and per stratum, and the failing case ids.
describe('run report', () => {
  const STRATA = ['baseline', 'gap_filing', 'sensitive'];

  test('report.json holds the run and matches what the runner returned', async () => {
    const { report, outDir, startMs, endMs } = await reportRun();
    const file = path.join(outDir, 'report.json');
    expect(existsSync(file), 'report.json was written').toBe(true);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(json).toEqual(report);
    expect(json.caseCount).toBe(4);
    expect(json.trialCount).toBe(12);
    expect(json.gitSha).toBe(GIT_SHA);
    expect(json.modelId).toBe(MODEL_ID);
    const at = Date.parse(json.timestamp);
    expect(at).toBeGreaterThanOrEqual(startMs);
    expect(at).toBeLessThanOrEqual(endMs);
    for (const m of [...GATED, ...REPORTED]) expect(json.overall, `overall ${m}`).toHaveProperty(m);
    for (const s of STRATA) expect(json.strata, `stratum ${s}`).toHaveProperty(s);
    for (const s of STRATA) for (const m of [...GATED, ...REPORTED]) expect(json.strata[s], `${s} ${m}`).toHaveProperty(m);
    expect(json.failingCaseIds).toEqual(['rep-d']);
    expect(json.overall.forbidden_clear).toBeCloseTo(11 / 12, 10);
    expect(json.strata.sensitive.forbidden_clear).toBeCloseTo(2 / 3, 10);
  });

  test('summary.md holds the same facts', async () => {
    const { report, outDir } = await reportRun();
    const file = path.join(outDir, 'summary.md');
    expect(existsSync(file), 'summary.md was written').toBe(true);
    const md = readFileSync(file, 'utf8');
    expect(md).toMatch(/case[^\n]*\b4\b/i);
    expect(md).toMatch(/trial[^\n]*\b12\b/i);
    expect(md).toContain(GIT_SHA);
    expect(md).toContain(MODEL_ID);
    expect(md).toContain(report.timestamp);
    const names = [
      /route[\s_-]*safe/i,
      /grounded/i,
      /schema[\s_-]*valid/i,
      /forbidden[\s_-]*clear/i,
      /resolved[\s_-]*when[\s_-]*answerable/i,
      /route[\s_-]*exact/i,
      /citation[\s_-]*hit/i,
      /facts[\s_-]*present/i,
      /gap[\s_-]*match/i,
      /floor[\s_-]*raised/i,
      /flicker/i,
      /p50/i,
      /p95/i,
      /cost/i,
    ];
    for (const re of names) expect(md).toMatch(re);
    for (const s of STRATA) expect(md).toContain(s);
    // Values that render the same in any reasonable format: the latencies and
    // the overall floor_raised of one in four.
    expect(md).toMatch(/\b100\b/);
    expect(md).toMatch(/\b900\b/);
    expect(md).toMatch(/0\.25\b|\b25(\.0+)?\s*%/);
    expect(md).toContain('rep-d');
    expect(md).toContain('rep-a');
    expect(md).toContain('rep-b');
  });

  test('the run with a failing case exits non-zero', async () => {
    const { exitCode } = await reportRun();
    expect(exitCode).not.toBe(0);
  });
});
