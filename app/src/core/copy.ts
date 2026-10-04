// Every user-facing string the pipeline chooses. Handoff and urgent replies
// are fixed text chosen by reason: reviewed once, never generated.

import { center } from '../seed/center';
import type { Reason } from './types';

export const PHONE = center.phone;
export const PHONE_HREF = `tel:+1${PHONE.replace(/\D/g, '')}`;

export const FIXED_TEXT: Record<Exclude<Reason, 'answered' | 'grounding_failed'>, string> = {
  not_in_source: `I don't have that in the center's information. Please call the front desk at ${PHONE}.`,
  sensitive: `A staff member should handle this one. Please call the front desk at ${PHONE}.`,
  system_error: `Sorry, something went wrong on our end. Please call the front desk at ${PHONE}.`,
  unsupported_language:
    `We can only answer questions in English right now. Please call the front desk at ${PHONE}. ` +
    `Por ahora solo podemos responder preguntas en inglés. Por favor llame a la recepción al ${PHONE}.`,
  emergency: `If this is an emergency, call 911 now. Then call the center at ${PHONE}.`,
  safety: `Please call the center right now at ${PHONE}. A staff member will act on this right away.`,
};

// The reply to a message over a limit. Its reason is system_error, but its
// text is its own, so a parent can tell "too much" from "broken".
export const LIMIT_NOTICE = `We can't answer this message here right now. Messages must be 500 characters or fewer, and there is a limit on how many we answer. Please call the front desk at ${PHONE}.`;

export const DEGRADED_PREFACE = "Here's what our handbook says:";

export const OFFICE_OPEN_LINE = 'The front desk will see this today.';

export function officeClosedLine(openingTime: string, day: string): string {
  return `The office is closed now. Staff will see this after ${openingTime} on ${day}.`;
}

// The gap label when the model names neither a label nor a topic.
export const FALLBACK_GAP_LABEL = 'Other questions';

// The Today card.
export const TODAY = {
  open: 'The center is open today.',
  weekend: 'the weekend',
  closed: (reason: string, nextOpenDay: string) => `Closed today for ${reason}. Next open day: ${nextOpenDay}.`,
};

export const NO_MENU = "Today's menu isn't posted yet";

// The parent view: every string it shows that is not a reply.
export const PARENT = {
  title: 'Front Desk',
  heading: `${center.name} Front Desk`,
  roles: 'View as',
  parent: 'Parent',
  operator: 'Operator',
  fictional: `${center.name} is a fictional center. The people, names and questions here are made up for this demo.`,
  today: `Today at ${center.name}`,
  hours: 'Hours today',
  menu: 'Menu',
  alerts: 'Alerts',
  conversation: 'Conversation',
  you: 'You:',
  frontDesk: 'Front desk:',
  inputLabel: 'Your question',
  placeholder: 'Ask about hours, meals, closures or tuition',
  send: 'Send',
  tooLong: 'Messages can be 500 characters or fewer. Shorten this one to send it.',
  typing: 'The front desk is typing',
  suggestionsLabel: 'Suggested questions',
  suggestions: [
    'What time do you open?',
    "What's for breakfast this week?",
    'Are you closed for Thanksgiving?',
    'What is the weekly tuition for preschool?',
    'Do I need to pack a lunch?',
  ],
  newConversation: 'New conversation',
  sendToFrontDesk: 'Send to front desk',
  sent: 'Sent to the front desk.',
  showMore: 'Show more',
  sources: 'Sources',
  updated: (date: string) => `Updated ${date}`,
  fromRecords: 'From center records',
  unavailable: "We can't show the front desk right now. Please call the front desk.",
};

// The operator view: every string it shows that is not a stored reply or a
// section's own text.
export const OPERATOR = {
  summary: 'Last 7 days',
  asked: 'questions asked',
  answered: 'answered',
  handoffs: 'handoffs',
  urgent: 'urgent',
  openGaps: 'open gaps',
  percent: (n: number) => `${n}%`,
  version: (n: number, date: string) => `Center info version ${n}, published ${date}`,
  publishHelp: "Publishing sends the new text to parents and checks the open gaps' questions again.",
  unpublished: 'Unpublished changes',
  publish: 'Publish',
  progressLabel: 'Replay progress',
  progress: (completed: number, total: number) => `Replayed ${completed} of ${total} questions`,
  areas: 'Areas',
  questions: 'Questions',
  gaps: 'Gaps',
  centerInfo: 'Center info',
  outcome: 'Outcome',
  all: 'All',
  outcomes: { answer: 'Answer', handoff: 'Handoff', urgent: 'Urgent' },
  sentToFrontDesk: 'Sent to front desk',
  cites: (titles: string) => `Sources: ${titles}`,
  noQuestions: 'No questions here yet.',
  reply: 'Reply as the parent saw it',
  close: 'Close',
  questionCount: (n: number) => (n === 1 ? '1 question' : `${n} questions`),
  lastAsked: (ago: string) => `Last asked ${ago}`,
  answerThis: 'Answer this',
  resolved: 'Resolved',
  result: (answered: number, replayed: number) => `${answered} of ${replayed} now answered`,
  noGaps: 'No open gaps right now.',
  addSection: 'Add section',
  edit: (title: string) => `Edit ${title}`,
  editLabel: 'Edit',
  visibility: { parent: 'Parent', staff: 'Staff' },
  newSection: 'New section',
  editSection: 'Edit section',
  titleLabel: 'Title',
  bodyLabel: 'Body',
  visibilityLabel: 'Visibility',
  save: 'Save',
  cancel: 'Cancel',
  phrasings: 'What parents asked',
  refused: 'This section was not saved. A title needs 1 to 80 characters, a body up to 4,000, and a visibility of Parent or Staff.',
  saveFailed: 'This section was not saved. Try again in a moment.',
  publishFailed: 'Nothing was published. Try again in a moment.',
  replayFailed: "We can't show the replay right now. Reload the page in a moment to see its results.",
  unavailable: "We can't show the operator view right now. Try again in a moment.",
};

// The demo's own controls on both views: the Try this strip and Reset demo
// (PRD D2, D5).
export const DEMO = {
  tryThis: 'Try this',
  // The first step's question belongs to the seeded Sibling discount gap.
  question: 'Do you offer a discount for siblings?',
  firstStep: 'Ask a gap question as a parent:',
  steps: ['Switch to Operator, then Gaps.', 'Answer the gap and publish.', 'Watch the replay.', 'Ask again as a parent.'],
  dismiss: 'Dismiss Try this',
  reset: 'Reset demo',
  resetTitle: 'Reset the demo?',
  resetBody: 'This deletes everything in this demo and starts a fresh copy of the center.',
  cancel: 'Cancel',
  confirm: 'Reset',
  resetFailed: 'The demo could not be reset. Try again in a moment.',
  failed: 'That did not work. Try again in a moment.',
};
