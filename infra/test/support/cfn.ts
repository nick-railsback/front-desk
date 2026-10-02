// Helpers that read a synthesized CloudFormation template as plain data.
// Not a test file: the runner only collects *.test.ts.
//
// Every scan here walks the whole template rather than one resource type, and
// anything it cannot resolve (a GetAtt, a Ref to a resource where a string is
// needed) counts as a failure, never as a pass.

export const ACCOUNT = '123456789012';
export const REGION = 'us-east-1';
export const REPO = 'nick-railsback/front-desk';
export const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

export type Resource = { Type: string; Properties?: Record<string, any> };
export type Cfn = { Resources?: Record<string, Resource> };

export function resources(t: Cfn): [string, Resource][] {
  return Object.entries(t.Resources ?? {});
}

export function ofType(t: Cfn, ...types: string[]): [string, Resource][] {
  return resources(t).filter(([, r]) => types.includes(r.Type));
}

export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// Intrinsic functions.

const PSEUDO: Record<string, string> = {
  'AWS::Partition': 'aws',
  'AWS::Region': REGION,
  'AWS::AccountId': ACCOUNT,
  'AWS::URLSuffix': 'amazonaws.com',
};

// A value as a plain string, or null when it depends on something only known
// at deploy time (another resource's attribute, a parameter, an import).
export function resolve(v: any): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1) return null;
  const [fn] = keys;
  const arg = v[fn];
  if (fn === 'Ref') return PSEUDO[arg] ?? null;
  if (fn === 'Fn::Join') {
    const [sep, parts] = arg;
    const out = asArray(parts).map((p) => resolve(p));
    return out.some((p) => p === null) ? null : out.join(sep);
  }
  if (fn === 'Fn::Sub') {
    const [text, subVars] = typeof arg === 'string' ? [arg, {}] : arg;
    let failed = false;
    const out = String(text).replace(/\$\{(!?)([^}]+)\}/g, (_m, bang, name) => {
      if (bang) return `\${${name}}`;
      if (name in PSEUDO) return PSEUDO[name];
      if (subVars && name in subVars) {
        const r = resolve(subVars[name]);
        if (r !== null) return r;
      }
      failed = true;
      return '';
    });
    return failed ? null : out;
  }
  if (fn === 'Fn::Select') {
    const [index, list] = arg;
    const items = Array.isArray(list) ? list : null;
    return items ? resolve(items[Number(index)]) : null;
  }
  return null;
}

// Every literal string in a value, with Fn::Join and Fn::Sub pieces glued
// back together, so a name split across join parts is still found.
export function textOf(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map(textOf).join(' ');
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === 'Fn::Join') {
    const [sep, parts] = v['Fn::Join'];
    return asArray(parts).map(textOf).join(sep);
  }
  if (keys.length === 1 && keys[0] === 'Fn::Sub') {
    const arg = v['Fn::Sub'];
    return typeof arg === 'string' ? arg : `${arg[0]} ${textOf(arg[1])}`;
  }
  return keys.map((k) => `${k} ${textOf(v[k])}`).join(' ');
}

// The logical ID a value points at through Ref or Fn::GetAtt, if any.
export function refTarget(v: any): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (typeof v.Ref === 'string') return v.Ref;
  const ga = v['Fn::GetAtt'];
  if (Array.isArray(ga)) return String(ga[0]);
  if (typeof ga === 'string') return ga.split('.')[0];
  return null;
}

// ---------------------------------------------------------------------------
// IAM policy statements.

export type Statement = {
  Effect?: string;
  Action?: any;
  NotAction?: any;
  Resource?: any;
  NotResource?: any;
  Principal?: any;
  NotPrincipal?: any;
  Condition?: Record<string, Record<string, any>>;
  Sid?: string;
};

export type Located = { where: string; statement: Statement };

