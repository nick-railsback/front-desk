// Shared helpers for the demo environment's route and server tests. Not a
// test file: vitest collects only *.test.ts. Nothing here imports a module
// that may not exist yet; each loader checks the file first and imports it
// inside a test, so a missing module is an assertion failure, never a
// collection error.
//
// Assumed interface. The tests hold the implementation to these contracts.
//
// 1. Activity. A sandbox's last activity is sandboxes.last_seen_at. Every
//    request that carries the sandbox's cookie sets it to the time of that
//    request.
//
// 2. Idle deletion, app/src/db/sandbox.ts:
//      export function deleteIdleSandboxes(now: Date): Promise<unknown>
//    Deletes every sandbox whose last_seen_at is more than 7 days before
//    `now`, with every row in any table that names it. A sandbox last seen
//    7 days ago or less is left exactly as it was. `now` is injected; the
//    function never reads the clock.
//
// 3. The daily run, app/src/server/idle.ts:
//      export function scheduleIdleDeletion(deps: {
//        clock: Clock;                              // app/src/core/types.ts
//        deleteIdle: (now: Date) => Promise<unknown>;
//      }): { stop(): void }
//    Calls deps.deleteIdle(new Date(clock.now())) once at once, then again
//    and again, waiting between calls only through clock.sleep(ms) with
//    0 < ms <= 24 hours. A call that rejects does not end the run. stop()
//    ends it: no call starts after it. Nothing here may keep a process alive
//    on its own (a real timer is unref'd), because tests call the app's
//    instrumentation register() in-process.
//    app/src/instrumentation.ts register() starts it with the real clock and
//    deleteIdleSandboxes once the server starts, after migrating.
//
// 4. Routes, called in-process as plain functions with a standard Request
//    whose Cookie header names the sandbox (`fd_sandbox=<sandbox ID>`), as
//    the operator route tests call them: POST /api/ask, POST /api/send,
//    POST /api/sections, POST /api/publish, GET /api/replay. The model comes
//    from getModel() in app/src/server/model.ts, which the tests replace.
//
// 5. The post-deploy check, .github/scripts/check-answer.sh, run as
//      bash .github/scripts/check-answer.sh <base URL>
//    with no other input. It loads <base URL>/ and keeps the fd_sandbox
//    cookie that page load sets, then sends POST <base URL>/api/ask with that
//    cookie and a JSON body { message, priorTurns: [] }, as the parent view
//    does. It exits 0 only when that response has a 2xx status and a JSON
//    body whose reply.outcome is "answer" and whose reply.citations holds at
//    least one entry; otherwise it exits non-zero. It may retry, and may use
//    curl and jq, but gives up within 120 seconds. Its message is one the
//    seed answers with a citation on any day. With the fixture model that
//    means text a parent-visible section holds word for word, such as the
//    Hours section's "The center is open Monday to Friday."
//    .github/workflows/deploy.yml runs it, against vars.APP_URL, in a step of
//    the deploy job after the step that checks /api/health.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import type { Clock, Model } from '../../src/core/types';

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ROOT = path.resolve(APP, '..');
export const COOKIE = 'fd_sandbox';
export const DAY = 86_400_000;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;

export const STACK = /\bat\s+\S+\s+\(?[^\s()]+:\d+:\d+\)?|\b(?:Type|Reference|Syntax|Range)?Error\b|node_modules|\.tsx?:\d+/;
export const SQL = /\binsert\s+into\b|\bupdate\s+"?\w+"?\s+set\b|\bselect\b[\s\S]{0,200}\bfrom\b|\bdelete\s+from\b|\bviolates\b|\brelation\s+"/i;

export function letters(n: number): string {
  return Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
}

export function moduleExists(rel: string): void {
  expect(fs.existsSync(path.join(APP, rel)), `app/${rel} does not exist`).toBe(true);
}

// ---------------------------------------------------------------------------
// The app's database module and routes, loaded fresh.

type Handler = (request: Request) => Promise<Response> | Response;

export type SandboxDb = {
  createSandbox(now: Date): Promise<string>;
  migrate(): Promise<void>;
  closeDb(): Promise<void>;
  deleteIdleSandboxes?: (now: Date) => Promise<unknown>;
};

const opened: SandboxDb[] = [];

export async function loadDb(): Promise<SandboxDb> {
  expect(process.env.DATABASE_URL, 'DATABASE_URL is not set; these tests need a reachable Postgres').toBeTruthy();
  moduleExists('src/db/sandbox.ts');
  const db = (await import('../../src/db/sandbox')) as unknown as SandboxDb;
  opened.push(db);
  await db.migrate();
  return db;
}

// The idle deletion, failing on an assertion when it does not exist.
export async function idleDeletion(): Promise<{ db: SandboxDb; deleteIdle: (now: Date) => Promise<unknown> }> {
  const db = await loadDb();
  expect(typeof db.deleteIdleSandboxes, 'app/src/db/sandbox.ts does not export deleteIdleSandboxes(now)').toBe('function');
  return { db, deleteIdle: db.deleteIdleSandboxes! };
}

export type Routes = { ask: Handler; send: Handler; sections: Handler; publish: Handler; replay: Handler };

