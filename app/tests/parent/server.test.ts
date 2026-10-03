// The parent view as a running server renders it: no model call, and a fixed
// message when the database is unavailable.
//
// no model call: loading the parent view, Today card included, opens no
// connection to the model. The server runs the real Bedrock model pointed at
// a local listener that counts connections; a message to /api/ask shows the
// listener sees model calls.
//
// database unavailable: when the database goes away after the server has
// started, loading the parent view, with or without a sandbox cookie, gives a
// page with a fixed message and the phone link. It is never blank and shows no
// stack trace, error message or sandbox ID.
//
// Assumed interface:
// - `next dev` serves the app from app/; no other `next dev` may be running
//   there (Next allows one per directory).
// - The AWS SDK reads AWS_ENDPOINT_URL_BEDROCK_RUNTIME, so the Bedrock model
//   connects to the local listener.
// - The fixed message for an unavailable database is in the HTML the server
//   returns for /, with the phone link as an <a href="tel:..."> there.
// - The page sets the fd_sandbox cookie (see ../e2e/support.ts).

import { type ChildProcess, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { longDate } from '../../src/core/today';
import { denverDate } from '../../src/seed/dates';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PHONE_DIGITS = '5055550142';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const STACK = /\bat\s+\S+\s+\(?[^\s()]+:\d+:\d+\)?|\b(?:Type|Reference|Syntax|Range)?Error\b|ECONNREFUSED|ECONNRESET|connect\s+E[A-Z]+|node_modules|\.tsx?:\d+/;

// A listener that counts connections and closes each one.
function counter(): Promise<{ port: number; count: () => number; close: () => void }> {
  let n = 0;
  const server = net.createServer((s) => {
    n += 1;
    s.destroy();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as net.AddressInfo).port, count: () => n, close: () => server.close() }),
    ),
  );
}

// A TCP proxy to Postgres that can be cut: `down()` drops every connection
// and refuses new ones.
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

// Visible text: the HTML without scripts, styles and tags.
function visible(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function telLinks(html: string): string[] {
  const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  return [...markup.matchAll(/<a\b[^>]*\bhref="(tel:[^"]*)"/gi)].map((m) => m[1]);
}

function sandboxCookie(response: Response): string | null {
  for (const header of response.headers.getSetCookie()) {
    const m = /^fd_sandbox=([^;]+)/.exec(header);
    if (m) return m[1];
  }
  return null;
}

let child: ChildProcess | null = null;
let output = '';
let base = '';
let model: Awaited<ReturnType<typeof counter>>;
let database: Awaited<ReturnType<typeof proxy>>;

beforeAll(async () => {
  expect(process.env.DATABASE_URL, 'DATABASE_URL is not set; the server needs a reachable Postgres').toBeTruthy();
  const url = new URL(process.env.DATABASE_URL!);
  database = await proxy({ host: url.hostname, port: Number(url.port || 5432) });
  url.host = `127.0.0.1:${database.port}`;
  model = await counter();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AWS_') || k === 'MODEL_MODE' || k === 'NODE_ENV') delete env[k];
  Object.assign(env, {
    DATABASE_URL: url.toString(),
    AWS_ENDPOINT_URL_BEDROCK_RUNTIME: `http://127.0.0.1:${model.port}`,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE00',
    AWS_SECRET_ACCESS_KEY: 'example-example-example-example-example0',
    AWS_EC2_METADATA_DISABLED: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
  });
  child = spawn(path.join(APP, 'node_modules', '.bin', 'next'), ['dev', '--port', String(port)], { cwd: APP, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));

  const deadline = Date.now() + 150_000;
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
}, 180_000);

afterAll(async () => {
  if (child?.pid && child.exitCode === null) {
    const exited = new Promise((r) => child!.once('exit', r));
    process.kill(-child.pid, 'SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
  }
  model?.close();
}, 30_000);

describe('no model call', () => {
  test('loading the parent view opens no connection to the model', async () => {
    const before = model.count();
    const first = await fetch(`${base}/`);
    const html = await first.text();
    expect(first.status, `the parent view did not load:\n${output.slice(-2000)}`).toBe(200);
    const id = sandboxCookie(first);
    expect(id, 'the page set no sandbox cookie').toBeTruthy();
    expect(visible(html), "the page does not show today's date").toContain(longDate(denverDate(new Date())));
    const again = await fetch(`${base}/`, { headers: { cookie: `fd_sandbox=${id}` } });
    expect(again.status).toBe(200);
    expect(model.count(), 'loading the parent view called the model').toBe(before);

    // The listener does see model calls.
    const asked = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `fd_sandbox=${id}` },
      body: JSON.stringify({ message: 'Do you have a swimming pool?', priorTurns: [] }),
    });
    expect(asked.status).toBe(200);
    expect(model.count(), 'a message reached no model, so this check proves nothing').toBeGreaterThan(before);
  }, 120_000);
});

describe('database unavailable', () => {
  test('the page shows a fixed message with the phone link, and nothing internal', async () => {
    const up = await fetch(`${base}/`);
    expect(up.status, `the parent view did not load with the database up:\n${output.slice(-2000)}`).toBe(200);
    const id = sandboxCookie(up);
    expect(id, 'the page set no sandbox cookie').toBeTruthy();

    database.down();
    for (const [what, headers] of [
      ['a first visit', {}],
      ['a return visit', { cookie: `fd_sandbox=${id}` }],
    ] as const) {
      const response = await fetch(`${base}/`, { headers });
      const html = await response.text();
      const text = visible(html);
      expect(text.length, `${what}: the page is blank`).toBeGreaterThan(0);
      expect(
        telLinks(html).some((h) => h.replace(/\D/g, '').endsWith(PHONE_DIGITS)),
        `${what}: the page has no tel: link for the front desk`,
      ).toBe(true);
      expect(text, `${what}: the page shows an error or a stack trace`).not.toMatch(STACK);
      expect(text, `${what}: the page shows an internal ID`).not.toMatch(UUID);
      expect(text, `${what}: the page shows the sandbox ID`).not.toContain(id!);
    }
  }, 120_000);
});
