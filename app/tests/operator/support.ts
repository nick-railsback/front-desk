// Shared helpers for the operator route tests. Not a test file: vitest
// collects only *.test.ts. Nothing here imports a module that may not exist
// yet; every loader checks the file first and imports it inside a test, so a
// missing module is an assertion failure, never a collection error.
//
// Host time zone: the first statement below sets process.env.TZ to
// Pacific/Kiritimati (UTC+14), before any date work in a test file that
// imports this module first. Late evening in Denver is already the next
// calendar day there, so code that reads the host's local date instead of
// America/Denver's writes a wrong last-updated date.
//
// Assumed interface. The tests hold the implementation to these contracts.
//
// 1. Route handlers, called in-process as plain functions with a standard
//    Request, the way the /api/ask route tests call that route. Each reads
//    the sandbox from the request's `Cookie` header (`fd_sandbox=<sandbox
//    ID>`), never from a request-scoped framework API (`cookies()`,
//    `headers()`, `after()` from next/*), and acts on that sandbox only.
//
//    app/src/app/api/sections/route.ts  export POST(request: Request)
//      Saves one section into the cookie's sandbox's draft.
//      Body: JSON { id: string | null, title: string, visibility: string, text: string }
//        id null (or absent) adds a new section; an existing section ID
//        replaces that section's title, visibility and text.
//      A 2xx status when saved. A 4xx status when refused: a title over 80
//      characters, a text over 4,000 characters, or a visibility other than
//      `parent` or `staff`. A refused or failed save leaves the draft as it
//      was. A failure is a status of 400 or more.
//
//    app/src/app/api/publish/route.ts  export POST(request: Request)
//      Publishes the cookie's sandbox's draft as snapshot version N+1 and
//      starts the replay of its open gaps. A 2xx status when published; a
//      status of 400 or more when publishing failed, and then no snapshot is
//      created.
//
//    app/src/app/api/replay/route.ts  export GET(request: Request)
//      The cookie's sandbox's latest replay: 200 JSON
//        { running: boolean, completed: number, total: number }
//      `total` is the number of questions the replay re-runs, `completed`
//      how many have finished. Once POST /api/publish has answered, this
//      reports that publish's replay: running, or finished with
//      completed === total. With no replay yet, running is false. The
//      operator view reads replay progress from this route while a replay
//      runs; the replay goes on on the server whether or not it is asked.
//
//    No response body, success or failure, holds a stack trace, a database
//    error, SQL, or a sandbox ID.
//
// 2. Model: replay gets its model from getModel() in app/src/server/model.ts,
//    as /api/ask does, and reserves each model call through the global daily
//    limit the way ask() does (GLOBAL_DAILY_MODEL_CALLS, read per call;
//    usage_global.count for the Denver day). The tests replace getModel with
//    vi.doMock after vi.resetModules, then import the routes fresh. Replay
//    calls the model only for questions it re-runs and never for anything
//    else; it stores no turn, files nothing into a gap, and counts no
//    message against the sandbox's limits (usage_sandbox).
//
// 3. Database: the draft is drafts.sections (a Section[]), published
//    snapshots are snapshots rows (sandbox_id, version, sections), the
//    sandbox's questions are turns rows, gaps are gaps rows with
//    gap_members. A gap whose replay resolves it gets a status other than
//    'open'; an open gap keeps 'open'. Startup (instrumentation register(),
//    called here as Next calls it) applies every migration.

process.env.TZ = 'Pacific/Kiritimati';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, vi } from 'vitest';
import type { Model, ModelRequest, Section } from '../../src/core/types';
import { denverDate } from '../../src/seed/dates';

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const COOKIE = 'fd_sandbox';
export const MARKER = 'pangolin';

export const ROUTES = {
  sections: 'src/app/api/sections/route.ts',
  publish: 'src/app/api/publish/route.ts',
  replay: 'src/app/api/replay/route.ts',
  ask: 'src/app/api/ask/route.ts',
} as const;

// The seeded open gaps' questions, newest first within each gap.
export const SEEDED_GAPS: Record<string, string[]> = {
  'Sibling discount': [
    'Do you offer a discount for siblings?',
    'Is there a sibling discount if both my kids enroll?',
    'My twins start next month. Is there a family rate?',
    'Does the second child get reduced tuition?',
    'Do brothers and sisters get a price break on tuition?',
    'We have a toddler and a preschooler. Any discount for having two kids there?',
    'Is tuition cheaper for the second kid in the same family?',
  ],
  'Part-time schedules': [
    'Can my daughter come just Tuesdays and Thursdays?',
    'Do you have a part-time option?',
    'Is there a 3 day a week schedule for preschool?',
    'Can I pay for half days only?',
    'Do you prorate tuition if he only comes Mondays, Wednesdays, and Fridays?',
  ],
  'Summer program': [
    'Is there a summer program for kids who finish Pre-K?',
    'What does the summer schedule look like?',
    'Do you run a summer camp?',
    'Are you open in the summer for school-age kids?',
  ],
};
export const SEEDED_GAP_QUESTIONS = Object.values(SEEDED_GAPS).flat();

