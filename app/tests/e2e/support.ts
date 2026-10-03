// Shared helpers for the parent view browser tests. Not a test file:
// Playwright collects only *.spec.ts.
//
// Assumed interface. The tests hold the implementation to these contracts.
//
// 1. Scripted replies in fixture mode (MODEL_MODE=fixture). The fixture model
//    in app/src/server/fixture.ts keeps its current output for every message
//    except one whose text starts with `fixture:<reason>` followed by a space,
//    for these five reasons. MARKER is in no section and no fixed text.
//
//      fixture:answered            { outcome: 'answer', reason: 'answered', language: 'en',
//                                    text: ANSWERED_TEXT, citations: ['meals', 'hours'] }
//      fixture:grounding_failed    { outcome: 'answer', reason: 'answered', language: 'en',
//                                    text: UNGROUNDED_TEXT, citations: ['meals', 'calendar', 'menu'] }
//                                  The pipeline finds 6:15 AM in no cited section, so the
//                                  reply is grounding_failed. `menu` is always over 600
//                                  characters; `calendar` is on some dates.
//      fixture:not_in_source       { outcome: 'handoff', reason: 'not_in_source', language: 'en',
//                                    text: `${MARKER} ...`, citations: [] }
//      fixture:unsupported_language { outcome: 'handoff', reason: 'unsupported_language',
//                                    language: 'es', text: `${MARKER} ...`, citations: [] }
//      fixture:system_error        output that fails validation and carries MARKER, for
//                                  example { text: MARKER }
//
//    topic and gapLabel are free. Floors still run first: `fixture:answered`
//    with a sensitive phrase is a sensitive handoff, and with an urgent phrase
//    an urgent reply.
//
// 2. The page at / sets the same HttpOnly cookie /api/ask reads, `fd_sandbox`,
//    whose value is the sandbox ID.
//
// 3. Roles and names in the parent view:
//    - the Today card is a region whose accessible name contains "Today";
//    - the conversation is the element with role `log`; replies render in it;
//    - the message input is the only textbox on the page;
//    - the send control is a button named "Send" (or "Send message");
//    - while a reply is pending, an element whose text or aria-label contains
//      "typing" is shown;
//    - each citation chip is a button with aria-expanded in the conversation;
//      a Show more control is a button named "Show more";
//    - Send to front desk is a button or link named "Send to front desk";
//      "New conversation" is a button;
//    - the phone link is an <a> whose href is a tel: URL ending in 5055550142;
//    - the role switcher holds controls (link, button or tab) named "Parent"
//      and "Operator".
//
// 4. Sending a stored reply to the front desk: POST /api/send with JSON body
//    { replyId: string }, the reply's stored turn ID, for the sandbox named by
//    the fd_sandbox cookie. 200 { sent: true } when this request marked it;
//    200 { sent: false } when nothing changed (already sent, unknown ID, or a
//    reply of another sandbox). The UI's Send to front desk issues this
//    request. The mark is turns.sent_to_front_desk: null or false until sent,
//    non-null and not false after.

import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import pg from 'pg';
import { FIXED_TEXT, LIMIT_NOTICE } from '../../src/core/copy';
import type { CalendarEntry } from '../../src/seed';

export const COOKIE = 'fd_sandbox';
export const PHONE = '(505) 555-0142';
export const PHONE_DIGITS = '5055550142';
export const MARKER = 'pangolin';
export const ANSWERED_TEXT = `Marker ${MARKER}: breakfast is served until 8:30 AM.`;
export const UNGROUNDED_TEXT = `Marker ${MARKER}: breakfast is served at 6:15 AM.`;
export const SENT_TEXT = 'Sent to the front desk.';
export const OPEN_LINE = 'The front desk will see this today.';
export const CLOSED_LINE = /The office is closed now\. Staff will see this after .{1,20}? on .{1,60}?\./g;

export const TRIGGER = {
  answered: 'fixture:answered When is breakfast served?',
  grounding_failed: 'fixture:grounding_failed When is breakfast served?',
  not_in_source: 'fixture:not_in_source Do you have a swimming pool?',
  unsupported_language: 'fixture:unsupported_language A que hora abren ustedes?',
  system_error: 'fixture:system_error What time do you open?',
  // A sensitive floor raises a proposed answer to a handoff.
  sensitive: 'fixture:answered I was charged twice and want a refund.',
  // Urgent floors answer before the model is asked.
  emergency: 'fixture:answered My daughter is not breathing.',
  safety: "fixture:answered I can't find my son.",
} as const;

