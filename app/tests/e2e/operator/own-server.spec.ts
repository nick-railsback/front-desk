// The operator view on a server of its own, where the model and the
// database can be watched and cut.
//
// The server is `next dev --webpack` run from a copy of the app (every file
// git tracks or would track, with the installed node_modules linked in), so
// it does not collide with the browser tests' own `next dev`. Its Bedrock
// model points at a local listener that counts each connection and
// closes it; its database connection runs through a proxy that can be cut;
// its process and the browser both run in Pacific/Honolulu (UTC-10).
//
// no model call: loading the operator view, opening each area, opening a
// question and a citation chip, opening the editor from Answer this and from
// an edit control, and saving a draft make no model request, and publishing
// with no open gap makes none either. A parent message to /api/ask on the
// same server does reach the listener, so the check can see model calls.
//
// calendar date: a section last updated on 2026-11-26 reads November 26,
// 2026 in Center info, never November 25, with the server and the browser
// west of UTC.
//
// database unavailable: when the database goes away after the server has
// started, loading the operator view, with or without a sandbox cookie,
// shows a fixed message and the view is not blank; it shows no stack trace,
// error text, SQL, internal ID or sandbox ID.
//
// Assumed interface: see ./support.ts. The AWS SDK reads
// AWS_ENDPOINT_URL_BEDROCK_RUNTIME, as the parent view's server test relies
// on, and the view takes its dates from the draft's updatedOn.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type Browser, type BrowserContext, expect, test } from '@playwright/test';
import {
  COOKIE,
  answerThis,
  bodyField,
  chips,
  control,
  db,
  draftOf,
  editControls,
  expectClean,
  gapItem,
  itemTitled,
  itemWith,
  letters,
  openedQuestion,
  opener,
  publish,
  save,
  showArea,
  titleField,
  version,
} from './support';

// Tests run in file order in one worker; a failure restarts the worker, and
// with it this server. The database test cuts the connection, so it is last.
test.use({ actionTimeout: 15_000 });

const APP = path.resolve(__dirname, '..', '..', '..');
const ROOT = path.resolve(APP, '..');
const ZONE = 'Pacific/Honolulu';
const SEEDED_ANSWER = 'How much is the late pickup fee?';

// A Bedrock stand-in that counts connections and closes each one. The
// Bedrock client speaks HTTP/2, so a model call is seen as a connection; a
// refused connection is a failed call, and the next call connects again.
function bedrock(): Promise<{ port: number; count: () => number; close: () => void }> {
  let n = 0;
  const server = net.createServer((s) => {
    n += 1;
    s.destroy();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, count: () => n, close: () => server.close() })),
  );
}

// A TCP proxy to Postgres that can be cut.
function proxy(target: { host: string; port: number }): Promise<{ port: number; down: () => void }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('error', () => s.destroy());
      s.on('close', () => sockets.delete(s));
    }
    client.pipe(upstream).pipe(client);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        down: () => {
          server.close();
          for (const s of sockets) s.destroy();
        },
      }),
    ),
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

// The app as git would hand it over, without its tests, plus the root
// workspace files, with node_modules linked from this checkout.
function copyApp(): string {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-server-'));
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT }).toString().split('\0').filter(Boolean);
  const wanted = listed.filter(
    (f) => (f.startsWith('app/') && !f.startsWith('app/tests/') && !f.split('/').includes('node_modules')) || ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'].includes(f),
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

let work = '';
let child: ChildProcess | null = null;
let output = '';
let base = '';
let model: Awaited<ReturnType<typeof bedrock>>;
let database: Awaited<ReturnType<typeof proxy>>;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  expect(process.env.DATABASE_URL, 'DATABASE_URL is not set; the server needs a reachable Postgres').toBeTruthy();
  const url = new URL(process.env.DATABASE_URL!);
  database = await proxy({ host: url.hostname, port: Number(url.port || 5432) });
  url.host = `127.0.0.1:${database.port}`;
  model = await bedrock();
  const port = await freePort();
  // localhost, not 127.0.0.1: next dev serves its client resources only to
  // the origin it names.
  base = `http://localhost:${port}`;
  work = copyApp();

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AWS_') || k.startsWith('__NEXT') || k === 'MODEL_MODE' || k === 'NODE_ENV' || k === 'PORT') delete env[k];
  Object.assign(env, {
    TZ: ZONE,
    DATABASE_URL: url.toString(),
    AWS_ENDPOINT_URL_BEDROCK_RUNTIME: `http://127.0.0.1:${model.port}`,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE00',
    AWS_SECRET_ACCESS_KEY: 'example-example-example-example-example0',
    AWS_EC2_METADATA_DISABLED: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
  });
  child = spawn(path.join(work, 'app', 'node_modules', '.bin', 'next'), ['dev', '--webpack', '--port', String(port)], {
    cwd: path.join(work, 'app'),
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));

  const deadline = Date.now() + 180_000;
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
});