// What a response may never hold.
export const STACK = /\bat\s+\S+\s+\(?[^\s()]+:\d+:\d+\)?|\b(?:Type|Reference|Syntax|Range)?Error\b|node_modules|\.tsx?:\d+/;
export const SQL = /\binsert\s+into\b|\bupdate\s+"?\w+"?\s+set\b|\bselect\b[\s\S]{0,200}\bfrom\b|\bdelete\s+from\b|\bviolates\b|\brelation\s+"/i;
export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Random lowercase letters, so a marker never holds a number a check reads.
export function letters(n: number): string {
  return Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
}

export function unique(text: string): string {
  return `${text} Ref ${letters(10)}`;
}

// ---------------------------------------------------------------------------
// The database, read and written directly.

let pool: pg.Pool | null = null;

export function sql(): pg.Pool {
  expect(process.env.DATABASE_URL, 'DATABASE_URL is not set; the operator route tests need a reachable Postgres').toBeTruthy();
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  return pool;
}

export async function closeSql(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export async function draftOf(id: string): Promise<Section[]> {
  const { rows } = await sql().query('select sections from drafts where sandbox_id = $1', [id]);
  expect(rows.length, `sandbox ${id} holds no draft`).toBe(1);
  return rows[0].sections as Section[];
}

export async function snapshotsOf(id: string): Promise<{ version: number; sections: Section[] }[]> {
  const { rows } = await sql().query('select version, sections from snapshots where sandbox_id = $1 order by version', [id]);
  return rows as { version: number; sections: Section[] }[];
}

// Everything a sandbox holds that an operator could change, as comparable
// JSON: its draft, snapshots, gaps with members, questions, structured data
// and message counts.
export async function stateOf(id: string): Promise<Record<string, unknown>> {
  const q = async (text: string) => (await sql().query(text, [id])).rows;
  return {
    draft: await q('select sections from drafts where sandbox_id = $1'),
    snapshots: await q('select version, sections, published_at from snapshots where sandbox_id = $1 order by version'),
    gaps: await q('select id, label, status from gaps where sandbox_id = $1 order by id'),
    members: await q('select gap_id, turn_id from gap_members where sandbox_id = $1 order by gap_id, turn_id'),
    turns: await q('select to_jsonb(t) as row from turns t where sandbox_id = $1 order by id'),
    structured: await q('select content from structured_data where sandbox_id = $1'),
    usage: await q('select bucket, count from usage_sandbox where sandbox_id = $1 order by bucket'),
  };
}

export async function globalCalls(day: string): Promise<number> {
  const { rows } = await sql().query('select count from usage_global where day = $1', [day]);
  return rows.length ? Number(rows[0].count) : 0;
}

export function today(): string {
  return denverDate(new Date());
}

// A trigger that makes every write to `table` for one sandbox fail, as a
// database failure mid-request would. Returns how to remove it.
export async function failWrites(table: 'drafts' | 'snapshots', sandboxId: string): Promise<() => Promise<void>> {
  const name = `oracle_fail_${letters(16)}`;
  await sql().query(`
    create function ${name}() returns trigger language plpgsql as $$
    begin
      if (tg_op = 'DELETE' and old.sandbox_id = '${sandboxId}') or (tg_op <> 'DELETE' and new.sandbox_id = '${sandboxId}') then
        raise exception 'oracle-boom % on ${table} for ${sandboxId}', tg_op;
      end if;
      return coalesce(new, old);
    end $$`);
  await sql().query(`create trigger ${name} before insert or update or delete on ${table} for each row execute function ${name}()`);
  return async () => {
    await sql().query(`drop trigger if exists ${name} on ${table}`);
    await sql().query(`drop function if exists ${name}()`);
  };
}

// ---------------------------------------------------------------------------
// The model.

// The section whose body holds `message`, by its ID in the model input's
// snapshot text ("[id] Title (updated date)\nbody" blocks).
export function sectionHolding(snapshotText: string, message: string): string | null {
  const m = message.trim();
  if (!m) return null;
  const blocks = snapshotText.split(/\n\n(?=\[[^\]\n]+\] )/);
  for (const block of blocks) {
    const header = /^\[([^\]\n]+)\] [^\n]*\n([\s\S]*)$/.exec(block);
    if (header && header[2].includes(m)) return header[1];
  }
  return null;
}

// A model that records every request and answers a message when a
// parent-visible section of the snapshot holds it word for word, citing that
// section; otherwise it hands off as not_in_source.
export function answeringModel(): { model: Model; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const model: Model = async (request) => {
    requests.push(request);
    const hit = sectionHolding(request.snapshotText, request.message);
    const output = hit
      ? { outcome: 'answer', reason: 'answered', text: `Marker ${MARKER}: ${request.message.trim()}`, citations: [hit], language: 'en', topic: 'Oracle topic', gapLabel: null }
      : { outcome: 'handoff', reason: 'not_in_source', text: '', citations: [], language: 'en', topic: 'Oracle topic', gapLabel: null };
    return { output, usage: { input: 1, cachedInput: 0, output: 1 } };
  };
  return { model, requests };
}