export type ReasonName = keyof typeof TRIGGER;
export const HANDOFF_REASONS = ['not_in_source', 'sensitive', 'unsupported_language', 'system_error'] as const;
export const URGENT_REASONS = ['emergency', 'safety'] as const;
export const ALL_REASONS: ReasonName[] = [
  'answered',
  'grounding_failed',
  'not_in_source',
  'sensitive',
  'unsupported_language',
  'system_error',
  'emergency',
  'safety',
];

// ---------------------------------------------------------------------------
// Text.

export function normalize(text: string): string {
  return String(text ?? '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function digits(text: string): string {
  return String(text).replace(/\D/g, '');
}

// A fixed text without its phone number, in the pieces around it, so the
// number may render as its own link.
export function fragments(fixed: string): string[] {
  return fixed
    .split(PHONE)
    .map((p) => normalize(p))
    .filter((p) => /[A-Za-z]{3}/.test(p));
}

export function fixedTextOf(reason: Exclude<ReasonName, 'answered' | 'grounding_failed'>): string {
  return FIXED_TEXT[reason];
}

export function limitNotice(): string {
  return LIMIT_NOTICE;
}

export async function visibleText(locator: Locator): Promise<string> {
  return normalize(await locator.innerText());
}

export async function expectFragments(locator: Locator, fixed: string, what: string): Promise<void> {
  const text = await visibleText(locator);
  for (const f of fragments(fixed)) expect(text, `${what}: the fixed text "${f}" is not shown`).toContain(f);
}

// Expectation lines in a text: how many of each form, and the closed ones.
export function expectationLines(text: string): { open: number; closed: string[] } {
  const t = normalize(text);
  return { open: t.split(OPEN_LINE).length - 1, closed: [...t.matchAll(CLOSED_LINE)].map((m) => m[0]) };
}

// Every way a careful writer might show a calendar date.
export function datePattern(date: string): RegExp {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const [y, m, d] = date.split('-').map(Number);
  const month = MONTHS[m - 1];
  const name = `(?:${month}|${month.slice(0, 3)}\\.?${month === 'September' ? '|Sept\\.?' : ''})`;
  const day = `0?${d}(?:st|nd|rd|th)?`;
  return new RegExp(
    [
      `(?<!\\d)${date}(?!\\d)`,
      `\\b${name}\\s+${day}(?![\\d:])`,
      `(?<![\\d:])${day}\\s+(?:of\\s+)?${name}\\b`,
      `(?<![\\d/:.$])0?${m}/0?${d}(?:/(?:${y}|${String(y).slice(2)}))?(?![\\d/])`,
    ].join('|'),
    'i',
  );
}

// ---------------------------------------------------------------------------
// The parent view.

export function todayCard(page: Page): Locator {
  return page.getByRole('region', { name: /today/i });
}

export function conversation(page: Page): Locator {
  return page.getByRole('log');
}

export function messageInput(page: Page): Locator {
  return page.getByRole('textbox');
}

export function sendButton(page: Page): Locator {
  return page.getByRole('button', { name: /^send( message)?$/i });
}

export function typingIndicator(page: Page): Locator {
  return page.getByLabel(/typing/i).or(page.getByText(/typing/i)).filter({ visible: true });
}

export function sendToFrontDesk(scope: Page | Locator): Locator {
  return scope.getByRole('button', { name: /send to front desk/i }).or(scope.getByRole('link', { name: /send to front desk/i }));
}

export function chips(scope: Locator): Locator {
  return scope.locator('button[aria-expanded]').filter({ hasNotText: /show more/i });
}

export function showMore(scope: Locator): Locator {
  return scope.getByRole('button', { name: /show more/i });
}

export function newConversation(page: Page): Locator {
  return page.getByRole('button', { name: /new conversation/i });
}

export function suggestions(page: Page): Locator {
  return page.getByRole('button', { name: /\?\s*$/ });
}

export function phoneLinks(scope: Page | Locator): Locator {
  return scope.locator('a[href^="tel:"]');
}

export async function expectPhoneLink(scope: Page | Locator, what: string): Promise<void> {
  const links = phoneLinks(scope);
  await expect(links.first(), `${what}: no tap-to-call link`).toBeVisible();
  const hrefs = await links.evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  expect(
    hrefs.some((h) => digits(h).endsWith(PHONE_DIGITS)),
    `${what}: no tel: link for ${PHONE} (found ${hrefs.join(', ')})`,
  ).toBe(true);
}

export async function open(page: Page): Promise<void> {
  await page.goto('/');
  await expect(todayCard(page), 'the parent view shows no Today card').toBeVisible();
}

// Sends one message through the UI and waits for /api/ask to answer.
export async function ask(page: Page, message: string): Promise<void> {
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/ask') && r.request().method() === 'POST');
  await messageInput(page).fill(message);
  await sendButton(page).click();
  await answered;
  await expect(typingIndicator(page)).toHaveCount(0);
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

// Records what every DOM update adds, and what reaches a live region, one
// entry per mutation callback. Install before the first navigation.
export async function recordUpdates(context: BrowserContext | Page): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as { __updates: string[]; __live: string[] };
    w.__updates = [];
    w.__live = [];
    const LIVE_ROLES = new Set(['log', 'status', 'alert']);
    const live = (node: Node | null): boolean => {
      let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
      while (el) {
        const aria = el.getAttribute('aria-live');
        if (aria) return aria !== 'off';
        if (LIVE_ROLES.has(el.getAttribute('role') ?? '') || el.tagName === 'OUTPUT') return true;
        el = el.parentElement;
      }
      return false;
    };
    new MutationObserver((records) => {
      const all: string[] = [];
      const inLive: string[] = [];
      for (const r of records) {
        if (r.type === 'characterData') {
          const t = (r.target as CharacterData).data;
          all.push(t);
          if (live(r.target)) inLive.push(t);
        } else {
          for (const n of Array.from(r.addedNodes)) {
            const t = n.textContent ?? '';
            all.push(t);
            if (live(n)) inLive.push(t);
          }
        }
      }
      const join = (a: string[]) => a.join(' ').replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();
      if (all.length) w.__updates.push(join(all));
      if (inLive.length) w.__live.push(join(inLive));
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

export async function updates(page: Page): Promise<{ all: string[]; live: string[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __updates: string[]; __live: string[] };
    return { all: w.__updates ?? [], live: w.__live ?? [] };
  });
}

// ---------------------------------------------------------------------------
// The database.

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  expect(process.env.DATABASE_URL, 'DATABASE_URL is not set; the browser tests read the database').toBeTruthy();
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, allowExitOnIdle: true, max: 2 });
  return pool;
}

