// Shared helpers for the answer pipeline tests. Not a test file: vitest
// collects only *.test.ts. Nothing here imports a module that may not exist
// yet; every loader checks the file first and imports it inside a test, so a
// missing module is an assertion failure, never a collection error.
//
// Host time zone: the first statement below sets process.env.TZ to
// Pacific/Kiritimati (UTC+14, no daylight saving time), before any date work
// in any test file that imports this module. Late evening in Denver is
// already the next calendar day there, so code that reads the host's local
// time instead of America/Denver produces a wrong weekday, date, or office
// state. Tests that depend on it assert the offset took effect.
//
// Assumed interface. The tests hold the implementation to these module paths
// and signatures.
//
// 1. The parent message entry point, app/src/server/ask.ts:
//
//   export function ask(
//     input: { sandboxId: string; message: string; priorTurns: Turn[]; now: Date },
//     deps: { model: Model; clock: Clock },
//   ): Promise<AskResult>
//
//   type Turn = { role: 'parent' | 'front_desk'; text: string };
//   type Clock = { now(): number; sleep(ms: number): Promise<void> };
//
//   One call is one parent message: it answers from the latest snapshot the
//   sandbox has published when the call starts, renders the six data
//   sections from the sandbox's structured data at `now`, applies the floors,
//   calls the model at most once per attempt, validates the output, checks
//   citations and grounding, files gaps, enforces the limits, and stores the
//   reply in the sandbox. `now` is the injected current time; the tests start
//   `clock.now()` at `now.getTime()`, so either may be read for the current
//   time. The 15 second model limit and every retry backoff wait on
//   `clock.sleep`, never on setTimeout or the system clock, so the tests run
//   them in virtual time.
//
//   AskResult is the eval harness's trial record plus the snapshot the reply
//   was produced from:
//   {
//     reply: Reply;                       // app/src/core/types.ts; reply.outcome is final
//     proposedOutcome: Outcome | null;    // the model's, null when no valid output was used
//     floor: Outcome;
//     modelCalled: boolean;
//     outputValid: boolean;               // false when the model output failed validation
//     latencyMs: number;
//     usage: { input: number; cachedInput: number; output: number };
//     gapLabel: string | null;
//     snapshot: { version: number; sections: Section[] };
//   }
//   `snapshot.sections` holds the published policy sections and the six data
//   sections exactly as rendered for this message. The handoff expectation
//   line is in reply.text or in another string field of the reply.
//
// 2. The model, supplied by the caller:
//
//   type Model = (request: ModelRequest) => Promise<ModelResult>;
//   type ModelRequest = {
//     instructions: string;        // the model instructions (system prompt), separate from section text
//     maxOutputTokens: number;     // the output cap this call asks for
//     [field: string]: unknown;    // everything else the pipeline sends
//   };
//   type ModelResult = { output: unknown; usage: { input: number; cachedInput: number; output: number } };
//
//   "The model input" is the whole request: every string in it, at any depth.
//   A valid `output` is:
//   {
//     outcome: Outcome;            // the proposed outcome
//     reason: Reason;              // a reason that belongs to that outcome
//     text: string;                // generated reply text
//     citations: string[];         // section IDs
//     language: string;            // ISO 639-1 code of the parent's message, 'en' for English
//     topic: string;
//     gapLabel: string | null;     // an open gap's label, or a proposed new label
//   }
//   Anything else fails validation. A model error is a rejected promise. A
//   throttling rejection is a rejected promise whose error has
//   `name === 'ThrottlingException'`, as the AWS SDK names Bedrock's. A call
//   that never returns is a promise that never settles. The scripted model
//   in this file records every request it receives.
//
// 3. Database, app/src/db/sandbox.ts, as app/tests/db/sandbox.test.ts
//    already assumes (migrate, createSandbox(now), forSandbox(id), closeDb),
//    with the scoped access grown by one read:
//
//   forSandbox(id).replies(): Promise<StoredReply[]>
//     Every reply the pipeline stored in that sandbox (not the seeded
//     history), in any order:
//     {
//       id: string;                       // the stored turn's ID
//       message: string;
//       askedAt: string;                  // ISO instant
//       reply: Reply;                     // final outcome, reason, citations, snapshot version
//       proposedOutcome: Outcome | null;
//       floors: string[];                 // the floors that fired; empty when none did
//       language: string | null;
//       topic: string | null;
//       latencyMs: number;
//       usage: { input: number; cachedInput: number; output: number };
//     }
//   Gaps the pipeline opens or joins show up in forSandbox(id).read().gaps,
//   whose questionIds hold StoredReply IDs.
//
// 4. The route, app/src/app/api/ask/route.ts: `POST(request: Request)`
//    resolves to a Response for every request, failures included. It works
//    when called directly with a standard Request: it reads the `Cookie`
//    request header and sets `Set-Cookie` on the Response, with no
//    request-scoped framework API. Request body: JSON `{ message: string;
//    priorTurns?: Turn[] }`. Reply response: JSON `{ reply: Reply }`. The
//    sandbox cookie is HttpOnly and its value is the sandbox ID.
//
//    The route gets its model from app/src/server/model.ts:
//      export function getModel(): Model
//    which returns a scripted fixture model with no network when
//    MODEL_MODE=fixture, and the Bedrock model otherwise. Route tests replace
//    it with `vi.doMock` (spreading the original module) after
//    `vi.resetModules()`, then import the route fresh. A failing database
//    call is produced without mocks, by pointing DATABASE_URL at a database
//    that does not exist or at a closed port.
//
// 5. Startup: if app/src/instrumentation.ts exists and exports register(),
//    the tests call it (with NEXT_RUNTIME=nodejs) before loading the route,
//    as Next does at server start. Against an empty database, the first
//    POST /api/ask after that must answer, so pending migrations are applied
//    at startup or by the route itself; a migration step that lives only in
//    the container command is not visible to these tests.
//
// 6. Production database connection: given only the environment the
//    container gets (the final Dockerfile stage's ENV, the app service's
//    `environment` in infra/compose.prod.yml interpolated the way the deploy
//    runs compose, with only APP_IMAGE in the shell, and POSTGRES_PASSWORD,
//    the one variable /etc/frontdesk/db.env holds), the database module
//    connects to host `db`.
//
// 7. The global daily cap on model calls comes from the environment variable
//    GLOBAL_DAILY_MODEL_CALLS (default 3,000). The global cap test sets it to
//    5 before any module loads, so it holds whether the pipeline reads it at
//    load or per message.
//
// 8. Data section text: in the calendar, menu, and alerts sections, each
//    entry (one calendar date, one menu day, one active alert) is one line of
//    the section text, and the facts about an entry are on its line. A
//    calendar date may be written as YYYY-MM-DD, as "November 26" or
//    "Nov 26" (with or without weekday and year), or as 11/26.

