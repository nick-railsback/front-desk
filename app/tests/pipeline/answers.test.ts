// Answers: grounding, degraded answers, citations, gap filing, and language.
//
// grounding: an answer keeps its generated text only if every money amount,
// time of day, calendar date, temperature, and number with a unit (minutes,
// hours, days, weeks, percent) in it appears in the text of a cited section
// after normalization. Equivalent forms are equal ("5:30 PM", "5:30 p.m.",
// "17:30"; "$15", "$15.00"; "100.4°F", "100.4 degrees"). A value found in no
// cited section, including one found only in a section the answer does not
// cite, fails the check.
//
// degraded answers: an answer that fails grounding becomes outcome answer,
// reason grounding_failed, with text that begins "Here's what our handbook
// says:" followed by the verbatim text of each cited section, and none of the
// generated text.
//
// citations: a citation that names no section of the snapshot used (an
// unknown ID, a section of an older snapshot, a draft-only section) or a staff
// section is removed. An answer left with no valid citation becomes a handoff
// with reason not_in_source.
//
// gap filing: every reply with reason grounding_failed or not_in_source is
// filed into exactly one gap: the open gap the model output names, or a new
// open gap with the model's proposed label. A reply with any other reason is
// never filed. No gap label is longer than 8 words.
//
// language: when the model output reports a language other than English and
// neither the floor nor the proposed outcome is urgent, the reply is a
// handoff with reason unsupported_language, whose fixed text is in English and
// Spanish and contains the center's phone number. When either is urgent, the
// reply is urgent with the matching reason: urgent wins over language.
//
// Assumed interface: see ./support.ts.

import { afterAll, describe, expect, test } from 'vitest';
import {
  type AskFn,
  type DbModule,
  GENERATED,
  type Reason,
  urgentOut,
  RUN_YEAR,
  type Section,
  addDays,
  answerOut,
  askWith,
  clone,
  closeLoadedDb,
  contains,
  dateTextIn,
  denver,
  expectReplies,
  handoffOut,
  hasPhone,
  linesWith,
  loadPipeline,
  mentionsDate,
  normalize,
  onOrAfter,
  output,
  replyText,
  returns,
  sectionText,
  ymd,
} from './support';

const TIMEOUT = 60_000;

afterAll(async () => {
  await closeLoadedDb();
});

// A Wednesday in mid-October; Picture Day is the next day.
const DAY = onOrAfter(ymd(RUN_YEAR, 10, 14), 3);
const NOW = denver(DAY, '10:00');
const PICTURE_DAY = addDays(DAY, 1);

let at = 0;
// Each message a minute apart, so no test comes near the per-minute limit.
function nextNow(): Date {
  at += 1;
  return new Date(NOW.getTime() + at * 61_000);
}

async function fresh(): Promise<{ ask: AskFn; db: DbModule; id: string }> {
  const { ask, db } = await loadPipeline();
  const id = await db.createSandbox(NOW);
  return { ask, db, id };
}

async function answerWith(out: unknown, message = 'Can you tell me about that?') {
  const { ask, db, id } = await fresh();
  const asked = await askWith(ask, id, message, nextNow(), returns(out));
  return { ...asked, db, id, ask };
}