// Everything the model was given for one request, as one string.
export function inputOf(request: ModelRequest): string {
  const { signal: _signal, ...rest } = request;
  return JSON.stringify(rest);
}

// ---------------------------------------------------------------------------
// The routes.

type Handler = (request: Request) => Promise<Response> | Response;

export type Loaded = {
  save: Handler;
  publish: Handler;
  replay: Handler;
  ask: Handler;
  db: { createSandbox(now: Date): Promise<string>; closeDb(): Promise<void> };
};

const opened: Loaded['db'][] = [];

// Loads the routes fresh, as a server start would: resets modules, swaps in
// the model, runs instrumentation's register() (migrations), then imports.
export async function loadRoutes(model: Model): Promise<Loaded> {
  for (const [name, file] of Object.entries(ROUTES)) {
    expect(fs.existsSync(path.join(APP, file)), `app/${file} does not exist (the ${name} route)`).toBe(true);
  }
  expect(process.env.DATABASE_URL, 'DATABASE_URL is not set; the operator route tests need a reachable Postgres').toBeTruthy();
  vi.resetModules();
  vi.doMock('../../src/server/model', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), getModel: () => model }));
  const instrumentation = (await import('../../src/instrumentation')) as { register?: () => Promise<void> };
  if (typeof instrumentation.register === 'function') {
    process.env.NEXT_RUNTIME = 'nodejs';
    await instrumentation.register();
  }
  const sections = (await import('../../src/app/api/sections/route')) as Record<string, unknown>;
  const publish = (await import('../../src/app/api/publish/route')) as Record<string, unknown>;
  const replay = (await import('../../src/app/api/replay/route')) as Record<string, unknown>;
  const ask = (await import('../../src/app/api/ask/route')) as Record<string, unknown>;
  expect(typeof sections.POST, `app/${ROUTES.sections} does not export POST`).toBe('function');
  expect(typeof publish.POST, `app/${ROUTES.publish} does not export POST`).toBe('function');
  expect(typeof replay.GET, `app/${ROUTES.replay} does not export GET`).toBe('function');
  const db = (await import('../../src/db/sandbox')) as unknown as Loaded['db'];
  opened.push(db);
  return { save: sections.POST as Handler, publish: publish.POST as Handler, replay: replay.GET as Handler, ask: ask.POST as Handler, db };
}

export async function unload(): Promise<void> {
  vi.doUnmock('../../src/server/model');
  while (opened.length > 0) await opened.pop()!.closeDb().catch(() => {});
}

export type Called = { status: number; text: string; json: any };

export async function call(handler: Handler, method: 'GET' | 'POST', route: string, sandboxId: string, body?: unknown): Promise<Called> {
  const headers: Record<string, string> = { cookie: `${COOKIE}=${sandboxId}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await handler(new Request(`http://localhost${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  expect(response instanceof Response, `${method} ${route} did not resolve to a Response`).toBe(true);
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

export function saveSection(r: Loaded, sandboxId: string, section: { id: string | null; title: string; visibility: string; text: string }): Promise<Called> {
  return call(r.save, 'POST', '/api/sections', sandboxId, section);
}

export function publishDraft(r: Loaded, sandboxId: string): Promise<Called> {
  return call(r.publish, 'POST', '/api/publish', sandboxId);
}

export function askAs(r: Loaded, sandboxId: string, message: string): Promise<Called> {
  return call(r.ask, 'POST', '/api/ask', sandboxId, { message, priorTurns: [] });
}

// Polls the replay route until the replay has finished.
export async function replayFinished(r: Loaded, sandboxId: string, timeoutMs: number): Promise<{ running: boolean; completed: number; total: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await call(r.replay, 'GET', '/api/replay', sandboxId);
    expect(res.status, `GET /api/replay answered ${res.status}: ${res.text.slice(0, 200)}`).toBe(200);
    const p = res.json as { running: boolean; completed: number; total: number };
    expect(typeof p?.running, 'GET /api/replay has no boolean `running`').toBe('boolean');
    if (!p.running && p.completed === p.total) return p;
    expect(Date.now(), `the replay did not finish within ${timeoutMs} ms (last: ${res.text})`).toBeLessThan(deadline);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export function expectNoLeak(text: string, sandboxId: string, what: string): void {
  expect(text, `${what}: the response holds a stack trace or error`).not.toMatch(STACK);
  expect(text, `${what}: the response holds SQL or a database error`).not.toMatch(SQL);
  expect(text, `${what}: the response holds the database failure's text`).not.toContain('oracle-boom');
  expect(text, `${what}: the response holds the sandbox ID`).not.toContain(sandboxId);
}