process.env.TZ = 'Pacific/Kiritimati';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ROOT = path.resolve(APP, '..');
export const ASK_MODULE = 'src/server/ask.ts';
export const DB_MODULE = 'src/db/sandbox.ts';
export const ROUTE_MODULE = 'src/app/api/ask/route.ts';
export const MODEL_MODULE = 'src/server/model.ts';
export const INSTRUMENTATION_MODULE = 'src/instrumentation.ts';
export const HOST_TZ = 'Pacific/Kiritimati';
export const HOST_OFFSET_MINUTES = -14 * 60;

export const PHONE = '(505) 555-0142';
export const EMAIL = 'frontdesk@juniperhill.example';
export const STAFF_CODE = '4417#';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Outcome = 'answer' | 'handoff' | 'urgent';
export type Reason =
  | 'answered'
  | 'grounding_failed'
  | 'not_in_source'
  | 'sensitive'
  | 'unsupported_language'
  | 'system_error'
  | 'emergency'
  | 'safety';
export type Section = { id: string; title: string; visibility: string; updatedOn: string; text: string };
export type Reply = { text: string; outcome: Outcome; reason: Reason; snapshotVersion: number; citations: { sectionId: string }[] };
export type Turn = { role: 'parent' | 'front_desk'; text: string };
export type Usage = { input: number; cachedInput: number; output: number };
export type ModelRequest = { instructions: string; maxOutputTokens: number; [field: string]: unknown };
export type ModelResult = { output: unknown; usage: Usage };
export type Model = (request: ModelRequest) => Promise<ModelResult>;
export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export type AskResult = {
  reply: Reply;
  proposedOutcome: Outcome | null;
  floor: Outcome;
  modelCalled: boolean;
  outputValid: boolean;
  latencyMs: number;
  usage: Usage;
  gapLabel: string | null;
  snapshot: { version: number; sections: Section[] };
};
export type AskFn = (
  input: { sandboxId: string; message: string; priorTurns: Turn[]; now: Date },
  deps: { model: Model; clock: Clock },
) => Promise<AskResult>;
export type StoredReply = {
  id: string;
  message: string;
  askedAt: string;
  reply: Reply;
  proposedOutcome: Outcome | null;
  floors: string[];
  language: string | null;
  topic: string | null;
  latencyMs: number;
  usage: Usage;
};
export type Access = { read(): Promise<any>; write(content: any): Promise<void>; replies(): Promise<StoredReply[]> };
export type DbModule = {
  migrate(): Promise<void>;
  createSandbox(now: Date): Promise<string>;
  forSandbox(id: string): Access;
  closeDb(): Promise<void>;
};

