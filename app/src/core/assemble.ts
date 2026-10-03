// The model input for one parent message: the six data sections rendered from
// structured data at `now`, then every parent-visible section of the snapshot,
// the current date, open gap labels, the last 2 exchanges, and the message.
// Expired content is filtered here, before the model sees it. Pure.

import type { Seed } from '../seed';
import { addDays, denverDate } from '../seed/dates';
import { INSTRUCTIONS } from './instructions';
import { activeAlerts, clockTime, isOpenDay, longDate, nextOpenDay } from './today';
import type { ModelRequest, Section, Turn } from './types';

type Structured = Seed['structured'];

export const MAX_OUTPUT_TOKENS = 400;
const CALENDAR_DAYS_AHEAD = 60;
const HISTORY_TURNS = 4;

function dataSection(id: string, title: string, today: string, lines: string[]): Section {
  return { id, title, visibility: 'parent', updatedOn: today, text: lines.join('\n') };
}

function calendarLines(structured: Structured, now: Date, today: string): string[] {
  const { calendar } = structured;
  const lines = [
    isOpenDay(today, calendar)
      ? `Today is ${longDate(today)}. The center is open today.`
      : `Today is ${longDate(today)}. The center is closed today. Next open day: ${longDate(nextOpenDay(today, calendar))}.`,
  ];
  const last = addDays(today, CALENDAR_DAYS_AHEAD);
  const upcoming = calendar.filter((e) => e.date >= today && e.date <= last).sort((a, b) => a.date.localeCompare(b.date));
  for (const e of upcoming) {
    const at = e.time ? ` at ${e.time}` : '';
    const status = e.status === 'closed' ? `CLOSED. Next open day: ${longDate(nextOpenDay(e.date, calendar))}.` : 'OPEN.';
    lines.push(`${longDate(e.date)}: ${e.name}${at}. ${status}`);
  }
  return lines;
}

// The six data sections, as rendered for a message at `now`.
export function renderDataSections(structured: Structured, now: Date): Section[] {
  const today = denverDate(now);
  const { center, programs, registrationFee, menus, alerts } = structured;
  const active = activeAlerts(alerts, now);
  return [
    dataSection('hours', 'Hours', today, [
      'The center is open Monday to Friday.',
      ...programs.map((p) => `${p.name} (${p.ages}): ${p.hours}.`),
    ]),
    dataSection('calendar', 'Calendar', today, calendarLines(structured, now, today)),
    dataSection(
      'menu',
      'Menu',
      today,
      menus.filter((m) => m.date >= today).map((m) => `${longDate(m.date)}: ${m.items.join('. ')}.`),
    ),
    dataSection('alerts', 'Alerts', today, active.length > 0 ? active.map((a) => a.text) : ['No alerts right now.']),
    dataSection('tuition', 'Tuition', today, [
      `Registration fee: ${registrationFee}.`,
      ...programs.map((p) => `${p.name} weekly tuition: ${p.weeklyTuition}.`),
    ]),
    dataSection('contacts', 'Contacts', today, [
      `Phone: ${center.phone}.`,
      `Email: ${center.email}.`,
      `Office hours: ${center.officeHours}.`,
      `Director: ${center.director}.`,
    ]),
  ];
}

export function buildModelRequest(input: {
  message: string;
  priorTurns: Turn[];
  now: Date;
  sections: Section[];
  openGapLabels: string[];
}): ModelRequest {
  const parentSections = input.sections.filter((s) => s.visibility === 'parent');
  return {
    instructions: INSTRUCTIONS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    currentDate: `${longDate(denverDate(input.now))}, ${clockTime(input.now)}`,
    snapshotText: parentSections.map((s) => `[${s.id}] ${s.title} (updated ${s.updatedOn})\n${s.text}`).join('\n\n'),
    openGapLabels: input.openGapLabels,
    history: input.priorTurns.slice(-HISTORY_TURNS),
    message: input.message,
  };
}
