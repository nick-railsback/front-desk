// The two eval workflows, read structurally (no YAML parser is available, so
// these use the repository's own indentation-based helpers).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
// Plain JavaScript helpers shared with the repository tests.
import * as repo from '../../tests/repo/support/repo.mjs';
import { ROOT } from './support';

type Line = { indent: number; text: string };
type Entry = { key: string; value: string; body: Line[] };
type Job = { id: string; lines: Line[]; text: string };

const EVALS = path.join(ROOT, '.github', 'workflows', 'evals.yml');
const GUARD = path.join(ROOT, '.github', 'workflows', 'oracle-guard.yml');

function read(file: string): string {
  expect(existsSync(file), `${path.relative(ROOT, file)} exists`).toBe(true);
  return readFileSync(file, 'utf8');
}

// Comment-free lines, so a comment can neither satisfy nor trip a check.
function codeLines(text: string): string[] {
  return (repo.yamlLines(text) as Line[]).map((l) => l.text);
}

function child(entry: Entry | null | undefined, key: string): Entry | undefined {
  if (!entry) return undefined;
  return (repo.mapEntries(entry.body) as Entry[]).find((e) => e.key === key);
}

// A permissions value as { scope: level }, from block or flow style.
function permissions(entry: Entry | undefined): Record<string, string> {
  if (!entry) return {};
  const value = repo.entryValue(entry);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { '*': String(value) };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = v && typeof v === 'object' && 'body' in (v as object) ? String(repo.entryValue(v)) : String(v);
  }
  return out;
}

function jobPermissions(job: Job): Record<string, string> {
  const entry = (repo.mapEntries(job.lines) as Entry[]).find((e) => e.key === 'permissions');
  return permissions(entry);
}

// The eval workflow runs on manual dispatch, on push to main, and on pull
// requests (evals/tests/pipeline/eval-workflow.test.ts checks the
// filters). Its one eval job alone
// gets id-token: write to assume a role through OIDC, runs the runner with
// nothing that swallows a non-zero exit, appends summary.md to the step
// summary, and uploads report.json as an artifact.
describe('eval workflow', () => {
  test('manual dispatch, push, and pull requests are the triggers', () => {
    const text = read(EVALS);
    const triggers = repo.workflowTriggers(text);
    expect(triggers, 'on: is declared').not.toBeNull();
    expect(Object.keys(triggers).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);
  });

  test('id-token: write is granted on the eval job only', () => {
    const text = read(EVALS);
    const top = permissions(repo.topLevelEntry(text, 'permissions'));
    expect(top, 'top-level permissions').not.toHaveProperty('id-token');
    const jobs = repo.workflowJobs(text) as Job[];
    const withIdToken = jobs.filter((j) => jobPermissions(j)['id-token'] === 'write');
    expect(withIdToken.map((j) => j.id), 'jobs granted id-token: write').toHaveLength(1);
    const idTokenLines = codeLines(text).filter((l) => /id-token/.test(l));
    expect(idTokenLines, 'id-token appears once in the workflow').toHaveLength(1);
  });

  test('the eval job assumes a role through OIDC, with no long-lived keys', () => {
    const text = read(EVALS);
    const job = (repo.workflowJobs(text) as Job[]).find((j) => jobPermissions(j)['id-token'] === 'write');
    expect(job, 'a job with id-token: write').toBeDefined();
    expect(job!.text).toMatch(/role-to-assume\s*:/);
    const keys = codeLines(text).filter((l) => /aws-access-key-id|aws-secret-access-key|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/.test(l));
    expect(keys, 'long-lived AWS credentials').toEqual([]);
  });

  test('the eval job runs the runner, publishes the summary and the report', () => {
    const text = read(EVALS);
    const job = (repo.workflowJobs(text) as Job[]).find((j) => jobPermissions(j)['id-token'] === 'write');
    expect(job, 'a job with id-token: write').toBeDefined();
    const lines = job!.lines.map((l) => l.text);
    expect(lines.some((l) => /\bpnpm\s+(run\s+)?eval\b/.test(l)), 'a step runs pnpm eval').toBe(true);
    expect(
      lines.some((l) => /summary\.md/.test(l) && />>\s*"?\$\{?GITHUB_STEP_SUMMARY\}?"?/.test(l)),
      'a step appends summary.md to $GITHUB_STEP_SUMMARY',
    ).toBe(true);
    const uploads = (repo.usesRefs(job!.text) as string[]).filter((r) => r.startsWith('actions/upload-artifact@'));
    expect(uploads, 'an actions/upload-artifact step').not.toHaveLength(0);
    expect(job!.text).toMatch(/report\.json/);
  });

  test('a non-zero runner exit fails the job', () => {
    const text = read(EVALS);
    const lines = codeLines(text);
    expect(lines.filter((l) => /continue-on-error/.test(l)), 'continue-on-error').toEqual([]);
    expect(lines.filter((l) => /\|\|\s*(true|:)(\s|$)/.test(l)), 'exit status swallowed').toEqual([]);
    expect(lines.filter((l) => /\bset\s+\+e\b/.test(l)), 'set +e').toEqual([]);
  });
});

// The guard runs on every pull request event that can change whether files
// under evals/cases/ carry the oracle-change label (opened, new commits,
// reopened, label added or removed), never through pull_request_target, and
// fails unless the label is present.
describe('oracle guard workflow', () => {
  test('triggers on pull_request filtered to evals/cases/**, never pull_request_target', () => {
    const text = read(GUARD);
    expect(codeLines(text).filter((l) => /pull_request_target/.test(l))).toEqual([]);
    const triggers = repo.workflowTriggers(text);
    expect(triggers, 'on: is declared').not.toBeNull();
    expect(Object.keys(triggers)).toContain('pull_request');
    const on = repo.topLevel(text).find((e: Entry) => e.key === 'on' || e.key === 'true') as Entry;
    const pr = child(on, 'pull_request');
    expect(pr, 'pull_request has filters').toBeDefined();
    const paths = child(pr, 'paths');
    expect(paths, 'pull_request.paths').toBeDefined();
    expect(repo.entryValue(paths)).toContain('evals/cases/**');
    expect(child(pr, 'paths-ignore'), 'no paths-ignore').toBeUndefined();
  });

  test('runs when the pull request opens, updates, reopens, or a label is added or removed', () => {
    const text = read(GUARD);
    const on = repo.topLevel(text).find((e: Entry) => e.key === 'on' || e.key === 'true') as Entry;
    const types = child(child(on, 'pull_request'), 'types');
    expect(types, 'pull_request.types').toBeDefined();
    const listed = repo.entryValue(types) as string[];
    for (const t of ['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled']) expect(listed).toContain(t);
  });

  test('a job fails unless the pull request carries the oracle-change label', () => {
    const text = read(GUARD);
    const jobs = repo.workflowJobs(text) as Job[];
    const guard = jobs.find((j) => /oracle-change/.test(j.text));
    expect(guard, 'a job that checks for the oracle-change label').toBeDefined();
    expect(guard!.text).toMatch(/labels/);
    expect(guard!.text).toMatch(/\bexit\s+1\b|setFailed/);
    expect(codeLines(text).filter((l) => /continue-on-error/.test(l)), 'continue-on-error').toEqual([]);
  });
});
