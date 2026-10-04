// Both views as the production build serves them: `next build`, then
// `next start`, from a copy of the app (every file git tracks or would
// track, installed from the local pnpm store) on a port of its own,
// with the fixture model, the server's clock in Pacific/Honolulu.
//
// idle sandboxes on start: a sandbox idle for 8 days, written before the
// server starts, is deleted with all its data once the server has started,
// before any request reaches it.
//
// content security policy: every response for either view, on a first
// visit and on return visits, carries a Content-Security-Policy whose
// frame-ancestors is 'none' and whose script-src allows only the app's own
// origin and one nonce: no 'unsafe-inline', no 'unsafe-eval', no
// 'strict-dynamic' (which would let a trusted script load scripts from any
// origin), no wildcard, no scheme and no other host. A script-src-elem or
// script-src-attr, if present, holds to the same. Each response carries a
// different nonce.
//
// views under the policy: with that header on the page, both views work and
// the browser reports no violation of it. A parent taps a suggested
// question and gets a reply, then gets an answer and expands its citation
// chip; an operator opens a gap's Answer this, saves a section and
// publishes; a parent activates Try this's first step, dismisses the strip
// and resets the demo.
//
// Tests run in file order in one worker; a failure restarts the worker, and
// with it the build and the server. The check on start comes first, before
// anything sends the server a request.
//
// Assumed interface: see ./support.ts, and ../../demo/support.ts (2, 3).
// The built app finds its migrations through MIGRATIONS_DIR, as the
// container does.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import { rowsNaming, sql } from '../../demo/tables';
import {
  answerThis,
  ask,
  bodyField,
  closeSql,
  confirmButton,
  conversation,
  cookieOf,
  dismiss,
  firstStep,
  gapItem,
  letters,
  newCookie,
  openConfirmation,
  publish,
  save,
  showArea,
  strip,
  titleField,
  version,
} from './support';

test.use({ actionTimeout: 20_000 });

const APP = path.resolve(__dirname, '..', '..', '..');
const ROOT = path.resolve(APP, '..');
const ZONE = 'Pacific/Honolulu';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

// The app as git would hand it over, without its tests, with the workspace
// files it installs from, installed from the local pnpm store with no
// network, as the container build installs it. A real install, not a link to
// this checkout's node_modules, so the build traces files inside the copy.
function copyApp(): string {
  const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'demo-production-'));
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT }).toString().split('\0').filter(Boolean);
  const wanted = listed.filter(
    (f) =>
      (f.startsWith('app/') && !f.startsWith('app/tests/') && !f.split('/').includes('node_modules')) ||
      ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'evals/package.json', 'infra/package.json'].includes(f),
  );
  for (const f of wanted) {
    const from = path.join(ROOT, f);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
    fs.copyFileSync(from, path.join(work, f));
  }
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--offline', '--filter', '@front-desk/app', '--reporter=silent'], { cwd: work, stdio: 'pipe', timeout: 180_000 });
  return work;
}

// A sandbox last active 8 days ago, holding a question no other sandbox
// holds. Written straight into the database, as an old sandbox would be.
async function staleSandbox(): Promise<string> {
  const { rows } = await sql().query(
    `insert into sandboxes (created_at, last_seen_at) values (now() - interval '9 days', now() - interval '8 days') returning id`,
  );
  const id = rows[0].id as string;
  await sql().query(
    `insert into turns (sandbox_id, id, message, created_at, answer_text, outcome, reason, snapshot_version, citations, source)
     values ($1, $2, $3, now() - interval '8 days', 'Please call the front desk.', 'handoff', 'not_in_source', 1, '[]'::jsonb, 'live')`,
    [id, `live-${letters(16)}`, `Is there a pottery class on Saturday? Ref ${letters(12)}`],
  );
  await sql().query(`insert into drafts (sandbox_id, sections) values ($1, '[]'::jsonb)`, [id]);
  return id;
}

let work = '';
let child: ChildProcess | null = null;
let output = '';
let base = '';
let stale = '';

