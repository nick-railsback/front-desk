// Grounding normalization, called directly (DESIGN 4.7). The pipeline tests
// in tests/pipeline/answers.test.ts cover accepted and rejected answers
// through ask(); these cover forms the extractor read wrongly, one per form.

import { describe, expect, test } from 'vitest';
import { isGrounded } from '../../src/core/grounding';
import type { Section } from '../../src/core/types';

const cited = (text: string): Section[] => [{ id: 'hours', title: 'Hours', visibility: 'parent', updatedOn: '2026-10-01', text }];

describe('values the extractor skipped (review F17)', () => {
  test.each([
    ['money written as dollars', 'The late fee is 50 dollars.', 'The late fee is $15 per 5 minutes.'],
    ['an impossible 12-hour time', 'We close at 17:30 PM.', 'We close at 5:30 PM.'],
  ])('%s that the source does not hold is not grounded', (_form, answer, source) => {
    expect(isGrounded(answer, cited(source))).toBe(false);
  });

  test('money written as dollars that the source holds is grounded', () => {
    expect(isGrounded('The late fee is 15 dollars.', cited('The late fee is $15 per 5 minutes.'))).toBe(true);
  });
});

// A bare "5:30" may be morning or evening (review F18).
describe('a time with no AM or PM', () => {
  test('is grounded by the source time it can be read as', () => {
    expect(isGrounded('We are open 7:00-5:30 on weekdays.', cited('Open 7:00 AM to 5:30 PM, Monday to Friday.'))).toBe(true);
  });

  test('is not grounded by a source that holds neither reading', () => {
    expect(isGrounded('We close at 5:30.', cited('We close at 6:30 PM.'))).toBe(false);
  });
});
