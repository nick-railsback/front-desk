// POST /api/ask: sandboxes by cookie, what every reply stores, what no
// response may contain, and fixture mode with no network.
//
// sandbox cookie: a request with no sandbox cookie creates a sandbox and sets
// an HttpOnly cookie naming it. A later request with that cookie uses the same
// sandbox. A cookie naming a sandbox that does not exist gets a new sandbox
// and a new cookie. Two cookie-less requests get two different sandboxes, and
// a reply in one is not visible in the other.
//
// reply log: every reply produced through the route is stored with the
// message, the final outcome and reason, the model's proposed outcome, which
// floors fired, the citations and snapshot version, the detected language and
// topic, the latency, and the model token usage (input, cached input,
// output). Checked for an answer, a sensitive handoff, an urgent reply, and a
// model failure.
//
// response bodies: no response body contains a stack trace, the model
// instructions, raw model output, a sandbox ID, or a database error. Checked
// with a model that throws an error carrying a marker, with model output that
// carries a marker and never reaches the parent (invalid, or failing
// grounding), and with three failing database calls: a database that does
// not exist, a closed port, and a scoped read that throws.
//
// fixture mode: with MODEL_MODE=fixture the route replies with no network
// access (only the database socket is allowed) and no AWS credentials.
//
// Assumed interface: see ./support.ts.

import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  APP,
  type DbModule,
  GENERATED,
  INSTRUMENTATION_MODULE,
  MODEL_MODULE,
  type Model,
  type ModelRequest,
  PAIRS,
  ROUTE_MODULE,
  USAGE,
  answerOut,
  expectReplies,
  inputText,
  normalize,
} from './support';

const TIMEOUT = 60_000;
const SAVED_ENV = { ...process.env };
const ENV_KEYS = [
  'DATABASE_URL',
  'MODEL_MODE',
  'NEXT_RUNTIME',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
];

const opened: DbModule[] = [];

afterEach(async () => {
  vi.doUnmock('../../src/server/model');
  vi.doUnmock('../../src/db/sandbox');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
  while (opened.length > 0) await opened.pop()!.closeDb().catch(() => {});
});

type Loaded = { POST: (request: Request) => Promise<Response> | Response; db: DbModule };

type LoadOptions = {
  model?: Model;
  env?: Record<string, string | undefined>;
  // A failing database fails at startup too; the route must still answer.
  startupMayFail?: boolean;
  failingDb?: Error;
};

// Loads the route fresh, as a server start would: resets modules, applies the
// environment and any replacement model, runs instrumentation's register()
// when the app has one, then imports the route.
async function loadRoute(options: LoadOptions = {}): Promise<Loaded> {
  expect(fs.existsSync(path.join(APP, ROUTE_MODULE)), `app/${ROUTE_MODULE} does not exist`).toBe(true);
  expect(fs.existsSync(path.join(APP, MODEL_MODULE)), `app/${MODEL_MODULE} does not exist`).toBe(true);
  expect(SAVED_ENV.DATABASE_URL, 'DATABASE_URL is not set; the route tests need a reachable Postgres').toBeTruthy();
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  if (options.model) {
    const model = options.model;
    vi.doMock('../../src/server/model', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), getModel: () => model }));
  }
  if (options.failingDb) {
    const failure = options.failingDb;
    vi.doMock('../../src/db/sandbox', async (importOriginal) => {
      const original = await importOriginal<Record<string, any>>();
      const fail = async () => {
        throw failure;
      };
      return {
        ...original,
        createSandbox: fail,
        forSandbox: (id: string) => new Proxy(original.forSandbox(id), { get: (target, key) => (typeof target[key] === 'function' ? fail : target[key]) }),
      };
    });
  }
  if (fs.existsSync(path.join(APP, INSTRUMENTATION_MODULE))) {
    const instrumentation = (await import('../../src/instrumentation')) as any;
    if (typeof instrumentation.register === 'function') {
      process.env.NEXT_RUNTIME = 'nodejs';
      try {
        await instrumentation.register();
      } catch (err) {
        if (!options.startupMayFail) throw err;
      }
    }
  }
  const route = (await import('../../src/app/api/ask/route')) as any;
  expect(typeof route.POST, `app/${ROUTE_MODULE} does not export POST`).toBe('function');
  const db = (await import('../../src/db/sandbox')) as any as DbModule;
  opened.push(db);
  return { POST: route.POST, db };
}

