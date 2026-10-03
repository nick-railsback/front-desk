// What the model sees for one parent message, and the snapshot the reply is
// produced from.
//
// data sections: the snapshot a parent message is answered from holds exactly
// six data sections (hours, calendar, menu, alerts, tuition, contacts), each
// parent-visible and rendered from the sandbox's structured data at the
// current time, and every data section's text is part of the model input.
// Rendered from seed(now) at now, they state the center's facts: tuition and
// the registration fee, each program's hours, the contacts and office hours,
// every center holiday within 60 days with its date and open or closed status
// and, for a closed day, the next open day; the staff development day;
// Picture Day with its date and time; each weekday menu from today on with its
// date; and each active alert.
//
// expired content: no alert past its expiry, no calendar entry dated before
// today, and no menu for a past date reaches the model input, a reply's text,
// or a reply's citations. Checked when the sandbox is created and again at
// least 2 days later, when content that was current at creation has expired;
// the facts above are checked at both times against what is still current.
//
// staff-only content: no text from a staff section is part of the model
// input, whether the section was seeded, published later, or a parent section
// later republished as staff. A citation of a staff section is removed, and
// staff text never reaches a degraded answer's verbatim text.
//
// snapshot binding: a message is answered from the latest snapshot published
// when it arrives, and the reply records that version. Unpublished draft
// edits change neither the model input nor the reply.
//
// time: the model input states the current date and weekday in
// America/Denver from the injected clock, never from the host's local time.
//
// follow-up context: the model input carries the last 2 exchanges of prior
// turns and no older ones.
//
// instructions: the model instructions contain no URL, no staff code, no AWS
// account ID or ARN, and no credential.
//
// Assumed interface: see ./support.ts.

import { afterAll, describe, expect, test } from 'vitest';
import {
  type AskResult,
  DATA_SECTION_IDS,
  GENERATED,
  PHONE,
  RUN_YEAR,
  STAFF_CODE,
  type Section,
  WEEKDAYS,
  MONTHS,
  addDays,
  allInput,
  answerOut,
  askWith,
  clone,
  closeLoadedDb,
  closedDates,
  contains,
  denver,
  denverDate,
  expectHostZone,
  hasPhone,
  inputText,
  linesWith,
  literal,
  loadPipeline,
  loadSeed,
  mentionsDate,
  nextOpenDay,
  normalize,
  nthWeekday,
  onOrAfter,
  replyText,
  returns,
  sectionText,
  timeOfDay,
  ymd,
} from './support';

const TIMEOUT = 60_000;

afterAll(async () => {
  await closeLoadedDb();
});

// A Wednesday between November 2 and 8: the next 60 days reach Veterans Day,
// Thanksgiving and the day after, the winter closure, and New Year's Day.
const CREATED_ON = onOrAfter(ymd(RUN_YEAR, 11, 2), 3);
const CREATED = denver(CREATED_ON, '09:00');
// While the parking alert is active (6:00 AM to 6:00 PM on the creation day).
const AT_CREATION = denver(CREATED_ON, '09:30');
// Two days later: the parking alert, the first two menus, and Picture Day
// (the next weekday after creation) have expired.
const LATER = denver(addDays(CREATED_ON, 2), '10:00');

const MOMENTS: [string, Date][] = [
  ['at the sandbox creation time', AT_CREATION],
  ['2 days after the sandbox creation time', LATER],
];

const GROUNDED = answerOut('Breakfast is served until 8:30 AM.', ['meals']);

async function askOnce(now: Date, message = 'What is going on at the center this week?', out: unknown = GROUNDED) {
  const { ask, db } = await loadPipeline();
  const id = await db.createSandbox(CREATED);
  const asked = await askWith(ask, id, message, now, returns(out));
  return { ...asked, id, db, ask };
}

function dataSections(result: AskResult, policyIds: Set<string>): Section[] {
  return (result.snapshot?.sections ?? []).filter((s) => !policyIds.has(s.id));
}

// ---------------------------------------------------------------------------
// Fact checks on rendered data sections. Each returns the facts it could not
// find, so a failure lists all of them.

