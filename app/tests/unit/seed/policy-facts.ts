// The facts each parent-visible policy section must state, and the check
// that finds which ones a section's text is missing. Matching is
// wrap-normalized and case-insensitive; literal values must appear as given,
// other facts are found by short word stems so sentence wording stays free.

import { literal, normalize } from './support';

// Each policy: its title, the literal values that must appear in its text,
// and stems for its other facts.
export const POLICIES: { title: string; literals: string[]; stems: RegExp[] }[] = [
  {
    title: 'Illness',
    literals: ['100.4', '24 hours', '60 minutes'],
    stems: [/fever/i, /vomit/i, /diarrh/i, /antibiotic/i, /rash/i, /pink\s?eye/i, /symptom[\s-]free/i, /fever[\s-]reduc/i, /\bpick/i, /doctor/i],
  },
  {
    title: 'Medication',
    literals: [],
    stems: [/authori[sz]ation form/i, /(each|every) medication/i, /original/i, /label/i, /teacher/i, /cubb(y|ies)/i, /backpack/i, /cough drops?/i],
  },
  {
    title: 'Pickup and authorized adults',
    literals: ['18'],
    stems: [/authori[sz]ed/i, /pick\s?-?up list/i, /\bapp\b/i, /photo id/i, /enrolling parent/i, /\bphone\b/i, /\btext\b/i, /\bchat\b/i],
  },
  {
    title: 'Late pickup',
    literals: ['$15', '30 minutes'],
    stems: [/\bcall\b/i, /late fee/i, /per (occurrence|instance|time)|each (time|occurrence)/i, /clos(e|ing)/i, /licensing/i, /authorities/i],
  },
  {
    title: 'Absences',
    literals: ['9:00 AM'],
    stems: [/\bapp\b/i, /\bphone\b/i],
  },
  {
    title: 'Meals',
    literals: ['8:30 AM', '$5'],
    stems: [/breakfast/i, /snack/i, /lunch/i, /backup lunch/i, /account/i, /allerg/i, /physician/i, /store[\s-]bought/i, /label/i],
  },
  {
    title: 'Tours and enrollment',
    literals: ['9:30 AM', '3:30 PM', '30 minutes', 'juniperhill.example/tour'],
    stems: [/tuesday/i, /thursday/i, /\bphone\b/i],
  },
  {
    title: 'Weather closures',
    literals: ['2-hour', '9:30 AM'],
    stems: [/cedar mesa public schools/i, /district/i, /clos(e|es|ed)\b/i, /delay/i, /breakfast/i],
  },
  {
    title: 'What to bring',
    literals: ['two', 'one'],
    stems: [/extra clothes/i, /comfort item/i, /\bnap\b/i, /blanket/i, /fridays?/i, /wash/i, /toys/i, /label/i],
  },
  {
    title: 'Sunscreen',
    literals: [],
    stems: [/parent[\s-]provided|provided by (the )?parent|parents? provide/i, /label/i, /permission form/i, /outdoor/i],
  },
  {
    title: 'Toilet learning',
    literals: [],
    stems: [/toilet[\s-]trained/i, /preschool/i, /toilet learning/i, /\bplan\b/i],
  },
  {
    title: 'Tuition and payments',
    literals: [],
    stems: [/weekly/i, /friday/i, /(following|next) week/i, /\bapp\b/i, /absence/i, /closed (for )?(all|the (whole|entire|full)) week/i, /not billed/i],
  },
  {
    title: 'Concerns and grievances',
    literals: [],
    stems: [/teacher/i, /director/i, /written/i, /e-?mail/i],
  },
];

// Literal words ("two", "one") must stand alone; numeric literals must not sit
// inside a longer number.
function literalPattern(token: string): RegExp {
  return /^[a-z]+$/i.test(token) ? new RegExp(`\\b${token}\\b`, 'i') : literal(token);
}

// Returns the facts a section's text is missing.
export function missingFacts(policy: (typeof POLICIES)[number], body: string): string[] {
  const t = normalize(body);
  const missing: string[] = [];
  for (const l of policy.literals) if (!literalPattern(l).test(t)) missing.push(`literal ${l}`);
  for (const s of policy.stems) if (!s.test(t)) missing.push(`fact ${s}`);
  return missing;
}

