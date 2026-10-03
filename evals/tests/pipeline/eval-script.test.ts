// pnpm eval.
//
// eval script: the root package.json has an eval script. Run with the fixture
// model, no network, no AWS credentials, and no database, it runs the runner
// over every case in evals/cases/ (3 trials each) and writes
// evals/reports/report.json and evals/reports/summary.md for that run.
//
// Assumed interface: see ./support.ts.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ROOT } from './support';

const REPORTS = path.join(ROOT, 'evals', 'reports');
const REPORT_FILES = ['report.json', 'summary.md'];
const CASES = path.join(ROOT, 'evals', 'cases');

// Refuses and records network use in every Node process of the run.
const PRELOAD = `
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns');
const logFile = process.env.FRONT_DESK_NET_LOG;
const record = (what) => { try { fs.appendFileSync(logFile, what + '\\n'); } catch {} };
const loopback = (h) => h === undefined || h === null || h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || String(h).startsWith('/');
const refused = () => new Error('network access refused during the fixture eval');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0];
  const isObj = typeof opts === 'object' && opts !== null;
  if (isObj && opts.path) return connect.apply(this, args);
  if (!isObj && typeof opts === 'string' && Number.isNaN(Number(opts))) return connect.apply(this, args);
  const host = isObj ? opts.host : args[1];
  const port = isObj ? opts.port : opts;
  if (loopback(host)) return connect.apply(this, args);
  record('socket ' + host + ':' + port);
  process.nextTick(() => this.destroy(refused()));
  return this;
};
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (loopback(host)) return lookup.call(this, host, ...rest);
  record('dns ' + host);
  const cb = rest[rest.length - 1];
  if (typeof cb === 'function') process.nextTick(() => cb(refused()));
};
const plookup = dns.promises.lookup;
dns.promises.lookup = function (host, ...rest) {
  if (loopback(host)) return plookup.call(this, host, ...rest);
  record('dns ' + host);
  return Promise.reject(refused());
};
if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    let host;
    try { host = new URL(typeof input === 'string' ? input : input.url ?? String(input)).hostname; } catch { host = String(input); }
    if (loopback(host)) return realFetch.call(this, input, init);
    record('fetch ' + host);
    return Promise.reject(refused());
  };
}
`;

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

// Saves whatever report files exist (a live run's, say) and returns a
// function that puts them back.
function saveReports(): () => void {
  const saved = new Map<string, Buffer | null>();
  for (const f of REPORT_FILES) {
    const file = path.join(REPORTS, f);
    saved.set(f, fs.existsSync(file) ? fs.readFileSync(file) : null);
  }
  const dirExisted = fs.existsSync(REPORTS);
  return () => {
    for (const [f, content] of saved) {
      const file = path.join(REPORTS, f);
      if (content === null) fs.rmSync(file, { force: true });
      else {
        fs.mkdirSync(REPORTS, { recursive: true });
        fs.writeFileSync(file, content);
      }
    }
    if (!dirExisted && fs.existsSync(REPORTS) && fs.readdirSync(REPORTS).length === 0) fs.rmdirSync(REPORTS);
  };
}

function caseCount(): number {
  let n = 0;
  for (const f of fs.readdirSync(CASES).filter((x) => x.endsWith('.json'))) n += JSON.parse(fs.readFileSync(path.join(CASES, f), 'utf8')).length;
  return n;
}

function fixtureEnv(scratch: string, netLog: string, preload: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^AWS_/.test(k) || k === 'DATABASE_URL' || /^PG/.test(k) || /^(npm_|pnpm_)/i.test(k) || k === 'NODE_OPTIONS' || /^VITEST/.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    MODEL_MODE: 'fixture',
    AWS_CONFIG_FILE: path.join(scratch, 'no-aws-config'),
    AWS_SHARED_CREDENTIALS_FILE: path.join(scratch, 'no-aws-credentials'),
    AWS_EC2_METADATA_DISABLED: 'true',
    NODE_OPTIONS: `--require ${preload}`,
    FRONT_DESK_NET_LOG: netLog,
    npm_config_update_notifier: 'false',
  };
}

describe('eval script', () => {
  test(
    'eval script: with the fixture model, no network, no AWS credentials, and no database, pnpm eval runs every case and writes the report and summary',
    () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      expect(typeof manifest.scripts?.eval, 'the root package.json has no eval script').toBe('string');

      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'front-desk-fixture-eval-'));
      const preload = path.join(scratch, 'no-network.cjs');
      const netLog = path.join(scratch, 'network.log');
      fs.writeFileSync(preload, PRELOAD);
      fs.writeFileSync(netLog, '');
      restore = saveReports();
      for (const f of REPORT_FILES) fs.rmSync(path.join(REPORTS, f), { force: true });
      try {
        const run = spawnSync('pnpm', ['run', 'eval'], { cwd: ROOT, env: fixtureEnv(scratch, netLog, preload), encoding: 'utf8', timeout: 180_000 });
        const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.split('\n').slice(-40).join('\n');
        expect(run.error, `pnpm run eval did not finish: ${run.error?.message}\n${output}`).toBeUndefined();
        expect(fs.readFileSync(netLog, 'utf8').trim(), 'network use during the fixture eval').toBe('');

        for (const f of REPORT_FILES) expect(fs.existsSync(path.join(REPORTS, f)), `evals/reports/${f} was not written (exit ${run.status})\n${output}`).toBe(true);
        const n = caseCount();
        const report = JSON.parse(fs.readFileSync(path.join(REPORTS, 'report.json'), 'utf8'));
        expect({ caseCount: report.caseCount, trialCount: report.trialCount }).toEqual({ caseCount: n, trialCount: 3 * n });
        expect(typeof report.overall?.schema_valid, 'no model call was recorded, so the pipeline did not answer').toBe('number');
        const summary = fs.readFileSync(path.join(REPORTS, 'summary.md'), 'utf8');
        expect(summary).toContain(`Cases: ${n}, trials: ${3 * n}`);
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    },
    200_000,
  );
});
