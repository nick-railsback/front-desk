// The deploy workflow: when it runs, how it gets cloud credentials, and the
// health gate that makes a broken deploy fail the run.

import { describe, expect, test } from 'vitest';
import { credentialHits } from './support/cfn';
import { readRepoFile } from './support/stack';
import {
  type Entry,
  type Line,
  entries,
  listValues,
  normalizeSpace,
  parseFlowValue,
  seqItems,
  topLevel,
  unquote,
  workflowJobs,
  yamlWithoutComments,
} from './support/yaml';

const DEPLOY = '.github/workflows/deploy.yml';

type Step = { fields: Record<string, Entry>; text: string };
type Job = { id: string; fields: Record<string, Entry>; steps: Step[]; text: string };

function triggers(text: string): Record<string, Entry | null> {
  const on = (topLevel(text) as Entry[]).find((e) => e.key === 'on' || e.key === 'true');
  if (!on) throw new Error(`${DEPLOY} has no on: triggers`);
  if (on.value !== '') {
    const v = parseFlowValue(on.value);
    const names = typeof v === 'string' ? [v] : Array.isArray(v) ? v : Object.keys(v);
    return Object.fromEntries(names.map((n: string) => [n, null]));
  }
  const nested = entries(on.body);
  if (Object.keys(nested).length > 0) return nested;
  return Object.fromEntries(listValues(on).map((n) => [String(n), null]));
}

// The filters of one trigger, as { filter: values }.
function filters(entry: Entry | null): Record<string, string[]> {
  if (!entry) return {};
  if (entry.value !== '') {
    const v = parseFlowValue(entry.value);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, (Array.isArray(x) ? x : [x]).map(String)]));
  }
  return Object.fromEntries(
    Object.entries(entries(entry.body)).map(([k, e]) => [k, listValues(e).map((x) => String(x))]),
  );
}

function jobs(text: string): Job[] {
  return workflowJobs(text).map((job: { id: string; lines: Line[] }) => {
    const fields = entries(job.lines);
    const steps = seqItems(fields.steps?.body ?? []).map((item) => {
      const lines: Line[] = [{ indent: item.indent, text: item.head }, ...item.body];
      return { fields: entries(lines), text: normalizeSpace(lines.map((l) => l.text).join('\n')) };
    });
    return { id: job.id, fields, steps, text: normalizeSpace(job.lines.map((l) => l.text).join('\n')) };
  });
}

function scalarOrName(entry: Entry | undefined): string | null {
  if (!entry) return null;
  if (entry.value !== '') {
    const v = parseFlowValue(entry.value);
    return typeof v === 'string' ? v : v && typeof v === 'object' ? String(v.name ?? '') : null;
  }
  const name = entries(entry.body).name;
  return name ? unquote(name.value) : null;
}

function idTokenWrite(job: Job): boolean {
  const p = job.fields.permissions;
  if (!p) return false;
  if (p.value !== '') {
    const v = parseFlowValue(p.value);
    if (v === 'write-all') return true;
    return !!v && typeof v === 'object' && v['id-token'] === 'write';
  }
  return unquote(entries(p.body)['id-token']?.value ?? '') === 'write';
}

const usesAction = (step: Step, action: string) => unquote(step.fields.uses?.value ?? '').startsWith(`${action}@`);
const CONFIGURE = 'aws-actions/configure-aws-credentials';
const assumesRole = (job: Job) => job.steps.some((s) => usesAction(s, CONFIGURE));
const credentialJobs = (all: Job[]) => all.filter((j) => assumesRole(j) || idTokenWrite(j));

describe('deploy trigger', () => {
  test('deploy trigger: the workflow runs only for pushes to main', () => {
    const t = triggers(readRepoFile(DEPLOY));
    expect(Object.keys(t), 'triggers other than push').toEqual(['push']);
    const f = filters(t.push);
    expect(f.branches, 'push has no branches filter, so it runs for every branch').toEqual(['main']);
    for (const widening of ['branches-ignore', 'tags', 'tags-ignore']) {
      expect(f[widening], `push also filters on ${widening}`).toBeUndefined();
    }
  });
});

describe('deploy credentials', () => {
  test('deploy credentials: every job that obtains cloud credentials runs in the production environment', () => {
    const all = jobs(readRepoFile(DEPLOY));
    const creds = credentialJobs(all);
    expect(creds.length, 'no job obtains cloud credentials').toBeGreaterThan(0);
    const outside = creds.filter((j) => scalarOrName(j.fields.environment) !== 'production').map((j) => j.id);
    expect(outside).toEqual([]);
  });

  test('deploy credentials: credentials come from assuming a role through OIDC', () => {
    const all = jobs(readRepoFile(DEPLOY));
    const assuming = all.filter(assumesRole);
    expect(assuming.length, `no job uses ${CONFIGURE}`).toBeGreaterThan(0);
    for (const job of assuming) {
      expect(idTokenWrite(job), `${job.id} cannot request an OIDC token (id-token: write)`).toBe(true);
      for (const step of job.steps.filter((s) => usesAction(s, CONFIGURE))) {
        expect(step.text, `${job.id}: configure step without role-to-assume`).toMatch(/\brole-to-assume\s*:/);
      }
    }
  });

  test('deploy credentials: the workflow references no stored keys or secrets', () => {
    const text = readRepoFile(DEPLOY);
    const code = yamlWithoutComments(text);
    expect(credentialHits(code)).toEqual([]);
    const expressions = [...code.matchAll(/\$\{\{([^}]*)\}\}/g)].map((m) => normalizeSpace(m[1]));
    const secretRefs = expressions.filter((e) => /\bsecrets\b/.test(e.replace(/\bsecrets\.GITHUB_TOKEN\b/g, '')));
    expect(secretRefs).toEqual([]);
    const inherited = jobs(text).filter((j) => j.fields.secrets !== undefined).map((j) => j.id);
    expect(inherited, 'jobs passing secrets to a reusable workflow').toEqual([]);
  });
});

describe('deploy health gate', () => {
  test('deploy health gate: the run fails unless the deployed app answers /api/health', () => {
    const all = jobs(readRepoFile(DEPLOY));
    const gates = all.flatMap((job) => job.steps.filter((s) => s.text.includes('/api/health')).map((step) => ({ job, step })));
    expect(gates.length, 'no step checks /api/health').toBeGreaterThan(0);
    const problems: string[] = [];
    for (const { job, step } of gates) {
      const where = `${job.id}: ${step.text.slice(0, 120)}`;
      if (/^true$/i.test(unquote(job.fields['continue-on-error']?.value ?? ''))) problems.push(`${job.id} continues on error`);
      if (/^true$/i.test(unquote(step.fields['continue-on-error']?.value ?? ''))) problems.push(`${where} continues on error`);
      if (/\|\|\s*(true|:|exit 0)(\s|;|$)/.test(step.text) || /\bset \+e\b/.test(step.text)) {
        problems.push(`${where} swallows a failed check`);
      }
      if (/\bcurl\b/.test(step.text)) {
        const failsOnError =
          /(^|\s)--fail(-with-body)?(\s|$)/.test(step.text) ||
          /(^|\s)-[A-Za-z]{0,20}f[A-Za-z]{0,20}(\s|$)/.test(step.text) ||
          /http_code/.test(step.text);
        if (!failsOnError) problems.push(`${where}: curl exits 0 on an HTTP error unless told to fail`);
      }
    }
    expect(problems).toEqual([]);
  });
});
