// The PRD's shared nouns as plain types. Pure: no clock, no I/O.

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
