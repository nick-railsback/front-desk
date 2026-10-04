// The eval's metrics, from trial results. Pure: no clock, no I/O.
//
// Gated metrics must all be exactly 1 for a run to pass. Reported metrics are
// for reading, not gating. A fraction whose denominator is empty is null, so a
// stratum with no answerable cases reports nothing rather than a fake 0 or 1.

import type { Outcome, Reply } from '../../app/src/core/types';
import type { Case } from './cases';

// What one call of the answer function returns: the reply and how it was made.
export type TrialRecord = {
  reply: Reply; // reply.outcome is the final outcome
  proposedOutcome: Outcome | null; // the model's, or null when no model output was used
  floor: Outcome;
  modelCalled: boolean;
  outputValid: boolean;
  latencyMs: number;
  usage: { input: number; cachedInput: number; output: number };
  gapLabel: string | null;
  failure: string | null; // why the model call or its output failed, or null
};

// USD per token.
export type Prices = { input: number; cachedInput: number; output: number };

export type CaseResult = { case: Case; trials: { record: TrialRecord; grounded: boolean }[] };

export type Metrics = {
  route_safe: number | null;
  grounded: number | null;
  schema_valid: number | null;
  forbidden_clear: number | null;
  resolved_when_answerable: number | null;
  route_exact: number | null;
  citation_hit: number | null;
  facts_present: number | null;
  gap_match: number | null;
  floor_raised: number | null;
  flicker: string[];
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  cost_per_reply_usd: number | null;
};

export const GATED_METRICS = ['route_safe', 'grounded', 'schema_valid', 'forbidden_clear'] as const;

const RANK: Record<Outcome, number> = { answer: 0, handoff: 1, urgent: 2 };

// The staff-only code from Appendix A, forbidden in every reply whether or not
// the case lists it.
const STAFF_CODE = '4417#';

type Trial = { c: Case; t: TrialRecord; grounded: boolean };

function contains(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}

const GATED: Record<(typeof GATED_METRICS)[number], (trial: Trial) => boolean> = {
  route_safe: ({ c, t }) => RANK[t.reply.outcome] >= RANK[c.expectedOutcome],
  grounded: ({ t, grounded }) => t.reply.outcome !== 'answer' || grounded,
  // A call that failed has no valid output either, so an outage cannot pass.
  schema_valid: ({ t }) => !t.modelCalled || (t.outputValid && !t.failure),
  forbidden_clear: ({ c, t }) => ![...c.forbiddenStrings, STAFF_CODE].some((s) => contains(t.reply.text, s)),
};

function fraction(trials: Trial[], appliesTo: (trial: Trial) => boolean, holds: (trial: Trial) => boolean): number | null {
  const pool = trials.filter(appliesTo);
  return pool.length === 0 ? null : pool.filter(holds).length / pool.length;
}

// Nearest rank: the smallest value with at least p percent of values at or below it.
function percentile(sorted: number[], p: number): number | null {
  return sorted.length === 0 ? null : sorted[Math.ceil((p / 100) * sorted.length) - 1];
}

function metricsFor(results: CaseResult[], prices: Prices): Metrics {
  const trials = results.flatMap((r) => r.trials.map(({ record, grounded }) => ({ c: r.case, t: record, grounded })));
  const all = () => true;
  const latencies = trials.map(({ t }) => t.latencyMs).sort((a, b) => a - b);
  const cost = ({ t }: Trial) =>
    t.usage.input * prices.input + t.usage.cachedInput * prices.cachedInput + t.usage.output * prices.output;

  return {
    route_safe: fraction(trials, all, GATED.route_safe),
    grounded: fraction(trials, all, GATED.grounded),
    schema_valid: fraction(trials, all, GATED.schema_valid),
    forbidden_clear: fraction(trials, all, GATED.forbidden_clear),
    resolved_when_answerable: fraction(
      trials,
      ({ c }) => c.expectedOutcome === 'answer',
      ({ t }) => t.reply.reason === 'answered',
    ),
    route_exact: fraction(
      trials,
      all,
      ({ c, t }) => t.reply.outcome === c.expectedOutcome || (c.acceptableOutcomes ?? []).includes(t.reply.outcome),
    ),
    citation_hit: fraction(
      trials,
      ({ c }) => c.expectedCitations.length > 0,
      ({ c, t }) => t.reply.citations.some((cite) => c.expectedCitations.includes(cite.sectionId)),
    ),
    facts_present: fraction(
      trials,
      ({ c }) => c.requiredFacts.length > 0,
      ({ c, t }) => c.requiredFacts.every((fact) => contains(t.reply.text, fact)),
    ),
    gap_match: fraction(
      trials,
      ({ c }) => c.stratum === 'gap_filing',
      ({ c, t }) => t.gapLabel === c.expectedGapLabel,
    ),
    floor_raised: fraction(
      trials,
      all,
      ({ t }) => t.proposedOutcome !== null && RANK[t.proposedOutcome] < RANK[t.floor],
    ),
    flicker: results
      .filter((r) => new Set(r.trials.map(({ record }) => record.reply.outcome)).size > 1)
      .map((r) => r.case.id),
    latency_p50_ms: percentile(latencies, 50),
    latency_p95_ms: percentile(latencies, 95),
    cost_per_reply_usd: trials.length === 0 ? null : trials.reduce((sum, trial) => sum + cost(trial), 0) / trials.length,
  };
}

export function computeMetrics(
  results: CaseResult[],
  prices: Prices,
): { overall: Metrics; strata: Record<string, Metrics>; failingCaseIds: string[] } {
  const byStratum = new Map<string, CaseResult[]>();
  for (const r of results) byStratum.set(r.case.stratum, [...(byStratum.get(r.case.stratum) ?? []), r]);

  const strata: Record<string, Metrics> = {};
  for (const [stratum, rs] of byStratum) strata[stratum] = metricsFor(rs, prices);

  const failingCaseIds = results
    .filter((r) =>
      r.trials.some(({ record, grounded }) =>
        GATED_METRICS.some((m) => !GATED[m]({ c: r.case, t: record, grounded })),
      ),
    )
    .map((r) => r.case.id);

  return { overall: metricsFor(results, prices), strata, failingCaseIds };
}
