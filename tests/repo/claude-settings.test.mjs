// Claude Code project settings: the deny list in .claude/settings.json (not
// the personal settings.local.json) blocks the actions the project forbids.
//
// Rules are matched the way Claude Code reads them: `x`, `./x`, and `/x` are
// all relative to the project root, a pattern with no slash matches at any
// depth, `**` crosses directories, and an Edit rule covers every built-in
// tool that writes files. For Bash, `prefix:*` and `prefix *` are both
// prefix matches. A broader rule that covers the target also counts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { bashRuleMatches, denies, pathRuleMatches, rootPath } from './support/repo.mjs';

const SETTINGS = '.claude/settings.json';

function denyRules() {
  const file = rootPath(SETTINGS);
  assert.ok(fs.existsSync(file), `${SETTINGS} does not exist`);
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const deny = settings?.permissions?.deny;
  assert.ok(Array.isArray(deny), `${SETTINGS} has no permissions.deny list`);
  return deny;
}

function uncovered(rules, tools, targets, matcher) {
  return targets.filter((t) => !denies(rules, tools, t, matcher));
}

const EVAL_CASE_FILES = ['evals/cases/greeting.yaml', 'evals/cases/urgent/fever.json'];

test('Claude settings: editing files under evals/cases/ is denied', () => {
  assert.deepEqual(uncovered(denyRules(), ['Edit'], EVAL_CASE_FILES, pathRuleMatches), [], 'eval case files Edit may change');
});

test('Claude settings: writing files under evals/cases/ is denied', () => {
  assert.deepEqual(
    uncovered(denyRules(), ['Write', 'Edit'], EVAL_CASE_FILES, pathRuleMatches),
    [],
    'eval case files Write may create or overwrite',
  );
});

test('Claude settings: reading .env and .env.* files is denied', () => {
  assert.deepEqual(
    uncovered(denyRules(), ['Read'], ['.env', '.env.local', '.env.production'], pathRuleMatches),
    [],
    'environment files Read may open',
  );
});

test('Claude settings: running cdk deploy is denied', () => {
  assert.deepEqual(
    uncovered(denyRules(), ['Bash'], ['cdk deploy', 'cdk deploy --all', 'cdk deploy FrontDeskStack --require-approval never'], bashRuleMatches),
    [],
    'cdk deploy commands Bash may run',
  );
});

test('Claude settings: running aws ssm send-command is denied', () => {
  assert.deepEqual(
    uncovered(
      denyRules(),
      ['Bash'],
      ['aws ssm send-command --instance-ids i-0123456789abcdef0 --document-name AWS-RunShellScript'],
      bashRuleMatches,
    ),
    [],
    'aws ssm send-command commands Bash may run',
  );
});
