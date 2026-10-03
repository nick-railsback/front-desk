// Shared helpers for the eval script and eval workflow tests. Not a test
// file: vitest collects only *.test.ts.
//
// Assumed interface. The tests hold the implementation to these:
//
// 1. The eval script. The root package.json defines an `eval` script, run as
//    `pnpm run eval` from the repository root. With MODEL_MODE=fixture it
//    uses the pipeline's scripted fixture model: it needs no network, no AWS
//    credentials, and no database (DATABASE_URL is unset for the run). It
//    runs the existing runner (`runEval` in evals/src/runner.ts) over every
//    case in evals/cases/ with the pipeline's answer function and grounding
//    check, and writes evals/reports/report.json and evals/reports/summary.md
//    in the runner's report format. Fixture calls are not paced against the
//    Bedrock quota, so the whole fixture run finishes within 180 seconds. The
//    test saves any report files already in evals/reports/ (a live run's
//    report, say) and puts them back afterwards.
//
//    "No network" is enforced in every Node process of the run by a preload
//    module (NODE_OPTIONS=--require) that refuses and records any TCP
//    connection, DNS lookup, or fetch to a host other than the loopback
//    interface. "No AWS credentials" means every AWS_* credential variable is
//    unset, AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE point at files
//    that do not exist, and instance metadata is disabled.
//
// 2. The eval workflow, .github/workflows/evals.yml. It runs on
//    workflow_dispatch, on push to main (a branch filter that matches main
//    and not a feature branch), and on pull_request filtered by `paths` (no
//    paths-ignore). The answer pipeline lives in app/src/core/ and
//    app/src/server/, the route in app/src/app/api/ask/, and the model
//    instructions and model configuration live inside those module areas;
//    the case set is evals/cases/. The `paths` filter, read with GitHub's
//    glob rules, must match a change to any file in those areas, so the test
//    checks one representative file of each kind; the names are examples,
//    not required file names. A change confined to docs/ or infra/lib/ does
//    not trigger it. A `concurrency` block at the workflow or eval job level
//    has a group with no ref-, run-, or event-dependent expression and does
//    not cancel the run in progress.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import * as repo from '../../../tests/repo/support/repo.mjs';

export const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const EVALS_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'evals.yml');

export type Line = { indent: number; text: string };
export type Entry = { key: string; value: string; body: Line[] };

export function read(file: string): string {
  expect(existsSync(file), `${path.relative(ROOT, file)} exists`).toBe(true);
  return readFileSync(file, 'utf8');
}

export function child(entry: Entry | null | undefined, key: string): Entry | undefined {
  if (!entry) return undefined;
  return (repo.mapEntries(entry.body) as Entry[]).find((e) => e.key === key);
}

// A key's value as a list of strings: a flow or block sequence, or a scalar.
export function listOf(entry: Entry | undefined): string[] {
  if (!entry) return [];
  const value = repo.entryValue(entry);
  if (Array.isArray(value)) return value.map(String);
  if (value === null) return [];
  if (typeof value === 'string') return [value];
  return Object.keys(value);
}

// GitHub's filter pattern rules: `*` matches any characters except `/`, `**`
// matches any characters, `?` matches one character, `+` repeats the
// preceding character, `[...]` is a character class, and a leading `!`
// negates. Patterns apply in order; the last one that matches decides.
function patternToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (ch === '+') out += '+';
    else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) out += '\\[';
      else {
        out += pattern.slice(i, close + 1);
        i = close;
      }
    } else out += ch.replace(/[.^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function filterMatches(patterns: string[], file: string): boolean {
  let matched = false;
  for (const raw of patterns) {
    const p = raw.trim();
    if (p.startsWith('!')) {
      if (patternToRegExp(p.slice(1)).test(file)) matched = false;
    } else if (patternToRegExp(p).test(file)) matched = true;
  }
  return matched;
}

export { repo };
