// The deployed app's database.
//
// database wiring: in the production container definition the app service
// reads /etc/frontdesk/db.env, depends on the db service, and, given only the
// environment the container really gets, connects to host `db`. That
// environment is the final Dockerfile stage's ENV, the app service's
// `environment` interpolated the way the deploy runs compose (only APP_IMAGE
// is set in the shell, so any other ${...} is empty), and POSTGRES_PASSWORD,
// the one variable the instance writes to db.env.
//
// migrations at startup: against an empty database, the app (instrumentation
// register(), when the app has one, then the route) applies the pending
// migrations before it answers POST /api/ask.
//
// Assumed interface: see ./support.ts.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as repo from '../../../tests/repo/support/repo.mjs';
import { APP, DB_MODULE, INSTRUMENTATION_MODULE, MODEL_MODULE, ROOT, ROUTE_MODULE, USAGE, answerOut } from './support';

const COMPOSE = path.join(ROOT, 'infra', 'compose.prod.yml');
const DOCKERFILE = path.join(ROOT, 'app', 'Dockerfile');
const DB_ENV_FILE = '/etc/frontdesk/db.env';
const SAVED_ENV = { ...process.env };

type Line = { indent: number; text: string };
type Entry = { key: string; value: string; body: Line[] };

afterEach(() => {
  vi.doUnmock('../../src/server/model');
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in SAVED_ENV)) delete process.env[key];
  for (const [key, value] of Object.entries(SAVED_ENV)) process.env[key] = value;
});

function service(name: string): Record<string, Entry> {
  const text = fs.readFileSync(COMPOSE, 'utf8');
  const services = repo.topLevelEntry(text, 'services') as Entry | null;
  expect(services, 'compose.prod.yml has no services').not.toBeNull();
  const svc = (repo.mapEntries(services!.body) as Entry[]).find((e) => e.key === name);
  expect(svc, `compose.prod.yml has no ${name} service`).toBeDefined();
  const out: Record<string, Entry> = {};
  for (const e of repo.mapEntries(svc!.body) as Entry[]) out[e.key] = e;
  return out;
}

function list(entry: Entry | undefined): string[] {
  if (!entry) return [];
  const value = repo.entryValue(entry);
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.keys(value);
  return [];
}

// Compose interpolation as the deploy runs it: only APP_IMAGE is in the shell.
function interpolate(value: string): string {
  const shell: Record<string, string> = { APP_IMAGE: 'example.invalid/app:test' };
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g, (_m, name, fallback) => shell[name] ?? fallback ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name) => shell[name] ?? '')
    .replace(/\$\$/g, '$');
}

function appEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  // The final Dockerfile stage's ENV lines.
  const stages = fs.readFileSync(DOCKERFILE, 'utf8').split(/^FROM\s/m);
  for (const line of stages[stages.length - 1].split('\n')) {
    const m = /^ENV\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    for (const pair of m[1].match(/[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|\S*)/g) ?? []) {
      const i = pair.indexOf('=');
      env[pair.slice(0, i)] = repo.unquote(pair.slice(i + 1));
    }
  }
  const entry = service('app').environment;
  const value = entry ? repo.entryValue(entry) : null;
  if (Array.isArray(value)) {
    for (const item of value.map(String)) {
      const i = item.indexOf('=');
      if (i > 0) env[item.slice(0, i)] = interpolate(repo.unquote(item.slice(i + 1)));
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      const raw = v && typeof v === 'object' && 'value' in v ? String(v.value) : String(v ?? '');
      env[k] = interpolate(repo.unquote(raw));
    }
  }
  env.POSTGRES_PASSWORD = 'sentinel-pw-0177';
  return env;
}

