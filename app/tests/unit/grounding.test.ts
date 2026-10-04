// Grounding normalization, called directly (DESIGN 4.7). The pipeline tests
// in tests/pipeline/answers.test.ts cover accepted and rejected answers
// through ask(); these cover forms the extractor read wrongly, one per form.

import { describe, expect, test } from 'vitest';
import { isGrounded } from '../../src/core/grounding';
import type { Section } from '../../src/core/types';

const cited = (text: string): Section[] => [{ id: 'hours', title: 'Hours', visibility: 'parent', updatedOn: '2026-10-01', text }];

describe('values the extractor skipped (feature-close F17)', () => {
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