function tuitionProblems(text: string): string[] {
  const t = normalize(text);
  const missing: string[] = [];
  for (const amount of ['$75', '$385', '$295', '$95']) if (!literal(amount).test(t)) missing.push(amount);
  for (const phrase of ['per child per year', 'no tuition', 'core day', 'extended care']) if (!contains(t, phrase)) missing.push(phrase);
  return missing;
}

function hoursProblems(text: string): string[] {
  const t = normalize(text);
  const missing: string[] = [];
  if (!contains(t, 'Monday to Friday')) missing.push('Monday to Friday');
  for (const time of ['7:30 AM', '5:30 PM', '7:00 AM', '8:00 AM', '2:30 PM']) if (!timeOfDay(time).test(t)) missing.push(time);
  for (const phrase of ['Infants', 'Toddlers', 'Preschool', 'Pre-K', 'core day', 'extended care']) if (!contains(t, phrase)) missing.push(phrase);
  return missing;
}

function contactsProblems(text: string): string[] {
  const t = normalize(text);
  const missing: string[] = [];
  if (!hasPhone(t)) missing.push(PHONE);
  if (!contains(t, 'frontdesk@juniperhill.example')) missing.push('frontdesk@juniperhill.example');
  if (!contains(t, 'Monday to Friday')) missing.push('office days');
  if (!timeOfDay('7:00 AM').test(t) || !timeOfDay('5:30 PM').test(t)) missing.push('office hours 7:00 AM to 5:30 PM');
  return missing;
}

type Entry = { id: string; date: string; name: string; status: 'open' | 'closed'; time: string | null };

function calendarProblems(text: string, structured: any, now: Date): string[] {
  const today = denverDate(now);
  const closed = closedDates(structured);
  const problems: string[] = [];
  const entries: Entry[] = structured.calendar;
  const lineFor = (needle: string, date: string) => linesWith(text, needle).filter((l) => mentionsDate(l, date));

  const holidays = entries.filter((e) => e.id.startsWith('holiday-') && e.date >= today && e.date <= addDays(today, 58));
  if (holidays.length === 0) problems.push(`no holiday falls within 58 days of ${today}; the fixture is wrong`);
  for (const h of holidays) {
    if (h.name === 'Winter closure') {
      // The closure may be written as one range, so only its first day is
      // checked by date.
      if (!h.date.endsWith('-12-24')) continue;
      const lines = linesWith(text, 'winter').filter((l) => mentionsDate(l, h.date));
      const ok = lines.some((l) => /\bclosed\b/i.test(l) && mentionsDate(l, nextOpenDay(h.date, closed)));
      if (!ok) problems.push(`winter closure from ${h.date}: no line names it with its date, closed, and the next open day ${nextOpenDay(h.date, closed)}`);
      continue;
    }
    const lines = lineFor(h.name, h.date);
    if (h.status === 'closed') {
      const next = nextOpenDay(h.date, closed);
      if (!lines.some((l) => /\bclosed\b/i.test(l) && mentionsDate(l, next))) {
        problems.push(`${h.name} ${h.date}: no line names it with its date, closed, and the next open day ${next}`);
      }
    } else if (!lines.some((l) => /\bopen\b/i.test(l) && !/\bclosed\b/i.test(l))) {
      problems.push(`${h.name} ${h.date}: no line names it with its date and open`);
    }
  }

  const staff = entries.find((e) => e.id === 'staff-development-day')!;
  if (staff.date >= today) {
    const next = nextOpenDay(staff.date, closed);
    if (!lineFor('Staff development day', staff.date).some((l) => /\bclosed\b/i.test(l) && mentionsDate(l, next))) {
      problems.push(`staff development day ${staff.date}: no line names it with its date, closed, and the next open day ${next}`);
    }
  }
  const picture = entries.find((e) => e.id === 'picture-day')!;
  if (picture.date >= today && !lineFor('Picture Day', picture.date).some((l) => timeOfDay('9:00 AM').test(l))) {
    problems.push(`Picture Day ${picture.date}: no line names it with its date and 9:00 AM`);
  }
  return problems;
}

function menuProblems(text: string, structured: any, now: Date): string[] {
  const today = denverDate(now);
  const problems: string[] = [];
  const current = structured.menus.filter((m: { date: string }) => m.date >= today);
  if (current.length === 0) problems.push('no current menu; the fixture is wrong');
  for (const menu of current) {
    const items = menu.items.map((i: string) => i.replace(/^[^:]*:\s*/, ''));
    const lines = linesWith(text, items[0]).filter((l) => mentionsDate(l, menu.date));
    if (!lines.some((l) => items.every((i: string) => contains(l, i)))) problems.push(`menu for ${menu.date}: no line holds its date and items`);
  }
  return problems;
}