test.afterAll(async () => {
  test.setTimeout(60_000);
  if (child?.pid && child.exitCode === null) {
    const exited = new Promise((r) => child!.once('exit', r));
    process.kill(-child.pid, 'SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
  }
  model?.close();
  database?.down();
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

async function context(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: base, timezoneId: ZONE, viewport: { width: 375, height: 812 } });
}

async function sandboxOf(ctx: BrowserContext): Promise<string> {
  const cookie = (await ctx.cookies()).find((c) => c.name === COOKIE);
  expect(cookie, `no ${COOKIE} cookie is set`).toBeTruthy();
  return cookie!.value;
}

test.describe('no model call', () => {
  test('loading, opening each area, a question, the editor, and saving make no model request; nor does publishing with no open gap', async ({ browser }) => {
    test.setTimeout(240_000);
    const ctx = await context(browser);
    const page = await ctx.newPage();
    const before = model.count();

    const response = await page.goto('/operator');
    expect(response?.status(), `the operator view did not load:\n${output.slice(-2000)}`).toBe(200);
    await expect(control(page.locator('body'), 'Questions').first()).toBeVisible({ timeout: 60_000 });
    const id = await sandboxOf(ctx);
    expect(model.count(), 'loading the operator view called the model').toBe(before);

    for (const name of ['Questions', 'Gaps', 'Center info'] as const) await showArea(page, name);
    const questions = await showArea(page, 'Questions');
    await opener(itemWith(questions, SEEDED_ANSWER)).click();
    await expect(openedQuestion(page)).toBeVisible();
    await chips(openedQuestion(page)).first().click();
    expect(model.count(), 'opening an area or a question called the model').toBe(before);

    await page.goto('/operator');
    await answerThis(gapItem(await showArea(page, 'Gaps'), 'Summer program')).first().click();
    await expect(titleField(page)).toBeVisible();
    await page.goto('/operator');
    await editControls(itemTitled(await showArea(page, 'Center info'), 'Meals')).first().click();
    await expect(titleField(page)).toBeVisible();
    await bodyField(page).fill(`Breakfast is served until 8:30 AM. Oracle ${letters(8)}.`);
    expect((await save(page)).ok(), 'the save failed').toBe(true);
    expect(model.count(), 'opening the editor or saving a draft called the model').toBe(before);

    await db().query('delete from gaps where sandbox_id = $1', [id]);
    expect((await publish(page)).ok(), 'the publish failed').toBe(true);
    await expect.poll(() => version(page), { timeout: 30_000 }).toBe(2);
    await new Promise((r) => setTimeout(r, 3000));
    expect(model.count(), 'publishing with no open gap called the model').toBe(before);

    // The listener does see model calls.
    const asked = await page.request.post('/api/ask', { data: { message: 'Do you have a swimming pool?', priorTurns: [] } });
    expect(asked.status()).toBe(200);
    expect(model.count(), 'a parent message reached no model, so this check proves nothing').toBeGreaterThan(before);
    await ctx.close();
  });
});

test.describe('calendar date', () => {
  test('a section last updated on 2026-11-26 reads November 26, 2026, never November 25', async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await context(browser);
    const page = await ctx.newPage();
    const response = await page.goto('/operator');
    expect(response?.status(), 'the operator view did not load').toBe(200);
    await expect(control(page.locator('body'), 'Questions').first()).toBeVisible({ timeout: 60_000 });
    const id = await sandboxOf(ctx);
    const draft = await draftOf(id);
    const meals = draft.find((s) => s.id === 'meals');
    expect(meals, 'the draft has no meals section').toBeTruthy();
    meals!.updatedOn = '2026-11-26';
    await db().query('update drafts set sections = $2::jsonb where sandbox_id = $1', [id, JSON.stringify(draft)]);
    expect(new Date('2026-06-01T00:00:00Z').toLocaleString('en-US', { timeZone: ZONE })).toContain('5/31/2026');

    await page.reload();
    const item = itemTitled(await showArea(page, 'Center info'), 'Meals');
    await expect(item, 'the Meals section does not read November 26, 2026').toContainText('November 26, 2026');
    await expect(item, 'the Meals section reads the day before').not.toContainText(/November 25/);
    await ctx.close();
  });
});

test.describe('database unavailable', () => {
  test('the operator view shows a fixed message and nothing internal', async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await context(browser);
    const page = await ctx.newPage();
    const up = await page.goto('/operator');
    expect(up?.status(), 'the operator view did not load with the database up').toBe(200);
    await expect(control(page.locator('body'), 'Questions').first()).toBeVisible({ timeout: 60_000 });
    const id = await sandboxOf(ctx);

    database.down();
    for (const [what, cookies] of [
      ['a first visit', false],
      ['a return visit', true],
    ] as const) {
      const visit = cookies ? page : await (await context(browser)).newPage();
      await visit.goto('/operator');
      await expect(visit.getByRole('alert').filter({ hasText: /[A-Za-z]{3}/ }).first(), `${what}: no fixed message is shown`).toBeVisible({ timeout: 30_000 });
      await expectClean(visit, id, what);
    }
    await ctx.close();
  });
});
