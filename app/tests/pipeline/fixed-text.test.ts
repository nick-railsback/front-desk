// Fixed text for handoff and urgent replies, and the expectation line.
//
// fixed text: every handoff and urgent reply's text is fixed text chosen by
// its reason, the same for any message, and the limit notice has its own
// fixed text, distinct from the model-failure text. Each contains the center's
// phone number and none of the generated text. Only an urgent reply with reason emergency contains
// 911, and no handoff text contains an email address.
//
// expectation line: every handoff reply carries one expectation line computed
// from the injected clock in America/Denver. During office hours (Monday to
// Friday, 7:00 AM to 5:30 PM, on a day the center is open) it reads "The front
// desk will see this today."; otherwise "The office is closed now. Staff will
// see this after <opening time> on <next open day>.", with the office opening
// time and the next open day's date. The host runs in Pacific/Kiritimati, so
// a reading of host local time lands on the wrong day.
//
// Assumed interface: see ./support.ts.

import { afterAll, describe, expect, test } from 'vitest';
import {
  type AskFn,
  EMAIL_PATTERN,
  GENERATED,
  OPEN_LINE,
  type Outcome,
  RUN_YEAR,
  type Reason,
  type Script,
  addDays,
  answerOut,
  askWith,
  closeLoadedDb,
  closedDates,
  denver,
  denverDate,
  expectHostZone,
  expectationLines,
  handoffOut,
  hasPhone,
  isOpeningTime,
  loadPipeline,
  loadSeed,
  mentionsDate,
  nextOpenDay,
  normalize,
  nthWeekday,
  onOrAfter,
  replyText,
  returns,
  ymd,
} from './support';

afterAll(async () => {
  await closeLoadedDb();
});

const WEDNESDAY = onOrAfter(ymd(RUN_YEAR, 10, 14), 3);
const NOW = denver(WEDNESDAY, '10:00');

const BENIGN = 'Do you have a sibling discount?';
const SENSITIVE = 'I was charged twice for tuition this week and I want a refund.';
const EMERGENCY = 'My son fell and is bleeding badly right now.';
const SAFETY = 'My daughter is missing. Nobody at pickup can find her.';
const GROUNDED_WITH_MARKER = answerOut(`Our ${GENERATED} says breakfast is served until 8:30 AM.`, ['meals']);

const throws: Script = () => {
  throw new Error('model unavailable');
};
const LONG = (lead: string) => `${lead} ${'Please tell me everything about it. '.repeat(15)}`;

// One route to each handoff and urgent reason, plus the limit notice. Each
// runs with two different messages at the same moment: fixed text depends
// on the reason, never on the message.
const ROUTES: [string, Reason, [string, string], Script][] = [
  ['not_in_source', 'not_in_source', [BENIGN, 'Do you run a summer camp?'], returns(handoffOut('not_in_source'))],
  ['sensitive', 'sensitive', [SENSITIVE, "Can I have Ms. Rosa's personal cell phone number?"], returns(GROUNDED_WITH_MARKER)],
  [
    'unsupported_language',
    'unsupported_language',
    ['¿Tienen descuento para hermanos?', '¿Tienen campamento de verano?'],
    returns(answerOut(`A ${GENERATED} discount exists.`, ['meals'], { language: 'es' })),
  ],
  ['system_error', 'system_error', [BENIGN, 'Do you run a summer camp?'], throws],
  ['emergency', 'emergency', [EMERGENCY, 'My daughter is having a seizure right now.'], returns(GROUNDED_WITH_MARKER)],
  ['safety', 'safety', [SAFETY, 'Someone just threatened to bring a gun to the center.'], returns(GROUNDED_WITH_MARKER)],
  ['the limit notice', 'system_error', [LONG(BENIGN), LONG('Do you run a summer camp?')], returns(handoffOut('not_in_source'))],
];

const OUTCOME_OF: Record<Reason, Outcome> = {
  answered: 'answer',
  grounding_failed: 'answer',
  not_in_source: 'handoff',
  sensitive: 'handoff',
  unsupported_language: 'handoff',
  system_error: 'handoff',
  emergency: 'urgent',
  safety: 'urgent',
};

async function replyVia(ask: AskFn, db: any, message: string, script: Script, now = NOW, createdAt = now) {
  const id = await db.createSandbox(createdAt);
  const { result } = await askWith(ask, id, message, now, script);
  return result;
}

