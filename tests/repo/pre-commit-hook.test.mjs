// pre-commit hook: with the repository's lefthook configuration installed, a
// commit that stages a secret gitleaks detects is refused and nothing is
// committed, while a commit that stages ordinary content goes through.
//
// Each check runs in a throwaway repository under the OS temp directory,
// with git isolated from the user's global and system configuration. The
// repository's own hooks are never installed or run. No check bypasses
// hooks; the commit runs exactly as a contributor's would.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isolatedGitEnv, makeTempDir, rootPath, run, tail } from './support/repo.mjs';

const HOOK_CONFIG = 'lefthook.yml';

// Files beside the hook configuration that it may rely on, copied when present.
const HOOK_SUPPORT = ['.gitleaks.toml', '.gitleaksignore', '.lefthook'];

// A fictional GitHub personal access token, derived at runtime so that this
// source file holds nothing a secret scanner flags. gitleaks reports it under
// its github-pat rule. It was never issued and grants access to nothing.
function fictionalToken() {
  const body = crypto
    .createHash('sha256')
    .update('front desk fictional token for the pre-commit hook check')
    .digest('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 36);
  return ['gh', 'p', '_'].join('') + body;
}

function fixtureRepo() {
  const dir = makeTempDir('hook');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const env = isolatedGitEnv(dir);
  const git = (...args) => run('git', args, { cwd: repo, env });

  const config = rootPath(HOOK_CONFIG);
  assert.ok(fs.existsSync(config), `the repository has no ${HOOK_CONFIG} hook configuration`);

  assert.equal(git('init', '-q').status, 0);
  git('config', 'user.name', 'Fixture Author');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'commit.gpgsign', 'false');

  fs.copyFileSync(config, path.join(repo, HOOK_CONFIG));
  for (const extra of HOOK_SUPPORT) {
    const src = rootPath(extra);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(repo, extra), { recursive: true });
  }

  const install = run('lefthook', ['install'], { cwd: repo, env });
  assert.equal(install.status, 0, `lefthook install failed:\n${tail(install.output)}`);
  assert.ok(
    fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')),
    `installing ${HOOK_CONFIG} did not create a pre-commit hook`,
  );
  return { dir, repo, env, git };
}

test('pre-commit hook: a commit staging a detected secret is refused and nothing is committed', () => {
  const token = fictionalToken();

  // The fixture must be one gitleaks itself detects, so a commit that goes
  // through can only mean the hook did not stop it.
  const probe = run('gitleaks', ['stdin', '--no-banner', '--redact'], { input: `GITHUB_TOKEN=${token}\n` });
  assert.notEqual(probe.status, 0, `gitleaks does not detect the fixture token:\n${tail(probe.output)}`);

  const fx = fixtureRepo();
  try {
    fs.writeFileSync(path.join(fx.repo, 'deploy.env'), `GITHUB_TOKEN=${token}\n`);
    assert.equal(fx.git('add', 'deploy.env').status, 0);

    const commit = fx.git('commit', '-m', 'Add deploy settings');
    assert.notEqual(commit.status, 0, `the commit staging a secret succeeded:\n${tail(commit.output)}`);

    const revs = fx.git('rev-list', '--all');
    const committed = revs.stdout
      .split('\n')
      .filter(Boolean)
      .filter((rev) => fx.git('grep', '-q', '-F', token, rev).status === 0);
    assert.deepEqual(committed, [], 'the secret reached a commit');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('pre-commit hook: a commit staging no secret succeeds', () => {
  const fx = fixtureRepo();
  try {
    fs.writeFileSync(
      path.join(fx.repo, 'hours.md'),
      '# Hours\n\nOpen weekdays 7:00 to 18:00. Call 555-0142 or write to desk@center.example.\n',
    );
    assert.equal(fx.git('add', 'hours.md').status, 0);

    const commit = fx.git('commit', '-m', 'Add hours');
    assert.equal(commit.status, 0, `the commit staging no secret was refused:\n${tail(commit.output)}`);

    const files = fx.git('ls-tree', '-r', '--name-only', 'HEAD');
    assert.match(files.stdout, /^hours\.md$/m, 'the committed tree does not hold the staged file');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});
