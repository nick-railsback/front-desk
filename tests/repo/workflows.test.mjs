// GitHub Actions workflows, every .yml and .yaml file under .github/workflows/.
//
// action pinning: every action or reusable workflow referenced from another
// repository, whether in a step or at job level, is pinned to a full
// 40-character commit SHA. References to this repository (./...) and to
// container images (docker://...) are not actions from another repository.
//
// token permissions: every workflow declares top-level permissions that
// grant read access at most (read-all, {}, or each scope read or none).
// A workflow without top-level permissions inherits the repository default,
// which may be write, so it does not count as read-only. Write access may
// appear only in a job's own permissions.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  entryValue,
  isPinnedToFullSha,
  isRemoteRef,
  topLevelEntry,
  usesRefs,
  workflowFiles,
} from './support/repo.mjs';

function scalarMap(value) {
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = v && typeof v === 'object' && 'body' in v ? entryValue(v) : v;
  }
  return out;
}

// Why a top-level permissions value is not read-only, or null when it is.
function writeGrant(entry) {
  if (!entry) return 'no top-level permissions, so the token gets the repository default';
  const value = entryValue(entry);
  if (value === 'read-all') return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `top-level permissions is ${JSON.stringify(value)}`;
  }
  const scopes = scalarMap(value);
  const writes = Object.entries(scopes).filter(([, v]) => v !== 'read' && v !== 'none');
  if (writes.length === 0) return null;
  return `top-level permissions grant ${writes.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')}`;
}

test('action pinning: every action from another repository is pinned to a full commit SHA', () => {
  const workflows = workflowFiles();
  assert.ok(workflows.length > 0, 'the repository has no workflows under .github/workflows/');

  const remote = workflows.flatMap((wf) =>
    usesRefs(wf.text)
      .filter(isRemoteRef)
      .map((ref) => ({ workflow: wf.name, ref })),
  );
  assert.ok(remote.length > 0, 'no workflow references an action from another repository');

  const unpinned = remote.filter(({ ref }) => !isPinnedToFullSha(ref)).map(({ workflow, ref }) => `${workflow}: ${ref}`);
  assert.deepEqual(unpinned, [], 'actions not pinned to a 40-character commit SHA');
});

test('token permissions: every workflow is read-only by default and grants write only per job', () => {
  const workflows = workflowFiles();
  assert.ok(workflows.length > 0, 'the repository has no workflows under .github/workflows/');

  const problems = workflows
    .map((wf) => ({ wf, why: writeGrant(topLevelEntry(wf.text, 'permissions')) }))
    .filter(({ why }) => why !== null)
    .map(({ wf, why }) => `${wf.name}: ${why}`);
  assert.deepEqual(problems, [], 'workflows whose token is not read-only by default');
});