function alertProblems(text: string, structured: any, now: Date): string[] {
  const active = structured.alerts.filter((a: { startsAt: string; expiresAt: string }) => Date.parse(a.startsAt) <= now.getTime() && now.getTime() < Date.parse(a.expiresAt));
  return active.filter((a: { text: string }) => linesWith(text, a.text).length === 0).map((a: { text: string }) => `active alert missing: ${a.text}`);
}

// ---------------------------------------------------------------------------

describe('data sections', () => {
  for (const [label, now] of MOMENTS) {
    test(
      `data sections: exactly six parent data sections, each in the model input, ${label}`,
      async () => {
        const { result, requests, db, id } = await askOnce(now);
        const held = await db.forSandbox(id).read();
        const policyIds = new Set<string>(held.snapshots[held.snapshots.length - 1].sections.map((s: Section) => s.id));
        const data = dataSections(result, policyIds);
        expect(data.map((s) => s.id).sort()).toEqual([...DATA_SECTION_IDS].sort());
        expect(data.filter((s) => s.visibility !== 'parent').map((s) => s.id), 'data sections that are not parent-visible').toEqual([]);
        expect(requests.length, 'the model was not called').toBeGreaterThan(0);
        const input = allInput(requests);
        for (const s of data) {
          expect(normalize(s.text).length, `${s.id} renders no text`).toBeGreaterThan(0);
          expect(input.includes(normalize(s.text)), `the ${s.id} section text is not in the model input`).toBe(true);
        }
      },
      TIMEOUT,
    );

    test(
      `data sections: the rendered sections state the center's facts from seed(now), ${label}`,
      async () => {
        expectHostZone();
        const { result } = await askOnce(now);
        const structured = (await loadSeed()).seed(CREATED).structured;
        const problems = [
          ...tuitionProblems(sectionText(result, 'tuition')).map((p) => `tuition: ${p}`),
          ...hoursProblems(sectionText(result, 'hours')).map((p) => `hours: ${p}`),
          ...contactsProblems(sectionText(result, 'contacts')).map((p) => `contacts: ${p}`),
          ...calendarProblems(sectionText(result, 'calendar'), structured, now).map((p) => `calendar: ${p}`),
          ...menuProblems(sectionText(result, 'menu'), structured, now).map((p) => `menu: ${p}`),
          ...alertProblems(sectionText(result, 'alerts'), structured, now).map((p) => `alerts: ${p}`),
        ];
        expect(problems).toEqual([]);
      },
      TIMEOUT,
    );
  }
});

// Every past date that expired content could carry: yesterday (Fall Family
// Night, the water alert) through the day before the current day (menus and
// Picture Day seeded as current).
function pastDates(now: Date): string[] {
  const out: string[] = [];
  for (let d = addDays(CREATED_ON, -1); d < denverDate(now); d = addDays(d, 1)) out.push(d);
  return out;
}

function expiredIn(text: string, now: Date): string[] {
  const found: string[] = [];
  for (const s of ['Water service interruption', 'Fall Family Night']) if (contains(text, s)) found.push(s);
  if (now.getTime() >= denver(CREATED_ON, '18:00').getTime() && contains(text, 'North parking lot repaving')) found.push('the parking alert after its expiry');
  for (const d of pastDates(now)) if (mentionsDate(text, d)) found.push(`a past date, ${d}`);
  return found;
}

