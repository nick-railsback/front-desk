// Grounding (PRD T2, DESIGN 4.7): every checkable value in a generated answer
// must appear in the text of a cited section. Values are normalized so
// equivalent forms match. Pure.

import type { Section } from './types';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAME = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const MERIDIEM = '([ap])\\.?\\s?m\\b\\.?';

const pad = (n: number) => String(n).padStart(2, '0');

function time(hour: number, minute: number, meridiem?: string): string | null {
  let h = hour;
  if (meridiem) {
    // "17:30 PM" is no time of day, so no source can ground it.
    if (h < 1 || h > 12) return `time invalid ${hour}:${pad(minute)}${meridiem.toLowerCase()}m`;
    h = (h % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0);
  }
  return h > 23 || minute > 59 ? null : `time ${pad(h)}:${pad(minute)}`;
}

function date(month: number, day: number): string | null {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? `date ${pad(month)}-${pad(day)}` : null;
}

const UNITS: [RegExp, string][] = [
  [/^min/, 'minute'],
  [/^(hour|hr)/, 'hour'],
  [/^day/, 'day'],
  [/^(week|wk)/, 'week'],
  [/^(percent|%)/, 'percent'],
];

// Each extractor: a pattern and how one match becomes a normalized value.
const EXTRACTORS: [RegExp, (m: RegExpExecArray) => string | null][] = [
  [/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g, (m) => `money $${Number(m[1].replace(/,/g, ''))}`],
  [/(?<![\d.$])(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars?|bucks)\b/gi, (m) => `money $${Number(m[1].replace(/,/g, ''))}`],
  [new RegExp(`(?<![\\d:.])(\\d{1,2}):(\\d{2})\\s*${MERIDIEM}`, 'gi'), (m) => time(Number(m[1]), Number(m[2]), m[3])],
  [new RegExp(`(?<![\\d:.])(\\d{1,2}):(\\d{2})(?!\\d|\\s*[ap]\\.?\\s?m\\b)`, 'gi'), (m) => time(Number(m[1]), Number(m[2]))],
  [new RegExp(`(?<![\\d:.$])(\\d{1,2})\\s*${MERIDIEM}`, 'gi'), (m) => time(Number(m[1]), 0, m[2])],
  [/(?<![\d.])(\d{4})-(\d{2})-(\d{2})(?!\d)/g, (m) => date(Number(m[2]), Number(m[3]))],
  [new RegExp(`\\b${MONTH_NAME}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])`, 'gi'), (m) => date(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, Number(m[2]))],
  [new RegExp(`(?<![\\d:.$])(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_NAME}(?![a-z])`, 'gi'), (m) => date(MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, Number(m[1]))],
  [/(?<![\d/:.$])(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?(?![\d/])/g, (m) => date(Number(m[1]), Number(m[2]))],
  [/(\d+(?:\.\d+)?)\s*(?:°\s*F?|degrees?\b(?:\s*F\b|\s*fahrenheit\b)?|F\b)/gi, (m) => `temp ${Number(m[1])}f`],
  [
    /(?<![\d.$:])(\d+(?:\.\d+)?)(?:\s+|-)?((?:minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|percent)\b|%)/gi,
    (m) => {
      const unit = UNITS.find(([re]) => re.test(m[2].toLowerCase()));
      return unit ? `${unit[1]} ${Number(m[1])}` : null;
    },
  ],
];

// The normalized values in a text: money, times of day, calendar dates,
// temperatures, and numbers with a unit.
export function extractValues(text: string): Set<string> {
  const values = new Set<string>();
  for (const [pattern, toValue] of EXTRACTORS) {
    for (const m of text.matchAll(pattern)) {
      const v = toValue(m as RegExpExecArray);
      if (v) values.add(v);
    }
  }
  return values;
}

// True when every value in `text` appears in the cited sections' text.
export function isGrounded(text: string, cited: Section[]): boolean {
  const source = extractValues(cited.map((s) => s.text).join('\n'));
  return [...extractValues(text)].every((v) => source.has(v));
}
