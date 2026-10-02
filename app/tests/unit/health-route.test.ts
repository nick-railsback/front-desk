// GET /api/health: answers 200 on its own, without the model or the
// database, and says nothing a visitor could use against the app.
//
// Network access is cut off while the route loads and runs: any socket,
// DNS lookup, or fetch is recorded and refused. Each check runs twice, with
// no database or model settings and with live-looking ones, so the answer
// cannot depend on either.

import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

const ROUTE = 'src/app/api/health/route.ts';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SENTINEL_PASSWORD = 'sentinel-pw-0155';
const SENTINEL_HOST = 'db.front-desk.example';
const LIVE_ENV: Record<string, string> = {
  DATABASE_URL: `postgres://frontdesk:${SENTINEL_PASSWORD}@${SENTINEL_HOST}:5432/frontdesk`,
  MODEL_MODE: 'live',
  MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  AWS_REGION: 'us-east-1',
};
const ENV_KEYS = [...Object.keys(LIVE_ENV), 'PGHOST', 'PGPASSWORD'];

const savedEnv = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

type Outcome = { status: number; body: string; attempts: string[] };

// Loads the route fresh under the given environment with the network cut
// off, then calls GET.
async function callHealth(env: Record<string, string> | null): Promise<Outcome> {
  expect(fs.existsSync(path.join(APP, ROUTE)), `app/${ROUTE} does not exist`).toBe(true);
  for (const key of ENV_KEYS) delete process.env[key];
  if (env) Object.assign(process.env, env);

  const attempts: string[] = [];
  const refuse = (what: string) => {
    attempts.push(what);
    throw new Error(`network access refused in this test: ${what}`);
  };
  vi.stubGlobal('fetch', (input: unknown) => refuse(`fetch ${String(input)}`));
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function connect(...args: unknown[]) {
    return refuse(`socket ${JSON.stringify(args[0])}`);
  });
  vi.spyOn(dns, 'lookup').mockImplementation(((host: string) => refuse(`dns ${host}`)) as never);
  vi.spyOn(dns.promises, 'lookup').mockImplementation(((host: string) => refuse(`dns ${host}`)) as never);

  vi.resetModules();
  const mod = await import('../../src/app/api/health/route');
  expect(typeof mod.GET, `app/${ROUTE} does not export GET`).toBe('function');
  const res: Response = await mod.GET(new Request('http://localhost/api/health'));
  const body = await res.text();
  return { status: res.status, body, attempts };
}

const SETTINGS: [string, Record<string, string> | null][] = [
  ['with no database or model settings', null],
  ['with live database and model settings', LIVE_ENV],
];

describe('health', () => {
  for (const [label, env] of SETTINGS) {
    test(`health: responds 200 ${label}`, async () => {
      const { status } = await callHealth(env);
      expect(status).toBe(200);
    });

    test(`health: opens no connection to the model or the database ${label}`, async () => {
      const { status, attempts } = await callHealth(env);
      expect(attempts).toEqual([]);
      expect(status).toBe(200);
    });
  }

  test('health: the body holds no stack trace, prompt, model output, or internal identifier', async () => {
    const { body } = await callHealth(LIVE_ENV);
    expect(body.length, 'a health body is a short status, not a report').toBeLessThanOrEqual(1024);
    const leaks: [string, RegExp][] = [
      ['a stack frame', /\bat\s+\S+\s+\(|\n\s+at\s/],
      ['an error message', /\b\w*Error:/],
      ['a source position', /[\w./-]+\.(ts|tsx|js|mjs|cjs):\d+/],
      ['a dependency path', /node_modules/],
      ['an ARN', /arn:aws/i],
      ['an account ID', /(^|\D)\d{12}(\D|$)/],
      ['an instance ID', /\bi-[0-9a-f]{8,17}\b/],
      ['an IP address', /\b\d{1,3}(\.\d{1,3}){3}\b/],
      ['the model or its provider', /claude|anthropic|bedrock/i],
      ['prompt text', /prompt|you are|assistant|system:/i],
      ['a connection string', /postgres(ql)?:\/\//i],
      ['the database password', new RegExp(SENTINEL_PASSWORD)],
      ['the database host', new RegExp(SENTINEL_HOST.replace(/\./g, '\\.'))],
      ['an environment variable name', /DATABASE_URL|MODEL_MODE|AWS_/],
    ];
    const hostname = os.hostname();
    if (hostname) leaks.push(['the machine hostname', new RegExp(hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')]);
    const found = leaks.filter(([, re]) => re.test(body)).map(([what]) => what);
    expect(found, `body: ${body}`).toEqual([]);
  });
});