describe('database wiring', () => {
  test(
    'database wiring: the app reads db.env, depends on db, and with only the container environment connects to host db',
    async () => {
      const app = service('app');
      expect(list(app.env_file), 'the app service env_file').toContain(DB_ENV_FILE);
      expect(list(app.depends_on), 'the app service depends_on').toContain('db');
      expect(list(service('db').env_file), 'the db service env_file').toContain(DB_ENV_FILE);

      expect(fs.existsSync(path.join(APP, DB_MODULE)), `app/${DB_MODULE} does not exist`).toBe(true);
      const containerEnv = appEnvironment();
      // Nothing database-related from the test run may leak in.
      for (const key of Object.keys(process.env)) if (/^(DATABASE|PG|POSTGRES|DB_)/i.test(key)) delete process.env[key];
      Object.assign(process.env, containerEnv);

      const targets: string[] = [];
      vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function connect(this: net.Socket, ...args: any[]) {
        let opts = args[0];
        if (Array.isArray(opts)) opts = opts[0];
        const host = typeof opts === 'object' && opts !== null ? (opts.host ?? opts.path ?? 'localhost') : (args[1] ?? 'localhost');
        targets.push(String(host));
        process.nextTick(() => this.destroy(new Error('connection refused in this test')));
        return this;
      } as never);

      vi.resetModules();
      let mod: any;
      try {
        mod = await import('../../src/db/sandbox');
      } catch (err) {
        throw new Error(`the database module failed to load with the container environment: ${(err as Error).message}`);
      }
      expect(typeof mod.migrate).toBe('function');
      const attempt = Promise.resolve()
        .then(() => mod.migrate())
        .catch(() => {});
      await Promise.race([attempt, new Promise((r) => setTimeout(r, 5000))]);
      await mod.closeDb?.().catch(() => {});
      expect(targets, `connection targets: ${JSON.stringify(targets)}`).toContain('db');
    },
    30_000,
  );
});

describe('migrations at startup', () => {
  test(
    'migrations at startup: against an empty database, the first POST /api/ask is answered',
    async () => {
      expect(fs.existsSync(path.join(APP, ROUTE_MODULE)), `app/${ROUTE_MODULE} does not exist`).toBe(true);
      expect(fs.existsSync(path.join(APP, MODEL_MODULE)), `app/${MODEL_MODULE} does not exist`).toBe(true);
      expect(SAVED_ENV.DATABASE_URL, 'DATABASE_URL is not set; this test needs a reachable Postgres').toBeTruthy();

      const name = `frontdesk_empty_${crypto.randomBytes(5).toString('hex')}`;
      const admin = new pg.Client({ connectionString: SAVED_ENV.DATABASE_URL });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${name}`);
      const url = new URL(SAVED_ENV.DATABASE_URL!);
      url.pathname = `/${name}`;
      let db: any = null;
      try {
        process.env.DATABASE_URL = url.href;
        vi.resetModules();
        const model = async () => ({ output: answerOut('Breakfast is served until 8:30 AM.', ['meals']), usage: USAGE });
        vi.doMock('../../src/server/model', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), getModel: () => model }));
        if (fs.existsSync(path.join(APP, INSTRUMENTATION_MODULE))) {
          const instrumentation = (await import('../../src/instrumentation')) as any;
          if (typeof instrumentation.register === 'function') {
            process.env.NEXT_RUNTIME = 'nodejs';
            await instrumentation.register();
          }
        }
        const route = (await import('../../src/app/api/ask/route')) as any;
        expect(typeof route.POST).toBe('function');
        db = await import('../../src/db/sandbox');
        const res: Response = await route.POST(
          new Request('http://localhost/api/ask', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: 'What time is breakfast served?', priorTurns: [] }),
          }),
        );
        const body = await res.text();
        expect(res.status, body).toBe(200);
        expect(JSON.parse(body).reply?.reason, body).toBe('answered');
        const fresh = new pg.Client({ connectionString: url.href });
        await fresh.connect();
        try {
          const schema = await fresh.query(`SELECT to_regclass('public.sandboxes') AS t`);
          expect(schema.rows[0].t, 'the empty database holds no schema after the first request').not.toBeNull();
        } finally {
          await fresh.end();
        }
      } finally {
        if (db?.closeDb) await db.closeDb().catch(() => {});
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
        await admin.end();
      }
    },
    60_000,
  );
});
