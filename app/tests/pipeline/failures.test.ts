// Model failures. Time is virtual: the injected clock advances only while the
// pipeline waits on the model, so the 15 second limit and every backoff run
// without real waiting.
//
// fail-safe: a model error, a model call that has not returned after 15
// seconds by the injected clock, or model output that fails validation
// produces a handoff with reason system_error, and the failure is logged. The
// trial record shows output validity false for invalid output and true for
// valid output. A call that returns before the limit is used.
//
// throttling: a call rejected for throttling is retried after a backoff. A
// call throttled once and then successful produces the successful call's
// reply. A call throttled on every attempt produces a system_error handoff
// within the 15 second limit.
//
// Assumed interface: see ./support.ts.

import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import {
  GENERATED,
  RUN_YEAR,
  type Script,
  USAGE,
  answerOut,
  askWith,
  closeLoadedDb,
  contains,
  denver,
  loadPipeline,
  onOrAfter,
  output,
  returns,
  ymd,
} from './support';

const TIMEOUT = 60_000;
const LIMIT_MS = 15_000;

afterAll(async () => {
  await closeLoadedDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DAY = onOrAfter(ymd(RUN_YEAR, 10, 14), 3);
const NOW = denver(DAY, '10:00');
const MESSAGE = 'What time is breakfast served?';
const GOOD_TEXT = 'Breakfast is served until 8:30 AM.';

// Counts what the pipeline writes to the console or the process streams
// while `work` runs.
async function logged<T>(work: () => Promise<T>): Promise<{ value: T; lines: number }> {
  let lines = 0;
  const count = () => {
    lines += 1;
  };
  for (const method of ['error', 'warn', 'log', 'info'] as const) vi.spyOn(console, method).mockImplementation(count);
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((() => (count(), true)) as never);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((() => (count(), true)) as never);
  try {
    const value = await work();
    return { value, lines };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

async function run(script: Script) {
  const { ask, db } = await loadPipeline();
  const id = await db.createSandbox(NOW);
  return askWith(ask, id, MESSAGE, NOW, script);
}

function throttle(): never {
  const err = new Error('Rate exceeded');
  err.name = 'ThrottlingException';
  throw err;
}

// Two representatives: output that is not structured at all, and a
// well-formed object whose reason belongs to a different outcome.
const INVALID: [string, unknown][] = [
  ['prose instead of structured output', `I think breakfast is at 8:30 AM, says the ${GENERATED}.`],
  ['a reason that does not belong to its outcome', output({ outcome: 'answer', reason: 'emergency' })],
];

describe('fail-safe', () => {
  test(
    'fail-safe: a model error produces a system_error handoff and is logged',
    async () => {
      const { value, lines } = await logged(() =>
        run(() => {
          throw new Error('model exploded');
        }),
      );
      expect({ outcome: value.result.reply.outcome, reason: value.result.reply.reason }).toEqual({ outcome: 'handoff', reason: 'system_error' });
      expect(lines, 'the failure was not logged').toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test(
    'fail-safe: a model call that has not returned after 15 seconds produces a system_error handoff and is logged',
    async () => {
      const { value, lines } = await logged(() => run(() => new Promise(() => {})));
      expect({ outcome: value.result.reply.outcome, reason: value.result.reply.reason }).toEqual({ outcome: 'handoff', reason: 'system_error' });
      expect(value.endMs - value.startMs, 'the pipeline gave up before 15 seconds').toBeGreaterThanOrEqual(LIMIT_MS);
      expect(lines, 'the timeout was not logged').toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test(
    'fail-safe: a model call that returns after 14 seconds is used',
    async () => {
      const { result } = await run(async (_req, _n, clock) => {
        await clock.sleep(14_000);
        return { output: answerOut(GOOD_TEXT, ['meals']), usage: USAGE };
      });
      expect({ outcome: result.reply.outcome, reason: result.reply.reason }).toEqual({ outcome: 'answer', reason: 'answered' });
      expect(contains(result.reply.text, GOOD_TEXT)).toBe(true);
    },
    TIMEOUT,
  );

  for (const [label, out] of INVALID) {
    test(
      `fail-safe: invalid output (${label}) produces a system_error handoff, output validity false, and is logged`,
      async () => {
        const { value, lines } = await logged(() => run(returns(out)));
        expect({ outcome: value.result.reply.outcome, reason: value.result.reply.reason }).toEqual({ outcome: 'handoff', reason: 'system_error' });
        expect(value.result.outputValid).toBe(false);
        expect(value.result.modelCalled).toBe(true);
        expect(lines, 'the failure was not logged').toBeGreaterThan(0);
      },
      TIMEOUT,
    );
  }

  test(
    'fail-safe: valid output is recorded as valid',
    async () => {
      const { result } = await run(returns(answerOut(GOOD_TEXT, ['meals'])));
      expect(result.outputValid).toBe(true);
      expect(result.modelCalled).toBe(true);
      expect(result.proposedOutcome).toBe('answer');
      expect(result.reply.reason).toBe('answered');
    },
    TIMEOUT,
  );
});

describe('throttling', () => {
  test(
    'throttling: a call throttled once and then successful produces the successful reply, after a backoff',
    async () => {
      const asked = await run((_req, n) => {
        if (n === 0) throttle();
        return { output: answerOut(GOOD_TEXT, ['meals']), usage: USAGE };
      });
      expect(asked.requests.length, 'the throttled call was not retried').toBe(2);
      expect(asked.attemptsAt[1], 'the retry did not wait').toBeGreaterThan(asked.attemptsAt[0]);
      expect({ outcome: asked.result.reply.outcome, reason: asked.result.reply.reason }).toEqual({ outcome: 'answer', reason: 'answered' });
      expect(contains(asked.result.reply.text, GOOD_TEXT)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'throttling: a call throttled on every attempt produces a system_error handoff within 15 seconds',
    async () => {
      const asked = await run(() => throttle());
      expect(asked.requests.length, 'the throttled call was not retried').toBeGreaterThanOrEqual(2);
      for (let i = 1; i < asked.attemptsAt.length; i++) expect(asked.attemptsAt[i], `attempt ${i + 1} did not wait`).toBeGreaterThan(asked.attemptsAt[i - 1]);
      expect({ outcome: asked.result.reply.outcome, reason: asked.result.reply.reason }).toEqual({ outcome: 'handoff', reason: 'system_error' });
      expect(asked.endMs - asked.startMs, 'the retries ran past the 15 second limit').toBeLessThanOrEqual(LIMIT_MS);
    },
    TIMEOUT,
  );
});
