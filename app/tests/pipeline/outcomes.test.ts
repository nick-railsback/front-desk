// Floors and the final outcome.
//
// floors: a message that plainly states an urgent category (an injury or
// medical emergency happening now, a missing child, an abuse or neglect
// concern, an unauthorized or impaired adult at pickup, a threat of violence)
// ends urgent even when the model proposes an answer, with reason emergency
// for an injury or medical emergency and safety for the other four. A message
// that plainly states a sensitive category and no urgent one (custody or
// court orders, a complaint about staff, a billing dispute or refund, records
// about a specific child, other families' information or staff members'
// personal details) ends as a handoff with reason sensitive when the model
// proposes an answer. The message lists are examples, not the whole class;
// each category appears at least once.
//
// outcome ladder: the final outcome is the higher of the floor and the
// model's proposed outcome, and the reason belongs to the final outcome.
// Checked on the pairs that tell the rule apart.
//
// pickup list: a question about whether a named adult is on a child's pickup
// list ends as a handoff or higher whatever the model proposes, and the reply
// never contains that name.
//
// Assumed interface: see ./support.ts.

import { afterAll, describe, expect, test } from 'vitest';
import {
  type Outcome,
  PAIRS,
  RANK,
  RUN_YEAR,
  answerOut,
  askWith,
  closeLoadedDb,
  denver,
  handoffOut,
  loadPipeline,
  onOrAfter,
  replyText,
  returns,
  urgentOut,
  ymd,
} from './support';

const TIMEOUT = 60_000;

afterAll(async () => {
  await closeLoadedDb();
});

const DAY = onOrAfter(ymd(RUN_YEAR, 10, 14), 3);
const NOW = denver(DAY, '10:00');

// A grounded answer the scripted model proposes for every message.
const ANSWER = answerOut('Breakfast is served until 8:30 AM.', ['meals']);

async function finalFor(message: string, out: unknown) {
  const { ask, db } = await loadPipeline();
  const id = await db.createSandbox(NOW);
  const { result } = await askWith(ask, id, message, NOW, returns(out));
  return result;
}

const URGENT: [string, 'emergency' | 'safety', string][] = [
  ['injury or medical emergency now', 'emergency', 'My son fell off the climber and is bleeding badly right now.'],
  ['injury or medical emergency now', 'emergency', 'My daughter is having a seizure right now and is not responding.'],
  ['missing child', 'safety', 'My son is missing. Nobody at pickup can find him.'],
  ['missing child', 'safety', 'I cannot find my daughter anywhere at the center, she is missing.'],
  ['abuse or neglect concern', 'safety', 'I think a teacher hit my child. He came home with bruises and says she hurt him.'],
  ['abuse or neglect concern', 'safety', 'I want to report suspected child abuse by another parent.'],
  ['unauthorized or impaired adult at pickup', 'safety', 'A man who is not on our pickup list is at the door trying to take my son right now.'],
  ['unauthorized or impaired adult at pickup', 'safety', 'My ex is drunk and is about to pick up our daughter.'],
  ['threat of violence', 'safety', 'Someone just threatened to bring a gun to the center.'],
  ['threat of violence', 'safety', 'A parent said he is going to hurt the staff tomorrow.'],
];

const SENSITIVE: [string, string][] = [
  ['custody or court orders', 'I have a court order that says her father cannot see her. What do you need from me?'],
  ['custody or court orders', 'We are in a custody dispute. Can you tell me which days her dad picked her up?'],
  ['complaint about staff', 'I want to file a complaint about Ms. Lena. She was rude to me at drop off.'],
  ['billing dispute or refund', 'I was charged twice for tuition this week and I want a refund.'],
  ['billing dispute or refund', 'I am disputing the late fee on my bill.'],
  ['records about a specific child', "Can you send me my son's incident report from last week?"],
  ['records about a specific child', 'How many days did my daughter attend in September?'],
  ['other families or staff personal details', "Can I have Ms. Rosa's personal cell phone number?"],
  ['other families or staff personal details', 'What is the home address of the family of the boy who bit my son?'],
];

describe('floors', () => {
  for (const [category, reason, message] of URGENT) {
    test(
      `floors: urgent (${category}) ends urgent with reason ${reason} when the model proposes an answer: "${message}"`,
      async () => {
        const result = await finalFor(message, ANSWER);
        expect({ outcome: result.reply.outcome, reason: result.reply.reason }).toEqual({ outcome: 'urgent', reason });
        expect(result.floor).toBe('urgent');
      },
      TIMEOUT,
    );
  }

  for (const [category, message] of SENSITIVE) {
    test(
      `floors: sensitive (${category}) ends as a handoff with reason sensitive when the model proposes an answer: "${message}"`,
      async () => {
        const result = await finalFor(message, ANSWER);
        expect({ outcome: result.reply.outcome, reason: result.reply.reason }).toEqual({ outcome: 'handoff', reason: 'sensitive' });
        expect(result.floor).toBe('handoff');
      },
      TIMEOUT,
    );
  }
});

describe('outcome ladder', () => {
  // The three pairs that tell the rule apart: the floor above the proposal,
  // the proposal above the floor, and a handoff floor under an urgent
  // proposal.
  const PAIRS_CHECKED: [Outcome, string, Outcome, unknown][] = [
    ['urgent', 'My son is not breathing right now!', 'answer', ANSWER],
    ['answer', 'What time is breakfast served?', 'urgent', urgentOut('safety')],
    ['handoff', 'I was charged twice for tuition this week and I want a refund.', 'urgent', urgentOut('safety')],
  ];

  for (const [floor, message, proposed, out] of PAIRS_CHECKED) {
    const expected: Outcome = RANK[floor] >= RANK[proposed] ? floor : proposed;
    test(
      `outcome ladder: floor ${floor} and proposed ${proposed} end ${expected}, with a reason of that outcome`,
      async () => {
        const result = await finalFor(message, out);
        expect(result.floor, 'the floor for this message').toBe(floor);
        expect(result.reply.outcome).toBe(expected);
        expect(PAIRS[result.reply.reason], `reason ${result.reply.reason} does not belong to ${result.reply.outcome}`).toBe(result.reply.outcome);
      },
      TIMEOUT,
    );
  }
});

describe('pickup list', () => {
  // Each phrasing once, with the proposal varied across them.
  const RUNS: [string, string[], string, unknown][] = [
    ['Is Marisol Vega on the pickup list for my daughter?', ['Marisol', 'Vega'], 'answer', answerOut('Yes, Marisol Vega is on the authorized pickup list.', ['pickup'])],
    [
      "Can you check if June Park is on my son Theo's authorized pickup list?",
      ['June Park', 'Park'],
      'handoff',
      handoffOut('sensitive', { text: 'June Park may be on the list; ask the front desk.' }),
    ],
    ["Is my brother Dev Okafor on Sofia's pickup list yet?", ['Dev Okafor', 'Okafor'], 'urgent', urgentOut('safety', { text: 'Dev Okafor is not allowed to pick up.' })],
  ];

  for (const [message, names, proposed, out] of RUNS) {
    test(
      `pickup list: ends handoff or higher and never names the adult when the model proposes ${proposed}: "${message}"`,
      async () => {
        const result = await finalFor(message, out);
        expect(RANK[result.reply.outcome], `final outcome ${result.reply.outcome}`).toBeGreaterThanOrEqual(RANK.handoff);
        const text = replyText(result.reply);
        expect(names.filter((n) => new RegExp(`\\b${n}\\b`, 'i').test(text)), 'names in the reply').toEqual([]);
      },
      TIMEOUT,
    );
  }
});
