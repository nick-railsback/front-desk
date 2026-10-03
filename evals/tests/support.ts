// Shared helpers for the eval harness tests. Not a test file: vitest collects
// only *.test.ts, and this module is imported by them.
//
// The interface these tests hold the harness to:
//
//   evals/src/cases.ts   loadCases(dir) -> { cases, problems }
//   evals/src/runner.ts  runEval(options) -> Promise<{ exitCode, report }>
//
// A case set is a directory of JSON files, each a JSON array of cases. A case:
//   id, stratum, split, now, message, priorTurns?, expectedOutcome,
//   acceptableOutcomes?, expectedReason?, expectedCitations, requiredFacts,
//   forbiddenStrings, expectedGapLabel?, rationale
//
// The answer function receives { message, priorTurns, now, snapshot } and
// resolves to a trial record:
//   { reply, proposedOutcome, floor, modelCalled, outputValid, latencyMs,
//     usage: { input, cachedInput, output }, gapLabel }
//
// The clock is { now(): number (epoch ms), sleep(ms): Promise<void> }.
// The run writes report.json and summary.md into outDir, and prints through
// the injected log(line).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Outcome, Reason, Reply } from '../../app/src/core/types';
import { seed } from '../../app/src/seed/index';
import type { Snapshot } from '../../app/src/seed/index';

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const CASES_DIR = path.join(ROOT, 'evals', 'cases');

export const STRATA_MINIMUMS: Record<string, number> = {
  baseline: 6,
  date_time: 5,
  staleness: 3,
  program: 3,
  medical_policy: 4,
  not_in_source: 4,
  sensitive: 4,
  urgent: 4,
  privacy: 3,
  correlation_breaker: 3,
  multi_intent: 2,
  adversarial: 3,
  non_english: 2,
  gap_filing: 2,
};

export const SPLIT = 'agent-drafted-author-reviewed';

export const DATA_SECTION_IDS = ['hours', 'calendar', 'menu', 'alerts', 'tuition', 'contacts'];

export const GATED = ['route_safe', 'grounded', 'schema_valid', 'forbidden_clear'] as const;

export const REPORTED = [
  'resolved_when_answerable',
  'route_exact',
  'citation_hit',
  'facts_present',
  'gap_match',
  'floor_raised',
  'flicker',
  'latency_p50_ms',
  'latency_p95_ms',
  'cost_per_reply_usd',
] as const;

export type Turn = { role: 'parent' | 'front_desk'; text: string };

export type Case = {
  id: string;
  stratum: string;
  split: string;
  now: string;
  message: string;
  priorTurns?: Turn[];
  expectedOutcome: Outcome;
  acceptableOutcomes?: Outcome[];
  expectedReason?: Reason;
  expectedCitations: string[];
  requiredFacts: string[];
  forbiddenStrings: string[];
  expectedGapLabel?: string;
  rationale: string;
};

export type AnswerInput = { message: string; priorTurns: Turn[]; now: Date; snapshot: Snapshot };

export type TrialRecord = {
  reply: Reply;
  proposedOutcome: Outcome | null;
  floor: Outcome;
  modelCalled: boolean;
  outputValid: boolean;
  latencyMs: number;
  usage: { input: number; cachedInput: number; output: number };
  gapLabel: string | null;
};

// A valid case to build fixtures from. Overrides replace fields; a field set
// to undefined is removed, so a fixture can drop a required field.
export function makeCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: 'fixture-baseline-1',
    stratum: 'baseline',
    split: SPLIT,
    now: '2026-10-05T09:00:00-06:00',
    message: 'When should I keep my child home with a fever?',
    expectedOutcome: 'answer',
    expectedReason: 'answered',
    expectedCitations: ['illness'],
    requiredFacts: ['100.4'],
    forbiddenStrings: ['4417#'],
    rationale: 'The illness policy states the fever threshold.',
  };
  const out: Record<string, unknown> = { ...base, ...overrides };
  for (const [k, v] of Object.entries(out)) if (v === undefined) delete out[k];
  return out;
}

// Writes a case set into a fresh temporary directory: { 'file.json': [cases] }.
export function writeCaseSet(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'front-desk-cases-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

export function makeOutDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'front-desk-eval-out-'));
}