export const RANK: Record<Outcome, number> = { answer: 0, handoff: 1, urgent: 2 };
export const PAIRS: Record<Reason, Outcome> = {
  answered: 'answer',
  grounding_failed: 'answer',
  not_in_source: 'handoff',
  sensitive: 'handoff',
  unsupported_language: 'handoff',
  system_error: 'handoff',
  emergency: 'urgent',
  safety: 'urgent',
};
export const DATA_SECTION_IDS = ['hours', 'calendar', 'menu', 'alerts', 'tuition', 'contacts'];

// ---------------------------------------------------------------------------
// Loading the modules under test.

export function expectHostZone(): void {
  expect(new Date('2026-06-01T00:00:00Z').getTimezoneOffset(), `the host time zone is not ${HOST_TZ}`).toBe(HOST_OFFSET_MINUTES);
}

let loadedDb: DbModule | null = null;
let migrated: Promise<void> | null = null;

// The pipeline entry point and the database module. Fails, in this order,
// when the entry point is missing, when DATABASE_URL is unset, and when an
// export is missing.
export async function loadPipeline(): Promise<{ ask: AskFn; db: DbModule }> {
  expect(fs.existsSync(path.join(APP, ASK_MODULE)), `app/${ASK_MODULE} does not exist`).toBe(true);
  expect(process.env.DATABASE_URL, 'DATABASE_URL is not set; the pipeline tests need a reachable Postgres').toBeTruthy();
  const mod = (await import('../../src/server/ask')) as any;
  expect(typeof mod.ask, `app/${ASK_MODULE} does not export ask`).toBe('function');
  const db = await loadDb();
  return { ask: mod.ask as AskFn, db };
}

export async function loadDb(): Promise<DbModule> {
  expect(fs.existsSync(path.join(APP, DB_MODULE)), `app/${DB_MODULE} does not exist`).toBe(true);
  expect(process.env.DATABASE_URL, 'DATABASE_URL is not set; the pipeline tests need a reachable Postgres').toBeTruthy();
  const mod = (await import('../../src/db/sandbox')) as any;
  for (const name of ['migrate', 'createSandbox', 'forSandbox', 'closeDb']) {
    expect(typeof mod[name], `app/${DB_MODULE} does not export ${name}`).toBe('function');
  }
  loadedDb = mod as DbModule;
  migrated ??= loadedDb.migrate();
  await migrated;
  return loadedDb;
}

