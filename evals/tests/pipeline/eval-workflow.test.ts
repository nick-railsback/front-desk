// When the eval workflow runs.
//
// triggers: the eval workflow runs on manual dispatch, on push to main, and on
// pull requests that change answer behavior: a pull request changing a file
// of the answer pipeline, the model instructions, the model configuration, or
// the case set triggers it. One representative file of each kind is checked
// against the pull_request paths filter with GitHub's glob rules; the names
// are examples inside the declared module areas, not required file names, so
// the filter has to cover each area as a whole. A change confined to docs or
// to the infrastructure stack does not trigger it.
//
// one run at a time: at most one eval run is in progress, and a queued run
// waits rather than cancelling the run in progress.
//
// Assumed interface: see ./support.ts.

import { describe, expect, test } from 'vitest';
import { EVALS_WORKFLOW, type Entry, child, filterMatches, listOf, read, repo } from './support';

function onEntry(text: string): Entry {
  const on = (repo.topLevel(text) as Entry[]).find((e) => e.key === 'on' || e.key === 'true');
  expect(on, 'on: is declared').toBeDefined();
  return on!;
}

// Representative changes. Pipeline: the entry point the pipeline tests load
// and a pure module beside the core types. Instructions and configuration:
// files inside the same module areas.
const TRIGGERING: [string, string][] = [
  ['an answer pipeline file', 'app/src/server/ask.ts'],
  ['a pure pipeline file', 'app/src/core/grounding.ts'],
  ['the ask route', 'app/src/app/api/ask/route.ts'],
  ['the model instructions', 'app/src/core/instructions.ts'],
  ['the model configuration', 'app/src/server/model.ts'],
  ['a case file', 'evals/cases/urgent.json'],
];

const NOT_TRIGGERING = ['docs/PRD.md', 'infra/lib/front-desk-stack.ts'];

describe('triggers', () => {
  test('triggers: manual dispatch, push to main only, and pull requests filtered by paths', () => {
    const text = read(EVALS_WORKFLOW);
    const triggers = repo.workflowTriggers(text) as Record<string, string[]> | null;
    expect(triggers, 'on: is declared').not.toBeNull();
    expect(Object.keys(triggers!).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);

    const on = onEntry(text);
    const push = child(on, 'push');
    const branches = listOf(child(push, 'branches'));
    expect(branches.length, 'push has no branches filter, so it runs on every branch').toBeGreaterThan(0);
    expect(filterMatches(branches, 'main'), `push branches ${JSON.stringify(branches)} do not match main`).toBe(true);
    expect(filterMatches(branches, 'feature/some-change'), 'push runs on feature branches').toBe(false);
    expect(child(push, 'branches-ignore'), 'push uses branches-ignore').toBeUndefined();

    const pr = child(on, 'pull_request');
    expect(child(pr, 'paths-ignore'), 'pull_request uses paths-ignore').toBeUndefined();
    const paths = listOf(child(pr, 'paths'));
    expect(paths.length, 'pull_request has no paths filter').toBeGreaterThan(0);
  });

  test('triggers: a pull request changing a pipeline file, the model instructions, the model configuration, or a case triggers it; docs and the stack do not', () => {
    const text = read(EVALS_WORKFLOW);
    const paths = listOf(child(child(onEntry(text), 'pull_request'), 'paths'));
    const missed = TRIGGERING.filter(([, file]) => !filterMatches(paths, file)).map(([kind, file]) => `${kind} (${file})`);
    expect(missed, `paths: ${JSON.stringify(paths)}`).toEqual([]);
    expect(NOT_TRIGGERING.filter((file) => filterMatches(paths, file)), `paths: ${JSON.stringify(paths)}`).toEqual([]);
  });
});

function concurrencyOf(entry: Entry | undefined): { group: string | null; cancel: string | null } | null {
  if (!entry) return null;
  if (entry.value !== '' && !entry.value.startsWith('{')) return { group: repo.unquote(entry.value), cancel: null };
  const value = repo.entryValue(entry) as Record<string, any> | string | null;
  if (value === null || typeof value !== 'object') return { group: value === null ? null : String(value), cancel: null };
  const scalar = (v: any) => (v && typeof v === 'object' && 'value' in v ? repo.unquote(String(v.value)) : v == null ? null : String(v));
  return { group: scalar(value.group), cancel: scalar(value['cancel-in-progress']) };
}

describe('one run at a time', () => {
  test('one run at a time: one fixed concurrency group that never cancels the run in progress', () => {
    const text = read(EVALS_WORKFLOW);
    const blocks: { where: string; c: NonNullable<ReturnType<typeof concurrencyOf>> }[] = [];
    const top = concurrencyOf((repo.topLevelEntry(text, 'concurrency') as Entry | null) ?? undefined);
    if (top) blocks.push({ where: 'workflow', c: top });
    for (const job of repo.workflowJobs(text) as { id: string; lines: Entry['body'] }[]) {
      const c = concurrencyOf((repo.mapEntries(job.lines) as Entry[]).find((e) => e.key === 'concurrency'));
      if (c) blocks.push({ where: `job ${job.id}`, c });
    }
    expect(blocks.length, 'no concurrency block').toBeGreaterThan(0);
    for (const { where, c } of blocks) {
      expect(c.group, `${where}: no concurrency group`).toBeTruthy();
      const expressions = [...String(c.group).matchAll(/\$\{\{([^}]*)\}\}/g)].map((m) => m[1].trim());
      expect(expressions.filter((e) => e !== 'github.workflow'), `${where}: the group varies by run`).toEqual([]);
      expect(c.cancel === null || c.cancel === 'false', `${where}: cancel-in-progress is ${c.cancel}`).toBe(true);
    }
  });
});
