// Floor lexicons (DESIGN 4.3): phrases that set a minimum outcome before the
// model is asked. Small, English-only, and biased toward over-triggering. The
// bare words "emergency", "urgent", "hurt" and "sick" never fire on their own.

import type { Outcome, Reason } from './types';

type Lexicon = { name: string; outcome: Outcome; reason: Reason; pattern: RegExp };

const CHILD = '(?:son|daughter|child|kid|baby|toddler|boy|girl)';
const MY = '(?:my|our)';
// "The app is not responding" names a device, not a child.
const NOT_A_DEVICE = '(?<!\\b(?:app|website|site|portal|page|phone|link|system|button|screen|email)\\b[^.?!]{0,20})';
// "Missing her jacket" names a thing the child is missing, not a missing child.
const NO_OBJECT = "(?!\\s+(?:her|his|their|its|a|an|the|my|our|some|\\w+'s)\\b)";

// Lexicon data: each entry names one category.
const LEXICONS: Lexicon[] = [
  {
    name: 'medical emergency',
    outcome: 'urgent',
    reason: 'emergency',
    pattern: new RegExp(
      [
        'not breathing',
        'stopped breathing',
        // Blue lips and slow or shallow breathing, said calmly (PRD T1).
        'lips? (?:\\w+ ){0,4}?(?:blue|purple)',
        'blue lips',
        'breathing (?:\\w+ ){0,3}?(?:slow|shallow|weird|funny)',
        '(?:slow|shallow) breathing',
        "can(?:no|')?t breathe",
        'unconscious',
        `${NOT_A_DEVICE}not responding`,
        `${NOT_A_DEVICE}unresponsive`,
        'seizures?',
        'choking',
        'allergic reaction',
        'anaphyla\\w*',
        'epi-?pen',
        'bleeding',
        'hit (?:his|her|their) head',
        'broken? (?:his |her |their )?(?:arm|leg|bone)',
        'call(?:ed|ing)? 911',
      ].join('|'),
      'i',
    ),
  },
  {
    name: 'missing child',
    outcome: 'urgent',
    reason: 'safety',
    pattern: new RegExp(
      [`(?:can(?:no|')?t|can not|unable to) find ${MY} ${CHILD}`, `${CHILD} is missing${NO_OBJECT}`, `(?:he|she) is missing${NO_OBJECT}`, 'missing child'].join('|'),
      'i',
    ),
  },
  {
    name: 'abuse or neglect',
    outcome: 'urgent',
    reason: 'safety',
    // "Neglected to pack her lunch" is forgetting, not neglect.
    pattern: new RegExp(['abused?', 'abusing', 'neglect\\w*(?!\\s+to\\b)', 'hurt by', `(?:hit|slapped|kicked|shook|shoved) ${MY} ${CHILD}`].join('|'), 'i'),
  },
  {
    name: 'unsafe pickup',
    outcome: 'urgent',
    reason: 'safety',
    pattern: new RegExp(
      [
        // A high fever or temperature is not an impaired adult.
        '(?:drunk|intoxicated|high(?!\\s+(?:fever|temp\\w*))|impaired)\\b.{0,60}\\bpick(?:ing)? (?:up|her|him|them)',
        'stranger\\b.{0,60}\\bpick(?:ing)? up',
        'not on (?:the|my|our|his|her|their) pickup list',
        `trying to (?:take|grab) ${MY} ${CHILD}`,
      ].join('|'),
      'i',
    ),
  },
  {
    name: 'threat of violence',
    outcome: 'urgent',
    reason: 'safety',
    pattern: new RegExp(
      ['guns?', 'weapons?', 'knife', 'threat\\w*', '(?:going to|gonna|will|wants? to) (?:hurt|kill|shoot|attack|stab)'].join('|'),
      'i',
    ),
  },
  {
    name: 'custody or court order',
    outcome: 'handoff',
    reason: 'sensitive',
    pattern: /custody|court order|restraining order|protective order|my ex\b|lawyer|attorney/i,
  },
  {
    name: 'complaint about staff',
    outcome: 'handoff',
    reason: 'sensitive',
    pattern: /complaint about|complain about|report (?:a|the) teacher/i,
  },
  {
    name: 'billing dispute',
    outcome: 'handoff',
    reason: 'sensitive',
    pattern: /refund|overcharged|charged twice|double charged|disput\w*/i,
  },
  {
    name: 'child records',
    outcome: 'handoff',
    reason: 'sensitive',
    pattern: new RegExp(['incident reports?', `did ${MY} ${CHILD} attend`, 'attendance records?', `${MY} ${CHILD}'s (?:records?|file)`].join('|'), 'i'),
  },
  {
    name: 'pickup list membership',
    outcome: 'handoff',
    reason: 'sensitive',
    pattern: /\bon (?:the|my|our|his|her|their|\w+'s)\b[^.?!]{0,40}\bpickup list/i,
  },
  {
    name: 'personal details',
    outcome: 'handoff',
    reason: 'sensitive',
    pattern: /other (?:kids|children|families)|home (?:address|phone)|personal (?:cell|phone|number|address|email)/i,
  },
];

const RANK: Record<Outcome, number> = { answer: 0, handoff: 1, urgent: 2 };

export type Floor = { floor: Outcome; reason: Reason | null; fired: string[] };

// The highest floor any lexicon sets for a message. Among urgent matches,
// emergency outranks safety, so a medical emergency is never sent to safety copy.
export function floorFor(message: string): Floor {
  const hits = LEXICONS.filter((l) => new RegExp(`\\b(?:${l.pattern.source})\\b`, 'i').test(message));
  if (hits.length === 0) return { floor: 'answer', reason: null, fired: [] };
  const top = hits.reduce((best, l) => (RANK[l.outcome] > RANK[best.outcome] ? l : best));
  const reason = hits.some((l) => l.reason === 'emergency') ? 'emergency' : top.reason;
  return { floor: top.outcome, reason, fired: hits.map((l) => l.name) };
}
