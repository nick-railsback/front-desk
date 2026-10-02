// Who can do what in the cloud: model access, the app host's role, the two
// CI roles and how they are assumed, cloud users and keys, credentials
// written into the stack, and the budget alert.
//
// The stack is synthesized in-process with a fictional account. Each test
// loads it first, so every test fails while the stack does not exist.

import { describe, expect, test } from 'vitest';
import {
  IAM_WRITE_ACTIONS,
  MODEL_ARNS,
  REPO,
  type Cfn,
  admits,
  allStatements,
  asArray,
  credentialHits,
  githubClaims,
  grants,
  hostRoleIds,
  hosts,
  invokesConfiguredModel,
  managedPolicyGrantsModelBroadly,
  managedPolicyWritesIam,
  modelScopeProblems,
  nonGitHubTrust,
  ofType,
  resolve,
  resources,
  rolePermissions,
  textOf,
  trustsGitHub,
} from './support/cfn';
import { stackTemplate } from './support/stack';

const sub = (suffix: string) => `repo:${REPO}:${suffix}`;
const DEPLOY_SUB = sub('environment:production');
const EVAL_SUBS = [sub('pull_request'), sub('ref:refs/heads/main')];

function hostRoles(t: Cfn): string[] {
  const found = hosts(t);
  expect(found.length, 'the stack defines no app host (EC2 instance or launch template)').toBeGreaterThan(0);
  const ids = new Set<string>();
  for (const h of found) {
    const roles = hostRoleIds(t, h);
    expect(roles, `host ${h.id} has no instance profile role defined in the stack`).not.toBeNull();
    roles!.forEach((r) => ids.add(r));
  }
  return [...ids];
}

function githubRoles(t: Cfn): string[] {
  return ofType(t, 'AWS::IAM::Role')
    .map(([id]) => id)
    .filter((id) => trustsGitHub(t, id));
}

function onlyRole(t: Cfn, claimsSub: string, what: string): string {
  const matching = githubRoles(t).filter((id) => admits(t, id, githubClaims(claimsSub)));
  expect(matching, `exactly one role should be the ${what}, assumable by ${claimsSub}`).toHaveLength(1);
  return matching[0];
}

const deployRole = (t: Cfn) => onlyRole(t, DEPLOY_SUB, 'CI deploy role');
const evalRole = (t: Cfn) => onlyRole(t, sub('pull_request'), 'CI eval role');

describe('model access', () => {
  test('model access: every model invocation grant in the stack names only the configured model', async () => {
    const t = await stackTemplate();
    const problems = allStatements(t).flatMap(modelScopeProblems);
    expect(problems).toEqual([]);
  });

  test('model access: no role carries an AWS managed policy that invokes every model', async () => {
    const t = await stackTemplate();
    const broad = ofType(t, 'AWS::IAM::Role').flatMap(([id]) =>
      rolePermissions(t, id)
        .awsManaged.filter(managedPolicyGrantsModelBroadly)
        .map((name) => `${id}: ${name}`),
    );
    expect(broad).toEqual([]);
  });

  test('model access: the app host reaches the configured model through its own role', async () => {
    const t = await stackTemplate();
    for (const role of hostRoles(t)) {
      expect(
        invokesConfiguredModel(rolePermissions(t, role).statements),
        `host role ${role} cannot invoke ${MODEL_ARNS[0]}`,
      ).toBe(true);
    }
  });
});

describe('host role', () => {
  test('host role: cannot create, modify, or delete roles, policies, users, or access keys', async () => {
    const t = await stackTemplate();
    const problems: string[] = [];
    for (const role of hostRoles(t)) {
      const perms = rolePermissions(t, role);
      for (const { where, statement } of perms.statements) {
        const writes = IAM_WRITE_ACTIONS.filter((a) => grants(statement, a));
        if (writes.length > 0) problems.push(`${where}: grants ${writes.join(', ')}`);
      }
      perms.awsManaged.filter(managedPolicyWritesIam).forEach((n) => problems.push(`${role}: AWS managed ${n}`));
      perms.unknownManaged.forEach((arn) => problems.push(`${role}: managed policy defined outside the stack, ${arn}`));
    }
    expect(problems).toEqual([]);
  });
});

describe('cloud identities', () => {
  test('cloud identities: the stack defines no IAM user and no access key', async () => {
    const t = await stackTemplate();
    const direct = resources(t)
      .filter(([, r]) => ['AWS::IAM::User', 'AWS::IAM::AccessKey', 'AWS::IAM::UserToGroupAddition'].includes(r.Type))
      .map(([id, r]) => `${id} (${r.Type})`);
    // Custom resources can call the IAM API at deploy time.
    const viaCustom = resources(t)
      .filter(([, r]) => r.Type.startsWith('Custom::') || r.Type === 'AWS::CloudFormation::CustomResource')
      .filter(([, r]) => /createuser|createaccesskey/.test(textOf(r.Properties).toLowerCase().replace(/[^a-z]/g, '')))
      .map(([id]) => `${id} (custom resource creating a user or key)`);
    expect([...direct, ...viaCustom]).toEqual([]);
  });
});

describe('credentials', () => {
  test('credentials: nothing in the stack sets an access key, secret access key, or model provider API key', async () => {
    const t = await stackTemplate();
    const problems = resources(t).flatMap(([id, r]) => credentialHits(textOf(r.Properties)).map((h) => `${id}: ${h}`));
    expect(problems).toEqual([]);
  });
});

