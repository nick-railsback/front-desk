// Trials that failed to reach the model, in the eval's report.
//
// The runner is driven through the app's own answer() with a model that
// throws on a known set of trials and answers every other one, so each
// failure text is the one the pipeline writes.
//
// failed model calls: each trial in report.json records its model-call
// failure, the failure text when the call failed and null when it succeeded,
// and the trials that record one are exactly the known set. summary.md
// states how many trials failed to reach the model overall, and lists the
// ids of the cases with a failed trial and no other case id beside them.
// With no failing trial, every trial records null and the count reads 0.
// The report keeps every field it had before: the counts, git SHA, model
// ID, timestamp, metrics overall and per stratum, and the failing case ids.
//
// Assumed interface: see ../support.ts, plus:
//   report.json gains `trials`, one entry per trial (trialCount in all):
//     { caseId: string; trial: number; failure: string | null }
//   where `failure` is the failure text answer() recorded for that trial's
//   model call (AnswerRecord.failure), or null when the call succeeded.
//   summary.md states the count on a line that says the trials failed to
//   reach the model, and lists the failing trials' case ids on a line that
//   mentions the model or reaching it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { answer } from '../../../app/src/core/answer';
import { renderDataSections } from '../../../app/src/core/assemble';
import type { Model } from '../../../app/src/core/types';
import { seed } from '../../../app/src/seed/index';
import { type AnswerInput, type Clock, GIT_SHA, MODEL_ID, type TrialRecord, makeCase, runScripted, writeCaseSet } from '../support';

const UNREACHABLE = 'connect ECONNREFUSED bedrock-runtime.example';

const IDS = ['case-alder', 'case-birch', 'case-cedar', 'case-dogwood'] as const;
const MESSAGES: Record<(typeof IDS)[number], string> = {
  'case-alder': 'Do you have a swimming pool?',
  'case-birch': 'Is there a pottery class on Saturday?',
  'case-cedar': 'Do you offer violin lessons?',
  'case-dogwood': 'Can we bring a pet hamster for show and tell?',
};

const cases = IDS.map((id) =>
  makeCase({
    id,
    message: MESSAGES[id],
    expectedOutcome: 'handoff',
    expectedReason: 'not_in_source',
    expectedCitations: [],
    requiredFacts: [],
  }),
);

const answers: Model = async () => ({
  output: { outcome: 'handoff', reason: 'not_in_source', text: '', citations: [], language: 'en', topic: 'Other', gapLabel: null },
  usage: { input: 10, cachedInput: 0, output: 5 },
});

const unreachable: Model = async () => {
  throw new Error(UNREACHABLE);
};

// Runs every case through answer(), with the model failing on the trials
// `fails` names: case id to the trial numbers (0, 1, 2 in call order).
async function run(fails: Partial<Record<(typeof IDS)[number], number[]>>) {
  const byMessage = new Map(cases.map((c) => [c.message as string, c.id as (typeof IDS)[number]]));
  const seen = new Map<string, number>();
  const result = await runScripted({
    casesDir: writeCaseSet({ 'cases.json': cases }),
    concurrency: 1,
    answer: async (input: AnswerInput, clock: Clock) => {
      const id = byMessage.get(input.message)!;
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      const content = seed(input.now);
      const record = await answer(
        { message: input.message, priorTurns: input.priorTurns, now: input.now },
        {
          snapshot: { version: input.snapshot.version, sections: [...input.snapshot.sections, ...renderDataSections(content.structured, input.now)] },
          calendar: content.structured.calendar,
          openGapLabels: [],
          model: (fails[id] ?? []).includes(n) ? unreachable : answers,
          clock,
        },
      );
      return record as unknown as TrialRecord;
    },
  });
  const json = JSON.parse(readFileSync(path.join(result.outDir, 'report.json'), 'utf8'));
  const summary = readFileSync(path.join(result.outDir, 'summary.md'), 'utf8');
  return { json, summary };
}