test.beforeAll(async () => {
  test.setTimeout(420_000);
  expect(process.env.DATABASE_URL, 'DATABASE_URL is not set; the server needs a reachable Postgres').toBeTruthy();
  work = copyApp();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AWS_') || k.startsWith('__NEXT') || k === 'MODEL_MODE' || k === 'NODE_ENV' || k === 'PORT') delete env[k];
  Object.assign(env, { NEXT_TELEMETRY_DISABLED: '1' });
  const next = path.join(work, 'app', 'node_modules', '.bin', 'next');
  try {
    execFileSync(next, ['build'], { cwd: path.join(work, 'app'), env: { ...env, NODE_ENV: 'production' }, stdio: 'pipe', timeout: 300_000 });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`next build failed:\n${String(e.stdout ?? '').slice(-2000)}\n${String(e.stderr ?? '').slice(-2000)}`);
  }

  stale = await staleSandbox();
  expect(await rowsNaming(stale), 'the idle sandbox was not written').not.toEqual([]);
  const port = await freePort();
  base = `http://localhost:${port}`;
  child = spawn(next, ['start', '--port', String(port)], {
    cwd: path.join(work, 'app'),
    env: { ...env, NODE_ENV: 'production', TZ: ZONE, MODEL_MODE: 'fixture', MIGRATIONS_DIR: path.join(work, 'app', 'src', 'db', 'migrations') },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));
  // Ready without a request: the start-up check below must see no request.
  const deadline = Date.now() + 90_000;
  while (!/\bReady\b/.test(output)) {
    expect(child.exitCode, `next start exited:\n${output.slice(-2000)}`).toBeNull();
    expect(Date.now(), `next start did not report ready:\n${output.slice(-2000)}`).toBeLessThan(deadline);
    await new Promise((r) => setTimeout(r, 250));
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
  if (work) fs.rmSync(work, { recursive: true, force: true });
  await closeSql();
});

test.describe('idle sandboxes on start', () => {
  test('a sandbox idle for 8 days is deleted with all its data once the server starts, before any request', async () => {
    test.setTimeout(180_000);
    await expect
      .poll(() => rowsNaming(stale), { timeout: 120_000, intervals: [1000], message: `rows still name the idle sandbox after the server started:\n${output.slice(-1000)}` })
      .toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The policy.

function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...tokens] = part.trim().split(/\s+/).filter(Boolean);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), tokens);
  }
  return out;
}

// What is wrong with a script source list, or [] when it allows only the
// app's own origin and one nonce.
function scriptProblems(name: string, tokens: string[]): string[] {
  const problems: string[] = [];
  const nonces = tokens.filter((t) => /^'nonce-[A-Za-z0-9+/_=-]{8,}'$/.test(t));
  if (nonces.length !== 1) problems.push(`${name} holds ${nonces.length} nonces`);
  for (const t of tokens) {
    if (nonces.includes(t) || t === "'self'" || t === new URL(base).origin) continue;
    problems.push(`${name} allows ${t}`);
  }
  return problems;
}

async function load(pathname: string, cookie: string | null): Promise<{ csp: string | null; cookie: string | null; status: number }> {
  const res = await fetch(`${base}${pathname}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  const set = res.headers.getSetCookie().find((c) => c.startsWith('fd_sandbox='));
  await res.arrayBuffer();
  return { csp: res.headers.get('content-security-policy'), cookie: set ? set.split(';')[0] : cookie, status: res.status };
}

test.describe('content security policy', () => {
  for (const pathname of ['/', '/operator']) {
    test(`every response for ${pathname} carries a policy limiting scripts to the app's origin and a fresh nonce, with frame-ancestors 'none'`, async () => {
      const nonces: string[] = [];
      let cookie: string | null = null;
      for (const visit of ['a first visit', 'a return visit', 'another return visit']) {
        const r = await load(pathname, cookie);
        cookie = r.cookie;
        expect(r.status, `${visit} to ${pathname} answered ${r.status}`).toBe(200);
        expect(r.csp, `${visit} to ${pathname} carries no Content-Security-Policy`).toBeTruthy();
        const d = directives(r.csp!);
        expect(d.get('frame-ancestors'), `${visit}: frame-ancestors`).toEqual(["'none'"]);
        expect(d.has('script-src'), `${visit}: the policy has no script-src`).toBe(true);
        const problems = ['script-src', 'script-src-elem', 'script-src-attr'].filter((n) => d.has(n)).flatMap((n) => scriptProblems(n, d.get(n)!));
        expect(problems, `${visit} to ${pathname}: ${r.csp}`).toEqual([]);
        nonces.push(d.get('script-src')!.find((t) => t.startsWith("'nonce-"))!);
      }
      expect(new Set(nonces).size, `the nonces repeat across loads of ${pathname}: ${nonces.join(', ')}`).toBe(nonces.length);
    });
  }
});

