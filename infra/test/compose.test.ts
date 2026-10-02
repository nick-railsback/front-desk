// The production container definition: no long-lived credential reaches a
// container, and the database port is never published beyond the host.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { credentialHits } from './support/cfn';
import { INFRA, ROOT, readRepoFile } from './support/stack';
import {
  type Entry,
  entries,
  hashCommentsRemoved,
  listValues,
  mapEntries,
  topLevelEntry,
  unquote,
  yamlLines,
  yamlWithoutComments,
} from './support/yaml';

const COMPOSE = 'infra/compose.prod.yml';
const DB_PORT = 5432;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

type Service = { name: string; fields: Record<string, Entry>; text: string };

function services(text: string): Service[] {
  const top = topLevelEntry(text, 'services');
  if (!top) throw new Error(`${COMPOSE} defines no services`);
  return (mapEntries(top.body) as Entry[]).map((e) => ({
    name: e.key,
    fields: entries(e.body),
    text: e.body.map((l) => l.text).join('\n'),
  }));
}

function isDatabase(s: Service): boolean {
  const image = unquote(s.fields.image?.value ?? '');
  return /postgres|postgis|pgvector|timescale/i.test(image);
}

type Range = [number, number];
type Mapping = { raw: string; hostIp: string | null; host: Range | null; container: Range | null };

function range(s: string | undefined): Range | null {
  if (s === undefined || s.trim() === '') return null;
  const [a, b] = s.trim().split('-').map(Number);
  return [a, b ?? a];
}

// One `ports:` entry, in short syntax (`5432`, `5432:5432`,
// `0.0.0.0:5432:5432`, `[::1]:5432:5432`, `5430-5440:5430-5440/tcp`) or long
// syntax (`target`, `published`, `host_ip`).
function parsePort(item: string | Record<string, string>): Mapping {
  if (typeof item !== 'string') {
    return {
      raw: JSON.stringify(item),
      hostIp: item.host_ip ? unquote(item.host_ip) : null,
      host: range(item.published === undefined ? undefined : unquote(String(item.published))),
      container: range(item.target === undefined ? undefined : unquote(String(item.target))),
    };
  }
  const raw = unquote(item).replace(/\/(tcp|udp|sctp)$/i, '');
  let hostIp: string | null = null;
  let rest = raw;
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    hostIp = raw.slice(1, close);
    rest = raw.slice(close + 2);
  }
  const parts = rest.split(':');
  if (parts.length === 1) return { raw, hostIp, host: null, container: range(parts[0]) };
  if (parts.length === 2) return { raw, hostIp, host: range(parts[0]), container: range(parts[1]) };
  return {
    raw,
    hostIp: parts.slice(0, -2).join(':'),
    host: range(parts[parts.length - 2]),
    container: range(parts[parts.length - 1]),
  };
}

const covers = (r: Range | null, port: number) => r !== null && r[0] <= port && port <= r[1];

// A mapping with no host address, or a non-loopback one, listens on every
// interface of the host.
const beyondHost = (m: Mapping) => m.hostIp === null || !LOOPBACK.has(m.hostIp.replace(/^\[|\]$/g, ''));

function exposureProblems(s: Service): string[] {
  const problems: string[] = [];
  const ports = s.fields.ports;
  if (ports && /^[*&]/.test(ports.value)) problems.push(`${s.name}: ports come from a YAML alias, which this check cannot follow`);
  if (Object.keys(s.fields).includes('<<')) problems.push(`${s.name}: merges keys from a YAML anchor, which this check cannot follow`);
  for (const m of listValues(ports).map(parsePort)) {
    if (!beyondHost(m)) continue;
    if (covers(m.host, DB_PORT) || covers(m.container, DB_PORT)) problems.push(`${s.name}: publishes ${m.raw}`);
    else if (isDatabase(s)) problems.push(`${s.name}: the database publishes ${m.raw}`);
  }
  if (isDatabase(s) && /^["']?host["']?$/.test(s.fields.network_mode?.value ?? '')) {
    problems.push(`${s.name}: the database shares the host network, so its port listens on every interface`);
  }
  return problems;
}

describe('database exposure', () => {
  test('database exposure: the production container definition runs a database', () => {
    const list = services(readRepoFile(COMPOSE));
    expect(list.filter(isDatabase).map((s) => s.name).length, 'no service runs a Postgres image').toBeGreaterThan(0);
  });

  test('database exposure: no container publishes the database port beyond the host', () => {
    const list = services(readRepoFile(COMPOSE));
    expect(list.filter(isDatabase).length, 'no service runs a Postgres image').toBeGreaterThan(0);
    expect(list.flatMap(exposureProblems)).toEqual([]);
  });
});

describe('container credentials', () => {
  test('container credentials: no environment entry, env file, or secret sets an access key or model provider API key', () => {
    const text = readRepoFile(COMPOSE);
    const problems = credentialHits(yamlWithoutComments(text)).map((h) => `${COMPOSE}: ${h}`);
    // Env files the definition points at, when they are part of the repository.
    for (const s of services(text)) {
      for (const f of listValues(s.fields.env_file)) {
        const rel = typeof f === 'string' ? f : (f.path ?? '');
        const file = path.resolve(INFRA, rel);
        if (rel && fs.existsSync(file)) {
          credentialHits(hashCommentsRemoved(fs.readFileSync(file, 'utf8'))).forEach((h) => problems.push(`${s.name} env_file ${rel}: ${h}`));
        }
      }
    }
    const dockerfile = path.join(ROOT, 'app', 'Dockerfile');
    if (fs.existsSync(dockerfile)) {
      credentialHits(hashCommentsRemoved(fs.readFileSync(dockerfile, 'utf8'))).forEach((h) => problems.push(`app/Dockerfile: ${h}`));
    }
    expect(problems).toEqual([]);
  });

  test('container credentials: no container mounts a cloud credentials directory', () => {
    const text = readRepoFile(COMPOSE);
    const mounts = yamlLines(text)
      .map((l: { text: string }) => l.text)
      .filter((line: string) => /(^|[\s"'=:~/])\.aws(\/|["'\s:]|$)/.test(line));
    expect(mounts).toEqual([]);
  });
});
