// One parent message in a sandbox: limits, the sandbox's latest snapshot, the
// pure pipeline, then the stored reply and its gap. The database half of
// DESIGN 4.1; `answer()` is the pure half.

import { renderDataSections } from '../core/assemble';
import { answer, noticeReply } from '../core/answer';
import { floorFor } from '../core/floors';
import { denverMinutes } from '../core/today';
import type { AnswerRecord, CitedSection, Clock, Model, Reply, Section, Turn } from '../core/types';
import { forSandbox, reserveModelCall } from '../db/sandbox';
import { denverDate } from '../seed/dates';

const MAX_MESSAGE_CHARS = 500;
const MESSAGES_PER_MINUTE = 20;
const MESSAGES_PER_DAY = 200;
const DEFAULT_GLOBAL_DAILY_MODEL_CALLS = 3000;

// The record, the snapshot the reply was made from, the stored turn's ID (null
// for a notice, which is never stored), and the sections the reply cites.
export type AskResult = AnswerRecord & {
  snapshot: { version: number; sections: Section[] };
  replyId: string | null;
  cited: CitedSection[];
};

function citedSections(reply: Reply, policy: Section[], data: Section[]): CitedSection[] {
  return reply.citations.flatMap(({ sectionId }) => {
    const p = policy.find((s) => s.id === sectionId);
    const s = p ?? data.find((d) => d.id === sectionId);
    return s ? [{ id: s.id, title: s.title, kind: p ? 'policy' : 'data', updatedOn: s.updatedOn, text: s.text } as const] : [];
  });
}

export async function ask(
  input: { sandboxId: string; message: string; priorTurns: Turn[]; now: Date },
  deps: { model: Model; clock: Clock },
): Promise<AskResult> {
  const { sandboxId, message, now } = input;
  const access = forSandbox(sandboxId);
  const context = await access.context();
  const { calendar } = context.structured;
  const data = renderDataSections(context.structured, now);
  const snapshot = { version: context.snapshot.version, sections: [...context.snapshot.sections, ...data] };
  const floor = floorFor(message);
  const notice = (): AskResult => ({
    reply: noticeReply(now, calendar, snapshot.version),
    proposedOutcome: null,
    floor: floor.floor,
    floorsFired: floor.fired,
    modelCalled: false,
    outputValid: true,
    language: null,
    topic: null,
    latencyMs: 0,
    usage: { input: 0, cachedInput: 0, output: 0 },
    gapLabel: null,
    failure: null,
    snapshot,
    replyId: null,
    cited: [],
  });

  if (message.length > MAX_MESSAGE_CHARS) return notice();
  const today = denverDate(now);
  const counts = await access.countMessage(`m:${today}:${denverMinutes(now)}`, `d:${today}`);
  if (counts.minute > MESSAGES_PER_MINUTE || counts.day > MESSAGES_PER_DAY) return notice();
  // Urgent floors never reach the model, so they never use up a model call.
  if (floor.floor !== 'urgent') {
    const cap = Number(process.env.GLOBAL_DAILY_MODEL_CALLS ?? DEFAULT_GLOBAL_DAILY_MODEL_CALLS);
    if (!(await reserveModelCall(today, cap))) return notice();
  }

  const record = await answer(input, { snapshot, calendar, openGapLabels: context.openGapLabels, model: deps.model, clock: deps.clock });
  if (record.failure) console.error(`ask: ${record.failure}`);
  const turnId = await access.storeReply(message, now, record);
  if (record.gapLabel) await access.fileIntoGap(turnId, record.gapLabel);
  return { ...record, snapshot, replyId: turnId, cited: citedSections(record.reply, context.snapshot.sections, data) };
}