export async function sandboxId(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((c) => c.name === COOKIE);
  expect(cookie, `no ${COOKIE} cookie is set`).toBeTruthy();
  return cookie!.value;
}

export type Structured = {
  calendar: CalendarEntry[];
  menus: { date: string; items: string[] }[];
  alerts: { id: string; text: string; startsAt: string; expiresAt: string }[];
  [key: string]: unknown;
};

export async function structuredOf(id: string): Promise<Structured> {
  const { rows } = await db().query('select content from structured_data where sandbox_id = $1', [id]);
  expect(rows.length, `sandbox ${id} holds no structured data`).toBe(1);
  return rows[0].content as Structured;
}

export type Section = { id: string; title: string; visibility: string; updatedOn: string; text: string };

export async function publishedSections(id: string): Promise<Section[]> {
  const { rows } = await db().query('select sections from snapshots where sandbox_id = $1 order by version desc limit 1', [id]);
  expect(rows.length, `sandbox ${id} holds no snapshot`).toBe(1);
  return rows[0].sections as Section[];
}

// The stored turns holding a message, in any sandbox, as whole rows.
export async function turnsWith(message: string): Promise<{ sandbox_id: string; id: string; row: Record<string, unknown> }[]> {
  const { rows } = await db().query('select t.sandbox_id, t.id, to_jsonb(t) as row from turns t where t.message = $1', [message]);
  return rows as { sandbox_id: string; id: string; row: Record<string, unknown> }[];
}

export function isSent(row: Record<string, unknown>): boolean {
  expect(row, 'the turns row has no sent_to_front_desk column').toHaveProperty('sent_to_front_desk');
  const v = row.sent_to_front_desk;
  return v !== null && v !== false;
}

// A message no other test or run sends. Letters only, so the suffix never
// holds a number a test forbids.
export function unique(text: string): string {
  const letters = Array.from({ length: 10 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  return `${text} Ref ${letters}.`;
}