const ROUTES = {
  ask: ['src/app/api/ask/route.ts', 'POST'],
  send: ['src/app/api/send/route.ts', 'POST'],
  sections: ['src/app/api/sections/route.ts', 'POST'],
  publish: ['src/app/api/publish/route.ts', 'POST'],
  replay: ['src/app/api/replay/route.ts', 'GET'],
} as const;

// Loads the routes fresh with `model` in place of getModel()'s.
export async function loadRoutes(model: Model): Promise<Routes> {
  for (const [file] of Object.values(ROUTES)) moduleExists(file);
  vi.resetModules();
  vi.doMock('../../src/server/model', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), getModel: () => model }));
  await loadDb();
  const out: Partial<Routes> = {};
  const modules = {
    ask: await import('../../src/app/api/ask/route'),
    send: await import('../../src/app/api/send/route'),
    sections: await import('../../src/app/api/sections/route'),
    publish: await import('../../src/app/api/publish/route'),
    replay: await import('../../src/app/api/replay/route'),
  } as Record<keyof Routes, Record<string, unknown>>;
  for (const [name, [file, method]] of Object.entries(ROUTES) as [keyof Routes, (typeof ROUTES)[keyof Routes]][]) {
    expect(typeof modules[name][method], `app/${file} does not export ${method}`).toBe('function');
    out[name] = modules[name][method] as Handler;
  }
  return out as Routes;
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
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

// A model that proposes the same grounded, cited answer to every message:
// breakfast is served until 8:30 AM, from the Meals section.
export function benignModel(): { model: Model; calls: () => number } {
  let n = 0;
  const model: Model = async () => {
    n += 1;
    return {
      output: {
        outcome: 'answer',
        reason: 'answered',
        language: 'en',
        text: 'Marker pangolin: breakfast is served until 8:30 AM.',
        citations: ['meals'],
        topic: 'Meals',
        gapLabel: null,
      },
      usage: { input: 1, cachedInput: 0, output: 1 },
    };
  };
  return { model, calls: () => n };
}

// ---------------------------------------------------------------------------
// A fake clock: sleep(ms) waits until advance() moves virtual time past it.

export function fakeClock(startMs: number) {
  let current = startMs;
  let sleepers: { at: number; resolve: () => void }[] = [];
  const requested: number[] = [];
  const clock: Clock = {
    now: () => current,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        requested.push(ms);
        sleepers.push({ at: current + Math.max(0, ms), resolve });
      }),
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  // Moves virtual time forward by `ms`, waking each sleeper at its own time.
  async function advance(ms: number): Promise<void> {
    const end = current + ms;
    await settle();
    for (;;) {
      const due = sleepers.filter((s) => s.at <= end);
      if (due.length === 0) break;
      const at = Math.min(...due.map((s) => s.at));
      current = Math.max(current, at);
      const now = sleepers.filter((s) => s.at <= current);
      sleepers = sleepers.filter((s) => s.at > current);
      for (const s of now) s.resolve();
      await settle();
    }
    current = end;
    await settle();
  }
  return { clock, advance, settle, requested };
}

// ---------------------------------------------------------------------------
// A server of the test's own: `next dev` run from a copy of the app (every
// file git tracks or would track, with the installed node_modules linked
// in), so it never collides with another `next dev` in app/.

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export function copyApp(label: string): string {
  const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `${label}-`));
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT }).toString().split('\0').filter(Boolean);
  const wanted = listed.filter(
    (f) =>
      (f.startsWith('app/') && !f.startsWith('app/tests/') && !f.split('/').includes('node_modules')) ||
      ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'].includes(f),
  );
  for (const f of wanted) {
    const from = path.join(ROOT, f);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
    fs.copyFileSync(from, path.join(work, f));
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(work, 'node_modules'));
  fs.symlinkSync(path.join(APP, 'node_modules'), path.join(work, 'app', 'node_modules'));
  return work;
}

export type OwnServer = { base: string; output: () => string; stop: () => Promise<void> };

// Starts `next dev` in fixture mode from a copy of the app and waits until it
// answers /api/health.
export async function startDevServer(): Promise<OwnServer> {
  expect(process.env.DATABASE_URL, 'DATABASE_URL is not set; the server needs a reachable Postgres').toBeTruthy();
  const work = copyApp('demo-server');
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AWS_') || k.startsWith('__NEXT') || k.startsWith('VITEST') || k === 'NODE_ENV' || k === 'PORT') delete env[k];
  Object.assign(env, { MODEL_MODE: 'fixture', NEXT_TELEMETRY_DISABLED: '1' });
  let output = '';
  const child: ChildProcess = spawn(path.join(work, 'app', 'node_modules', '.bin', 'next'), ['dev', '--webpack', '--port', String(port)], {
    cwd: path.join(work, 'app'),
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));
  const stop = async () => {
    if (child.pid && child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      process.kill(-child.pid, 'SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    }
    fs.rmSync(work, { recursive: true, force: true });
  };
  const deadline = Date.now() + 180_000;
  try {
    for (;;) {
      expect(child.exitCode, `next dev exited:\n${output.slice(-2000)}`).toBeNull();
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        // not listening yet
      }
      expect(Date.now(), `next dev did not start:\n${output.slice(-2000)}`).toBeLessThan(deadline);
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (err) {
    await stop();
    throw err;
  }
  return { base, output: () => output, stop };
}
