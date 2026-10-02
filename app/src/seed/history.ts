// A week of past parent questions and their replies, and the three open gaps
// they form. Reply texts are historical fixture data recording what each
// reply said, not strings the app chooses at runtime.

import { addDays, startOfDenverDay } from './dates';
import type { Outcome, Reason, Section } from '../core/types';
import type { Gap, Question } from './index';

type GapKey = 'sibling' | 'part-time' | 'summer';

type Row = {
  text: string;
  outcome: Outcome;
  reason: Reason;
  replyText?: string; // absent for reasons whose reply is fixed text or the cited sections
  cites: string[];
  gap?: GapKey;
};

const PHONE = '(505) 555-0142';

const FIXED: Partial<Record<Reason, string>> = {
  not_in_source: `I don't have that in the center's information. The front desk can help: call ${PHONE} or send this to the front desk.`,
  sensitive: `A staff member should handle this one. Please call the front desk at ${PHONE} or send this to the front desk.`,
  system_error: `Sorry, something went wrong on our end. Please call the front desk at ${PHONE} or send this to the front desk.`,
  unsupported_language:
    `We can only answer questions in English right now. Please call the front desk at ${PHONE}. ` +
    `Por ahora solo podemos responder preguntas en inglés. Llame a la recepción al ${PHONE}.`,
  emergency: `If this is an emergency, call 911 first. Then call the center at ${PHONE}.`,
  safety: `If a child is in danger right now, call 911. Then call the center at ${PHONE}.`,
};

const ROWS: Row[] = [
  // Sibling discount gap.
  { text: 'Do you offer a discount for siblings?', outcome: 'handoff', reason: 'not_in_source', cites: [], gap: 'sibling' },
  { text: 'Is there a sibling discount if both my kids enroll?', outcome: 'handoff', reason: 'not_in_source', cites: [], gap: 'sibling' },
  { text: 'My twins start next month. Is there a family rate?', outcome: 'handoff', reason: 'not_in_source', cites: [], gap: 'sibling' },
  { text: 'Does the second child get reduced tuition?', outcome: 'handoff', reason: 'not_in_source', cites: [], gap: 'sibling' },
  { text: 'Do brothers and sisters get a price break on tuition?', outcome: 'handoff', reason: 'not_in_source', cites: [], gap: 'sibling' },
  { text: 'We have a toddler and a preschooler. Any discount for having two kids there?', outcome: 'handoff', reason: 'not_in_source', cites: [], gap: 'sibling' },
  { text: 'Is tuition cheaper for the second kid in the same family?', outcome: 'handoff', reason: 'not_in_source', cites: [], gap: 'sibling' },

  // Part-time schedules gap.
  { text: 'Can my daughter come just Tuesdays and Thursdays?', outcome: 'handoff', reason: 'not_in_source', cites: [], gap: 'part-time' },
  { text: 'Do you have a part-time option?', outcome: 'handoff', reason: 'not_in_source', cites: [], gap: 'part-time' },
  { text: 'Is there a 3 day a week schedule for preschool?', outcome: 'answer', reason: 'grounding_failed', cites: ['tuition-and-payments'], gap: 'part-time' },
  { text: 'Can I pay for half days only?', outcome: 'handoff', reason: 'not_in_source', cites: [], gap: 'part-time' },
  { text: 'Do you prorate tuition if he only comes Mondays, Wednesdays, and Fridays?', outcome: 'answer', reason: 'grounding_failed', cites: ['tuition-and-payments'], gap: 'part-time' },

  // Summer program gap.
  { text: 'Do you run a summer camp?', outcome: 'handoff', reason: 'not_in_source', cites: [], gap: 'summer' },
  { text: 'Are you open in the summer for school-age kids?', outcome: 'handoff', reason: 'not_in_source', cites: [], gap: 'summer' },
  { text: 'Is there a summer program for kids who finish Pre-K?', outcome: 'handoff', reason: 'not_in_source', cites: [], gap: 'summer' },
  { text: 'What does the summer schedule look like?', outcome: 'answer', reason: 'grounding_failed', cites: ['sunscreen'], gap: 'summer' },

  // Answered from the center's information.
  {
    text: 'She had a fever last night. Does she need to stay home, and how do I let you know?',
    outcome: 'answer',
    reason: 'answered',
    replyText: 'Yes. Keep her home after a fever of 100.4°F or higher in the last 24 hours. Tell us by 9:00 AM by app message or phone.',
    cites: ['illness', 'absences'],
  },
  {
    text: 'How much is the late pickup fee?',
    outcome: 'answer',
    reason: 'answered',
    replyText: 'A $15 late fee applies per occurrence after closing time. Please call us if you will be late.',
    cites: ['late-pickup'],
  },
  {
    text: 'When can I tour the center?',
    outcome: 'answer',
    reason: 'answered',
    replyText: 'Tours are on Tuesdays and Thursdays at 9:30 AM and 3:30 PM and take about 30 minutes. You can book at juniperhill.example/tour.',
    cites: ['tours-and-enrollment'],
  },
  {
    text: 'Can I add my neighbor to the pickup list by text?',
    outcome: 'answer',
    reason: 'answered',
    replyText: 'Staff cannot add anyone by phone, text, or chat. Only the enrolling parent can change the list, in the parent app.',
    cites: ['pickup'],
  },
  {
    text: 'Do I need to send a blanket for nap?',
    outcome: 'answer',
    reason: 'answered',
    replyText: 'Please bring one labeled comfort item for nap. Nap blankets go home on Fridays to be washed.',
    cites: ['what-to-bring'],
  },
  {
    text: 'Are you open if the schools have a delay because of snow?',
    outcome: 'answer',
    reason: 'answered',
    replyText: 'On a district 2-hour delay, we open at 9:30 AM and do not serve breakfast.',
    cites: ['weather-closures'],
  },
  {
    text: 'My son started antibiotics this morning. Can he come in?',
    outcome: 'answer',
    reason: 'answered',
    replyText: 'Not yet. Children stay home until they have been on antibiotics for 24 hours.',
    cites: ['illness'],
  },
  {
    text: "Do I still pay tuition for the week we're away on vacation?",
    outcome: 'answer',
    reason: 'answered',
    replyText: 'Yes. Tuition is owed regardless of absences. Only weeks when the center is closed all week are not billed.',
    cites: ['tuition-and-payments'],
  },
  {
    text: 'I forgot to pack lunch today. Is that ok?',
    outcome: 'answer',
    reason: 'answered',
    replyText: 'Yes. We serve a backup lunch for $5, billed to your account.',
    cites: ['meals'],
  },
  {
    text: 'Can I just leave her inhaler in her backpack?',
    outcome: 'answer',
    reason: 'answered',
    replyText: 'No. Medication must be handed to a teacher in its original labeled container, with a written authorization form.',
    cites: ['medication'],
  },

  // Handed off or escalated.
  { text: 'I want to dispute the late fee from last week. It was not my fault.', outcome: 'handoff', reason: 'sensitive', cites: [] },
  { text: 'My ex and I have a new custody order. Who do I give it to?', outcome: 'handoff', reason: 'sensitive', cites: [] },
  { text: 'My son is having an allergic reaction right now and his lips are swelling. What do I do?', outcome: 'urgent', reason: 'emergency', cites: [] },
  { text: '¿Cuál es el horario del centro los viernes?', outcome: 'handoff', reason: 'unsupported_language', cites: [] },
  { text: "What's on the menu for Thursday?", outcome: 'handoff', reason: 'system_error', cites: [] },
];

