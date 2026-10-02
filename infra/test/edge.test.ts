// What the internet can reach: inbound rules on every security group in the
// stack, the app host's own groups, the CDN's protocol policy, and the
// security headers the CDN adds to every response.

import { describe, expect, test } from 'vitest';
import { type Cfn, asArray, hosts, ofType, refTarget, resolve, resources } from './support/cfn';
import { stackTemplate } from './support/stack';

type Ingress = { where: string; group: string | null; rule: Record<string, any> };

// Inbound rules from both mechanisms: inline on a security group, and
// standalone AWS::EC2::SecurityGroupIngress resources.
function ingressRules(t: Cfn): Ingress[] {
  const out: Ingress[] = [];
  for (const [id, r] of resources(t)) {
    if (r.Type === 'AWS::EC2::SecurityGroup') {
      asArray(r.Properties?.SecurityGroupIngress).forEach((rule: any, i: number) =>
        out.push({ where: `${id}.SecurityGroupIngress[${i}]`, group: id, rule }),
      );
    } else if (r.Type === 'AWS::EC2::SecurityGroupIngress') {
      out.push({ where: id, group: refTarget(r.Properties?.GroupId), rule: r.Properties ?? {} });
    }
  }
  return out;
}

function isOpenRange(cidr: unknown): boolean {
  if (cidr === undefined) return false;
  const s = resolve(cidr);
  return s === null || /\/0$/.test(s.trim());
}

// Whether a rule admits traffic on a TCP or UDP port. Protocol -1 is every
// protocol on every port; ICMP rules have no ports.
function opensPort(rule: Record<string, any>, port: number): boolean {
  const proto = String(rule.IpProtocol ?? '').toLowerCase();
  if (proto === '-1' || proto === 'all') return true;
  if (!['tcp', 'udp', '6', '17'].includes(proto)) return false;
  const from = Number(rule.FromPort ?? -1);
  const to = Number(rule.ToPort ?? rule.FromPort ?? -1);
  if (from === -1 && to === -1) return true;
  return from <= port && port <= to;
}

function distributions(t: Cfn) {
  const found = ofType(t, 'AWS::CloudFront::Distribution');
  expect(found.length, 'the stack defines no CloudFront distribution').toBeGreaterThan(0);
  return found;
}

function behaviors(dist: any): { where: string; behavior: any }[] {
  const config = dist.Properties?.DistributionConfig ?? {};
  return [
    { where: 'DefaultCacheBehavior', behavior: config.DefaultCacheBehavior ?? {} },
    ...asArray(config.CacheBehaviors).map((b: any, i: number) => ({ where: `CacheBehaviors[${i}]`, behavior: b })),
  ];
}

type HeaderSet = Map<string, string>;

// The headers a response headers policy adds, from its security headers and
// its custom headers, keyed by lowercase name.
function policyHeaders(policy: any): HeaderSet {
  const config = policy.Properties?.ResponseHeadersPolicyConfig ?? {};
  const sec = config.SecurityHeadersConfig ?? {};
  const out: HeaderSet = new Map();
  if (sec.StrictTransportSecurity) {
    out.set('strict-transport-security', `max-age=${sec.StrictTransportSecurity.AccessControlMaxAgeSec}`);
  }
  if (sec.ContentTypeOptions) out.set('x-content-type-options', 'nosniff');
  if (sec.ReferrerPolicy?.ReferrerPolicy) out.set('referrer-policy', String(sec.ReferrerPolicy.ReferrerPolicy));
  if (sec.ContentSecurityPolicy?.ContentSecurityPolicy) {
    out.set('content-security-policy', String(sec.ContentSecurityPolicy.ContentSecurityPolicy));
  }
  for (const item of asArray(config.CustomHeadersConfig?.Items)) {
    const name = String((item as any).Header ?? '').toLowerCase();
    if (!out.has(name)) out.set(name, String((item as any).Value ?? ''));
  }
  return out;
}

// The headers every behavior of every distribution adds. A behavior without
// a policy defined in the stack contributes an error instead.
async function headersPerBehavior(): Promise<{ where: string; headers: HeaderSet | string }[]> {
  const t = await stackTemplate();
  const out: { where: string; headers: HeaderSet | string }[] = [];
  for (const [id, dist] of distributions(t)) {
    for (const { where, behavior } of behaviors(dist)) {
      const ref = behavior.ResponseHeadersPolicyId;
      const target = refTarget(ref);
      const policy = target ? t.Resources?.[target] : undefined;
      if (!policy || policy.Type !== 'AWS::CloudFront::ResponseHeadersPolicy') {
        out.push({
          where: `${id}.${where}`,
          headers: ref
            ? `uses response headers policy ${JSON.stringify(ref)}, which is not defined in the stack and so cannot be checked`
            : 'has no response headers policy',
        });
      } else {
        out.push({ where: `${id}.${where}`, headers: policyHeaders(policy) });
      }
    }
  }
  return out;
}

async function headerProblems(check: (h: HeaderSet) => string | null): Promise<string[]> {
  const problems: string[] = [];
  for (const { where, headers } of await headersPerBehavior()) {
    if (typeof headers === 'string') problems.push(`${where} ${headers}`);
    else {
      const why = check(headers);
      if (why) problems.push(`${where}: ${why}`);
    }
  }
  return problems;
}

function cspDirectives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/).filter(Boolean);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), values);
  }
  return out;
}

// A script source list that admits only the app's own origin: 'self', or
// nothing, optionally narrowed further by nonces or hashes.
function scriptSourcesProblem(values: string[]): string | null {
  const ok = (v: string) =>
    /^'(self|none|report-sample)'$/i.test(v) || /^'nonce-[^']+'$/i.test(v) || /^'sha(256|384|512)-[^']+'$/i.test(v);
  const bad = values.filter((v) => !ok(v));
  if (values.length === 0) return 'an empty source list';
  return bad.length > 0 ? `sources beyond the app's own origin: ${bad.join(' ')}` : null;
}