type Posted = { status: number; body: string; json: any; cookie: { name: string; value: string } | null; setCookies: string[] };

async function post(POST: Loaded['POST'], message: string, cookie?: string): Promise<Posted> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const request = new Request('http://localhost/api/ask', { method: 'POST', headers, body: JSON.stringify({ message, priorTurns: [] }) });
  const res = await POST(request);
  expect(res instanceof Response, 'POST did not resolve to a Response').toBe(true);
  const body = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  const httpOnly = setCookies.find((c) => /;\s*httponly\b/i.test(c));
  let parsed: Posted['cookie'] = null;
  if (httpOnly) {
    const [pair] = httpOnly.split(';');
    const eq = pair.indexOf('=');
    parsed = { name: pair.slice(0, eq).trim(), value: decodeURIComponent(pair.slice(eq + 1).trim()) };
  }
  return { status: res.status, body, json, cookie: parsed, setCookies };
}

// A model that answers from `make` and records each request with the
// message it was for.
function recordingModel(make: (request: ModelRequest) => unknown | Promise<unknown>) {
  const requests: ModelRequest[] = [];
  const model: Model = async (request) => {
    requests.push(request);
    return { output: await make(request), usage: USAGE };
  };
  return { model, requests };
}

const GROUNDED = answerOut('Breakfast is served until 8:30 AM.', ['meals']);

function requestFor(requests: ModelRequest[], message: string): ModelRequest | undefined {
  return requests.find((r) => inputText(r).includes(normalize(message)));
}

describe('sandbox cookie', () => {
  test(
    'sandbox cookie: a cookie-less request creates a sandbox and sets an HttpOnly cookie naming it; the cookie keeps later requests in that sandbox',
    async () => {
      const { POST, db } = await loadRoute({ model: recordingModel(() => GROUNDED).model });
      const first = await post(POST, 'Cookie question one?');
      expect(first.status).toBe(200);
      expect(first.cookie, `no HttpOnly cookie in ${JSON.stringify(first.setCookies)}`).not.toBeNull();
      const access = db.forSandbox(first.cookie!.value);
      expectReplies(access);
      expect((await access.replies()).map((r) => r.message)).toEqual(['Cookie question one?']);

      const second = await post(POST, 'Cookie question two?', `${first.cookie!.name}=${first.cookie!.value}`);
      expect(second.status).toBe(200);
      if (second.cookie) expect(second.cookie.value, 'a valid cookie was replaced').toBe(first.cookie!.value);
      expect((await access.replies()).map((r) => r.message).sort()).toEqual(['Cookie question one?', 'Cookie question two?']);
    },
    TIMEOUT,
  );

  test(
    'sandbox cookie: a cookie naming a sandbox that does not exist gets a new sandbox and a new cookie',
    async () => {
      const { POST, db } = await loadRoute({ model: recordingModel(() => GROUNDED).model });
      const first = await post(POST, 'Which cookie name do you use?');
      expect(first.cookie, 'no HttpOnly cookie').not.toBeNull();
      const stale = crypto.randomUUID();
      const res = await post(POST, 'Stale cookie question?', `${first.cookie!.name}=${stale}`);
      expect(res.status).toBe(200);
      expect(res.cookie, 'no new cookie for a stale sandbox').not.toBeNull();
      expect(res.cookie!.value).not.toBe(stale);
      expect(res.cookie!.value).not.toBe(first.cookie!.value);
      expect((await db.forSandbox(res.cookie!.value).replies()).map((r) => r.message)).toEqual(['Stale cookie question?']);
    },
    TIMEOUT,
  );

  test(
    'sandbox cookie: two cookie-less requests get two sandboxes, and neither sees the other reply',
    async () => {
      const { POST, db } = await loadRoute({ model: recordingModel(() => GROUNDED).model });
      const a = await post(POST, 'Sandbox A question?');
      const b = await post(POST, 'Sandbox B question?');
      expect(a.cookie && b.cookie, 'a request got no HttpOnly cookie').toBeTruthy();
      expect(a.cookie!.value).not.toBe(b.cookie!.value);
      expect((await db.forSandbox(a.cookie!.value).replies()).map((r) => r.message)).toEqual(['Sandbox A question?']);
      expect((await db.forSandbox(b.cookie!.value).replies()).map((r) => r.message)).toEqual(['Sandbox B question?']);
    },
    TIMEOUT,
  );
});

