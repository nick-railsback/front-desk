// The fixture model (MODEL_MODE=fixture): no network, no files, no
// credentials. Every message gets a valid not_in_source handoff, so the UI
// and the fixture eval run end to end. It is not a quality signal.

import type { Model } from '../core/types';

export const fixtureModel: Model = async (request) => ({
  output: {
    outcome: 'handoff',
    reason: 'not_in_source',
    text: '',
    citations: [],
    language: 'en',
    topic: request.message.split(/\s+/).filter(Boolean).slice(0, 6).join(' '),
    gapLabel: null,
  },
  usage: { input: 0, cachedInput: 0, output: 0 },
});
