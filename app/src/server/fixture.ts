// The fixture model (MODEL_MODE=fixture): no network, no files, no
// credentials. Every message gets a valid not_in_source handoff, so the UI
// and the fixture eval run end to end. It is not a quality signal.
//
// The browser tests script a reply by starting the message with
// `fixture:<reason> `, for the reasons in SCRIPTED. `pangolin` marks text the
// model wrote, so a test can prove no generated text is shown.

import type { Model } from '../core/types';

const MARKER = 'pangolin';

const SCRIPTED: Record<string, object> = {
  answered: { outcome: 'answer', reason: 'answered', language: 'en', text: `Marker ${MARKER}: breakfast is served until 8:30 AM.`, citations: ['meals', 'hours'] },
  // 6:15 AM is in no cited section, so grounding fails.
  grounding_failed: { outcome: 'answer', reason: 'answered', language: 'en', text: `Marker ${MARKER}: breakfast is served at 6:15 AM.`, citations: ['meals', 'calendar', 'menu'] },
  not_in_source: { outcome: 'handoff', reason: 'not_in_source', language: 'en', text: `${MARKER} has no answer.`, citations: [] },
  unsupported_language: { outcome: 'handoff', reason: 'unsupported_language', language: 'es', text: `${MARKER} no sabe.`, citations: [] },
  // Fails validation.
  system_error: { text: MARKER },
};

export const fixtureModel: Model = async (request) => {
  const topic = request.message.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  const reason = /^fixture:(\w+) /.exec(request.message)?.[1];
  const scripted = reason && Object.hasOwn(SCRIPTED, reason) ? SCRIPTED[reason] : null;
  return {
    output: scripted
      ? { topic, gapLabel: null, ...scripted }
      : { outcome: 'handoff', reason: 'not_in_source', text: '', citations: [], language: 'en', topic, gapLabel: null },
    usage: { input: 0, cachedInput: 0, output: 0 },
  };
};
