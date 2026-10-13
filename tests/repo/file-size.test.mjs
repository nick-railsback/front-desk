// file size: no tracked file is larger than 5 MB, so a run log written by a
// harness cannot quietly make every clone and every clean-clone test copy
// hundreds of megabytes (review H1, F34).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ROOT, rootPath, run } from './support/repo.mjs';

const LIMIT_BYTES = 5 * 1024 * 1024;

test('file size: every tracked file is at most 5 MB', () => {
  const listed = run('git', ['ls-files', '-z'], { cwd: ROOT });
  assert.equal(listed.status, 0, `git ls-files failed:\n${listed.output}`);
  const large = listed.stdout
    .split('\0')
    .filter((file) => file !== '' && fs.existsSync(rootPath(file)))
    .map((file) => ({ file, bytes: fs.statSync(rootPath(file)).size }))
    .filter(({ bytes }) => bytes > LIMIT_BYTES)
    .map(({ file, bytes }) => `${file} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  assert.deepEqual(large, [], 'tracked files over 5 MB');
});
