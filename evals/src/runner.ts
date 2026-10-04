// The eval runner: validates the case set, runs 3 trials of each case against
// the snapshot seed(case.now) publishes, computes the metrics, and writes
// report.json and summary.md to outDir.
//
// The answer function, the grounding check, and the clock are injected, so a
// test can drive the whole run with scripted replies on a fake clock. The
// runner never reads real time: every trial start waits on clock.sleep.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Reply } from '../../app/src/core/types';
import { type Snapshot, seed } from '../../app/src/seed/index';
import { type Case, loadCases } from './cases';
import { type CaseResult, GATED_METRICS, type Metrics, type Prices, type TrialRecord, computeMetrics } from './metrics';

export const TRIALS_PER_CASE = 3;

export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export type AnswerInput = {
  message: string;
  priorTurns: { role: 'parent' | 'front_desk'; text: string }[];
  now: Date;
  snapshot: Snapshot;
};

export type RunOptions = {
  casesDir: string;
  answer: (input: AnswerInput) => Promise<TrialRecord>;
  // `now` is the case's current time, so a check can re-render data sections.
  groundingCheck: (reply: Reply, snapshot: Snapshot, now: Date) => boolean;
  // Trials in flight at once.
  concurrency: number;
  // The least time between the starts of any two trials. Every trial waits its
  // turn, including one a floor answers without a model call: the runner
  // cannot know which trials call the model until they return.
  minStartIntervalMs: number;
  clock: Clock;
  gitSha: string;
  modelId: string;
  prices: Prices;
  outDir: string;
  log: (line: string) => void;
};

export type Report = {
  caseCount: number;
  trialCount: number;
  gitSha: string;
  modelId: string;
  timestamp: string;
  overall: Metrics;
  strata: Record<string, Metrics>;
  failingCaseIds: string[];
  // Every trial in case order, then trial order, with its failure text.
  trials: { caseId: string; trial: number; failure: string | null }[];
};

function latestSnapshot(c: Case): Snapshot {
  const { snapshots } = seed(new Date(c.now));
  return snapshots[snapshots.length - 1];
}

// Runs every trial with at most `concurrency` in flight. Each worker reserves
// its start slot before it awaits anything, so no two trials share a slot.
async function runTrials(cases: Case[], options: RunOptions): Promise<CaseResult[]> {
  const { clock, minStartIntervalMs } = options;
  const snapshots = cases.map(latestSnapshot);
  const results: CaseResult[] = cases.map((c) => ({ case: c, trials: [] }));
  const queue = cases.flatMap((_, ci) => Array.from({ length: TRIALS_PER_CASE }, (_, n) => ({ ci, n })));
  let next = 0;
  let nextStart = clock.now();

  async function worker() {
    while (next < queue.length) {
      const { ci, n } = queue[next];
      next += 1;
      const startAt = Math.max(clock.now(), nextStart);
      nextStart = startAt + minStartIntervalMs;
      if (startAt > clock.now()) await clock.sleep(startAt - clock.now());

      const c = cases[ci];
      const snapshot = snapshots[ci];
      const record = await options.answer({
        message: c.message,
        priorTurns: c.priorTurns ?? [],
        now: new Date(c.now),
        snapshot,
      });
      results[ci].trials[n] = { record, grounded: options.groundingCheck(record.reply, snapshot, new Date(c.now)) };
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  return results;
}

function fixed(value: number | null, digits: number): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function metricCells(m: Metrics): [string, string][] {
  return [
    ['route_safe (gated)', fixed(m.route_safe, 2)],
    ['grounded (gated)', fixed(m.grounded, 2)],
    ['schema_valid (gated)', fixed(m.schema_valid, 2)],
    ['forbidden_clear (gated)', fixed(m.forbidden_clear, 2)],
    ['resolved_when_answerable', fixed(m.resolved_when_answerable, 2)],
    ['route_exact', fixed(m.route_exact, 2)],
    ['citation_hit', fixed(m.citation_hit, 2)],
    ['facts_present', fixed(m.facts_present, 2)],
    ['gap_match', fixed(m.gap_match, 2)],
    ['floor_raised', fixed(m.floor_raised, 2)],
    ['flicker (cases)', String(m.flicker.length)],
    ['latency p50 (ms)', fixed(m.latency_p50_ms, 0)],
    ['latency p95 (ms)', fixed(m.latency_p95_ms, 0)],
    ['cost per reply (USD)', fixed(m.cost_per_reply_usd, 6)],
  ];
}

function list(ids: string[]): string {
  return ids.length === 0 ? 'none' : ids.join(', ');
}

function summary(report: Report): string {
  const overall = metricCells(report.overall);
  const strata = Object.entries(report.strata);
  const header = overall.map(([name]) => name);
  const failed = report.trials.filter((t) => t.failure !== null);
  return [
    '# Eval summary',
    '',
    `Cases: ${report.caseCount}, trials: ${report.trialCount}`,
    `Trials that failed to reach the model: ${failed.length}`,
    `Cases with a trial that failed to reach the model: ${list([...new Set(failed.map((t) => t.caseId))])}`,
    '',
    `- Git SHA: ${report.gitSha}`,
    `- Model: ${report.modelId}`,
    `- Timestamp: ${report.timestamp}`,
    '',
    '## Overall',
    '',
    '| Metric | Value |',
    '|---|---|',
    ...overall.map(([name, value]) => `| ${name} | ${value} |`),
    '',
    '## Per stratum',
    '',
    `| Stratum | ${header.join(' | ')} |`,
    `|---|${header.map(() => '---').join('|')}|`,
    ...strata.map(([stratum, m]) => `| ${stratum} | ${metricCells(m).map(([, value]) => value).join(' | ')} |`),
    '',
    `Failing cases: ${list(report.failingCaseIds)}`,
    '',
    `Flicker: ${list(report.overall.flicker)}`,
    '',
  ].join('\n');
}

export async function runEval(options: RunOptions): Promise<{ exitCode: number; report: Report | null }> {
  const { log } = options;
  const timestamp = new Date(options.clock.now()).toISOString();

  const { cases, problems } = loadCases(options.casesDir);
  if (problems.length > 0) {
    for (const p of problems) log(`Invalid case ${p.caseId ?? '(no id)'} in ${p.file}: ${p.message}`);
    log(`Refusing to run: ${problems.length} problem(s) in ${options.casesDir}.`);
    return { exitCode: 1, report: null };
  }
  if (cases.length === 0) {
    log(`Refusing to run: no cases in ${options.casesDir}.`);
    return { exitCode: 1, report: null };
  }

  log(`Running ${cases.length} cases, ${cases.length * TRIALS_PER_CASE} trials.`);
  const results = await runTrials(cases, options);
  const { overall, strata, failingCaseIds } = computeMetrics(results, options.prices);
  const report: Report = {
    caseCount: cases.length,
    trialCount: cases.length * TRIALS_PER_CASE,
    gitSha: options.gitSha,
    modelId: options.modelId,
    timestamp,
    overall,
    strata,
    failingCaseIds,
    // An injected answer function written before `failure` existed leaves it out.
    trials: results.flatMap((r) => r.trials.map(({ record }, n) => ({ caseId: r.case.id, trial: n, failure: record.failure ?? null }))),
  };

  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(path.join(options.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(options.outDir, 'summary.md'), summary(report));

  const passed = GATED_METRICS.every((m) => overall[m] === 1);
  log(passed ? 'Every gated metric is 1.00.' : `Gated metrics below 1.00. Failing cases: ${list(failingCaseIds)}.`);
  return { exitCode: passed ? 0 : 1, report };
}
