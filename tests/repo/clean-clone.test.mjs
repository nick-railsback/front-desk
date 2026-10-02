// clean clone: a copy of the repository holding only what git would hand a
// new contributor installs with `pnpm install --frozen-lockfile` and then
// passes `pnpm test`, both exiting 0.
//
// The copy is built from the working tree, not from a commit, so changes
// that are staged or not yet committed are checked too: every file git
// tracks or would track (tracked, staged, and untracked files that no ignore
// rule matches), never node_modules or anything under .git. The copy is then
// made a git repository with a single commit, as a clone would be.
//
// The install needs the npm registry unless pnpm's store already holds every
// locked package; pnpm's user-level store and cache are reused. Allow up to
// 15 minutes.
//
// recursion guard: `pnpm test` in the copy may run this file again. The
// outer run sets FRONT_DESK_CLEAN_COPY to a random token and writes the same
// token to .front-desk-clean-copy at the copy's root. A run that sees the
// variable and a matching sentinel file is the inner run and skips; a run
// that sees the variable without a matching sentinel fails, so setting the
// variable by hand cannot turn this check into a skip. The repository's test
// command must pass the environment through to the test runner.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ROOT, isolatedGitEnv, makeTempDir, readIfExists, run, tail } from './support/repo.mjs';

const GUARD_VAR = 'FRONT_DESK_CLEAN_COPY';
const SENTINEL = '.front-desk-clean-copy';
const TIMEOUT_MS = 15 * 60 * 1000;

function isInnerRun() {
  const token = process.env[GUARD_VAR];
  if (token === undefined) return false;
  const sentinel = readIfExists(path.join(ROOT, SENTINEL));
  assert.ok(
    sentinel !== null && sentinel.trim() === token && token.length >= 16,
    `${GUARD_VAR} is set outside a clean copy made by this test`,
  );
  return true;
}

// Files a fresh clone would contain, relative to the root.
function cloneFiles() {
  const listed = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT });
  assert.equal(listed.status, 0, `git ls-files failed:\n${listed.output}`);
  const unique = [...new Set(listed.stdout.split('\0').filter(Boolean))];
  return unique.filter((rel) => {
    const parts = rel.split('/');
    if (parts.includes('node_modules') || parts[0] === '.git') return false;
    return fs.existsSync(path.join(ROOT, rel)) || isSymlink(path.join(ROOT, rel));
  });
}

function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function copyInto(dest, files) {
  for (const rel of files) {
    const from = path.join(ROOT, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (isSymlink(from)) fs.symlinkSync(fs.readlinkSync(from), to);
    else if (fs.statSync(from).isFile()) fs.copyFileSync(from, to);
  }
}

test('clean clone: installing with the frozen lockfile and running the test command both succeed', { timeout: TIMEOUT_MS }, (t) => {
  if (isInnerRun()) {
    t.skip('inner run inside the clean copy');
    return;
  }

  const files = cloneFiles();
  assert.ok(files.includes('package.json'), 'the repository has no root package.json');
  assert.ok(files.includes('pnpm-lock.yaml'), 'the repository has no pnpm-lock.yaml to install from');
  assert.ok(!files.includes(SENTINEL), `${SENTINEL} must not be part of the repository`);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(manifest?.scripts?.test, 'the root package.json defines no test script');

  const scratch = makeTempDir('clean-clone');
  const copy = path.join(scratch, 'front-desk');
  try {
    fs.mkdirSync(copy);
    copyInto(copy, files);

    const gitEnv = isolatedGitEnv(scratch);
    const git = (...args) => run('git', args, { cwd: copy, env: gitEnv });
    assert.equal(git('init', '-q', '-b', 'main').status, 0);
    git('config', 'user.name', 'Fixture Author');
    git('config', 'user.email', 'fixture@example.com');
    git('config', 'commit.gpgsign', 'false');
    assert.equal(git('add', '-A').status, 0);
    const commit = git('commit', '-q', '-m', 'Clean copy');
    assert.equal(commit.status, 0, `could not commit the clean copy:\n${tail(commit.output)}`);

    const token = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(copy, SENTINEL), `${token}\n`);
    const env = isolatedGitEnv(scratch, { [GUARD_VAR]: token });

    const install = run('pnpm', ['install', '--frozen-lockfile'], { cwd: copy, env, timeout: TIMEOUT_MS / 2 });
    assert.equal(install.status, 0, `pnpm install --frozen-lockfile exited ${install.status}:\n${tail(install.output, 40)}`);

    const suite = run('pnpm', ['test'], { cwd: copy, env, timeout: TIMEOUT_MS / 2 });
    assert.equal(suite.status, 0, `pnpm test exited ${suite.status}:\n${tail(suite.output, 60)}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
