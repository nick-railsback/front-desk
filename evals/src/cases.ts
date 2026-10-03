// The eval case set: every top-level *.json file in a directory, each a JSON
// array of cases. Loading never throws on a bad case; it collects every
// problem with the id of the case it belongs to, so the runner can refuse the
// whole set before any trial runs.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ALLOWED_PAIRS, type Reason } from '../../app/src/core/types';

// The strata of PRD Appendix B.
export const STRATA = [
  'baseline',
  'date_time',
  'staleness',
  'program',
  'medical_policy',
  'not_in_source',
  'sensitive',
  'urgent',
  'privacy',
  'correlation_breaker',
  'multi_intent',
  'adversarial',
  'non_english',
  'gap_filing',
] as const;

// Every case is drafted by an agent and reviewed by the author; none is held out.
export const SPLIT = 'agent-drafted-author-reviewed';

const OUTCOMES = ['answer', 'handoff', 'urgent'] as const;
const REASONS = Object.keys(ALLOWED_PAIRS) as [Reason, ...Reason[]];

// An ISO 8601 timestamp that names its offset, so a case means one instant
// wherever the eval runs.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const caseSchema = z.strictObject({
  id: z.string().min(1),
  stratum: z.enum(STRATA),
  split: z.literal(SPLIT),
  now: z
    .string()
    .refine((s) => ISO_WITH_OFFSET.test(s) && !Number.isNaN(Date.parse(s)), 'must be an ISO timestamp with an explicit offset'),
  message: z.string().min(1),
  priorTurns: z.array(z.strictObject({ role: z.enum(['parent', 'front_desk']), text: z.string().min(1) })).optional(),
  expectedOutcome: z.enum(OUTCOMES),
  acceptableOutcomes: z.array(z.enum(OUTCOMES)).optional(),
  expectedReason: z.enum(REASONS).optional(),
  expectedCitations: z.array(z.string().min(1)),
  requiredFacts: z.array(z.string().min(1)),
  forbiddenStrings: z.array(z.string().min(1)),
  expectedGapLabel: z.string().min(1).optional(),
  rationale: z.string().trim().min(1),
});

export type Case = z.infer<typeof caseSchema>;

export type Problem = { caseId: string | null; file: string; message: string };

// The rules that span fields: the reason belongs to the outcome, and only a
// gap_filing case names a gap.
function ruleProblem(c: Case): string | null {
  if (c.expectedReason !== undefined && ALLOWED_PAIRS[c.expectedReason] !== c.expectedOutcome) {
    return `expectedReason ${c.expectedReason} does not go with expectedOutcome ${c.expectedOutcome}`;
  }
  if (c.stratum === 'gap_filing' && c.expectedGapLabel === undefined) return 'a gap_filing case needs expectedGapLabel';
  if (c.stratum !== 'gap_filing' && c.expectedGapLabel !== undefined) return 'only a gap_filing case may set expectedGapLabel';
  return null;
}

function rawId(item: unknown): string | null {
  if (item === null || typeof item !== 'object') return null;
  const id = (item as Record<string, unknown>).id;
  return typeof id === 'string' && id !== '' ? id : null;
}

export function loadCases(dir: string): { cases: Case[]; problems: Problem[] } {
  const cases: Case[] = [];
  const problems: Problem[] = [];
  const fileOf = new Map<string, string>();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  for (const file of files) {
    let items: unknown;
    try {
      items = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      problems.push({ caseId: null, file, message: `does not parse as JSON: ${(err as Error).message}` });
      continue;
    }
    if (!Array.isArray(items)) {
      problems.push({ caseId: null, file, message: 'is not a JSON array of cases' });
      continue;
    }

    for (const item of items) {
      const caseId = rawId(item);
      const parsed = caseSchema.safeParse(item);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          problems.push({ caseId, file, message: `${issue.path.join('.') || 'case'}: ${issue.message}` });
        }
        continue;
      }
      const rule = ruleProblem(parsed.data);
      if (rule !== null) {
        problems.push({ caseId, file, message: rule });
        continue;
      }
      const earlier = fileOf.get(parsed.data.id);
      if (earlier !== undefined) {
        problems.push({ caseId, file, message: `duplicate id, first used in ${earlier}` });
        continue;
      }
      fileOf.set(parsed.data.id, file);
      cases.push(parsed.data);
    }
  }
  return { cases, problems };
}