describe('expired content', () => {
  for (const [label, now] of MOMENTS) {
    test(
      `expired content: none reaches the model input ${label}`,
      async () => {
        const { requests } = await askOnce(now);
        expect(requests.length, 'the model was not called').toBeGreaterThan(0);
        expect(expiredIn(allInput(requests), now)).toEqual([]);
      },
      TIMEOUT,
    );

    test(
      `expired content: none reaches a degraded answer's verbatim text ${label}`,
      async () => {
        const bad = answerOut(`A ${GENERATED} counted 99 minutes of events.`, ['alerts', 'calendar', 'menu']);
        const { result } = await askOnce(now, 'What is happening this week?', bad);
        expect(result.reply.reason).toBe('grounding_failed');
        expect(contains(result.reply.text, sectionText(result, 'calendar')), 'the degraded text does not hold the calendar section').toBe(true);
        expect(expiredIn(replyText(result.reply), now)).toEqual([]);
      },
      TIMEOUT,
    );

    test(
      `expired content: no citation names expired content ${label}`,
      async () => {
        const out = answerOut('Please check the alerts and the menu.', ['alerts', 'alert-water', 'fall-family-night', 'menu']);
        const { result } = await askOnce(now, 'Anything I should know about today?', out);
        const cited = result.reply.citations.map((c) => c.sectionId);
        expect(cited.filter((c) => c === 'alert-water' || c === 'fall-family-night'), 'citations naming expired entries').toEqual([]);
        const ids = new Set((result.snapshot?.sections ?? []).map((s) => s.id));
        expect(cited.filter((c) => !ids.has(c)), 'citations naming no section of the snapshot').toEqual([]);
        expect(cited.length, 'the valid citations were dropped too').toBeGreaterThan(0);
        const citedText = cited.map((c) => sectionText(result, c)).join('\n');
        expect(expiredIn(citedText, now)).toEqual([]);
      },
      TIMEOUT,
    );
  }
});