describe('ci eval trust', () => {
  test('ci eval trust: only GitHub OIDC can assume the eval role', async () => {
    const t = await stackTemplate();
    expect(nonGitHubTrust(t, evalRole(t))).toEqual([]);
  });

  test("ci eval trust: this repository's pull requests and main branch can assume it", async () => {
    const t = await stackTemplate();
    const role = evalRole(t);
    for (const s of EVAL_SUBS) expect(admits(t, role, githubClaims(s)), s).toBe(true);
  });

  test('ci eval trust: other branches, tags, environments, and repositories cannot', async () => {
    const t = await stackTemplate();
    const role = evalRole(t);
    const outsiders = [
      sub('ref:refs/heads/feature-x'),
      sub('ref:refs/heads/main-old'),
      sub('ref:refs/heads/mainline'),
      sub('ref:refs/heads/main/extra'),
      sub('ref:refs/tags/v1.0.0'),
      sub('environment:staging'),
      'repo:other-owner-example/front-desk:pull_request',
      'repo:other-owner-example/front-desk:ref:refs/heads/main',
      'repo:nick-railsback/front-desk-fork:pull_request',
      'repo:nick-railsback/front-desk-fork:ref:refs/heads/main',
      'repo:nick-railsback/other-repo:ref:refs/heads/main',
    ];
    const admitted = outsiders.filter((s) => admits(t, role, githubClaims(s)));
    expect(admitted).toEqual([]);
  });
});

describe('ci eval permissions', () => {
  test('ci eval permissions: the eval role can invoke the configured model and nothing else', async () => {
    const t = await stackTemplate();
    const role = evalRole(t);
    const perms = rolePermissions(t, role);
    expect(perms.awsManaged, 'AWS managed policies on the eval role').toEqual([]);
    expect(perms.unknownManaged, 'managed policies from outside the stack on the eval role').toEqual([]);
    const allowed = ['bedrock:invokemodel', 'bedrock:invokemodelwithresponsestream'];
    const problems: string[] = [];
    for (const { where, statement: s } of perms.statements) {
      if (s.Effect !== 'Allow') continue;
      if (s.NotAction !== undefined) problems.push(`${where}: NotAction`);
      for (const a of asArray(s.Action)) {
        const name = resolve(a);
        if (name === null || !allowed.includes(name.toLowerCase())) problems.push(`${where}: allows ${name ?? JSON.stringify(a)}`);
      }
      for (const r of asArray(s.Resource)) {
        const arn = resolve(r);
        if (arn === null || !MODEL_ARNS.includes(arn)) problems.push(`${where}: on ${arn ?? JSON.stringify(r)}`);
      }
      if (s.NotResource !== undefined) problems.push(`${where}: NotResource`);
    }
    expect(problems).toEqual([]);
    expect(invokesConfiguredModel(perms.statements), 'the eval role cannot invoke the configured model').toBe(true);
  });
});

describe('ci deploy trust', () => {
  test('ci deploy trust: only GitHub OIDC can assume the deploy role', async () => {
    const t = await stackTemplate();
    expect(nonGitHubTrust(t, deployRole(t))).toEqual([]);
  });

  test("ci deploy trust: only this repository's production environment matches", async () => {
    const t = await stackTemplate();
    const role = deployRole(t);
    expect(admits(t, role, githubClaims(DEPLOY_SUB))).toBe(true);
    const outsiders = [
      sub('ref:refs/heads/main'),
      sub('ref:refs/heads/feature-x'),
      sub('ref:refs/tags/v1.0.0'),
      sub('pull_request'),
      sub('environment:staging'),
      sub('environment:production-preview'),
      sub('environment:productionx'),
      'repo:other-owner-example/front-desk:environment:production',
      'repo:nick-railsback/front-desk-fork:environment:production',
      'repo:nick-railsback/other-repo:environment:production',
    ];
    const admitted = outsiders.filter((s) => admits(t, role, githubClaims(s)));
    expect(admitted).toEqual([]);
  });
});

describe('ci roles', () => {
  test('ci roles: the eval and deploy roles are the only roles GitHub can assume, and they differ', async () => {
    const t = await stackTemplate();
    const evalId = evalRole(t);
    const deployId = deployRole(t);
    expect(evalId).not.toBe(deployId);
    expect(githubRoles(t).sort()).toEqual([evalId, deployId].sort());
  });
});

describe('budget', () => {
  test('budget: a monthly cost budget notifies when forecast spend exceeds $25', async () => {
    const t = await stackTemplate();
    const budgets = ofType(t, 'AWS::Budgets::Budget');
    expect(budgets.length, 'the stack defines no budget').toBeGreaterThan(0);
    const fits = budgets.some(([, r]) => {
      const b = r.Properties?.Budget ?? {};
      if (b.BudgetType !== 'COST' || b.TimeUnit !== 'MONTHLY') return false;
      const limit = Number(b.BudgetLimit?.Amount);
      if (b.BudgetLimit && b.BudgetLimit.Unit !== 'USD') return false;
      return asArray(r.Properties?.NotificationsWithSubscribers).some((n: any) => {
        const note = n.Notification ?? {};
        if (note.NotificationType !== 'FORECASTED' || note.ComparisonOperator !== 'GREATER_THAN') return false;
        const threshold = Number(note.Threshold);
        const absolute = (note.ThresholdType ?? 'PERCENTAGE') === 'ABSOLUTE_VALUE' ? threshold : (threshold * limit) / 100;
        return Math.abs(absolute - 25) < 0.005 && asArray(n.Subscribers).length > 0;
      });
    });
    expect(fits, `no budget matches: ${JSON.stringify(budgets.map(([, r]) => r.Properties))}`).toBe(true);
  });
});