export async function closeLoadedDb(): Promise<void> {
  if (loadedDb) await loadedDb.closeDb();
}

export function expectReplies(access: Access): void {
  expect(typeof access.replies, 'forSandbox(id) has no replies() read').toBe('function');
}

// ---------------------------------------------------------------------------
// The scripted model and the virtual clock.

export const USAGE: Usage = { input: 1200, cachedInput: 800, output: 60 };

// Generated text in scripted outputs carries this word so a reply that
// leaks generated text is easy to spot. It appears in no section.
export const GENERATED = 'quokka';

// `failedAt` is the clock's timer count when the last attempt failed, so the
// driver can tell a backoff (registered after the failure) from a deadline
// registered before it.
export type ModelState = { inFlight: number; lastFailed: boolean; calls: number; failedAt: number };

export type Script = (request: ModelRequest, n: number, clock: Clock) => Promise<ModelResult> | ModelResult;

export type Scripted = {
  model: Model;
  requests: ModelRequest[];
  attemptsAt: number[];
  state: ModelState;
};

// A model that answers from `script` and records every request, the virtual
// time of every attempt, and whether a call is in flight.
export function scriptedModel(script: Script, clock: Clock, timerCount: () => number = () => 0): Scripted {
  const requests: ModelRequest[] = [];
  const attemptsAt: number[] = [];
  const state: ModelState = { inFlight: 0, lastFailed: false, calls: 0, failedAt: 0 };
  const model: Model = async (request) => {
    requests.push(request);
    attemptsAt.push(clock.now());
    const n = state.calls;
    state.calls += 1;
    state.inFlight += 1;
    try {
      const result = await script(request, n, clock);
      state.lastFailed = false;
      return result;
    } catch (err) {
      state.lastFailed = true;
      state.failedAt = timerCount();
      throw err;
    } finally {
      state.inFlight -= 1;
    }
  };
  return { model, requests, attemptsAt, state };
}

// A virtual clock. `sleep` registers a wake time. `drive(work, state)` advances
// virtual time to the earliest pending wake only while the pipeline is
// waiting on the model: while a model call is in flight (any wake), or after
// a failed attempt (only wakes registered after the failure, which are
// backoffs). It never advances before the first model call, after a
// successful one, or toward a deadline left over from a failed call, so
// database round trips never consume virtual time.
export function virtualClock(startMs: number) {
  let current = startMs;
  let registered = 0;
  let timers: { at: number; seq: number; resolve: () => void }[] = [];
  const clock: Clock = {
    now: () => current,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        registered += 1;
        timers.push({ at: current + Math.max(0, Number(ms) || 0), seq: registered, resolve });
      }),
  };
  const timerCount = () => registered;
  async function drive<T>(work: Promise<T>, state: ModelState): Promise<T> {
    let done = false;
    const settled = work.finally(() => {
      done = true;
    });
    const loop = (async () => {
      while (!done) {
        await new Promise((r) => setImmediate(r));
        if (done) break;
        const eligible = state.inFlight > 0 ? timers : state.lastFailed ? timers.filter((t) => t.seq > state.failedAt) : [];
        if (eligible.length === 0) continue;
        const at = Math.min(...eligible.map((t) => t.at));
        current = Math.max(current, at);
        const due = timers.filter((t) => t.at <= current);
        timers = timers.filter((t) => t.at > current);
        for (const t of due) t.resolve();
      }
    })();
    try {
      return await settled;
    } finally {
      done = true;
      await loop;
    }
  }
  return { clock, drive, timerCount };
}

export function output(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: 'answer',
    reason: 'answered',
    text: 'Breakfast is served until 8:30 AM.',
    citations: ['meals'],
    language: 'en',
    topic: 'meals',
    gapLabel: null,
    ...fields,
  };
}

export const answerOut = (text: string, citations: string[], extra: Record<string, unknown> = {}) =>
  output({ text, citations, ...extra });

