// Patterns that find members of a class of text wherever they appear: phone
// numbers in every common written form, email and URL hosts with or without a
// scheme, and the subjects the center's information does not cover in the
// ways a writer might name them.

// Phone numbers in any common form: (505) 555-0142, 505-555-0142,
// 505.555.0142, 505 555 0142, 5055550142, +1 505 555 0142, or a bare
// 555-0142. The lookarounds keep dates, times, decimals, and identifier
// segments from matching.
const TEN_DIGIT = /(?<![\w.-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-]|\.\d)/g;
const SEVEN_DIGIT = /(?<![\w.()-])(?<!\)\s)\d{3}[\s.-]\d{4}(?![\w-]|\.\d)/g;

export function phoneNumbers(texts: string[]): string[] {
  const found: string[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(TEN_DIGIT)) found.push(m[0]);
    for (const m of t.matchAll(SEVEN_DIGIT)) found.push(m[0]);
  }
  return found;
}

// True when a phone number's last seven digits are 555-0100 to 555-0199.
export function inRange(phone: string): boolean {
  return /55501\d\d$/.test(phone.replace(/\D/g, ''));
}

// Hosts written after an @, with a scheme, or bare with a real top-level
// domain (www.example-daycare.com, cedarmesa.org/forms).
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const SCHEME_URL = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#"'<>)\]]+)/gi;
const BARE_HOST =
  /(?<![\w@.-])((?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|mil|int|io|us|co|info|biz|app|dev|ai|me|ly|tv|site|online|example))(?![\w-])/gi;

export function hosts(texts: string[]): { emails: string[]; urls: string[] } {
  const emails: string[] = [];
  const urls: string[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(EMAIL)) emails.push(m[1].toLowerCase());
    const withoutEmails = t.replace(EMAIL, ' ');
    for (const m of withoutEmails.matchAll(SCHEME_URL)) urls.push(m[1].toLowerCase().replace(/:\d+$/, '').replace(/^.*@/, ''));
    for (const m of withoutEmails.replace(SCHEME_URL, ' ').matchAll(BARE_HOST)) urls.push(m[1].toLowerCase());
  }
  return { emails, urls };
}

// Each subject the center's information does not cover, in the ways a writer
// might name it.
export const SUBJECTS: [string, RegExp][] = [
  ['siblings', /\b(siblings?|brothers?|sisters?|second child|multi[\s-]?child|family discount)\b/i],
  [
    'part-time schedules',
    /\bpart[\s-]?time\b|\bpartial[\s-]?weeks?\b|\bhalf[\s-]?days?\b|\b(1|2|3|4|one|two|three|four)[\s-]days?[\s-](a|per|each)[\s-]week\b|\b(2|3|two|three)[\s-]day\s+(schedule|program|option|plan|week)s?\b/i,
  ],
  ['a summer program', /\bsummer\s+(programs?|camps?|sessions?|school|care|enrollment|break program)\b/i],
];
