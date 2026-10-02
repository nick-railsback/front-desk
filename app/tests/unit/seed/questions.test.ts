// past questions: at least 30 parent questions, each asked within the 7 days
// before `now`, with every one of the 7 calendar dates before the creation
// date (America/Denver) holding at least one.
//
// replies: every question has exactly one reply. Each reply records snapshot
// version 1 and has one outcome and one reason forming an allowed pair. The
// mix includes at least one `answered`, at least two `sensitive`, exactly one
// `urgent` outcome, and exactly one `unsupported_language` reply whose
// question is not in English.
//
// gaps: exactly three open gaps, "Sibling discount" (7 questions),
// "Part-time schedules" (5), and "Summer program" (4). Every reply with
// reason `not_in_source` or `grounding_failed` is filed into exactly one gap,
// no other reply is filed into any gap, and every label is at most 8 words.
// "Do you offer a discount for siblings?" is one of the sibling questions.
//
// citations: every citation names a parent-visible section of snapshot 1,
// every `answered` reply has at least one, and none names the staff-only
// section.
//
// Assumed interface: `seed(now)` from app/src/seed/index.ts, with the Seed
// shape documented in ./support.ts: `questions[]` as
// `{ id, text, askedAt, reply: { text, outcome, reason, snapshotVersion,
// citations: { sectionId }[] } }` and `gaps[]` as
// `{ id, label, status: 'open', questionIds }`.

import { describe, expect, test } from 'vitest';
import { NOWS, ONE_NOW, addDays, denverDate, seedAt } from './support';

type Reply = { text: string; outcome: string; reason: string; snapshotVersion: number; citations: { sectionId: string }[] };
type Question = { id: string; text: string; askedAt: string; reply: Reply };
type Gap = { id: string; label: string; status: string; questionIds: string[] };
type Section = { id: string; visibility: string; title: string };

const PAIRS: Record<string, string[]> = {
  answer: ['answered', 'grounding_failed'],
  handoff: ['not_in_source', 'sensitive', 'unsupported_language', 'system_error'],
  urgent: ['emergency', 'safety'],
};

const GAPS: [string, number][] = [
  ['Sibling discount', 7],
  ['Part-time schedules', 5],
  ['Summer program', 4],
];

const GAP_REASONS = ['not_in_source', 'grounding_failed'];
const DAY_MS = 24 * 60 * 60 * 1000;

function questionsOf(s: { questions?: Question[] }): Question[] {
  expect(Array.isArray(s.questions), 'questions is not an array').toBe(true);
  expect(s.questions!.length, 'number of seeded questions').toBeGreaterThanOrEqual(30);
  return s.questions!;
}

function gapsOf(s: { gaps?: Gap[] }): Gap[] {
  expect(Array.isArray(s.gaps), 'gaps is not an array').toBe(true);
  return s.gaps!;
}

// Common English words that rarely appear as words in other languages.
const ENGLISH = ['the', 'you', 'your', 'what', 'when', 'where', 'how', 'does', 'can', 'will', 'and', 'have', 'with', 'this', 'that', 'there', 'about', 'please', 'should', 'would'];