export const handoffOut = (reason: Reason, extra: Record<string, unknown> = {}) =>
  output({
    outcome: 'handoff',
    reason,
    text: `A ${GENERATED} would hand this to the front desk.`,
    citations: [],
    topic: 'other',
    gapLabel: reason === 'not_in_source' ? 'Weekend care' : null,
    ...extra,
  });

export const urgentOut = (reason: 'emergency' | 'safety', extra: Record<string, unknown> = {}) =>
  output({ outcome: 'urgent', reason, text: `A ${GENERATED} says this is urgent.`, citations: [], topic: 'safety', ...extra });

export const returns = (out: unknown, usage: Usage = USAGE): Script => () => ({ output: out, usage });

export type Asked = {
  result: AskResult;
  requests: ModelRequest[];
  attemptsAt: number[];
  startMs: number;
  endMs: number;
};

// One parent message in `sandboxId` at `now`, answered by `script`.
export async function askWith(
  ask: AskFn,
  sandboxId: string,
  message: string,
  now: Date,
  script: Script,
  priorTurns: Turn[] = [],
): Promise<Asked> {
  const { clock, drive, timerCount } = virtualClock(now.getTime());
  const s = scriptedModel(script, clock, timerCount);
  const startMs = clock.now();
  const result = await drive(ask({ sandboxId, message, priorTurns, now }, { model: s.model, clock }), s.state);
  expect(result, 'ask resolved to nothing').toBeTruthy();
  expect(result.reply, 'the result holds no reply').toBeTruthy();
  return { result, requests: s.requests, attemptsAt: s.attemptsAt, startMs, endMs: clock.now() };
}

// ---------------------------------------------------------------------------
// Text.

export function normalize(text: string): string {
  return String(text ?? '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Every string leaf of a value, at any depth. A string that holds JSON (the
// pipeline may serialize sections into one message) also contributes the
// strings inside it, so escaping never hides or invents text.
export function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    const t = value.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        strings(JSON.parse(t), out);
      } catch {
        // not JSON
      }
    }
  } else if (typeof value === 'number') out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

// The model input of one request as one whitespace-normalized string.
export function inputText(request: ModelRequest): string {
  return normalize(strings(request).join('\n'));
}

export function allInput(requests: ModelRequest[]): string {
  return requests.map(inputText).join('\n');
}

// Every string a reply carries, so a line kept outside reply.text still counts.
export function replyText(reply: Reply): string {
  return normalize(strings(reply).join('\n'));
}

export function contains(haystack: string, needle: string): boolean {
  return normalize(haystack).toLowerCase().includes(normalize(needle).toLowerCase());
}

export function digits(text: string): string {
  return String(text).replace(/\D/g, '');
}

export function hasPhone(text: string): boolean {
  return digits(text).includes('5055550142');
}

export const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

// A literal value that refuses to match inside a longer number: `$15` does
// not match `$150`.
export function literal(token: string): RegExp {
  const before = /^[\d$]/.test(token) ? '(?<![\\d.$])' : '';
  const after = /\d$/.test(token) ? '(?![\\d])' : '';
  const body = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*');
  return new RegExp(`${before}${body}${after}`, 'i');
}

// A time of day as "7:30 AM", "7:30 a.m.", or "07:30".
export function timeOfDay(twelveHour: string): RegExp {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(twelveHour);
  if (!m) throw new Error(`not a 12-hour time: ${twelveHour}`);
  let h = Number(m[1]) % 12;
  if (m[3] === 'PM') h += 12;
  const hh = String(h).padStart(2, '0');
  const ap = m[3] === 'AM' ? 'a\\.?\\s?m\\.?' : 'p\\.?\\s?m\\.?';
  return new RegExp(`(?<![\\d:])(${m[1]}:${m[2]}\\s*${ap}|${hh}:${m[2]}(?!\\s*[ap]\\.?\\s?m))`, 'i');
}

// ---------------------------------------------------------------------------
// Calendar dates (YYYY-MM-DD strings) and Denver instants. Arithmetic runs in
// UTC so the host zone never enters.

