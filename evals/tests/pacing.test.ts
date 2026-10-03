// Every trial is paced, with no exceptions for trials that turn out not to
// call the model: no two trials start closer together than the run's minimum
// start interval, and no more trials are in flight than its concurrency. Time
// is the injected clock's; the scripted answers take simulated time on it.

import { describe, expect, test } from 'vitest';
import { type AnswerInput, type Clock, makeCase, runScripted, trial, writeCaseSet } from './support';

const CASES = Array.from({ length: 6 }, (_, i) =>
  makeCase({ id: `paced-${i}`, message: `Paced question number ${i}?` }),
);
// paced-0 is answered from a floor: no model call, no simulated time.
const FLOORED = 'Paced question number 0?';

async function pacedRun(concurrency: number, minStartIntervalMs: number, workMs: number) {
  const starts: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const answer = async (input: AnswerInput, clock: Clock) => {
    starts.push(clock.now());
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (input.message === FLOORED) {
        return trial(
          { outcome: 'urgent', reason: 'safety', text: 'Call 911 now, then the center.' },
          { modelCalled: false, proposedOutcome: null, floor: 'urgent', latencyMs: 0 },
        );
      }
      await clock.sleep(workMs);
      return trial(
        { outcome: 'answer', reason: 'answered', text: 'Fever of 100.4°F.', citations: [{ sectionId: 'illness' }] },
        { latencyMs: workMs },
      );
    } finally {
      inFlight -= 1;
    }
  };
  const result = await runScripted({
    casesDir: writeCaseSet({ 'cases.json': CASES }),
    answer,
    concurrency,
    minStartIntervalMs,
  });
  return { result, starts, maxInFlight };
}

function closestStarts(starts: number[]): number {
  const sorted = [...starts].sort((a, b) => a - b);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sorted.length; i += 1) min = Math.min(min, sorted[i] - sorted[i - 1]);
  return min;
}

describe('pacing', () => {
  test('long trials: concurrency caps the trials in flight and starts keep the interval', { timeout: 20_000 }, async () => {
    const { result, starts, maxInFlight } = await pacedRun(2, 1_000, 5_000);
    expect(starts.length).toBe(18);
    expect(closestStarts(starts)).toBeGreaterThanOrEqual(1_000);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(result.exitCode).toBe(0);
  });

  test('short trials: starts keep the interval, floored trials included', { timeout: 20_000 }, async () => {
    const { result, starts, maxInFlight } = await pacedRun(3, 6_000, 1_000);
    expect(starts.length).toBe(18);
    expect(closestStarts(starts)).toBeGreaterThanOrEqual(6_000);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(result.exitCode).toBe(0);
  });

  test('floored trials alone are still paced', { timeout: 20_000 }, async () => {
    const floored = [makeCase({ id: 'paced-floor', message: FLOORED, expectedOutcome: 'urgent', expectedReason: 'safety', expectedCitations: [], requiredFacts: [] })];
    const starts: number[] = [];
    const result = await runScripted({
      casesDir: writeCaseSet({ 'cases.json': floored }),
      answer: async (_input, clock) => {
        starts.push(clock.now());
        return trial(
          { outcome: 'urgent', reason: 'safety', text: 'Call 911 now, then the center.' },
          { modelCalled: false, proposedOutcome: null, floor: 'urgent', latencyMs: 0 },
        );
      },
      concurrency: 3,
      minStartIntervalMs: 2_500,
    });
    expect(starts.length).toBe(3);
    expect(closestStarts(starts)).toBeGreaterThanOrEqual(2_500);
    expect(result.exitCode).toBe(0);
  });
});