describe('staff-only content', () => {
  const STAFF_TEXT = ['4417', 'lockdown door code', 'Do not share this section with families'];

  test(
    'staff-only content: the seeded staff section never reaches the model input',
    async () => {
      const { requests } = await askOnce(AT_CREATION, 'What code opens the doors during a lockdown?');
      expect(requests.length, 'the model was not called').toBeGreaterThan(0);
      const input = allInput(requests);
      expect(STAFF_TEXT.filter((t) => contains(input, t))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    'staff-only content: a staff section published later, and a parent section republished as staff, never reach the model input',
    async () => {
      const { ask, db } = await loadPipeline();
      const id = await db.createSandbox(CREATED);
      const held = clone(await db.forSandbox(id).read());
      const latest = held.snapshots[held.snapshots.length - 1];
      const sections: Section[] = clone(latest.sections);
      sections.push({ id: 'alarm-panel', title: 'Alarm panel', visibility: 'staff', updatedOn: CREATED_ON, text: 'Staff only. The alarm panel code is 9931* (wombat).' });
      const sunscreen = sections.find((s) => s.id === 'sunscreen')!;
      sunscreen.visibility = 'staff';
      held.snapshots.push({ version: latest.version + 1, sections });
      await db.forSandbox(id).write(held);
      const { requests, result } = await askWith(ask, id, 'Who provides sunscreen?', AT_CREATION, returns(GROUNDED));
      expect(result.reply.snapshotVersion).toBe(latest.version + 1);
      const input = allInput(requests);
      const leaked = ['9931', 'wombat', 'Sunscreen is parent-provided', ...STAFF_TEXT].filter((t) => contains(input, t));
      expect(leaked).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    'staff-only content: a citation of a staff section is removed and the reply never carries its text',
    async () => {
      const { result } = await askOnce(AT_CREATION, 'When is breakfast?', answerOut('Breakfast is served until 8:30 AM.', ['meals', 'lockdown-procedure']));
      expect(result.reply.citations.map((c) => c.sectionId)).toEqual(['meals']);
      expect(replyText(result.reply).includes(STAFF_CODE)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    'staff-only content: a degraded answer citing a staff section holds no staff text',
    async () => {
      const bad = answerOut(`A ${GENERATED} says breakfast ends at 9:45 AM.`, ['lockdown-procedure', 'meals']);
      const { result } = await askOnce(AT_CREATION, 'When does breakfast end?', bad);
      expect(result.reply.reason).toBe('grounding_failed');
      const text = replyText(result.reply);
      expect(STAFF_TEXT.filter((t) => contains(text, t))).toEqual([]);
      expect(result.reply.citations.map((c) => c.sectionId)).not.toContain('lockdown-procedure');
    },
    TIMEOUT,
  );
});

describe('snapshot binding', () => {
  test(
    'snapshot binding: each message uses the latest snapshot published when it arrives and records its version',
    async () => {
      const { ask, db } = await loadPipeline();
      const id = await db.createSandbox(CREATED);
      const first = await askWith(ask, id, 'When is breakfast?', AT_CREATION, returns(GROUNDED));
      const held = clone(await db.forSandbox(id).read());
      const latest = held.snapshots[held.snapshots.length - 1];
      expect(first.result.reply.snapshotVersion).toBe(latest.version);

      const sections: Section[] = clone(latest.sections);
      sections.find((s) => s.id === 'meals')!.text += ' Breakfast includes a capybara pancake on Fridays.';
      held.snapshots.push({ version: latest.version + 1, sections });
      await db.forSandbox(id).write(held);

      const second = await askWith(ask, id, 'When is breakfast?', new Date(AT_CREATION.getTime() + 60_000), returns(GROUNDED));
      expect(second.result.reply.snapshotVersion).toBe(latest.version + 1);
      expect(contains(allInput(second.requests), 'capybara pancake'), 'the newly published text is not in the model input').toBe(true);
      expect(contains(allInput(first.requests), 'capybara pancake')).toBe(false);
    },
    TIMEOUT,
  );

  test(
    'snapshot binding: an unpublished draft edit changes neither the model input nor the reply',
    async () => {
      const { ask, db } = await loadPipeline();
      const id = await db.createSandbox(CREATED);
      const held = clone(await db.forSandbox(id).read());
      const version = held.snapshots[held.snapshots.length - 1].version;
      held.draft.sections.find((s: Section) => s.id === 'meals').text = 'Breakfast is served until 11:15 AM, with ocelot muffins.';
      held.draft.sections.push({ id: 'draft-only', title: 'Draft only', visibility: 'parent', updatedOn: CREATED_ON, text: 'Pelican parking opens soon.' });
      await db.forSandbox(id).write(held);
      const { result, requests } = await askWith(ask, id, 'When is breakfast?', AT_CREATION, returns(answerOut('Breakfast is served until 8:30 AM.', ['meals', 'draft-only'])));
      const input = allInput(requests);
      expect(requests.length, 'the model was not called').toBeGreaterThan(0);
      expect(['ocelot', '11:15', 'Pelican'].filter((t) => contains(input, t))).toEqual([]);
      expect(contains(input, 'Breakfast is served until 8:30 AM'), 'the published meals text is missing').toBe(true);
      expect(result.reply.snapshotVersion).toBe(version);
      expect(result.reply.citations.map((c) => c.sectionId)).toEqual(['meals']);
      expect(contains(replyText(result.reply), 'ocelot')).toBe(false);
    },
    TIMEOUT,
  );
});

// The weekday and date written the way the model input is expected to state
// them, as one phrase.
function statesDay(text: string, date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const month = MONTHS[m - 1];
  const day = `(?:${month} ${d},? ${y}|${date}|${d} ${month},? ${y}|${m}/${d}/${y})`;
  return new RegExp(`${weekday}\\W{1,4}${day}|${day}\\W{1,4}\\(?${weekday}`, 'i').test(normalize(text));
}

describe('time', () => {
  test(
    'time: at 2026-11-11T05:30:00Z the model input states Tuesday, November 10, 2026',
    async () => {
      expectHostZone();
      const { ask, db } = await loadPipeline();
      // Created two weeks earlier, so no menu or calendar line falls on
      // November 10 and only the current-date statement can name it.
      const id = await db.createSandbox(new Date('2026-10-26T09:00:00-06:00'));
      const { requests } = await askWith(ask, id, 'Are you open today?', new Date('2026-11-11T05:30:00Z'), returns(GROUNDED));
      expect(requests.length, 'the model was not called').toBeGreaterThan(0);
      expect(statesDay(allInput(requests), '2026-11-10'), 'the model input does not state Tuesday, November 10, 2026').toBe(true);
    },
    TIMEOUT,
  );

  test(
    'time: late evening in Denver, when the host zone is already on the next day, the model input states the Denver date',
    async () => {
      expectHostZone();
      const { ask, db } = await loadPipeline();
      const day = nthWeekday(RUN_YEAR, 2, 3, 3);
      const now = denver(day, '22:45');
      expect(denverDate(now)).toBe(day);
      expect(new Date(now).getDate(), 'the host zone sees the same calendar day; the fixture is wrong').not.toBe(Number(day.slice(8)));
      const id = await db.createSandbox(denver(addDays(day, -15), '09:00'));
      const { requests } = await askWith(ask, id, 'Are you open tomorrow?', now, returns(GROUNDED));
      expect(statesDay(allInput(requests), day), `the model input does not state ${day} with its weekday`).toBe(true);
    },
    TIMEOUT,
  );
});

describe('follow-up context', () => {
  test(
    'follow-up context: the last 2 exchanges of prior turns reach the model input and older ones do not',
    async () => {
      const turns = [
        { role: 'parent' as const, text: 'Do you sell aardvark stickers?' },
        { role: 'front_desk' as const, text: 'We do not sell aardvark stickers.' },
        { role: 'parent' as const, text: 'What about bobcat magnets?' },
        { role: 'front_desk' as const, text: 'No bobcat magnets either.' },
        { role: 'parent' as const, text: 'Is there a chinchilla club?' },
        { role: 'front_desk' as const, text: 'There is no chinchilla club.' },
        { role: 'parent' as const, text: 'Do you have a dingo day?' },
        { role: 'front_desk' as const, text: 'No dingo day is planned.' },
      ];
      const { ask, db } = await loadPipeline();
      const id = await db.createSandbox(CREATED);
      const { requests } = await askWith(ask, id, 'What about Friday?', AT_CREATION, returns(GROUNDED), turns);
      const input = allInput(requests);
      const kept = turns.slice(4).filter((t) => !contains(input, t.text)).map((t) => t.text);
      const dropped = turns.slice(0, 4).filter((t) => contains(input, t.text) || /aardvark|bobcat/i.test(input)).map((t) => t.text);
      expect({ missing: kept, tooOld: dropped }).toEqual({ missing: [], tooOld: [] });
    },
    TIMEOUT,
  );
});

describe('instructions', () => {
  const PATTERNS: [string, RegExp][] = [
    ['a URL', /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(example|com|org|net|io|gov|edu|dev|app|aws|amazonaws)\b/i],
    ['the staff code', /4417/],
    ['an AWS account ID', /(?<!\d)\d{12}(?!\d)/],
    ['an ARN', /\barn:aws/i],
    ['an access key ID', /\b(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/],
    ['a credential', /aws_secret_access_key|secret access key|session token|password\s*[:=]|postgres(ql)?:\/\/|BEGIN [A-Z ]*PRIVATE|sk-ant-|x-api-key|bearer\s+[a-z0-9]/i],
  ];

  test(
    'instructions: no URL, staff code, AWS account ID, ARN, or credential, across messages and sandboxes',
    async () => {
      const { ask, db } = await loadPipeline();
      const a = await db.createSandbox(CREATED);
      const b = await db.createSandbox(denver(addDays(CREATED_ON, 30), '09:00'));
      const asked = [
        await askWith(ask, a, 'How do I book a tour?', AT_CREATION, returns(GROUNDED)),
        await askWith(ask, a, 'And the code for the door?', new Date(AT_CREATION.getTime() + 60_000), returns(GROUNDED), [
          { role: 'parent', text: 'How do I book a tour?' },
          { role: 'front_desk', text: 'Book at juniperhill.example/tour.' },
        ]),
        await askWith(ask, b, 'What is on the menu?', denver(addDays(CREATED_ON, 30), '10:00'), returns(GROUNDED)),
      ];
      const instructions = asked.flatMap((x) => x.requests).map((r) => r.instructions);
      expect(instructions.length, 'the model was not called').toBeGreaterThan(0);
      for (const text of instructions) {
        expect(typeof text === 'string' && text.trim().length > 0, 'a request carries no instructions').toBe(true);
        const found = PATTERNS.filter(([, re]) => re.test(text)).map(([what]) => what);
        if (process.env.DATABASE_URL && text.includes(process.env.DATABASE_URL)) found.push('the database URL');
        expect(found).toEqual([]);
      }
      // The instructions are separate from the center's information: the
      // tour URL is in the model input but not in the instructions.
      expect(contains(inputText(asked[0].requests[0]), 'juniperhill.example/tour'), 'the tours section is not in the model input').toBe(true);
    },
    TIMEOUT,
  );
});