export function latestSnapshot(now: string): Snapshot {
  const s = seed(new Date(now));
  return s.snapshots[s.snapshots.length - 1];
}

// A trial record for a reply, with defaults for everything a test doesn't set.
export function trial(reply: Partial<Reply> & Pick<Reply, 'outcome' | 'reason'>, extra: Partial<TrialRecord> = {}): TrialRecord {
  const full: Reply = { text: 'Scripted reply.', snapshotVersion: 1, citations: [], ...reply };
  return {
    reply: full,
    proposedOutcome: full.outcome,
    floor: 'answer',
    modelCalled: true,
    outputValid: true,
    latencyMs: 100,
    usage: { input: 0, cachedInput: 0, output: 0 },
    gapLabel: null,
    ...extra,
  };
}

export const PRICES = { input: 0.000003, cachedInput: 0.0000003, output: 0.000015 };

export type Clock = { now(): number; sleep(ms: number): Promise<void> };

// A fake clock over virtual time. sleep(ms) registers a wake time; the driver,
// once the event loop is idle, advances virtual time to the earliest pending
// wake and resolves every sleeper due at that instant.
export function fakeClock(startMs: number) {
  let current = startMs;
  let timers: { at: number; resolve: () => void }[] = [];
  const clock: Clock = {
    now: () => current,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push({ at: current + Math.max(0, ms), resolve });
      }),
  };
  async function drive<T>(work: Promise<T>): Promise<T> {
    let done = false;
    const settled = work.finally(() => {
      done = true;
    });
    const loop = (async () => {
      while (!done) {
        await new Promise((r) => setImmediate(r));
        if (done) break;
        if (timers.length === 0) continue;
        const at = Math.min(...timers.map((t) => t.at));
        current = Math.max(current, at);
        const due = timers.filter((t) => t.at <= current);
        timers = timers.filter((t) => t.at > current);
        for (const t of due) t.resolve();
      }
    })();
    try {
      return await settled;
    } finally {
      done = true;
      await loop;
    }
  }
  return { clock, drive };
}

export type RunArgs = {
  casesDir: string;
  // The scripted answer function; it gets the run's fake clock so it can take
  // simulated time.
  answer: (input: AnswerInput, clock: Clock) => Promise<TrialRecord>;
  groundingCheck?: (reply: Reply, snapshot: Snapshot) => boolean;
  concurrency?: number;
  minStartIntervalMs?: number;
  startMs?: number;
};

export const GIT_SHA = '0123456789abcdef0123456789abcdef01234567';
export const MODEL_ID = 'scripted-model-for-tests';

// Runs the harness with scripted replies on a fake clock. Returns what the
// runner returned plus the log lines and the clock's start and end.
export async function runScripted(args: RunArgs) {
  const { runEval } = await import('../src/runner');
  const startMs = args.startMs ?? Date.parse('2026-10-02T18:00:00Z');
  const { clock, drive } = fakeClock(startMs);
  const lines: string[] = [];
  const outDir = makeOutDir();
  const result = await drive(
    runEval({
      casesDir: args.casesDir,
      answer: (input: AnswerInput) => args.answer(input, clock),
      groundingCheck: args.groundingCheck ?? (() => true),
      concurrency: args.concurrency ?? 4,
      minStartIntervalMs: args.minStartIntervalMs ?? 0,
      clock,
      gitSha: GIT_SHA,
      modelId: MODEL_ID,
      prices: PRICES,
      outDir,
      log: (line: string) => {
        lines.push(String(line));
      },
    }),
  );
  return { ...result, lines, outDir, startMs, endMs: clock.now() };
}

// Denver wall clock of an instant.
const DENVER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Denver',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

export function denverWallClock(instant: Date): { year: number; date: string; hour: number } {
  const p: Record<string, string> = {};
  for (const part of DENVER.formatToParts(instant)) p[part.type] = part.value;
  return { year: Number(p.year), date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// The US fall-back date (first Sunday of November) of a year, as YYYY-MM-DD.
export function fallBackDate(year: number): string {
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const offset = (7 - nov1.getUTCDay()) % 7;
  return new Date(Date.UTC(year, 10, 1 + offset)).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
