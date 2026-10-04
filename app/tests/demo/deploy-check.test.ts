// The post-deploy check: after the deploy's health check, the deploy job asks
// the deployed app one question the way a browser does, and fails unless
// the reply is an answer with at least one citation.
//
// passes: against the app in fixture mode on a server of the test's own, the
// check exits 0. Against a stand-in app that answers only a request
// carrying the cookie its page load set, the check exits 0, and it loaded
// the page before it asked, with that cookie and a JSON message.
//
// fails: the check exits non-zero when the reply is a handoff, an urgent
// reply, or an answer with no citation; when the response has a server
// error status (even with an answer in its body); when a success response
// is not JSON or is JSON that is not a reply; and when the app cannot be
// reached at all.
//
// deploy workflow: the deploy job runs the check against the deployed app's
// URL in a step after the step that checks /api/health, in the same job,
// with nothing that lets the job go on when the check fails.
//
// Assumed interface: see ./support.ts (5).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import * as repo from '../../../tests/repo/support/repo.mjs';
import { COOKIE, ROOT, freePort, startDevServer } from './support';

const SCRIPT = '.github/scripts/check-answer.sh';
const DEPLOY = '.github/workflows/deploy.yml';
const SANDBOX = '5b0e8c1e-4d6f-4a35-9c1f-2a7e3c9d0b14';

function scriptExists(): void {
  expect(fs.existsSync(path.join(ROOT, SCRIPT)), `${SCRIPT} does not exist`).toBe(true);
}

// Runs the check against `base` and resolves with its exit status and output.
function check(base: string, timeoutMs = 170_000): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn('bash', [path.join(ROOT, SCRIPT), base], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => {
      output += '\n[the check was still running and was stopped]';
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    }, timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, output: output.slice(-1500) });
    });
  });
}

type Seen = { method: string; path: string; cookie: string; body: string };

// A stand-in app: its page load sets the sandbox cookie, and POST /api/ask
// answers with `ask(request)`.
function standIn(ask: (seen: Seen) => { status: number; type: string; body: string }): Promise<{ base: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', path: (req.url ?? '').split('?')[0], cookie: req.headers.cookie ?? '', body };
      seen.push(s);
      if (s.method === 'GET' && (s.path === '/' || s.path === '')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `${COOKIE}=${SANDBOX}; Path=/; HttpOnly; SameSite=Lax` });
        res.end('<!doctype html><title>Front Desk</title><main>Front desk</main>');
      } else if (s.method === 'POST' && s.path === '/api/ask') {
        const r = ask(s);
        res.writeHead(r.status, { 'content-type': r.type });
        res.end(r.body);
      } else if (s.path === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}');
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ base: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, seen, close: () => server.close() }),
    ),
  );
}

function reply(outcome: string, reason: string, citations: string[]): string {
  return JSON.stringify({
    reply: {
      text: outcome === 'answer' ? 'The center is open Monday to Friday.' : 'Please call the front desk at (505) 555-0142.',
      outcome,
      reason,
      snapshotVersion: 1,
      citations: citations.map((sectionId) => ({ sectionId })),
    },
    replyId: 'live-1',
    sections: citations.map((id) => ({ id, title: 'Hours', kind: 'data', updatedOn: '2026-10-03', text: 'The center is open Monday to Friday.' })),
  });
}

const JSON_TYPE = 'application/json';
const ANSWER = { status: 200, type: JSON_TYPE, body: reply('answer', 'answered', ['hours']) };

const REJECTED: { name: string; respond: () => { status: number; type: string; body: string } }[] = [
  { name: 'a handoff reply', respond: () => ({ status: 200, type: JSON_TYPE, body: reply('handoff', 'not_in_source', []) }) },
  { name: 'an urgent reply', respond: () => ({ status: 200, type: JSON_TYPE, body: reply('urgent', 'emergency', []) }) },
  { name: 'an answer with no citation', respond: () => ({ status: 200, type: JSON_TYPE, body: reply('answer', 'answered', []) }) },
  { name: 'a server error status with an answer in its body', respond: () => ({ ...ANSWER, status: 500 }) },
  { name: 'a success response that is not JSON', respond: () => ({ status: 200, type: 'text/html', body: '<!doctype html><p>answer citations</p>' }) },
  { name: 'a success response that is JSON but not a reply', respond: () => ({ status: 200, type: JSON_TYPE, body: '{"status":"ok","outcome":"answer","citations":[{"sectionId":"hours"}]}' }) },
];