export function globMatch(pattern: string, value: string, ignoreCase = true): boolean {
  const p = ignoreCase ? pattern.toLowerCase() : pattern;
  const v = ignoreCase ? value.toLowerCase() : value;
  const source = p
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`).test(v);
}

export function hasWildcard(s: string): boolean {
  return /[*?]/.test(s);
}

// Action patterns as strings; an unresolvable token becomes '*' so it is
// treated as the broadest possible grant.
function actionPatterns(v: any): string[] {
  return asArray(v).map((a) => resolve(a) ?? '*');
}

// Whether an Allow statement grants this concrete action.
export function grants(s: Statement, action: string): boolean {
  if (s.Effect !== 'Allow') return false;
  if (s.NotAction !== undefined) return !actionPatterns(s.NotAction).some((p) => globMatch(p, action));
  return actionPatterns(s.Action).some((p) => globMatch(p, action));
}

// Whether an Allow statement grants any action of a service through a
// wildcard (`*`, `bedrock:*`, `bedrock:Invoke*`, `b*:*`) or through NotAction.
export function grantsWildcardOf(s: Statement, service: string): boolean {
  if (s.Effect !== 'Allow') return false;
  if (s.NotAction !== undefined) return true;
  return actionPatterns(s.Action).some((p) => {
    if (!hasWildcard(p)) return false;
    const svc = p.includes(':') ? p.slice(0, p.indexOf(':')) : p;
    return globMatch(svc, service);
  });
}

function isStatementHolder(v: any): boolean {
  return v && typeof v === 'object' && !Array.isArray(v) && 'Statement' in v;
}

// Every policy statement anywhere in the template: role inline policies,
// AWS::IAM::Policy, AWS::IAM::RolePolicy, AWS::IAM::ManagedPolicy, resource
// policies, and anything else shaped like a policy document. Trust policies
// (AssumeRolePolicyDocument) are permissions to assume, not grants, and are
// read separately.
export function allStatements(t: Cfn): Located[] {
  const out: Located[] = [];
  const walk = (v: any, where: string) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${where}[${i}]`));
      return;
    }
    for (const [k, child] of Object.entries(v)) {
      if (k === 'AssumeRolePolicyDocument') continue;
      if (isStatementHolder(child)) {
        asArray((child as any).Statement).forEach((s: any, i: number) =>
          out.push({ where: `${where}.${k}.Statement[${i}]`, statement: s }),
        );
      }
      walk(child, `${where}.${k}`);
    }
  };
  for (const [id, r] of resources(t)) walk(r.Properties ?? {}, id);
  return out;
}

export type RolePermissions = {
  statements: Located[];
  awsManaged: string[];
  unknownManaged: string[];
};

function sameRole(ref: any, roleId: string, roleName: string | null): boolean {
  if (refTarget(ref) === roleId) return true;
  const name = resolve(ref);
  return name !== null && roleName !== null && name === roleName;
}