describe('fixed text', () => {
  test(
    'fixed text: each handoff and urgent reason, and the limit notice, has one fixed text with the phone number, no generated text, 911 only for emergency, and no email address in a handoff',
    async () => {
      const { ask, db } = await loadPipeline();
      const textOf = new Map<string, string>();
      const problems: string[] = [];
      for (const [key, reason, messages, script] of ROUTES) {
        const texts = new Set<string>();
        for (const message of messages) {
          const result = await replyVia(ask, db, message, script);
          if (result.reply.reason !== reason || result.reply.outcome !== OUTCOME_OF[reason]) {
            problems.push(`${key}: got ${result.reply.outcome}/${result.reply.reason}`);
            continue;
          }
          const all = replyText(result.reply);
          if (!hasPhone(all)) problems.push(`${key}: no phone number`);
          if (all.toLowerCase().includes(GENERATED)) problems.push(`${key}: generated text in the reply`);
          if (/(?<!\d)911(?!\d)/.test(all) !== (reason === 'emergency')) problems.push(`${key}: 911 ${reason === 'emergency' ? 'missing' : 'present'}`);
          if (OUTCOME_OF[reason] === 'handoff' && (EMAIL_PATTERN.test(all) || all.includes('@'))) problems.push(`${key}: an email address`);
          texts.add(normalize(result.reply.text));
        }
        if (texts.size > 1) problems.push(`${key}: the text changes with the message, so it is not fixed`);
        if (texts.size > 0) textOf.set(key, [...texts][0]);
      }
      // Every reason has its own text, and the limit notice is distinct from
      // the model-failure text that shares its reason.
      if (new Set(textOf.values()).size !== textOf.size) problems.push('two routes share one text, so the text is not chosen by reason');
      expect(problems).toEqual([]);
      expect(textOf.size, 'not every route was reached').toBe(ROUTES.length);
    },
    300_000,
  );
});

type Moment = { label: string; now: Date; createdAt?: Date; open?: boolean; next?: string; notNext?: string[] };

// Next open day after a date, from the sandbox's own calendar.
async function nextOpen(createdAt: Date, date: string): Promise<string> {
  const { seed } = await loadSeed();
  return nextOpenDay(date, closedDates(seed(createdAt).structured));
}

async function moments(): Promise<Moment[]> {
  const thanksgiving = nthWeekday(RUN_YEAR, 11, 4, 4);
  const staffCreated = denver(WEDNESDAY, '10:00');
  const { seed } = await loadSeed();
  const staffDay = seed(staffCreated).structured.calendar.find((e: { id: string }) => e.id === 'staff-development-day').date as string;
  const list: Moment[] = [
    { label: 'Wednesday 10:00 AM, office hours', now: denver(WEDNESDAY, '10:00'), open: true },
    { label: 'Wednesday 5:45 PM, after the office closes', now: denver(WEDNESDAY, '17:45'), next: addDays(WEDNESDAY, 1) },
    { label: 'Saturday noon', now: denver(addDays(WEDNESDAY, 3), '12:00'), next: addDays(WEDNESDAY, 5) },
    { label: 'Thanksgiving Day 10:00 AM, a closed holiday', now: denver(thanksgiving, '10:00'), next: addDays(thanksgiving, 4) },
    { label: 'the staff development day at 10:00 AM', now: denver(staffDay, '10:00'), createdAt: staffCreated },
    {
      label: 'Wednesday 10:30 PM in Denver, already Thursday evening on the host',
      now: denver(WEDNESDAY, '22:30'),
      next: addDays(WEDNESDAY, 1),
      notNext: [addDays(WEDNESDAY, 2)],
    },
  ];
  for (const m of list) {
    if (m.open || m.next) continue;
    const date = denverDate(m.now);
    m.next = await nextOpen(m.createdAt ?? m.now, date);
  }
  return list;
}

describe('expectation line', () => {
  test(
    'expectation line: one line per handoff, open during office hours, and otherwise the opening time on the next open day',
    async () => {
      expectHostZone();
      const { ask, db } = await loadPipeline();
      const problems: string[] = [];
      for (const m of await moments()) {
        // Created at the message time (or earlier for the staff day), so the
        // sandbox calendar holds the day in question.
        const result = await replyVia(ask, db, BENIGN, returns(handoffOut('not_in_source')), m.now, m.createdAt ?? m.now);
        const lines = expectationLines(replyText(result.reply));
        const count = lines.open + lines.closed.length;
        if (result.reply.outcome !== 'handoff') problems.push(`${m.label}: not a handoff`);
        if (count !== 1) problems.push(`${m.label}: ${count} expectation lines`);
        if (m.open) {
          if (lines.open !== 1) problems.push(`${m.label}: expected "${OPEN_LINE}"`);
          continue;
        }
        const closed = lines.closed[0];
        if (!closed) {
          problems.push(`${m.label}: no closed-office line`);
          continue;
        }
        if (!isOpeningTime(closed.time)) problems.push(`${m.label}: opening time "${closed.time}"`);
        if (!mentionsDate(closed.day, m.next!)) problems.push(`${m.label}: next open day "${closed.day}", expected ${m.next}`);
        for (const wrong of m.notNext ?? []) if (mentionsDate(closed.day, wrong)) problems.push(`${m.label}: names ${wrong}`);
      }
      expect(problems).toEqual([]);
    },
    300_000,
  );
});