describe('grounding', () => {
  const ACCEPT: [string, string, string[]][] = [
    ['a time in 24-hour form against 5:30 PM', 'Preschool closes at 17:30.', ['hours']],
    ['a time written p.m. against 5:30 PM', 'Preschool closes at 5:30 p.m. each day.', ['hours']],
    ['$15.00 against $15', 'The late fee is $15.00 per occurrence.', ['late-pickup']],
    ['100.4 degrees against 100.4°F', 'Keep your child home after a fever of 100.4 degrees or higher.', ['illness']],
    ['minutes as the section writes them', 'Your child must be picked up within 60 minutes of our call.', ['illness']],
    ['values spread over two cited sections', 'Breakfast is served until 8:30 AM, and the late fee is $15.', ['meals', 'late-pickup']],
  ];

  for (const [label, text, cites] of ACCEPT) {
    test(
      `grounding: passes for ${label}`,
      async () => {
        const { result } = await answerWith(answerOut(text, cites));
        expect({ outcome: result.reply.outcome, reason: result.reply.reason }).toEqual({ outcome: 'answer', reason: 'answered' });
        expect(contains(result.reply.text, text), 'the generated text was not kept').toBe(true);
      },
      TIMEOUT,
    );
  }

  test(
    'grounding: passes for a calendar date written as the calendar section writes it',
    async () => {
      const probe = await answerWith(answerOut('Breakfast is served until 8:30 AM.', ['meals']));
      const line = linesWith(sectionText(probe.result, 'calendar'), 'Picture Day').find((l) => mentionsDate(l, PICTURE_DAY));
      expect(line, 'no calendar line names Picture Day with its date').toBeDefined();
      const dateText = dateTextIn(line!, PICTURE_DAY)!;
      const text = `Picture Day is on ${dateText} at 9:00 AM.`;
      const { result } = await answerWith(answerOut(text, ['calendar']));
      expect({ outcome: result.reply.outcome, reason: result.reply.reason }).toEqual({ outcome: 'answer', reason: 'answered' });
      expect(contains(result.reply.text, text)).toBe(true);
    },
    TIMEOUT,
  );

  const REJECT: [string, string, string[]][] = [
    ['a time in no cited section', `Our ${GENERATED} says breakfast is served until 9:15 AM.`, ['meals']],
    ['a money amount only in a section the answer does not cite', `Our ${GENERATED} says a backup lunch costs $5.`, ['late-pickup']],
    ['$150 against $15', `Our ${GENERATED} says the late fee is $150.`, ['late-pickup']],
    ['a temperature in no cited section', `Our ${GENERATED} says to stay home after a fever of 101°F.`, ['illness']],
    ['minutes in no cited section', `Our ${GENERATED} says pickup is within 45 minutes of our call.`, ['illness']],
  ];

  for (const [label, text, cites] of REJECT) {
    test(
      `grounding: fails for ${label}`,
      async () => {
        const { result } = await answerWith(answerOut(text, cites));
        expect({ outcome: result.reply.outcome, reason: result.reply.reason }).toEqual({ outcome: 'answer', reason: 'grounding_failed' });
      },
      TIMEOUT,
    );
  }

  test(
    'grounding: fails for a calendar date in no cited section',
    async () => {
      const probe = await answerWith(answerOut('Breakfast is served until 8:30 AM.', ['meals']));
      const calendar = sectionText(probe.result, 'calendar');
      let wrong = addDays(DAY, 3);
      while (mentionsDate(calendar, wrong)) wrong = addDays(wrong, 1);
      const [, m, d] = wrong.split('-').map(Number);
      const month = new Date(Date.UTC(2000, m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
      const { result } = await answerWith(answerOut(`Our ${GENERATED} says Picture Day is on ${month} ${d}.`, ['calendar']));
      expect({ outcome: result.reply.outcome, reason: result.reply.reason }).toEqual({ outcome: 'answer', reason: 'grounding_failed' });
    },
    TIMEOUT,
  );
});

describe('degraded answers', () => {
  const CASES: [string, string, string[]][] = [
    ['a cited policy section and a cited data section', `Our ${GENERATED} says breakfast ends at 9:15 AM and the office opens at 6:15 AM.`, ['meals', 'contacts']],
  ];

  for (const [label, text, cites] of CASES) {
    test(
      `degraded answers: the handbook preface, the verbatim cited text, and no generated text, with ${label}`,
      async () => {
        const { result } = await answerWith(answerOut(text, cites));
        expect({ outcome: result.reply.outcome, reason: result.reply.reason }).toEqual({ outcome: 'answer', reason: 'grounding_failed' });
        const t = normalize(result.reply.text);
        expect(t.startsWith("Here's what our handbook says:"), `the text begins: ${t.slice(0, 60)}`).toBe(true);
        for (const id of cites) expect(t.includes(normalize(sectionText(result, id))), `the verbatim ${id} text is missing`).toBe(true);
        expect(contains(replyText(result.reply), GENERATED), 'generated text leaked into the degraded answer').toBe(false);
        expect(contains(t, text)).toBe(false);
      },
      TIMEOUT,
    );
  }
});

describe('citations', () => {
  // A sandbox whose latest snapshot dropped the sunscreen section and whose
  // draft holds a section that was never published.
  async function republished() {
    const { ask, db, id } = await fresh();
    const held = clone(await db.forSandbox(id).read());
    const latest = held.snapshots[held.snapshots.length - 1];
    const sections: Section[] = clone(latest.sections).filter((s: Section) => s.id !== 'sunscreen');
    held.snapshots.push({ version: latest.version + 1, sections });
    held.draft.sections.push({ id: 'draft-only', title: 'Draft only', visibility: 'parent', updatedOn: DAY, text: 'Breakfast is served until 8:30 AM.' });
    await db.forSandbox(id).write(held);
    return { ask, db, id };
  }

  const MIXED: [string, string][] = [
    ['an unknown section ID', 'no-such-section'],
    ['a staff section', 'lockdown-procedure'],
    ['a section of an older snapshot', 'sunscreen'],
    ['a draft-only section', 'draft-only'],
  ];

  for (const [label, bad] of MIXED) {
    test(
      `citations: ${label} is removed and the valid citation stays`,
      async () => {
        const { ask, id } = await republished();
        const { result } = await askWith(ask, id, 'When is breakfast?', nextNow(), returns(answerOut('Breakfast is served until 8:30 AM.', ['meals', bad])));
        expect(result.reply.citations.map((c) => c.sectionId)).toEqual(['meals']);
        expect(result.reply.reason).toBe('answered');
      },
      TIMEOUT,
    );
  }

  test(
    'citations: an answer citing only a staff section becomes a not_in_source handoff',
    async () => {
      const { ask, id } = await republished();
      const { result } = await askWith(ask, id, 'When is breakfast?', nextNow(), returns(answerOut('Breakfast is served until 8:30 AM.', ['lockdown-procedure'])));
      expect({ outcome: result.reply.outcome, reason: result.reply.reason }).toEqual({ outcome: 'handoff', reason: 'not_in_source' });
      expect(result.reply.citations.map((c) => c.sectionId)).not.toContain('lockdown-procedure');
    },
    TIMEOUT,
  );

  test(
    'citations: a data section is a valid citation',
    async () => {
      const { result } = await answerWith(answerOut('The office opens at 7:00 AM.', ['contacts', 'no-such-section']));
      expect(result.reply.citations.map((c) => c.sectionId)).toEqual(['contacts']);
      expect(result.reply.reason).toBe('answered');
    },
    TIMEOUT,
  );
});

describe('gap filing', () => {
  async function gapsAfter(out: unknown, message: string, script?: Parameters<typeof askWith>[4]) {
    const { ask, db, id } = await fresh();
    const access = db.forSandbox(id);
    expectReplies(access);
    const before = (await access.read()).gaps as { id: string; label: string; status: string; questionIds: string[] }[];
    const { result } = await askWith(ask, id, message, nextNow(), script ?? returns(out));
    const stored = (await access.replies()).filter((r) => r.message === message);
    expect(stored.length, 'the reply was not stored').toBe(1);
    const after = (await access.read()).gaps as { id: string; label: string; status: string; questionIds: string[] }[];
    const holding = after.filter((g) => g.questionIds.includes(stored[0].id));
    return { result, before, after, holding };
  }

  const JOIN: [string, unknown, string, Reason][] = [
    [
      'a degraded answer naming an open gap',
      answerOut(`Our ${GENERATED} says part-time care is 3 days a week.`, ['tuition-and-payments'], { gapLabel: 'Part-time schedules' }),
      'Part-time schedules',
      'grounding_failed',
    ],
    ['a not_in_source handoff naming an open gap', handoffOut('not_in_source', { gapLabel: 'Sibling discount' }), 'Sibling discount', 'not_in_source'],
    // Feature-close F21: the plural opened a second gap beside the singular.
    ['a not_in_source handoff naming an open gap in the plural', handoffOut('not_in_source', { gapLabel: 'Sibling discounts' }), 'Sibling discount', 'not_in_source'],
    [
      'an answer left with no valid citation naming an open gap',
      answerOut('Summer care is available.', ['no-such-section'], { gapLabel: 'Summer program' }),
      'Summer program',
      'not_in_source',
    ],
  ];

  for (const [label, out, gapLabel, reason] of JOIN) {
    test(
      `gap filing: ${label} joins that gap and no other`,
      async () => {
        const { result, before, after, holding } = await gapsAfter(out, `Question for the ${gapLabel} gap?`);
        expect(result.reply.reason).toBe(reason);
        expect(holding.map((g) => g.label)).toEqual([gapLabel]);
        expect(holding[0].status).toBe('open');
        expect(after.length, 'a new gap was opened').toBe(before.length);
      },
      TIMEOUT,
    );
  }

  test(
    'gap filing: a label naming no open gap opens a new open gap holding the reply',
    async () => {
      const { result, before, after, holding } = await gapsAfter(handoffOut('not_in_source', { gapLabel: 'Weekend care' }), 'Are you open on Saturdays?');
      expect(result.reply.reason).toBe('not_in_source');
      expect(after.length).toBe(before.length + 1);
      expect(holding.map((g) => ({ label: g.label, status: g.status, size: g.questionIds.length }))).toEqual([{ label: 'Weekend care', status: 'open', size: 1 }]);
    },
    TIMEOUT,
  );

  test(
    'gap filing: a proposed label over 8 words still files the reply into exactly one gap, and no label exceeds 8 words',
    async () => {
      const long = 'Rules about bringing the family dog along to afternoon pickup time';
      const { holding, after } = await gapsAfter(handoffOut('not_in_source', { gapLabel: long }), 'Can I bring our dog to pickup?');
      expect(holding.length).toBe(1);
      expect(after.filter((g) => g.label.trim().split(/\s+/).length > 8).map((g) => g.label)).toEqual([]);
    },
    TIMEOUT,
  );

  const NEVER: [Reason, string, Parameters<typeof askWith>[4]][] = [
    ['answered', 'When is breakfast?', returns(answerOut('Breakfast is served until 8:30 AM.', ['meals'], { gapLabel: 'Sibling discount' }))],
    ['sensitive', 'I was charged twice this week and I want a refund.', returns(answerOut('Breakfast is served until 8:30 AM.', ['meals'], { gapLabel: 'Sibling discount' }))],
    [
      'system_error',
      'Do you have a sibling discount?',
      () => {
        throw new Error('model unavailable');
      },
    ],
  ];

  for (const [reason, message, script] of NEVER) {
    test(
      `gap filing: a reply with reason ${reason} is never filed`,
      async () => {
        const { result, before, after, holding } = await gapsAfter(null, message, script);
        expect(result.reply.reason).toBe(reason);
        expect(holding.map((g) => g.label)).toEqual([]);
        expect(after.length).toBe(before.length);
      },
      TIMEOUT,
    );
  }
});

const SPANISH = /\b(por|para|llame|llamar|recepci[oó]n|solo|preguntas|ingl[eé]s|espa[nñ]ol|podemos|responder|favor|tel[eé]fono|ahora|usted|gracias|puede|nuestro|nuestra|escriba)\b/gi;
const ENGLISH = /\b(the|please|call|we|only|english|can|questions|right|now|front|desk|answer)\b/gi;

function distinct(text: string, re: RegExp): number {
  return new Set([...normalize(text).matchAll(re)].map((m) => m[0].toLowerCase())).size;
}

describe('language', () => {
  const URGENT_WINS: [string, string, unknown, 'emergency' | 'safety'][] = [
    ['the model proposes urgent', 'Mi hijo no respira. ¿Qué hago?', urgentOut('emergency', { language: 'es' }), 'emergency'],
    [
      'the floor catches an urgent category stated in English words',
      'Por favor, my son is not breathing right now, ayúdenme.',
      answerOut('Breakfast is served until 8:30 AM.', ['meals'], { language: 'es' }),
      'emergency',
    ],
  ];

  for (const [label, message, out, reason] of URGENT_WINS) {
    test(
      `language: urgent wins over language when ${label}: "${message}"`,
      async () => {
        const { result } = await answerWith(out, message);
        expect({ outcome: result.reply.outcome, reason: result.reply.reason }).toEqual({ outcome: 'urgent', reason });
      },
      TIMEOUT,
    );
  }

  test(
    'language: a non-English message gets the fixed English and Spanish handoff with the phone number',
    async () => {
      const { result } = await answerWith(answerOut('Breakfast is served until 8:30 AM.', ['meals'], { language: 'es' }), '¿A qué hora sirven el desayuno?');
      expect({ outcome: result.reply.outcome, reason: result.reply.reason }).toEqual({ outcome: 'handoff', reason: 'unsupported_language' });
      const t = replyText(result.reply);
      expect(hasPhone(t), 'no phone number').toBe(true);
      expect(distinct(result.reply.text, SPANISH), `not in Spanish: ${result.reply.text}`).toBeGreaterThanOrEqual(3);
      expect(distinct(result.reply.text, ENGLISH), `not in English: ${result.reply.text}`).toBeGreaterThanOrEqual(3);
      expect(contains(t, 'Breakfast is served until 8:30 AM'), 'generated text leaked').toBe(false);
    },
    TIMEOUT,
  );

  test(
    'language: an English message is not handed off for language',
    async () => {
      const { result } = await answerWith(output({ language: 'en' }), 'What time is breakfast?');
      expect(result.reply.reason).toBe('answered');
    },
    TIMEOUT,
  );

});