describe('host network', () => {
  test('host network: no inbound rule anywhere in the stack admits an internet-wide address range', async () => {
    const t = await stackTemplate();
    expect(hosts(t).length, 'the stack defines no app host').toBeGreaterThan(0);
    const open = ingressRules(t)
      .filter(({ rule }) => isOpenRange(rule.CidrIp) || isOpenRange(rule.CidrIpv6))
      .map(({ where, rule }) => `${where}: ${resolve(rule.CidrIp ?? rule.CidrIpv6) ?? 'unresolvable range'}`);
    expect(open).toEqual([]);
  });

  test('host network: no inbound rule opens port 22 or the database port 5432', async () => {
    const t = await stackTemplate();
    expect(hosts(t).length, 'the stack defines no app host').toBeGreaterThan(0);
    const opened = ingressRules(t)
      .filter(({ rule }) => opensPort(rule, 22) || opensPort(rule, 5432))
      .map(({ where, rule }) => `${where}: ${rule.IpProtocol} ${rule.FromPort}-${rule.ToPort}`);
    expect(opened).toEqual([]);
  });

  test('host network: the host admits traffic only from a named source, never an address range', async () => {
    const t = await stackTemplate();
    const found = hosts(t);
    expect(found.length, 'the stack defines no app host').toBeGreaterThan(0);
    const problems: string[] = [];
    for (const h of found) {
      const groups = h.securityGroups.map(refTarget);
      if (groups.length === 0 || groups.some((g) => g === null)) {
        problems.push(`${h.id}: security groups not defined in the stack`);
        continue;
      }
      for (const { where, rule } of ingressRules(t).filter((r) => groups.includes(r.group))) {
        if (rule.CidrIp !== undefined || rule.CidrIpv6 !== undefined) problems.push(`${where}: admits an address range`);
        else if (rule.SourcePrefixListId === undefined && rule.SourceSecurityGroupId === undefined) {
          problems.push(`${where}: no source prefix list or security group`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('host network: no managed database in the stack is publicly accessible', async () => {
    const t = await stackTemplate();
    expect(hosts(t).length, 'the stack defines no app host').toBeGreaterThan(0);
    const exposed = ofType(t, 'AWS::RDS::DBInstance', 'AWS::RDS::DBCluster')
      .filter(([, r]) => r.Properties?.PubliclyAccessible === true || r.Properties?.PubliclyAccessible === 'true')
      .map(([id]) => id);
    expect(exposed).toEqual([]);
  });
});

describe('cdn https', () => {
  test('cdn https: every cache behavior redirects plain HTTP to HTTPS', async () => {
    const t = await stackTemplate();
    const problems = distributions(t).flatMap(([id, dist]) =>
      behaviors(dist)
        .filter(({ behavior }) => behavior.ViewerProtocolPolicy !== 'redirect-to-https')
        .map(({ where, behavior }) => `${id}.${where}: ${behavior.ViewerProtocolPolicy ?? 'allow-all (default)'}`),
    );
    expect(problems).toEqual([]);
  });
});

describe('cdn headers', () => {
  test('cdn headers: every response carries HSTS with a positive max-age', async () => {
    const problems = await headerProblems((h) => {
      const v = h.get('strict-transport-security');
      const m = v ? /max-age=(\d+)/i.exec(v) : null;
      return m && Number(m[1]) > 0 ? null : `Strict-Transport-Security is ${JSON.stringify(v ?? null)}`;
    });
    expect(problems).toEqual([]);
  });

  test('cdn headers: every response carries X-Content-Type-Options: nosniff', async () => {
    const problems = await headerProblems((h) =>
      h.get('x-content-type-options')?.trim().toLowerCase() === 'nosniff'
        ? null
        : `X-Content-Type-Options is ${JSON.stringify(h.get('x-content-type-options') ?? null)}`,
    );
    expect(problems).toEqual([]);
  });

  test('cdn headers: every response carries a Referrer-Policy', async () => {
    const problems = await headerProblems((h) =>
      (h.get('referrer-policy') ?? '').trim() !== '' ? null : 'no Referrer-Policy',
    );
    expect(problems).toEqual([]);
  });

  test("cdn headers: the Content-Security-Policy sets frame-ancestors 'none'", async () => {
    const problems = await headerProblems((h) => {
      const csp = h.get('content-security-policy');
      if (!csp) return 'no Content-Security-Policy';
      const fa = cspDirectives(csp).get('frame-ancestors');
      return fa && fa.length === 1 && fa[0].toLowerCase() === "'none'"
        ? null
        : `frame-ancestors is ${JSON.stringify(fa ?? null)}`;
    });
    expect(problems).toEqual([]);
  });

  test("cdn headers: the Content-Security-Policy limits scripts to the app's own origin", async () => {
    const problems = await headerProblems((h) => {
      const csp = h.get('content-security-policy');
      if (!csp) return 'no Content-Security-Policy';
      const d = cspDirectives(csp);
      const scripts = d.get('script-src') ?? d.get('default-src');
      if (!scripts) return 'neither script-src nor default-src is set, so scripts are unrestricted';
      const why = [scripts, d.get('script-src-elem'), d.get('script-src-attr')]
        .filter((v): v is string[] => v !== undefined)
        .map(scriptSourcesProblem)
        .find((p) => p !== null);
      return why ? `scripts: ${why}` : null;
    });
    expect(problems).toEqual([]);
  });
});