type Trial = { caseId: string; trial: number; failure: string | null };

function trialsOf(json: any): Trial[] {
  expect(Array.isArray(json.trials), 'report.json has no `trials` list').toBe(true);
  expect(json.trials.length, 'report.json does not hold one entry per trial').toBe(json.trialCount);
  for (const t of json.trials) {
    expect(t, 'a trial entry has no `failure` field').toHaveProperty('failure');
    expect(t.failure === null || typeof t.failure === 'string', `a trial's failure is ${JSON.stringify(t.failure)}`).toBe(true);
    expect(IDS as readonly string[], `a trial entry names no case: ${JSON.stringify(t)}`).toContain(t.caseId);
  }
  return json.trials as Trial[];
}

function expectEveryField(json: any, summary: string): void {
  for (const key of ['caseCount', 'trialCount', 'gitSha', 'modelId', 'timestamp', 'overall', 'strata', 'failingCaseIds']) {
    expect(json, `report.json lost ${key}`).toHaveProperty(key);
  }
  expect({ caseCount: json.caseCount, trialCount: json.trialCount, gitSha: json.gitSha, modelId: json.modelId }).toEqual({
    caseCount: 4,
    trialCount: 12,
    gitSha: GIT_SHA,
    modelId: MODEL_ID,
  });
  expect(summary).toContain('Cases: 4, trials: 12');
  expect(summary).toMatch(/Failing cases:/);
}

// The line stating how many trials failed to reach the model.
function countLine(summary: string): string {
  const line = summary.split('\n').find((l) => /\breach/i.test(l) && /\bmodel\b/i.test(l) && /\d/.test(l));
  expect(line, `summary.md has no line stating how many trials failed to reach the model:\n${summary}`).toBeTruthy();
  return line!;
}

describe('failed model calls', () => {
  test('with a model that fails on a known set of trials, each trial records its failure or null, and the summary counts and lists them', async () => {
    const { json, summary } = await run({ 'case-alder': [0, 1, 2], 'case-birch': [1], 'case-cedar': [0] });
    expectEveryField(json, summary);
    const trials = trialsOf(json);
    const failed: Record<string, number> = {};
    for (const t of trials) {
      if (t.failure === null) continue;
      expect(t.failure, `trial ${t.trial} of ${t.caseId} records a failure that is not the model call's`).toContain(UNREACHABLE);
      failed[t.caseId] = (failed[t.caseId] ?? 0) + 1;
    }
    expect(failed, 'the trials recording a failure are not the ones whose model call failed').toEqual({ 'case-alder': 3, 'case-birch': 1, 'case-cedar': 1 });

    expect(countLine(summary), 'the summary does not count 5 trials that failed to reach the model').toMatch(/(?<![\d.])5(?![\d.])/);
    const listing = summary.split('\n').filter((l) => /\bmodel\b|\breach/i.test(l) && ['case-alder', 'case-birch', 'case-cedar'].every((id) => l.includes(id)));
    expect(listing.length, `summary.md lists the cases with a failed trial on no line about the model:\n${summary}`).toBeGreaterThan(0);
    for (const l of summary.split('\n').filter((x) => /\bmodel\b|\breach/i.test(x))) {
      expect(l, 'a case with no failed trial is listed among them').not.toContain('case-dogwood');
    }
  });

  test('with no failing trial, every trial records null and the count reads 0', async () => {
    const { json, summary } = await run({});
    expectEveryField(json, summary);
    const trials = trialsOf(json);
    expect(trials.filter((t) => t.failure !== null), 'a trial records a failure though every model call succeeded').toEqual([]);
    expect(countLine(summary), 'the summary does not count 0 trials that failed to reach the model').toMatch(/(?<![\d.])0(?![\d.])/);
    for (const l of summary.split('\n').filter((x) => /\bmodel\b|\breach/i.test(x))) {
      for (const id of IDS) expect(l, `${id} is listed as failing to reach the model`).not.toContain(id);
    }
  });
});