describe('reply log', () => {
  test(
    'reply log: an answer, a sensitive handoff, an urgent reply, and a model failure are each stored with every logged field',
    async () => {
      const scripted = recordingModel(() => GROUNDED);
      const first = await loadRoute({ model: scripted.model });
      const messages = {
        answer: 'What time is breakfast served?',
        sensitive: 'I was charged twice for tuition this week and I want a refund.',
        urgent: 'My son is not breathing right now!',
        failure: 'Is the late fee per day?',
      };
      const posted: Record<string, Posted> = {};
      posted.answer = await post(first.POST, messages.answer);
      const cookie = `${posted.answer.cookie!.name}=${posted.answer.cookie!.value}`;
      posted.sensitive = await post(first.POST, messages.sensitive, cookie);
      posted.urgent = await post(first.POST, messages.urgent, cookie);

      const failing: Model = async () => {
        throw new Error('model unavailable');
      };
      const second = await loadRoute({ model: failing });
      posted.failure = await post(second.POST, messages.failure, cookie);

      const stored = await second.db.forSandbox(posted.answer.cookie!.value).replies();
      const problems: string[] = [];
      for (const [kind, message] of Object.entries(messages)) {
        const row = stored.find((r) => r.message === message);
        const res = posted[kind].json?.reply;
        if (!row) {
          problems.push(`${kind}: not stored`);
          continue;
        }
        if (!res) {
          problems.push(`${kind}: the response holds no reply`);
          continue;
        }
        const usedModel = kind !== 'failure' && requestFor(scripted.requests, message) !== undefined;
        if (row.reply.outcome !== res.outcome || row.reply.reason !== res.reason) problems.push(`${kind}: stored ${row.reply.outcome}/${row.reply.reason}, replied ${res.outcome}/${res.reason}`);
        if (PAIRS[row.reply.reason as keyof typeof PAIRS] !== row.reply.outcome) problems.push(`${kind}: invalid pair`);
        if (row.proposedOutcome !== (usedModel ? 'answer' : null)) problems.push(`${kind}: proposed outcome ${row.proposedOutcome}`);
        if (!Array.isArray(row.floors)) problems.push(`${kind}: floors is not a list`);
        else if ((kind === 'sensitive' || kind === 'urgent') !== row.floors.length > 0) problems.push(`${kind}: floors ${JSON.stringify(row.floors)}`);
        if (JSON.stringify(row.reply.citations) !== JSON.stringify(res.citations)) problems.push(`${kind}: citations differ`);
        if (row.reply.snapshotVersion !== 1 || res.snapshotVersion !== 1) problems.push(`${kind}: snapshot version ${row.reply.snapshotVersion}`);
        if (usedModel && (row.language !== 'en' || row.topic !== 'meals')) problems.push(`${kind}: language ${row.language}, topic ${row.topic}`);
        if (!(typeof row.latencyMs === 'number' && Number.isFinite(row.latencyMs) && row.latencyMs >= 0)) problems.push(`${kind}: latency ${row.latencyMs}`);
        const u = row.usage ?? ({} as any);
        if (![u.input, u.cachedInput, u.output].every((n) => typeof n === 'number' && n >= 0)) problems.push(`${kind}: usage ${JSON.stringify(u)}`);
        else if (usedModel && JSON.stringify([u.input, u.cachedInput, u.output]) !== JSON.stringify([USAGE.input, USAGE.cachedInput, USAGE.output])) {
          problems.push(`${kind}: usage ${JSON.stringify(u)}, the model reported ${JSON.stringify(USAGE)}`);
        }
      }
      if (posted.answer.json?.reply?.reason !== 'answered') problems.push('answer: not answered');
      if (posted.failure.json?.reply?.reason !== 'system_error') problems.push('failure: not a system_error handoff');
      expect(problems).toEqual([]);
      expect(stored.find((r) => r.message === messages.answer)!.reply.citations).toEqual([{ sectionId: 'meals' }]);
    },
    TIMEOUT,
  );
});

