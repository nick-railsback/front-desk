// lockfile: the pnpm lockfile exists, is tracked by git (committed or staged
// in the index both count), and is not matched by any ignore rule, so a
// later edit to it can never silently drop out of version control.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ROOT, rootPath, run } from './support/repo.mjs';

const LOCKFILE = 'pnpm-lock.yaml';

test('lockfile: the pnpm lockfile is tracked by git and not ignored', () => {
  const text = fs.existsSync(rootPath(LOCKFILE)) ? fs.readFileSync(rootPath(LOCKFILE), 'utf8') : null;
  assert.ok(text !== null, `${LOCKFILE} does not exist at the repository root`);
  assert.match(text, /^lockfileVersion\s*:/m, `${LOCKFILE} is not a pnpm lockfile`);

  const tracked = run('git', ['ls-files', '--error-unmatch', '--', LOCKFILE], { cwd: ROOT });
  assert.equal(tracked.status, 0, `${LOCKFILE} is not in the git index:\n${tracked.output}`);

  // --no-index asks whether the ignore rules would match the path, which a
  // plain check-ignore never reports for a file that is already tracked.
  const ignored = run('git', ['check-ignore', '--no-index', '-v', '--', LOCKFILE], { cwd: ROOT });
  assert.equal(ignored.status, 1, `${LOCKFILE} is matched by an ignore rule: ${ignored.stdout.trim()}`);
});