function looksEnglish(text: string): boolean {
  const words = new Set(text.toLowerCase().match(/[a-z']+/g) ?? []);
  return ENGLISH.filter((w) => words.has(w)).length >= 2;
}

describe('past questions', () => {
  for (const { label, now } of NOWS) {
    test(`past questions: at least 30, all within the 7 days before now, every one of the 7 prior dates covered, now ${label}`, async () => {
      const qs = questionsOf(await seedAt(now));
      const creation = denverDate(now);
      const outside = qs
        .filter((q) => {
          const t = new Date(q.askedAt).getTime();
          return Number.isNaN(t) || t > now.getTime() || t < now.getTime() - 7 * DAY_MS;
        })
        .map((q) => `${q.id} at ${q.askedAt}`);
      expect(outside, `asked outside the 7 days before ${now.toISOString()}`).toEqual([]);
      const dates = new Set(qs.map((q) => denverDate(new Date(q.askedAt))));
      const uncovered = [1, 2, 3, 4, 5, 6, 7].map((i) => addDays(creation, -i)).filter((d) => !dates.has(d));
      expect(uncovered, `creation date ${creation}`).toEqual([]);
    });
  }

  test('past questions: question IDs are unique and every question has text', async () => {
    const qs = questionsOf(await seedAt(ONE_NOW.now));
    expect(new Set(qs.map((q) => q.id)).size).toBe(qs.length);
    for (const q of qs) expect(typeof q.text === 'string' && q.text.trim().length > 0, `question ${q.id} has no text`).toBe(true);
  });
});

describe('replies', () => {
  test('replies: every question has one reply recording snapshot version 1 and an allowed outcome and reason pair', async () => {
    const qs = questionsOf(await seedAt(ONE_NOW.now));
    const bad: string[] = [];
    for (const q of qs) {
      const r = q.reply;
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        bad.push(`${q.id}: no single reply`);
        continue;
      }
      if (r.snapshotVersion !== 1) bad.push(`${q.id}: snapshot version ${r.snapshotVersion}`);
      if (!(PAIRS[r.outcome] ?? []).includes(r.reason)) bad.push(`${q.id}: ${r.outcome} with ${r.reason}`);
      if (typeof r.text !== 'string' || r.text.trim() === '') bad.push(`${q.id}: reply has no text`);
    }
    expect(bad).toEqual([]);
  });

  test('replies: at least one answered, at least two sensitive, exactly one urgent, exactly one unsupported_language', async () => {
    const qs = questionsOf(await seedAt(ONE_NOW.now));
    const replies = qs.map((q) => q.reply);
    expect(replies.filter((r) => r?.reason === 'answered').length, 'answered replies').toBeGreaterThanOrEqual(1);
    expect(replies.filter((r) => r?.reason === 'sensitive').length, 'sensitive replies').toBeGreaterThanOrEqual(2);
    expect(replies.filter((r) => r?.outcome === 'urgent').length, 'urgent replies').toBe(1);
    expect(replies.filter((r) => r?.reason === 'unsupported_language').length, 'unsupported_language replies').toBe(1);
  });

  test('replies: the unsupported_language question is not in English', async () => {
    const qs = questionsOf(await seedAt(ONE_NOW.now));
    const q = qs.filter((x) => x.reply?.reason === 'unsupported_language');
    expect(q.length, 'unsupported_language replies').toBe(1);
    expect(q[0].text).toMatch(/\p{L}{2,}/u);
    expect(looksEnglish(q[0].text), `reads as English: ${q[0].text}`).toBe(false);
  });
});

describe('gaps', () => {
  test('gaps: exactly three open gaps with 7, 5, and 4 questions', async () => {
    const s = await seedAt(ONE_NOW.now);
    const gaps = gapsOf(s);
    expect(gaps.map((g) => [g.label, g.status, g.questionIds?.length]).sort()).toEqual(GAPS.map(([l, n]) => [l, 'open', n]).sort());
  });

  test('gaps: every not_in_source or grounding_failed reply is filed into exactly one gap, and no other reply is', async () => {
    const s = await seedAt(ONE_NOW.now);
    const qs = questionsOf(s);
    const gaps = gapsOf(s);
    expect(gaps.length, 'there are no gaps to file into').toBeGreaterThan(0);
    const ids = new Set(qs.map((q) => q.id));
    const filed = new Map<string, number>();
    for (const g of gaps) for (const id of g.questionIds ?? []) filed.set(id, (filed.get(id) ?? 0) + 1);
    expect([...filed.keys()].filter((id) => !ids.has(id)), 'gaps name questions that do not exist').toEqual([]);
    const wrong: string[] = [];
    for (const q of qs) {
      const n = filed.get(q.id) ?? 0;
      const want = GAP_REASONS.includes(q.reply?.reason) ? 1 : 0;
      if (n !== want) wrong.push(`${q.id} (${q.reply?.reason}) is in ${n} gaps`);
    }
    expect(wrong).toEqual([]);
    expect(qs.filter((q) => GAP_REASONS.includes(q.reply?.reason)).length).toBe(16);
  });

  test('gaps: every gap label is at most 8 words', async () => {
    const gaps = gapsOf(await seedAt(ONE_NOW.now));
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) expect(g.label.trim().split(/\s+/).length, g.label).toBeLessThanOrEqual(8);
  });

  test('gaps: the sibling discount gap holds "Do you offer a discount for siblings?" exactly as written', async () => {
    const s = await seedAt(ONE_NOW.now);
    const qs = questionsOf(s);
    const gap = gapsOf(s).find((g) => g.label === 'Sibling discount');
    expect(gap, 'no Sibling discount gap').toBeTruthy();
    const texts = qs.filter((q) => gap!.questionIds.includes(q.id)).map((q) => q.text);
    expect(texts).toContain('Do you offer a discount for siblings?');
  });
});

describe('citations', () => {
  test('citations: every citation names a parent-visible section of snapshot 1, never the staff-only section', async () => {
    const s = await seedAt(ONE_NOW.now);
    const qs = questionsOf(s);
    const snap = (s.snapshots ?? []).find((x: { version: number }) => x.version === 1);
    expect(snap, 'no snapshot 1').toBeTruthy();
    const sections: Section[] = snap.sections ?? [];
    const parentIds = new Set(sections.filter((x) => x.visibility === 'parent').map((x) => x.id));
    const staffIds = new Set(sections.filter((x) => x.visibility === 'staff').map((x) => x.id));
    expect(staffIds.size, 'snapshot 1 has no staff-only section').toBeGreaterThan(0);
    const citations = qs.flatMap((q) => (q.reply?.citations ?? []).map((c) => ({ q: q.id, id: c.sectionId })));
    expect(citations.length, 'no seeded reply has a citation').toBeGreaterThan(0);
    expect(citations.filter((c) => staffIds.has(c.id)), 'citations of the staff-only section').toEqual([]);
    expect(citations.filter((c) => !parentIds.has(c.id)), 'citations that name no parent-visible section of snapshot 1').toEqual([]);
  });

  test('citations: every answered reply has at least one citation', async () => {
    const qs = questionsOf(await seedAt(ONE_NOW.now));
    const answered = qs.filter((q) => q.reply?.reason === 'answered');
    expect(answered.length, 'answered replies').toBeGreaterThan(0);
    expect(answered.filter((q) => !Array.isArray(q.reply.citations) || q.reply.citations.length === 0).map((q) => q.id)).toEqual([]);
  });
});
