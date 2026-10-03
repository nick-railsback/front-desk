// One parent message in, one reply out (DESIGN 4.2): floors, the model call,
// the post-guard, the outcome ladder, fixed text, and the gap label. Pure:
// the clock and the model are injected, and nothing here reads the database.

import type { CalendarEntry } from '../seed';
import { buildModelRequest } from './assemble';
import { DEGRADED_PREFACE, FIXED_TEXT, LIMIT_NOTICE } from './copy';
import { floorFor } from './floors';
import { chooseGapLabel } from './gaps';
import { isGrounded } from './grounding';
import { expectationLine } from './today';
import {
  ALLOWED_PAIRS,
  type AnswerRecord,
  type Clock,
  type Model,
  type ModelRequest,
  ModelOutput,
  type ModelUsage,
  type Outcome,
  type Reason,
  type Reply,
  type Section,
  type Turn,
} from './types';

const MODEL_DEADLINE_MS = 15_000;
const BACKOFFS_MS = [500, 1000, 2000, 4000];
const NO_USAGE: ModelUsage = { input: 0, cachedInput: 0, output: 0 };
const RANK: Record<Outcome, number> = { answer: 0, handoff: 1, urgent: 2 };

type FixedReason = keyof typeof FIXED_TEXT;
type Called = { ok: true; output: unknown; usage: ModelUsage } | { ok: false; failure: string };

export type AnswerContext = {
  snapshot: { version: number; sections: Section[] };
  calendar: CalendarEntry[];
  openGapLabels: string[];
  model: Model;
  clock: Clock;
};

// Fixed text for a handoff or urgent reason. Every handoff says when the
// front desk will see it; urgent replies do not wait for the front desk.
export function fixedReply(reason: FixedReason, now: Date, calendar: CalendarEntry[], version: number): Reply {
  const outcome = ALLOWED_PAIRS[reason];
  const text = outcome === 'handoff' ? `${FIXED_TEXT[reason]} ${expectationLine(now, calendar)}` : FIXED_TEXT[reason];
  return { text, outcome, reason, snapshotVersion: version, citations: [] };
}

// The reply to a message over a limit.
export function noticeReply(now: Date, calendar: CalendarEntry[], version: number): Reply {
  return { text: `${LIMIT_NOTICE} ${expectationLine(now, calendar)}`, outcome: 'handoff', reason: 'system_error', snapshotVersion: version, citations: [] };
}

// One deadline for the whole call, registered before the first attempt.
// Throttled attempts back off and retry while another attempt still fits.
async function callModel(model: Model, request: ModelRequest, clock: Clock): Promise<Called> {
  const deadline = clock.now() + MODEL_DEADLINE_MS;
  const expired = clock.sleep(MODEL_DEADLINE_MS).then(() => ({ timedOut: true }) as const);
  const controller = new AbortController();
  for (let attempt = 0; ; attempt++) {
    const backoff = BACKOFFS_MS[attempt] ?? Infinity;
    const call = Promise.resolve()
      .then(() => model({ ...request, signal: controller.signal }))
      .then((result) => ({ result }), (error: unknown) => ({ error }));
    const settled = await Promise.race([call, expired]);
    if ('timedOut' in settled) {
      controller.abort();
      return { ok: false, failure: `model call timed out after ${MODEL_DEADLINE_MS} ms` };
    }
    if ('result' in settled) return { ok: true, output: settled.result.output, usage: settled.result.usage };
    const err = settled.error as { name?: string; message?: string };
    if (err?.name !== 'ThrottlingException' || clock.now() + backoff >= deadline) {
      return { ok: false, failure: `model call failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(err)}` };
    }
    await clock.sleep(backoff);
  }
}

// What the post-guard makes of valid model output (DESIGN 4.6, steps 3 to 6).
function judge(o: ModelOutput, sections: Section[]): { reason: Reason; cited: Section[] } {
  if (!/^en\b/i.test(o.language) && o.outcome !== 'urgent') return { reason: 'unsupported_language', cited: [] };
  const parent = sections.filter((s) => s.visibility === 'parent');
  const cited = parent.filter((s) => o.citations.includes(s.id));
  if (o.outcome !== 'answer') return { reason: o.reason, cited: [] };
  if (cited.length === 0) return { reason: 'not_in_source', cited };
  return { reason: isGrounded(o.text, cited) ? 'answered' : 'grounding_failed', cited };
}

export async function answer(input: { message: string; priorTurns: Turn[]; now: Date }, ctx: AnswerContext): Promise<AnswerRecord> {
  const { now } = input;
  const { snapshot, calendar, clock } = ctx;
  const started = clock.now();
  const floor = floorFor(input.message);
  const record = (reply: Reply, rest: Partial<AnswerRecord>): AnswerRecord => ({
    reply,
    proposedOutcome: null,
    floor: floor.floor,
    floorsFired: floor.fired,
    modelCalled: false,
    outputValid: true,
    language: null,
    topic: null,
    usage: NO_USAGE,
    gapLabel: null,
    failure: null,
    ...rest,
    latencyMs: clock.now() - started,
  });

  // Nothing ranks above urgent, so an urgent floor needs no model call.
  if (floor.floor === 'urgent') return record(fixedReply(floor.reason as FixedReason, now, calendar, snapshot.version), {});

  const request = buildModelRequest({ ...input, sections: snapshot.sections, openGapLabels: ctx.openGapLabels });
  const called = await callModel(ctx.model, request, clock);
  if (!called.ok) return record(fixedReply('system_error', now, calendar, snapshot.version), { modelCalled: true, failure: called.failure });
  const parsed = ModelOutput.safeParse(called.output);
  if (!parsed.success) {
    return record(fixedReply('system_error', now, calendar, snapshot.version), {
      modelCalled: true,
      outputValid: false,
      usage: called.usage,
      failure: `model output failed validation: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    });
  }
  const o = parsed.data;
  const judged = judge(o, snapshot.sections);
  // The outcome ladder: the higher of the floor and the post-guard's result.
  // The reason belongs to the final outcome, so a raising floor brings its own.
  const raised = RANK[floor.floor] > RANK[ALLOWED_PAIRS[judged.reason]];
  const reason = raised ? (floor.reason as Reason) : judged.reason;
  const citations = judged.cited.map((s) => ({ sectionId: s.id }));
  let reply: Reply;
  if (reason === 'answered') reply = { text: o.text, outcome: 'answer', reason, snapshotVersion: snapshot.version, citations };
  else if (reason === 'grounding_failed') {
    const text = [DEGRADED_PREFACE, ...judged.cited.map((s) => s.text)].join('\n\n');
    reply = { text, outcome: 'answer', reason, snapshotVersion: snapshot.version, citations };
  } else reply = fixedReply(reason, now, calendar, snapshot.version);
  const filed = reason === 'not_in_source' || reason === 'grounding_failed';
  return record(reply, {
    proposedOutcome: o.outcome,
    modelCalled: true,
    language: o.language,
    topic: o.topic,
    usage: called.usage,
    gapLabel: filed ? chooseGapLabel(o.gapLabel, o.topic, ctx.openGapLabels) : null,
  });
}