// Everything a role is granted, from every attachment mechanism.
export function rolePermissions(t: Cfn, roleId: string): RolePermissions {
  const role = t.Resources?.[roleId];
  if (!role || role.Type !== 'AWS::IAM::Role') throw new Error(`${roleId} is not a role in the template`);
  const props = role.Properties ?? {};
  const roleName = resolve(props.RoleName);
  const out: RolePermissions = { statements: [], awsManaged: [], unknownManaged: [] };
  const take = (doc: any, where: string) =>
    asArray(doc?.Statement).forEach((s: any, i: number) =>
      out.statements.push({ where: `${where}.Statement[${i}]`, statement: s }),
    );

  asArray(props.Policies).forEach((p: any, i: number) => take(p.PolicyDocument, `${roleId}.Policies[${i}]`));

  for (const [id, r] of resources(t)) {
    const p = r.Properties ?? {};
    if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') {
      if (asArray(p.Roles).some((ref: any) => sameRole(ref, roleId, roleName))) take(p.PolicyDocument, id);
    }
    if (r.Type === 'AWS::IAM::RolePolicy' && sameRole(p.RoleName, roleId, roleName)) take(p.PolicyDocument, id);
  }

  for (const arn of asArray(props.ManagedPolicyArns)) {
    const target = refTarget(arn);
    const targetRes = target ? t.Resources?.[target] : undefined;
    if (targetRes?.Type === 'AWS::IAM::ManagedPolicy') {
      take(targetRes.Properties?.PolicyDocument, target!);
      continue;
    }
    const s = resolve(arn);
    const m = s ? /^arn:aws[a-z-]*:iam::aws:policy\/(.+)$/.exec(s) : null;
    if (m) out.awsManaged.push(m[1]);
    else out.unknownManaged.push(s ?? JSON.stringify(arn));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The app host: EC2 instances, launch templates, and launch configurations,
// and the roles their instance profiles carry.

export type Host = { id: string; profile: any; securityGroups: any[] };

export function hosts(t: Cfn): Host[] {
  const out: Host[] = [];
  for (const [id, r] of resources(t)) {
    const p = r.Properties ?? {};
    if (r.Type === 'AWS::EC2::Instance') {
      out.push({
        id,
        profile: p.IamInstanceProfile,
        securityGroups: [
          ...asArray(p.SecurityGroupIds),
          ...asArray(p.SecurityGroups),
          ...asArray(p.NetworkInterfaces).flatMap((n: any) => asArray(n.GroupSet)),
        ],
      });
    } else if (r.Type === 'AWS::EC2::LaunchTemplate') {
      const d = p.LaunchTemplateData ?? {};
      const prof = d.IamInstanceProfile ?? {};
      out.push({
        id,
        profile: prof.Arn ?? prof.Name,
        securityGroups: [
          ...asArray(d.SecurityGroupIds),
          ...asArray(d.SecurityGroups),
          ...asArray(d.NetworkInterfaces).flatMap((n: any) => asArray(n.Groups)),
        ],
      });
    } else if (r.Type === 'AWS::AutoScaling::LaunchConfiguration') {
      out.push({ id, profile: p.IamInstanceProfile, securityGroups: asArray(p.SecurityGroups) });
    }
  }
  return out;
}

// Role logical IDs attached to a host through its instance profile, or null
// when the profile cannot be traced to roles in this template.
export function hostRoleIds(t: Cfn, host: Host): string[] | null {
  const profileId = refTarget(host.profile);
  const profile = profileId ? t.Resources?.[profileId] : undefined;
  if (!profile || profile.Type !== 'AWS::IAM::InstanceProfile') return null;
  const ids = asArray(profile.Properties?.Roles).map((r: any) => {
    const target = refTarget(r);
    if (target && t.Resources?.[target]?.Type === 'AWS::IAM::Role') return target;
    const name = resolve(r);
    const byName = ofType(t, 'AWS::IAM::Role').find(([, role]) => resolve(role.Properties?.RoleName) === name);
    return byName ? byName[0] : null;
  });
  return ids.length > 0 && ids.every((x) => x !== null) ? (ids as string[]) : null;
}

// ---------------------------------------------------------------------------
// Trust policies and GitHub OIDC.

export function trustStatements(t: Cfn, roleId: string): Statement[] {
  return asArray(t.Resources?.[roleId]?.Properties?.AssumeRolePolicyDocument?.Statement);
}

function isGitHubProviderUrl(url: string | null): boolean {
  return url !== null && url.replace(/\/+$/, '') === `https://${GITHUB_OIDC_HOST}`;
}

// Whether a Federated principal value is GitHub's OIDC provider, whether the
// provider is defined in this template or referenced by ARN.
export function isGitHubProvider(t: Cfn, v: any): boolean {
  const target = refTarget(v);
  if (target) {
    const r = t.Resources?.[target];
    if (!r) return false;
    if (r.Type === 'AWS::IAM::OIDCProvider' || r.Type.startsWith('Custom::')) {
      return isGitHubProviderUrl(resolve(r.Properties?.Url));
    }
    return false;
  }
  const s = resolve(v);
  return s !== null && new RegExp(`^arn:aws[a-z-]*:iam::\\d{12}:oidc-provider/${GITHUB_OIDC_HOST.replace(/\./g, '\\.')}$`).test(s);
}

function principalIsOnlyGitHub(t: Cfn, s: Statement): boolean {
  if (s.NotPrincipal !== undefined) return false;
  const p = s.Principal;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  const keys = Object.keys(p);
  if (keys.length !== 1 || keys[0] !== 'Federated') return false;
  const feds = asArray(p.Federated);
  return feds.length > 0 && feds.every((f: any) => isGitHubProvider(t, f));
}

export function trustsGitHub(t: Cfn, roleId: string): boolean {
  return trustStatements(t, roleId).some((s) => s.Effect === 'Allow' && principalIsOnlyGitHub(t, s));
}

const TRUST_ACTIONS = ['sts:AssumeRoleWithWebIdentity', 'sts:TagSession'];

// Reasons a trust policy lets in anything other than GitHub's OIDC provider.
export function nonGitHubTrust(t: Cfn, roleId: string): string[] {
  const problems: string[] = [];
  trustStatements(t, roleId).forEach((s, i) => {
    if (s.Effect !== 'Allow') return;
    if (!principalIsOnlyGitHub(t, s)) problems.push(`statement ${i} trusts ${JSON.stringify(s.Principal ?? s.NotPrincipal)}`);
    if (s.NotAction !== undefined) problems.push(`statement ${i} uses NotAction`);
    for (const a of actionPatterns(s.Action)) {
      if (!TRUST_ACTIONS.some((ok) => ok.toLowerCase() === a.toLowerCase())) {
        problems.push(`statement ${i} allows ${a}`);
      }
    }
  });
  return problems;
}

export type Claims = Record<string, string>;

export function githubClaims(sub: string, aud = 'sts.amazonaws.com'): Claims {
  return { [`${GITHUB_OIDC_HOST}:sub`]: sub, [`${GITHUB_OIDC_HOST}:aud`]: aud };
}

const STRING_OPS: Record<string, { negate: boolean; match: (pattern: string, value: string) => boolean }> = {
  stringequals: { negate: false, match: (p, v) => p === v },
  stringnotequals: { negate: true, match: (p, v) => p === v },
  stringequalsignorecase: { negate: false, match: (p, v) => p.toLowerCase() === v.toLowerCase() },
  stringnotequalsignorecase: { negate: true, match: (p, v) => p.toLowerCase() === v.toLowerCase() },
  stringlike: { negate: false, match: (p, v) => globMatch(p, v, false) },
  stringnotlike: { negate: true, match: (p, v) => globMatch(p, v, false) },
};

// IAM condition evaluation for single-valued keys. Keys are case-insensitive;
// values within one key are ORed; keys and operators are ANDed. An operator
// this evaluator does not know is unsatisfied, so the check fails closed.
export function conditionHolds(cond: Statement['Condition'], claims: Claims): boolean {
  if (!cond) return true;
  const ctx: Record<string, string> = {};
  for (const [k, v] of Object.entries(claims)) ctx[k.toLowerCase()] = v;
  return Object.entries(cond).every(([rawOp, block]) => {
    let op = rawOp.toLowerCase();
    let setOp: 'any' | 'all' | null = null;
    if (op.startsWith('foranyvalue:')) {
      setOp = 'any';
      op = op.slice('foranyvalue:'.length);
    } else if (op.startsWith('forallvalues:')) {
      setOp = 'all';
      op = op.slice('forallvalues:'.length);
    }
    const ifExists = op.endsWith('ifexists');
    if (ifExists) op = op.slice(0, -'ifexists'.length);
    return Object.entries(block ?? {}).every(([key, rawValues]) => {
      const values = asArray(rawValues).map((x: any) => resolve(x) ?? '\u0000');
      const actual = ctx[key.toLowerCase()];
      if (op === 'null') {
        const wantMissing = values.some((x) => x.toLowerCase() === 'true');
        return wantMissing ? actual === undefined : actual !== undefined;
      }
      const rule = STRING_OPS[op];
      if (!rule) return false;
      if (actual === undefined) {
        if (ifExists || setOp === 'all') return true;
        return rule.negate;
      }
      const hit = values.some((p) => rule.match(p, actual));
      return rule.negate ? !hit : hit;
    });
  });
}

// Whether GitHub's OIDC provider presenting these claims may assume the role.
export function admits(t: Cfn, roleId: string, claims: Claims): boolean {
  const applies = (s: Statement) =>
    principalIsOnlyGitHub(t, s) &&
    (s.NotAction !== undefined || actionPatterns(s.Action).some((p) => globMatch(p, 'sts:AssumeRoleWithWebIdentity'))) &&
    conditionHolds(s.Condition, claims);
  const stmts = trustStatements(t, roleId);
  if (stmts.some((s) => s.Effect === 'Deny' && applies({ ...s, Effect: 'Allow' }))) return false;
  return stmts.some((s) => s.Effect === 'Allow' && applies(s));
}

// ---------------------------------------------------------------------------
// Model access.

export const PROFILE_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
export const MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';
export const PROFILE_ARN = `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/${PROFILE_ID}`;
export const MODEL_ARNS = [
  PROFILE_ARN,
  ...['us-east-1', 'us-east-2', 'us-west-2'].map((r) => `arn:aws:bedrock:${r}::foundation-model/${MODEL_ID}`),
];

// Actions that run a model, directly or on the caller's behalf.
export const INVOKE_ACTIONS = [
  'bedrock:InvokeModel',
  'bedrock:InvokeModelWithResponseStream',
  'bedrock:InvokeModelWithBidirectionalStream',
  'bedrock:Converse',
  'bedrock:ConverseStream',
  'bedrock:CreateModelInvocationJob',
  'bedrock:StartAsyncInvoke',
  'bedrock:InvokeAgent',
  'bedrock:InvokeInlineAgent',
  'bedrock:InvokeFlow',
  'bedrock:RetrieveAndGenerate',
];

export function grantsInvoke(s: Statement): boolean {
  return INVOKE_ACTIONS.some((a) => grants(s, a));
}

// Why a statement's model-invocation grant reaches beyond the one configured
// model, or [] when it does not.
export function modelScopeProblems(loc: Located): string[] {
  const s = loc.statement;
  if (s.Effect !== 'Allow') return [];
  const problems: string[] = [];
  if (grantsWildcardOf(s, 'bedrock')) {
    problems.push(`${loc.where}: wildcard model service action ${JSON.stringify(s.Action ?? { NotAction: s.NotAction })}`);
  }
  if (!grantsInvoke(s)) return problems;
  if (s.NotResource !== undefined) problems.push(`${loc.where}: model invocation through NotResource`);
  const res = asArray(s.Resource);
  if (res.length === 0) problems.push(`${loc.where}: model invocation with no Resource`);
  for (const r of res) {
    const arn = resolve(r);
    if (arn === null) problems.push(`${loc.where}: model invocation on unresolvable resource ${JSON.stringify(r)}`);
    else if (!MODEL_ARNS.includes(arn)) problems.push(`${loc.where}: model invocation on ${arn}`);
  }
  return problems;
}

// AWS managed policies that grant model invocation on every model.
export function managedPolicyGrantsModelBroadly(name: string): boolean {
  return /(^|\/)(AdministratorAccess|PowerUserAccess)$/.test(name) || (/Bedrock/i.test(name) && !/ReadOnly/i.test(name));
}

// Whether any statement grants bedrock:InvokeModel on the inference profile.
export function invokesConfiguredModel(statements: Located[]): boolean {
  return statements.some(
    ({ statement: s }) =>
      grants(s, 'bedrock:InvokeModel') && asArray(s.Resource).some((r: any) => resolve(r) === PROFILE_ARN),
  );
}

// ---------------------------------------------------------------------------
// IAM write access to identities.

export const IAM_WRITE_ACTIONS = [
  'iam:CreateRole',
  'iam:DeleteRole',
  'iam:UpdateRole',
  'iam:UpdateAssumeRolePolicy',
  'iam:PutRolePolicy',
  'iam:DeleteRolePolicy',
  'iam:AttachRolePolicy',
  'iam:DetachRolePolicy',
  'iam:PutRolePermissionsBoundary',
  'iam:CreateServiceLinkedRole',
  'iam:CreatePolicy',
  'iam:CreatePolicyVersion',
  'iam:DeletePolicy',
  'iam:DeletePolicyVersion',
  'iam:SetDefaultPolicyVersion',
  'iam:CreateUser',
  'iam:DeleteUser',
  'iam:UpdateUser',
  'iam:PutUserPolicy',
  'iam:AttachUserPolicy',
  'iam:CreateLoginProfile',
  'iam:AddUserToGroup',
  'iam:PutGroupPolicy',
  'iam:AttachGroupPolicy',
  'iam:CreateAccessKey',
  'iam:UpdateAccessKey',
  'iam:DeleteAccessKey',
];

// AWS managed policies that include IAM writes (FullAccess policies commonly
// carry iam:CreateServiceLinkedRole).
export function managedPolicyWritesIam(name: string): boolean {
  return /Administrator|PowerUser|FullAccess|(^|\/)IAM(?!ReadOnly)/i.test(name);
}

// ---------------------------------------------------------------------------
// Credentials written as text.

const CREDENTIAL_NAMES = [
  'awsaccesskeyid',
  'awssecretaccesskey',
  'secretaccesskey',
  'awsbearertokenbedrock',
  'anthropicapikey',
  'claudeapikey',
];

// Names or values of long-lived credentials found in a block of text.
export function credentialHits(text: string): string[] {
  const squashed = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hits = CREDENTIAL_NAMES.filter((n) => squashed.includes(n));
  if (/\b(AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)) hits.push('an access key ID');
  if (/sk-ant-[A-Za-z0-9_-]{8,200}/.test(text)) hits.push('an Anthropic API key');
  return hits;
}
