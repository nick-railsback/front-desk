// Floor lexicons, called directly (DESIGN 4.3). The pipeline tests in
// tests/pipeline/outcomes.test.ts cover each category's positive cases
// through ask(); these cover the precision edges, one message per branch.

import { describe, expect, test } from 'vitest';
import { floorFor } from '../../src/core/floors';

describe('everyday messages that name an urgent word without an emergency (feature-close F3)', () => {
  test.each([
    ['a device is not responding', 'The parent app is not responding when I try to pay tuition.'],
    ['a child is missing an item', 'My daughter is missing her jacket, did anyone find it?'],
    ['neglected to do something', 'I neglected to pack her lunch today. What happens?'],
    ['a high fever before pickup', 'She has a high fever today, so I will pick her up early. Do I need a note?'],
  ])('%s is not floored urgent', (_branch, message) => {
    expect(floorFor(message).floor).not.toBe('urgent');
  });
});

describe('the narrowed branches still fire on the emergency', () => {
  test.each([
    ['a child not responding', 'emergency', 'I found him on the floor and he is not responding.'],
    ['a missing child', 'safety', 'My daughter is missing. Nobody can find her.'],
    ['neglect', 'safety', 'I think the toddler room is neglecting the babies.'],
    ['a high adult at pickup', 'safety', 'Her uncle is high and on his way to pick her up.'],
  ])('%s', (_branch, reason, message) => {
    expect(floorFor(message)).toMatchObject({ floor: 'urgent', reason });
  });
});

describe('plain statements of an emergency (feature-close F5)', () => {
  test.each([
    ['trouble breathing', 'emergency', 'My son is having trouble breathing right now.'],
    ['will not wake up', 'emergency', 'She passed out and will not wake up.'],
    ['collapsed', 'emergency', 'My daughter collapsed in the hallway.'],
    ['swallowed a battery', 'emergency', 'I think he swallowed a battery from the toy.'],
    ['nobody can find a child', 'safety', 'Nobody can find my son at pickup.'],
    ['an adult showed up drunk', 'safety', 'Her father showed up drunk to get her.'],
  ])('%s', (_branch, reason, message) => {
    expect(floorFor(message)).toMatchObject({ floor: 'urgent', reason });
  });

  test('a late wake-up is not one', () => {
    expect(floorFor('She did not wake up until 9, so we are running late.').floor).toBe('answer');
  });
});
