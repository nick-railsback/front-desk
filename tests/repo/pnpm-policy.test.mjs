// pnpm supply-chain settings, read back from pnpm itself rather than from the
// settings file text, so a key pnpm does not honor cannot satisfy them.
//
// Every pnpm call runs at the repository root with user-level pnpm
// configuration and npm_*/pnpm_* environment variables removed, so only the
// repository's own settings are observed.
//
// install scripts: pnpm resolves an explicit allowBuilds allowlist naming
// specific packages, never every package, and never with
// dangerouslyAllowAllBuilds. Under the repository's settings, a dependency
// that is not on the allowlist is installed without running its install
// scripts.
//
// release age: pnpm resolves minimumReleaseAge to at least 1440 minutes, so
// a version published less than 24 hours ago is never installed, and no
// exclusion pattern exempts every package.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ROOT, isolatedEnv, makeTempDir, rootPath, run, tail } from './support/repo.mjs';

const DAY_IN_MINUTES = 24 * 60;

function pnpmEnv(scratch) {
  const xdg = path.join(scratch, 'xdg');
  fs.mkdirSync(xdg, { recursive: true });
  const userrc = path.join(scratch, 'user.npmrc');
  fs.writeFileSync(userrc, '');
  return isolatedEnv({ XDG_CONFIG_HOME: xdg, npm_config_userconfig: userrc });
}

function withScratch(label, fn) {
  const scratch = makeTempDir(label);
  try {
    return fn(scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// The value pnpm resolves for a setting in `cwd`, or undefined when unset.
function pnpmConfig(key, cwd, env) {
  const r = run('pnpm', ['config', 'get', key, '--json'], { cwd, env });
  assert.equal(r.status, 0, `pnpm config get ${key} failed:\n${tail(r.output)}`);
  const out = r.stdout.trim();
  if (out === '' || out === 'undefined') return undefined;
  return JSON.parse(out);
}

test('install scripts: pnpm resolves an explicit allowlist of packages that may run install scripts', () => {
  withScratch('pnpm-allowlist', (scratch) => {
    const env = pnpmEnv(scratch);

    const allowAll = pnpmConfig('dangerouslyAllowAllBuilds', ROOT, env);
    assert.notEqual(allowAll, true, 'dangerouslyAllowAllBuilds lets every package run install scripts');

    const allowBuilds = pnpmConfig('allowBuilds', ROOT, env);
    assert.ok(
      allowBuilds !== null && typeof allowBuilds === 'object' && !Array.isArray(allowBuilds),
      `pnpm resolves no allowBuilds allowlist for this repository (got ${JSON.stringify(allowBuilds)})`,
    );
    const allowed = Object.entries(allowBuilds)
      .filter(([, v]) => v === true)
      .map(([name]) => name);
    const wildcards = allowed.filter((name) => name.trim() === '' || name.includes('*'));
    assert.deepEqual(wildcards, [], 'the allowlist admits packages by pattern instead of by name');
  });
});

test('install scripts: a dependency outside the allowlist is installed without running its scripts', () => {
  const settings = rootPath('pnpm-workspace.yaml');
  assert.ok(fs.existsSync(settings), 'the repository has no pnpm-workspace.yaml holding its pnpm settings');

  withScratch('pnpm-build-probe', (scratch) => {
    const env = pnpmEnv(scratch);
    const name = `build-probe-${crypto.randomBytes(4).toString('hex')}`;

    // A project with the repository's pnpm settings and a single local
    // dependency whose install scripts each leave a marker file behind.
    const project = (dir, marker) => {
      fs.mkdirSync(path.join(dir, 'probe'), { recursive: true });
      fs.copyFileSync(settings, path.join(dir, 'pnpm-workspace.yaml'));
      if (fs.existsSync(rootPath('.npmrc'))) fs.copyFileSync(rootPath('.npmrc'), path.join(dir, '.npmrc'));
      const write = `node -e "require('fs').appendFileSync(process.argv[1], process.argv[2] + '\\n')" "${marker}"`;
      fs.writeFileSync(
        path.join(dir, 'probe', 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          scripts: {
            preinstall: `${write} preinstall`,
            install: `${write} install`,
            postinstall: `${write} postinstall`,
          },
        }),
      );
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'probe-host', private: true, dependencies: { [name]: 'file:./probe' } }),
      );
    };

    // Control: the probe does observe install scripts when builds are allowed.
    const controlDir = path.join(scratch, 'control');
    const controlMarker = path.join(scratch, 'control-ran');
    project(controlDir, controlMarker);
    const control = run('pnpm', ['install', '--offline', '--config.dangerously-allow-all-builds=true'], {
      cwd: controlDir,
      env,
      timeout: 180_000,
    });
    assert.ok(
      fs.existsSync(controlMarker),
      `the probe could not observe install scripts even with all builds allowed:\n${tail(control.output)}`,
    );

    const dir = path.join(scratch, 'subject');
    const marker = path.join(scratch, 'subject-ran');
    project(dir, marker);
    const allowBuilds = pnpmConfig('allowBuilds', dir, env) ?? {};
    assert.notEqual(allowBuilds[name], true, 'the probe package is unexpectedly on the allowlist');

    const install = run('pnpm', ['install', '--offline'], { cwd: dir, env, timeout: 180_000 });
    assert.ok(
      fs.existsSync(path.join(dir, 'node_modules', name, 'package.json')),
      `pnpm did not install the probe dependency:\n${tail(install.output)}`,
    );
    const ran = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
    assert.equal(ran, '', `install scripts ran for a package outside the allowlist: ${ran}`);
  });
});

test('release age: pnpm refuses versions published less than 24 hours ago', () => {
  withScratch('pnpm-release-age', (scratch) => {
    const env = pnpmEnv(scratch);

    const minutes = pnpmConfig('minimumReleaseAge', ROOT, env);
    assert.ok(
      Number.isFinite(Number(minutes)) && minutes !== undefined && minutes !== null,
      `pnpm resolves no minimumReleaseAge for this repository (got ${JSON.stringify(minutes)})`,
    );
    assert.ok(
      Number(minutes) >= DAY_IN_MINUTES,
      `minimumReleaseAge is ${minutes} minutes, less than ${DAY_IN_MINUTES} (24 hours)`,
    );

    const excluded = pnpmConfig('minimumReleaseAgeExclude', ROOT, env) ?? [];
    const list = Array.isArray(excluded) ? excluded : [excluded];
    assert.deepEqual(
      list.filter((p) => /^\s*\*+\s*$/.test(String(p))),
      [],
      'minimumReleaseAgeExclude exempts every package',
    );
  });
});