// ---------------------------------------------------------------------------
// The views under the policy.

async function context(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: base, timezoneId: ZONE, viewport: { width: 375, height: 812 } });
  await ctx.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__violations.push(`${e.effectiveDirective} blocked ${e.blockedURI || 'inline'}`));
  });
  return ctx;
}

function watch(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (m) => {
    if (/Refused to|Content Security Policy/i.test(m.text())) seen.push(m.text().slice(0, 300));
  });
  return seen;
}

async function violations(page: Page, console: string[]): Promise<string[]> {
  const reported = await page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? []);
  return [...reported, ...console];
}

async function openUnderPolicy(page: Page, pathname: string): Promise<void> {
  const response = await page.goto(pathname);
  expect(response?.status(), `${pathname} did not load:\n${output.slice(-1500)}`).toBe(200);
  expect(await response!.headerValue('content-security-policy'), `${pathname} carries no Content-Security-Policy`).toBeTruthy();
}

test.describe('views under the policy', () => {
  test('a parent taps a suggested question, gets a reply, gets an answer and expands its citation chip, with no violation', async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await context(browser);
    const page = await ctx.newPage();
    const seen = watch(page);
    await openUnderPolicy(page, '/');
    const suggestion = page.getByRole('list', { name: /suggested questions/i }).getByRole('button').first();
    await expect(suggestion, 'no suggested question').toBeVisible();
    const tapped = (await suggestion.innerText()).trim();
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/ask', { timeout: 60_000 });
    await suggestion.click();
    await answered;
    await expect(conversation(page), 'the tapped question got no exchange').toContainText(tapped, { timeout: 30_000 });
    await expect(conversation(page).getByRole('link', { name: /555/ }).first(), 'the tapped question got no reply').toBeVisible({ timeout: 30_000 });

    await ask(page, 'fixture:answered When is breakfast served?');
    const chip = conversation(page).locator('button[aria-expanded]').first();
    await expect(chip, 'the answer shows no citation chip').toBeVisible();
    await chip.click();
    await expect(chip, 'the citation chip did not expand').toHaveAttribute('aria-expanded', 'true');
    expect(await violations(page, seen), 'the browser reported policy violations').toEqual([]);
    await ctx.close();
  });

  test("an operator opens a gap's Answer this, saves a section and publishes, with no violation", async ({ browser }) => {
    test.setTimeout(240_000);
    const ctx = await context(browser);
    const page = await ctx.newPage();
    const seen = watch(page);
    await openUnderPolicy(page, '/operator');
    await answerThis(gapItem(await showArea(page, 'Gaps'), 'Summer program')).first().click();
    await expect(titleField(page), 'Answer this opened no editor').toBeVisible();
    await bodyField(page).fill(`We run no summer program. Ref ${letters(8)}.`);
    expect((await save(page)).ok(), 'the save failed').toBe(true);
    expect((await publish(page)).ok(), 'the publish failed').toBe(true);
    await expect.poll(() => version(page), { timeout: 60_000 }).toBe(2);
    expect(await violations(page, seen), 'the browser reported policy violations').toEqual([]);
    await ctx.close();
  });

  test("a parent activates Try this's first step, dismisses the strip and resets the demo, with no violation", async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx = await context(browser);
    const page = await ctx.newPage();
    const seen = watch(page);
    await openUnderPolicy(page, '/');
    const old = await cookieOf(ctx);
    await expect(firstStep(page), 'no Try this first step').toBeVisible();
    await firstStep(page).click();
    await expect(conversation(page), 'the first step sent no question').toContainText('Do you offer a discount for siblings?', { timeout: 30_000 });
    await dismiss(page).click();
    await expect(strip(page), 'dismissing did not hide the strip').toBeHidden();
    await openConfirmation(page);
    await confirmButton(page).click();
    await newCookie(ctx, old);
    expect(await violations(page, seen), 'the browser reported policy violations').toEqual([]);
    await ctx.close();
  });
});
