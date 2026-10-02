// fictional contact data: every phone number anywhere in the seed is in the
// 555-0100 to 555-0199 range, and every email address and URL uses an
// `.example` domain. Every string and number leaf of the seed is searched, so
// the check does not depend on which field holds a value.
//
// uncovered subjects: no section title or text (published or draft) and no
// structured data mentions siblings, part-time schedules, or a summer
// program. Questions, replies, and gap labels are free to.
//
// clock independence: `seed(now)` is a pure function of `now`. Two calls with
// the same `now` agree, and moving the system clock changes nothing.
//
// Assumed interface: `seed(now)` from app/src/seed/index.ts, with the Seed
// shape documented in ./support.ts.

import { afterEach, describe, expect, test, vi } from 'vitest';
import { SUBJECTS, hosts, inRange, phoneNumbers } from './patterns';
import { NOWS, ONE_NOW, canonical, leaves, normalize, seedAt } from './support';

afterEach(() => {
  vi.useRealTimers();
});

type Section = { title: string; text: string };

describe('fictional contact data', () => {
  for (const { label, now } of [ONE_NOW, NOWS[NOWS.length - 1]]) {
    test(`fictional contact data: every phone number is in 555-0100 to 555-0199, now ${label}`, async () => {
      const s = await seedAt(now);
      const found = phoneNumbers(leaves(s));
      expect(found.length, 'the seed holds no phone number at all').toBeGreaterThan(0);
      expect(found.filter((p) => !inRange(p))).toEqual([]);
    });

    test(`fictional contact data: every email address and URL uses an .example domain, now ${label}`, async () => {
      const s = await seedAt(now);
      const { emails, urls } = hosts(leaves(s));
      expect(emails.length, 'the seed holds no email address').toBeGreaterThan(0);
      expect(urls.length, 'the seed holds no URL').toBeGreaterThan(0);
      expect(emails.filter((h) => !h.endsWith('.example')), 'email domains').toEqual([]);
      expect(urls.filter((h) => !h.endsWith('.example')), 'URL hosts').toEqual([]);
    });
  }
});

describe('uncovered subjects', () => {
  test('uncovered subjects: no section title or text and no structured data mentions siblings, part-time schedules, or a summer program', async () => {
    const s = await seedAt(ONE_NOW.now);
    const sections: Section[] = [...(s.snapshots ?? []).flatMap((x: { sections: Section[] }) => x.sections ?? []), ...(s.draft?.sections ?? [])];
    expect(sections.length, 'the seed has no sections').toBeGreaterThan(0);
    expect(s.structured, 'the seed has no structured data').toBeTruthy();
    const texts = [...sections.flatMap((x) => [x.title, x.text]), ...leaves(s.structured)].map((t) => normalize(String(t ?? '')));
    const hits: string[] = [];
    for (const t of texts) for (const [subject, re] of SUBJECTS) if (re.test(t)) hits.push(`${subject}: ${t.match(re)![0]}`);
    expect(hits).toEqual([]);
  });
});

describe('clock independence', () => {
  test('clock independence: the same now always yields the same seed', async () => {
    const a = await seedAt(ONE_NOW.now);
    const b = await seedAt(new Date(ONE_NOW.now.getTime()));
    expect(canonical(b)).toEqual(canonical(a));
  });

  test('clock independence: moving the system clock does not change the seed', async () => {
    const before = await seedAt(ONE_NOW.now);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2041-07-04T12:00:00Z'));
    const after = await seedAt(ONE_NOW.now);
    vi.useRealTimers();
    expect(canonical(after)).toEqual(canonical(before));
  });
});
