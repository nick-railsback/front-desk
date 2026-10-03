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