const DAY_MS = 86_400_000;
export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function ymd(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isWeekday(date: string): boolean {
  const w = weekdayOf(date);
  return w >= 1 && w <= 5;
}

export function onOrAfter(date: string, weekday: number): string {
  let d = date;
  while (weekdayOf(d) !== weekday) d = addDays(d, 1);
  return d;
}

export function nthWeekday(y: number, m: number, weekday: number, n: number): string {
  return addDays(onOrAfter(ymd(y, m, 1), weekday), (n - 1) * 7);
}

const WALL = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Denver',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function wall(instant: Date): { date: string; minutes: number } {
  const p: Record<string, string> = {};
  for (const part of WALL.formatToParts(instant)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export function denverDate(instant: Date): string {
  return wall(instant).date;
}

// The instant at a Denver wall-clock time on a date.
export function denver(date: string, hhmm: string): Date {
  const want = Date.parse(`${date}T${hhmm}:00Z`);
  let guess = want;
  for (let pass = 0; pass < 3; pass++) {
    const seen = wall(new Date(guess));
    guess += want - (Date.parse(`${seen.date}T00:00:00Z`) + seen.minutes * 60_000);
  }
  return new Date(guess);
}

// Every way a careful writer might name a calendar date.
export function datePattern(date: string): RegExp {
  const [y, m, d] = date.split('-').map(Number);
  const month = MONTHS[m - 1];
  const abbr = month.slice(0, 3);
  const monthName = `(?:${month}|${abbr}\\.?${month === 'September' ? '|Sept\\.?' : ''})`;
  const day = `0?${d}(?:st|nd|rd|th)?`;
  const forms = [
    `(?<!\\d)${date}(?!\\d)`,
    `\\b${monthName}\\s+${day}(?![\\d:])`,
    `(?<![\\d:])${day}\\s+(?:of\\s+)?${monthName}\\b`,
    `(?<![\\d/:.$])0?${m}/0?${d}(?:/(?:${y}|${String(y).slice(2)}))?(?![\\d/])`,
  ];
  return new RegExp(forms.join('|'), 'i');
}

export function mentionsDate(text: string, date: string): boolean {
  return datePattern(date).test(normalize(text));
}

// The text a section uses for a date, so a generated sentence can reuse it.
export function dateTextIn(text: string, date: string): string | null {
  const m = datePattern(date).exec(normalize(text));
  return m ? m[0] : null;
}

// A run-unique year: the global model call limit is counted per day across
// every sandbox in a long-lived database, so tests that reuse fixed dates
// would pile up calls on the same days run after run. Each test file gets
// its own year in 2041 to 2899.
export const RUN_YEAR = 2041 + Math.floor(Math.random() * 859);

// ---------------------------------------------------------------------------
// Sections.

export function sectionById(result: AskResult, id: string): Section | undefined {
  return (result.snapshot?.sections ?? []).find((s) => s.id === id);
}

export function sectionText(result: AskResult, id: string): string {
  const s = sectionById(result, id);
  expect(s, `the snapshot holds no ${id} section`).toBeDefined();
  return s!.text;
}

export function linesOf(text: string): string[] {
  return String(text)
    .split(/\r?\n/)
    .map((l) => normalize(l))
    .filter((l) => l !== '');
}

export function linesWith(text: string, needle: string): string[] {
  return linesOf(text).filter((l) => contains(l, needle));
}

// Seed content to write back after a change: a deep copy of what the
// sandbox holds.
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type SeedModule = { seed: (now: Date) => any };

export async function loadSeed(): Promise<SeedModule> {
  expect(fs.existsSync(path.join(APP, 'src/seed/index.ts')), 'app/src/seed/index.ts does not exist').toBe(true);
  const mod = (await import('../../src/seed/index')) as any;
  expect(typeof mod.seed).toBe('function');
  return mod as SeedModule;
}

// The first date after `date` that is a weekday and not a closed calendar
// entry.
export function nextOpenDay(date: string, closed: Set<string>): string {
  let d = addDays(date, 1);
  while (!isWeekday(d) || closed.has(d)) d = addDays(d, 1);
  return d;
}

export function closedDates(structured: any): Set<string> {
  return new Set<string>((structured.calendar ?? []).filter((e: any) => e.status === 'closed').map((e: any) => e.date as string));
}

// ---------------------------------------------------------------------------
// The handoff expectation line.

export const OPEN_LINE = 'The front desk will see this today.';
const CLOSED_LINE = /The office is closed now\. Staff will see this after (.{1,20}?) on ([^\n]{1,80}?)\.(?=\s|$)/g;

export type Expectation = { open: number; closed: { time: string; day: string }[] };

export function expectationLines(text: string): Expectation {
  const t = normalize(text);
  const open = t.split(OPEN_LINE).length - 1;
  const closed = [...t.matchAll(CLOSED_LINE)].map((m) => ({ time: m[1], day: m[2] }));
  return { open, closed };
}

export function isOpeningTime(time: string): boolean {
  return timeOfDay('7:00 AM').test(time) || /^7\s*a\.?\s?m\.?$/i.test(time.trim());
}

// ---------------------------------------------------------------------------
// Limit notices.

export const GROUNDED = answerOut('Breakfast is served until 8:30 AM.', ['meals']);

export type Sent = { called: boolean; text: string; requests: ModelRequest[]; reply?: any; stored?: boolean; filed?: boolean };

export async function send(
  ask: AskFn,
  sandboxId: string,
  message: string,
  now: Date,
  script: Script = returns(GROUNDED),
  priorTurns: Turn[] = [],
): Promise<Sent> {
  const { result, requests } = await askWith(ask, sandboxId, message, now, script, priorTurns);
  return { called: requests.length > 0, text: normalize(replyText(result.reply)), requests, reply: result.reply };
}

// The model, if the pipeline wrongly called it, would propose a filed
// handoff with generated text, so a stored or filed notice shows up.
export const TEMPTING = returns(handoffOut('not_in_source', { gapLabel: 'Weekend care' }));

// A message expected to be over a limit: records whether it was stored as a
// reply and whether any gap gained a member.
export async function overLimit(ask: AskFn, db: DbModule, sandboxId: string, message: string, now: Date): Promise<Sent> {
  const access = db.forSandbox(sandboxId);
  expectReplies(access);
  const members = async () => ((await access.read()).gaps as { questionIds: string[] }[]).reduce((n, g) => n + g.questionIds.length, 0);
  const before = await members();
  const o = await send(ask, sandboxId, message, now, TEMPTING);
  const stored = (await access.replies()).some((r) => r.message === message);
  return { ...o, stored, filed: (await members()) !== before };
}

export function expectNotice(over: Sent[], messages: string[]): void {
  for (const o of over) expect(o.called, 'a message over the limit reached the model').toBe(false);
  for (const o of over) expect(o.text.length, 'the notice is empty').toBeGreaterThan(0);
  expect(new Set(over.map((o) => o.text)).size, 'the notice differs between messages, so it is not fixed').toBe(1);
  for (const m of messages) expect(contains(over[0].text, m), 'the notice repeats the message').toBe(false);
  for (const o of over) {
    expect({ outcome: o.reply?.outcome, reason: o.reply?.reason }, 'the notice outcome and reason').toEqual({ outcome: 'handoff', reason: 'system_error' });
    expect(hasPhone(o.text), 'the notice has no phone number').toBe(true);
    expect(o.text.toLowerCase().includes(GENERATED), 'the notice holds generated text').toBe(false);
    expect(EMAIL_PATTERN.test(o.text) || o.text.includes('@'), 'the notice holds an email address').toBe(false);
    const lines = expectationLines(o.text);
    expect(lines.open + lines.closed.length, 'the notice does not carry exactly one expectation line').toBe(1);
    expect(o.stored, 'the notice was stored as a reply').toBe(false);
    expect(o.filed, 'the notice was filed into a gap').toBe(false);
  }
}
