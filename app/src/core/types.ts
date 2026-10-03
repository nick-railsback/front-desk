// The PRD's shared nouns as plain types. Pure: no clock, no I/O.

import { z } from 'zod';

export type Visibility = 'parent' | 'staff';

// One titled, independently citable part of the center's information.
export type Section = {
  id: string;
  title: string;
  visibility: Visibility;
  updatedOn: string; // YYYY-MM-DD in America/Denver
  text: string;
};

export type Citation = { sectionId: string };

export type Outcome = 'answer' | 'handoff' | 'urgent';

export type Reason =
  | 'answered'
  | 'grounding_failed'
  | 'not_in_source'
  | 'sensitive'
  | 'unsupported_language'
  | 'system_error'
  | 'emergency'
  | 'safety';

export type Reply = {
  text: string;
  outcome: Outcome;
  reason: Reason;
  snapshotVersion: number;
  citations: Citation[];
};

// A section a reply cites, as the parent view shows it: a policy section from
// the snapshot, or a data section rendered from structured data.
export type CitedSection = {
  id: string;
  title: string;
  kind: 'policy' | 'data';
  updatedOn: string;
  text: string;
};

// The eight allowed outcome and reason pairs: each reason belongs to exactly one outcome.
export const ALLOWED_PAIRS = {
  answered: 'answer',
  grounding_failed: 'answer',
  not_in_source: 'handoff',
  sensitive: 'handoff',
  unsupported_language: 'handoff',
  system_error: 'handoff',
  emergency: 'urgent',
  safety: 'urgent',
} as const satisfies Record<Reason, Outcome>;

// One earlier message in the conversation.
export type Turn = { role: 'parent' | 'front_desk'; text: string };

// Injected time. `sleep` is how every wait (the model deadline, a backoff)
// passes, so tests can run them on a virtual clock.
export type Clock = { now(): number; sleep(ms: number): Promise<void> };

// Everything the pipeline sends the model for one message.
export type ModelRequest = {
  instructions: string;
  maxOutputTokens: number;
  currentDate: string;
  snapshotText: string;
  openGapLabels: string[];
  history: Turn[];
  message: string;
  signal?: AbortSignal;
};

export type ModelUsage = { input: number; cachedInput: number; output: number };

export type Model = (request: ModelRequest) => Promise<{ output: unknown; usage: ModelUsage }>;

// What the model must return. A reason must belong to its outcome.
export const ModelOutput = z
  .object({
    outcome: z.enum(['answer', 'handoff', 'urgent']),
    reason: z.enum(Object.keys(ALLOWED_PAIRS) as [Reason, ...Reason[]]),
    text: z.string(),
    citations: z.array(z.string()),
    language: z.string(),
    topic: z.string(),
    gapLabel: z.string().nullable(),
  })
  .refine((o) => ALLOWED_PAIRS[o.reason] === o.outcome, { message: 'reason does not belong to outcome' });

export type ModelOutput = z.infer<typeof ModelOutput>;

// One answered message and how it was made: the eval runner's trial record.
export type AnswerRecord = {
  reply: Reply;
  proposedOutcome: Outcome | null;
  floor: Outcome;
  floorsFired: string[];
  modelCalled: boolean;
  outputValid: boolean;
  language: string | null;
  topic: string | null;
  latencyMs: number;
  usage: ModelUsage;
  gapLabel: string | null;
  // Why the model's output was not used, for the log; null when it was.
  failure: string | null;
};
