// center facts: the seeded structured data holds the demo center's details,
// its three programs, and its registration fee exactly as the center states
// them.
//
// Assumed interface: `seed(now)` from app/src/seed/index.ts, with the Seed
// shape documented in ./support.ts. Facts are searched in the serialized
// `structured.center`, each `structured.programs` entry, and
// `structured.registrationFee`, so extra fields are allowed. Times of day may
// be written as "7:30 AM" or "07:30"; money as "$385" or 385 (dollars).

import { describe, expect, test } from 'vitest';
import { ONE_NOW, leaves, literal, normalize, seedAt, timeOfDay } from './support';

function text(value: unknown): string {
  return normalize(leaves(value).join(' | '));
}

// "Monday to Friday" in words, or a list of days that is exactly Monday to Friday.
function mondayToFriday(value: string): boolean {
  if (/monday\s*(to|through|thru|-)\s*friday/i.test(value)) return true;
  const named = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].every((d) => new RegExp(`\\b${d}\\b`, 'i').test(value));
  const weekend = /\b(saturday|sunday)\b/i.test(value);
  return named && !weekend;
}

function dollars(amount: number): RegExp {
  return new RegExp(`(?<![\\d.])\\$?${amount}(?:\\.00)?(?![\\d])`);
}

describe('center details', () => {
  test('center details: name, city, timezone, phone, email, and director', async () => {
    const s = await seedAt(ONE_NOW.now);
    const center = s.structured?.center;
    expect(center, 'structured.center is missing').toBeTruthy();
    const t = text(center);
    for (const fact of [
      'Juniper Hill Early Learning Center',
      'Cedar Mesa',
      'America/Denver',
      '(505) 555-0142',
      'frontdesk@juniperhill.example',
      'Dana Whitfield',
    ]) {
      expect(t.includes(fact), `structured.center does not state ${fact}: ${t}`).toBe(true);
    }
  });

  test('center details: office hours are Monday to Friday, 7:00 AM to 5:30 PM', async () => {
    const s = await seedAt(ONE_NOW.now);
    const t = text(s.structured?.center);
    expect(t, 'structured.center is empty').not.toBe('');
    expect(mondayToFriday(t), `office hours are not Monday to Friday: ${t}`).toBe(true);
    expect(t, 'office hours do not open at 7:00 AM').toMatch(timeOfDay('7:00 AM'));
    expect(t, 'office hours do not close at 5:30 PM').toMatch(timeOfDay('5:30 PM'));
  });
});

describe('programs', () => {
  test('programs: exactly the three program IDs', async () => {
    const s = await seedAt(ONE_NOW.now);
    const programs = s.structured?.programs;
    expect(Array.isArray(programs), 'structured.programs is not an array').toBe(true);
    expect(programs.map((p: { id: string }) => p.id).sort()).toEqual(['infant-toddler', 'prek', 'preschool']);
  });

  const expected: { id: string; ages: string; opens: string[]; closes: string; tuition: number }[] = [
    { id: 'infant-toddler', ages: '6 weeks to 3 years', opens: ['7:30 AM'], closes: '5:30 PM', tuition: 385 },
    { id: 'preschool', ages: '3 to 5 years', opens: ['7:00 AM'], closes: '5:30 PM', tuition: 295 },
    { id: 'prek', ages: '4 years old by September 1', opens: ['8:00 AM', '2:30 PM'], closes: '5:30 PM', tuition: 95 },
  ];

  for (const p of expected) {
    test(`programs: ${p.id} states its ages, Monday-to-Friday hours, and weekly tuition`, async () => {
      const s = await seedAt(ONE_NOW.now);
      const program = (s.structured?.programs ?? []).find((x: { id: string }) => x.id === p.id);
      expect(program, `no program with id ${p.id}`).toBeTruthy();
      const t = text(program);
      expect(t, `${p.id} does not state its age range`).toMatch(literal(p.ages));
      expect(mondayToFriday(t), `${p.id} hours are not Monday to Friday: ${t}`).toBe(true);
      for (const o of p.opens) expect(t, `${p.id} does not state ${o}`).toMatch(timeOfDay(o));
      expect(t, `${p.id} does not state ${p.closes}`).toMatch(timeOfDay(p.closes));
      expect(t, `${p.id} does not state weekly tuition of $${p.tuition}`).toMatch(dollars(p.tuition));
    });
  }

  test('programs: Pre-K separates a state-funded core day from paid extended care', async () => {
    const s = await seedAt(ONE_NOW.now);
    const prek = (s.structured?.programs ?? []).find((x: { id: string }) => x.id === 'prek');
    expect(prek, 'no program with id prek').toBeTruthy();
    const t = text(prek);
    expect(t, 'Pre-K does not name its core day').toMatch(/core/i);
    expect(t, 'Pre-K core day is not state-funded').toMatch(/state[\s-]?funded/i);
    expect(t, 'Pre-K core day does not say there is no tuition').toMatch(/no tuition/i);
    expect(t, 'Pre-K does not name extended care').toMatch(/extended/i);
  });
});

describe('registration fee', () => {
  test('registration fee: $75 per child per year', async () => {
    const s = await seedAt(ONE_NOW.now);
    const fee = s.structured?.registrationFee;
    expect(fee, 'structured.registrationFee is missing').toBeTruthy();
    const t = text(fee);
    expect(t).toMatch(dollars(75));
    expect(t, 'the fee is not stated per child').toMatch(/child/i);
    expect(t, 'the fee is not stated per year').toMatch(/year/i);
  });
});