const GAPS: { key: GapKey; id: string; label: string }[] = [
  { key: 'sibling', id: 'gap-sibling-discount', label: 'Sibling discount' },
  { key: 'part-time', id: 'gap-part-time-schedules', label: 'Part-time schedules' },
  { key: 'summer', id: 'gap-summer-program', label: 'Summer program' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

function questionId(i: number): string {
  return `question-${String(i + 1).padStart(2, '0')}`;
}

// A degraded answer shows the verbatim text of each cited section (PRD P7).
function degradedText(cites: string[], sections: Section[]): string {
  const texts = cites.map((id) => sections.find((s) => s.id === id)!.text);
  return `Here's what our handbook says: ${texts.join(' ')}`;
}

// Question i goes to the (1 + i % 7)th Denver date before the creation date,
// spaced evenly inside the part of that date that lies in [now - 7 days, now].
function askedAt(i: number, now: Date, creation: string): string {
  const offset = 1 + (i % 7);
  const date = addDays(creation, -offset);
  const count = ROWS.filter((_, k) => k % 7 === i % 7).length;
  const j = Math.floor(i / 7);
  const lo = Math.max(startOfDenverDay(date).getTime(), now.getTime() - 7 * DAY_MS);
  // Clamped to lo: within six days after a fall-back change, a `now` in the
  // last hour of its Denver day leaves the 7th date back no time in the window.
  const hi = Math.max(lo, Math.min(startOfDenverDay(addDays(date, 1)).getTime() - 1, now.getTime()));
  return new Date(Math.floor(lo + ((j + 1) * (hi - lo)) / (count + 1))).toISOString();
}

export function history(now: Date, creation: string, sections: Section[]): { questions: Question[]; gaps: Gap[] } {
  const questions: Question[] = ROWS.map((row, i) => ({
    id: questionId(i),
    text: row.text,
    askedAt: askedAt(i, now, creation),
    reply: {
      text: row.replyText ?? (row.reason === 'grounding_failed' ? degradedText(row.cites, sections) : FIXED[row.reason]!),
      outcome: row.outcome,
      reason: row.reason,
      snapshotVersion: 1,
      citations: row.cites.map((sectionId) => ({ sectionId })),
    },
  }));
  const gaps: Gap[] = GAPS.map(({ key, id, label }) => ({
    id,
    label,
    status: 'open',
    questionIds: ROWS.flatMap((row, i) => (row.gap === key ? [questionId(i)] : [])),
  }));
  return { questions, gaps };
}