const MARKER = `leak-marker-${crypto.randomBytes(6).toString('hex')}`;

function leaks(body: string, extra: [string, string | RegExp][] = []): string[] {
  const checks: [string, RegExp][] = [
    ['the marker', new RegExp(MARKER)],
    ['a stack frame', /\bat\s+\S+\s+\(|\n\s+at\s/],
    ['an error name', /\b\w*Error:/],
    ['a source position', /[\w./-]+\.(ts|tsx|js|mjs|cjs):\d+/],
    ['a dependency path', /node_modules/],
    ['a connection string', /postgres(ql)?:\/\//i],
    ['a connection error', /ECONNREFUSED|ENOTFOUND|connect\s+E[A-Z]+/],
    ['a database error', /does not exist|password authentication|relation "|SQLSTATE|duplicate key|syntax error at/i],
    ['the machine hostname', new RegExp(os.hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')],
  ];
  for (const [what, needle] of extra) checks.push([what, typeof needle === 'string' ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : needle]);
  return checks.filter(([, re]) => re.test(body)).map(([what]) => what);
}

function instructionLeaks(body: string, requests: ModelRequest[]): [string, string][] {
  const text = requests.map((r) => normalize(String(r.instructions ?? ''))).find((t) => t.length >= 20);
  expect(text, 'the model received no instructions').toBeDefined();
  // A distinctive stretch from the middle of the instructions.
  const mid = Math.floor(text!.length / 2);
  return [['the model instructions', text!.slice(Math.max(0, mid - 30), mid + 30)]];
}

describe('response bodies', () => {
  test(
    'response bodies: a model that throws leaks no marker, error text, stack trace, instructions, or sandbox ID',
    async () => {
      const requests: ModelRequest[] = [];
      const model: Model = async (request) => {
        requests.push(request);
        const err = new Error(`model exploded ${MARKER}`);
        err.name = 'ModelExplodedError';
        throw err;
      };
      const { POST } = await loadRoute({ model });
      const res = await post(POST, 'What time is breakfast?');
      expect(res.cookie, 'no sandbox cookie').not.toBeNull();
      expect(res.json?.reply?.reason, 'the failure is not a system_error handoff').toBe('system_error');
      const found = leaks(res.body, [...instructionLeaks(res.body, requests), ['the sandbox ID', res.cookie!.value], ['the error text', 'model exploded']]);
      expect(found, res.body).toEqual([]);
    },
    TIMEOUT,
  );

  const OUTPUTS: [string, unknown][] = [
    ['invalid output', { outcome: 'answer', text: `Raw ${GENERATED} output ${MARKER}` }],
    ['an answer that fails grounding', answerOut(`Raw ${GENERATED} output ${MARKER} says breakfast ends at 9:45 AM.`, ['meals'])],
  ];

  for (const [label, out] of OUTPUTS) {
    test(
      `response bodies: ${label} carrying a marker never reaches the body`,
      async () => {
        const scripted = recordingModel(() => out);
        const { POST } = await loadRoute({ model: scripted.model });
        const res = await post(POST, 'What time does breakfast end?');
        expect(res.json?.reply, 'the response holds no reply').toBeTruthy();
        const found = leaks(res.body, [...instructionLeaks(res.body, scripted.requests), ['the sandbox ID', res.cookie?.value ?? MARKER], ['generated text', GENERATED]]);
        expect(found, res.body).toEqual([]);
      },
      TIMEOUT,
    );
  }

  const base = new URL(SAVED_ENV.DATABASE_URL ?? 'postgres://frontdesk:frontdesk@localhost:5432/frontdesk');
  const missing = new URL(base.href);
  missing.pathname = `/missing_${MARKER.replace(/-/g, '_')}`;
  const closed = new URL(base.href);
  closed.port = '1';
  closed.pathname = `/closed_${MARKER.replace(/-/g, '_')}`;
  const dbError = new Error(`relation "turns" does not exist ${MARKER}`);

  const FAILURES: [string, LoadOptions][] = [
    ['a database that does not exist', { env: { DATABASE_URL: missing.href }, startupMayFail: true }],
    ['a closed database port', { env: { DATABASE_URL: closed.href }, startupMayFail: true }],
    ['a scoped database call that throws', { failingDb: dbError, startupMayFail: true }],
  ];

  for (const [label, options] of FAILURES) {
    test(
      `response bodies: ${label} leaks no marker, database error, connection string, or stack trace`,
      async () => {
        const scripted = recordingModel(() => GROUNDED);
        const { POST } = await loadRoute({ ...options, model: scripted.model });
        const first = await post(POST, 'What time is breakfast?');
        const again = await post(POST, 'And the late fee?', first.cookie ? `${first.cookie.name}=${first.cookie.value}` : undefined);
        for (const res of [first, again]) {
          const extra: [string, string][] = [['the database name', MARKER.replace(/-/g, '_')]];
          if (res.cookie) extra.push(['the sandbox ID', res.cookie.value]);
          expect(leaks(res.body, extra), res.body).toEqual([]);
        }
      },
      TIMEOUT,
    );
  }
});

describe('fixture mode', () => {
  test(
    'fixture mode: the route replies with no network access and no AWS credentials',
    async () => {
      const dbUrl = new URL(SAVED_ENV.DATABASE_URL ?? 'postgres://localhost:5432/frontdesk');
      const dbHost = dbUrl.hostname;
      const dbPort = Number(dbUrl.port || 5432);
      const local = new Set([dbHost, 'localhost', '127.0.0.1', '::1']);
      const attempts: string[] = [];
      const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'front-desk-no-aws-'));
      const env: Record<string, string | undefined> = {
        MODEL_MODE: 'fixture',
        AWS_ACCESS_KEY_ID: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_SESSION_TOKEN: undefined,
        AWS_PROFILE: undefined,
        AWS_DEFAULT_PROFILE: undefined,
        AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
        AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
        AWS_CONFIG_FILE: path.join(missingDir, 'config'),
        AWS_SHARED_CREDENTIALS_FILE: path.join(missingDir, 'credentials'),
        AWS_EC2_METADATA_DISABLED: 'true',
      };

      const originalConnect = net.Socket.prototype.connect;
      vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function connect(this: net.Socket, ...args: any[]) {
        let opts = args[0];
        if (Array.isArray(opts)) opts = opts[0];
        const port = typeof opts === 'object' && opts !== null ? Number(opts.port) : Number(opts);
        const host = typeof opts === 'object' && opts !== null ? (opts.host ?? 'localhost') : (args[1] ?? 'localhost');
        const unixPath = typeof opts === 'object' && opts !== null ? opts.path : typeof opts === 'string' && Number.isNaN(Number(opts)) ? opts : undefined;
        if (unixPath || (port === dbPort && local.has(String(host)))) return originalConnect.apply(this, args as never);
        attempts.push(`socket ${host}:${port}`);
        process.nextTick(() => this.destroy(new Error('network access refused in this test')));
        return this;
      } as never);
      const originalLookup = dns.lookup;
      vi.spyOn(dns, 'lookup').mockImplementation(((host: string, ...rest: any[]) => {
        if (local.has(host)) return (originalLookup as any)(host, ...rest);
        attempts.push(`dns ${host}`);
        const cb = rest[rest.length - 1];
        process.nextTick(() => cb(new Error('network access refused in this test')));
      }) as never);
      const originalPromiseLookup = dns.promises.lookup;
      vi.spyOn(dns.promises, 'lookup').mockImplementation(((host: string, ...rest: any[]) => {
        if (local.has(host)) return (originalPromiseLookup as any)(host, ...rest);
        attempts.push(`dns ${host}`);
        return Promise.reject(new Error('network access refused in this test'));
      }) as never);
      vi.stubGlobal('fetch', async (input: unknown) => {
        attempts.push(`fetch ${String(input)}`);
        throw new Error('network access refused in this test');
      });

      try {
        const { POST } = await loadRoute({ env });
        const res = await post(POST, 'What time is breakfast served?');
        expect(res.status).toBe(200);
        const reply = res.json?.reply;
        expect(reply, `no reply in ${res.body}`).toBeTruthy();
        expect(PAIRS[reply.reason as keyof typeof PAIRS], `reply ${reply.outcome}/${reply.reason}`).toBe(reply.outcome);
        expect(typeof reply.text === 'string' && reply.text.length > 0).toBe(true);
        expect(attempts).toEqual([]);
      } finally {
        fs.rmSync(missingDir, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
