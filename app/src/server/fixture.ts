// The fixture model (MODEL_MODE=fixture): no network, no files, no
// credentials. Every message gets a valid not_in_source handoff, so the UI
// and the fixture eval run end to end. It is not a quality signal.
//
// The browser tests script a reply by starting the message with
// `fixture:<reason> `, for the reasons in SCRIPTED. An unscripted message
// that a parent-visible section of the snapshot holds word for word is
// answered from that section, so publishing a section can make a replay
// answer. `pangolin` marks text the model wrote, so a test can prove no
// generated text is shown.

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

// The ID of the section whose body holds `message`, read from the snapshot
// text's `[id] Title (updated date)` blocks. Only parent-visible sections are
// in that text.
function sectionHolding(snapshotText: string, message: string): string | null {
  const wanted = message.trim();
  if (wanted === '') return null;
  for (const block of snapshotText.split(/\n\n(?=\[[^\]\n]+\] )/)) {
    const section = /^\[([^\]\n]+)\] [^\n]*\n([\s\S]*)$/.exec(block);
    if (section && section[2].includes(wanted)) return section[1];
  }
  return null;
}

export const fixtureModel: Model = async (request) => {
  const topic = request.message.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  const reason = /^fixture:(\w+) /.exec(request.message)?.[1];
  const scripted = reason && Object.hasOwn(SCRIPTED, reason) ? SCRIPTED[reason] : null;
  const holding = scripted ? null : sectionHolding(request.snapshotText, request.message);
  return {
    output: scripted
      ? { topic, gapLabel: null, ...scripted }
      : holding
        ? { outcome: 'answer', reason: 'answered', language: 'en', text: `Marker ${MARKER}: ${request.message.trim()}`, citations: [holding], topic, gapLabel: null }
        : { outcome: 'handoff', reason: 'not_in_source', text: '', citations: [], language: 'en', topic, gapLabel: null },
    usage: { input: 0, cachedInput: 0, output: 0 },
  };
};