describe('post-deploy check passes', () => {
  test('against the app in fixture mode on a server of its own', async () => {
    scriptExists();
    const server = await startDevServer();
    try {
      // The first request to each route compiles it; warm both, so the check
      // meets a running app as it would after a deploy.
      const page = await fetch(`${server.base}/`);
      const cookie = (page.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`)) ?? '').split(';')[0];
      await fetch(`${server.base}/api/ask`, { method: 'POST', headers: { 'content-type': JSON_TYPE, cookie }, body: JSON.stringify({ message: 'When is breakfast served?', priorTurns: [] }) });
      const result = await check(server.base);
      expect(result.status, `the check failed against the app in fixture mode:\n${result.output}\n${server.output().slice(-1500)}`).toBe(0);
    } finally {
      await server.stop();
    }
  }, 400_000);

  test('against a stand-in that answers only with the cookie its page load set, after loading that page', async () => {
    scriptExists();
    const app = await standIn((s) =>
      s.cookie.includes(`${COOKIE}=${SANDBOX}`) ? ANSWER : { status: 200, type: JSON_TYPE, body: reply('handoff', 'not_in_source', []) },
    );
    try {
      const result = await check(app.base);
      expect(result.status, `the check failed against an app that answers:\n${result.output}`).toBe(0);
      const page = app.seen.findIndex((s) => s.method === 'GET' && s.path === '/');
      const asks = app.seen.filter((s) => s.method === 'POST' && s.path === '/api/ask');
      expect(page, 'the check never loaded the page').toBeGreaterThanOrEqual(0);
      expect(asks.length, 'the check never asked').toBeGreaterThan(0);
      expect(app.seen.indexOf(asks[0]), 'the check asked before it loaded the page').toBeGreaterThan(page);
      expect(asks[0].cookie, 'the check asked without the page load cookie').toContain(`${COOKIE}=${SANDBOX}`);
      const body = JSON.parse(asks[0].body);
      expect(typeof body.message === 'string' && body.message.trim().length > 0, 'the check sent no message').toBe(true);
    } finally {
      app.close();
    }
  }, 200_000);
});

describe('post-deploy check fails', () => {
  for (const c of REJECTED) {
    test.concurrent(`on ${c.name}`, async () => {
      scriptExists();
      const app = await standIn(c.respond);
      try {
        const result = await check(app.base);
        expect(result.status, `the check passed on ${c.name}:\n${result.output}`).not.toBe(0);
        expect(result.output, 'the check was stopped rather than failing on its own').not.toContain('[the check was still running and was stopped]');
        expect(app.seen.some((s) => s.method === 'POST' && s.path === '/api/ask'), `the check never asked, so ${c.name} was never seen`).toBe(true);
      } finally {
        app.close();
      }
    }, 200_000);
  }

  test.concurrent('on an app that cannot be reached', async () => {
    scriptExists();
    const port = await freePort();
    const result = await check(`http://127.0.0.1:${port}`);
    expect(result.status, `the check passed with nothing listening:\n${result.output}`).not.toBe(0);
    expect(result.output, 'the check was stopped rather than failing on its own').not.toContain('[the check was still running and was stopped]');
  }, 200_000);
});

type Line = { indent: number; text: string };
type Entry = { key: string; value: string; body: Line[] };

// The items of a block sequence, each as its lines.
function items(lines: Line[]): Line[][] {
  if (lines.length === 0) return [];
  const indent = Math.min(...lines.map((l) => l.indent));
  const out: Line[][] = [];
  for (const line of lines) {
    if (line.indent === indent && /^-(\s|$)/.test(line.text)) out.push([{ indent: indent + 2, text: line.text.replace(/^-\s*/, '') }]);
    else if (out.length > 0) out[out.length - 1].push(line);
  }
  return out;
}

describe('deploy workflow', () => {
  test('the deploy job runs the check against the deployed app after its health check, and a failed check fails the job', () => {
    const text = fs.readFileSync(path.join(ROOT, DEPLOY), 'utf8');
    const jobs = repo.workflowJobs(text) as { id: string; lines: Line[] }[];
    const found: string[] = [];
    for (const job of jobs) {
      const fields = repo.mapEntries(job.lines) as Entry[];
      const steps = items(fields.find((f) => f.key === 'steps')?.body ?? []).map((lines) => {
        const entries = repo.mapEntries(lines) as Entry[];
        return { entries, text: lines.map((l) => l.text).join('\n') };
      });
      const health = steps.findIndex((s) => s.text.includes('/api/health'));
      const runs = steps.findIndex((s) => s.text.includes(SCRIPT));
      if (runs < 0) continue;
      found.push(job.id);
      expect(health, `${job.id} runs ${SCRIPT} but has no step that checks /api/health`).toBeGreaterThanOrEqual(0);
      expect(runs, `${job.id} runs ${SCRIPT} before its health check`).toBeGreaterThan(health);
      const step = steps[runs];
      const run = step.entries.find((e) => e.key === 'run');
      expect(run, `the step running ${SCRIPT} has no run: key`).toBeTruthy();
      expect(step.text, `the step running ${SCRIPT} does not pass it the deployed app's URL`).toMatch(/APP_URL/);
      expect(step.text, `the step running ${SCRIPT} swallows its failure`).not.toMatch(/\|\|\s*(true|:|exit 0)(\s|;|$)|\bset \+e\b/);
      for (const where of [step.entries, fields]) {
        const coe = where.find((e) => e.key === 'continue-on-error');
        expect(repo.unquote(coe?.value ?? 'false'), `${job.id} continues when the check fails`).not.toMatch(/^true$/i);
      }
      const condition = repo.unquote(step.entries.find((e) => e.key === 'if')?.value ?? '');
      expect(condition, `the step running ${SCRIPT} runs only on a condition`).toMatch(/^(?:|(?:\$\{\{\s*)?success\(\)(?:\s*\}\})?)$/);
    }
    expect(found, `no job in ${DEPLOY} runs ${SCRIPT}`).toEqual(['deploy']);
  });
});
