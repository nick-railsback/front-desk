// Secret scanning of the repository history, locally and in CI.
//
// history scan: gitleaks run over every commit reachable from any ref or
// HEAD reports no findings. A shallow clone cannot show the full history, so
// the scan refuses to run there instead of passing on a truncated history.
//
// CI scan: some workflow runs that same full-history scan on every push and
// every pull request, with no branch, tag, or path filter on either trigger,
// and checks out the full history first (fetch-depth: 0).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  ROOT,
  makeTempDir,
  run,
  tail,
  workflowFiles,
  workflowJobs,
  workflowTriggers,
} from './support/repo.mjs';

// A step that runs gitleaks over git history: `gitleaks git` (or the older
// `gitleaks detect`), possibly from a container image tag, and not limited
// to staged changes or to a commit range.
const HISTORY_SCAN = /\bgitleaks(?::\S+)?[ \t]+(git|detect)\b[^\n]*/;

function historyScanStep(jobText) {
  const m = HISTORY_SCAN.exec(jobText);
  if (!m) return null;
  const line = m[0];
  if (/--staged\b|--pre-commit\b|--no-git\b/.test(line)) return null;
  if (/--log-opts[=\s]+["']?[^"'\n]*\.\./.test(line)) return null;
  return line.trim();
}

function ciHistoryScans() {
  const found = [];
  for (const wf of workflowFiles()) {
    for (const job of workflowJobs(wf.text)) {
      const step = historyScanStep(job.text);
      if (!step) continue;
      found.push({
        workflow: wf.name,
        job: job.id,
        step,
        fullCheckout: /(^|[\s{,])fetch-depth\s*:\s*["']?0["']?\s*($|[,}\n])/.test(job.text),
        triggers: workflowTriggers(wf.text),
      });
    }
  }
  return found;
}

const UNFILTERED_PUSH = ['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore'];
const UNFILTERED_PR = ['branches', 'branches-ignore', 'paths', 'paths-ignore'];

test('CI scan: a workflow scans the full git history for secrets on every push and every pull request', () => {
  const scans = ciHistoryScans();
  assert.ok(
    scans.length > 0,
    'expected a workflow job under .github/workflows/ with a step running `gitleaks git` (or `gitleaks detect`) ' +
      'over the history, not limited by --staged, --pre-commit, --no-git, or a --log-opts commit range',
  );
  const problems = [];
  for (const s of scans) {
    const where = `${s.workflow} job "${s.job}"`;
    const triggers = s.triggers ?? {};
    const own = [];
    if (!s.fullCheckout) own.push(`${where}: checkout does not set fetch-depth: 0, so the scan sees one commit`);
    if (!('push' in triggers)) own.push(`${where}: workflow does not run on push`);
    else {
      const f = triggers.push.filter((k) => UNFILTERED_PUSH.includes(k));
      if (f.length) own.push(`${where}: push trigger is filtered by ${f.join(', ')}`);
    }
    if (!('pull_request' in triggers)) own.push(`${where}: workflow does not run on pull_request`);
    else {
      const f = triggers.pull_request.filter((k) => UNFILTERED_PR.includes(k));
      if (f.length) own.push(`${where}: pull_request trigger is filtered by ${f.join(', ')}`);
    }
    if (own.length === 0) return;
    problems.push(...own);
  }
  assert.fail(`no history scan step runs on every push and pull request:\n${problems.join('\n')}`);
});

test('history scan: gitleaks finds no secret in any commit of the full history', () => {
  // The local scan is the check CI repeats on every change; it is only a
  // guarantee once CI actually runs it.
  assert.ok(
    ciHistoryScans().length > 0,
    'no workflow runs a full-history gitleaks scan, so nothing repeats this check on new commits',
  );

  const shallow = run('git', ['rev-parse', '--is-shallow-repository'], { cwd: ROOT });
  assert.equal(shallow.status, 0, `git rev-parse failed:\n${shallow.output}`);
  assert.equal(
    shallow.stdout.trim(),
    'false',
    'this clone is shallow, so its full history cannot be scanned; fetch the full history (fetch-depth: 0 in CI)',
  );

  const commits = run('git', ['rev-list', '--count', '--all', 'HEAD'], { cwd: ROOT });
  assert.equal(commits.status, 0, `git rev-list failed:\n${commits.output}`);
  assert.ok(Number(commits.stdout.trim()) > 0, 'the repository has no commits to scan');

  const reportDir = makeTempDir('history-scan');
  const report = path.join(reportDir, 'report.json');
  try {
    const scan = run(
      'gitleaks',
      ['git', ROOT, '--no-banner', '--redact', '--report-format', 'json', '--report-path', report],
      { cwd: ROOT, timeout: 300_000 },
    );
    const findings = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
    assert.ok(Array.isArray(findings), `gitleaks wrote no report (exit ${scan.status}):\n${tail(scan.output)}`);
    assert.deepEqual(
      findings.map((f) => `${f.RuleID} in ${f.File} at ${f.Commit}`),
      [],
      'gitleaks reported secrets in the history',
    );
    assert.equal(scan.status, 0, `gitleaks exited ${scan.status}:\n${tail(scan.output)}`);
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
});
