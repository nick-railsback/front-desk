// Shared helpers for the repository tests. Not a test file: the runner only
// collects files named *.test.mjs, and this module is imported by them.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repository root, anchored on this file rather than the working
// directory, so the tests behave the same whether they are started from the
// root, from a workspace package, or by a script runner.
export const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export function rootPath(...parts) {
  return path.join(ROOT, ...parts);
}

export function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function makeTempDir(label) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `front-desk-${label}-`)));
}

// An environment for child processes that cannot be steered by the caller's
// git, npm, pnpm, or lefthook settings. Script runners export npm_* and
// pnpm_* variables, git hooks export GIT_DIR and friends, and LEFTHOOK=0
// disables hooks; any of these would make a child observe something other
// than the repository's own configuration.
export function isolatedEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(git_|npm_|pnpm_|lefthook|init_cwd$)/i.test(key) && key !== 'PNPM_HOME') continue;
    env[key] = value;
  }
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
  return { ...env, ...extra };
}

// Git configuration isolated from the user's global and system files, so a
// global core.hooksPath, commit signing, or template directory cannot change
// what a fixture repository does.
export function isolatedGitEnv(dir, extra = {}) {
  const globalConfig = path.join(dir, 'isolated.gitconfig');
  if (!fs.existsSync(globalConfig)) fs.writeFileSync(globalConfig, '');
  return isolatedEnv({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', ...extra });
}

export function run(cmd, args, { cwd = ROOT, env = isolatedEnv(), timeout = 120_000, input } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env,
    input,
    timeout,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error(`${cmd} is not on PATH`);
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

export function tail(text, lines = 25) {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

// ---------------------------------------------------------------------------
// YAML reading. No YAML parser is available without dependencies, so these
// helpers read the indentation structure of a workflow file: block mappings,
// block sequences, flow collections, quoted or unquoted keys, and comments.

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      if (i === 0 || /[\s:[{,-]/.test(line[i - 1])) quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

// Non-blank lines with comments removed, each with its indentation.
export function yamlLines(text) {
  const out = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(---|\.\.\.)\s*$/.test(raw)) continue;
    const line = stripComment(raw).replace(/\s+$/, '');
    if (line.trim() === '') continue;
    out.push({ indent: line.length - line.trimStart().length, text: line.trim() });
  }
  return out;
}

export function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

const KEY_LINE = /^("[^"]*"|'[^']*'|[^\s"'#:][^:]*?)\s*:(?:\s+(.*))?$/;

// Entries of a block mapping whose lines are `lines` (already sliced to one
// level): [{ key, value, body }], where value is the inline text after the
// colon and body is the nested lines.
export function mapEntries(lines) {
  if (lines.length === 0) return [];
  const indent = Math.min(...lines.map((l) => l.indent));
  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.indent !== indent) continue;
    const m = KEY_LINE.exec(line.text);
    if (!m || line.text.startsWith('- ')) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && lines[j].indent > indent; j += 1) body.push(lines[j]);
    entries.push({ key: unquote(m[1]), value: (m[2] ?? '').trim(), body });
  }
  return entries;
}

// Scalar items of a block sequence: `- push`, `- "pull_request"`.
export function seqScalars(lines) {
  if (lines.length === 0) return [];
  const indent = Math.min(...lines.map((l) => l.indent));
  return lines
    .filter((l) => l.indent === indent && /^-(\s|$)/.test(l.text))
    .map((l) => unquote(l.text.replace(/^-\s*/, '')));
}

function splitTopLevel(inner) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

// A flow collection as plain data: `[a, b]` to an array, `{a: b}` to an
// object; anything else is returned as an unquoted scalar string.
export function parseFlow(value) {
  const v = value.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    return splitTopLevel(v.slice(1, -1)).map(parseFlow);
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const obj = {};
    for (const part of splitTopLevel(v.slice(1, -1))) {
      const m = /^("[^"]*"|'[^']*'|[^:]+?)\s*(?::(?:\s+(.*))?)?$/.exec(part);
      obj[unquote(m[1])] = m[2] === undefined ? null : parseFlow(m[2]);
    }
    return obj;
  }
  return unquote(v);
}

// A key's value as plain data: inline flow or scalar, or a nested block
// mapping or sequence. Nested blocks are read one level deep, which is all
// the workflow checks need.
export function entryValue(entry) {
  if (entry.value !== '' && !/^[|>]/.test(entry.value)) return parseFlow(entry.value);
  if (entry.body.length === 0) return null;
  const indent = Math.min(...entry.body.map((l) => l.indent));
  if (entry.body.some((l) => l.indent === indent && /^-(\s|$)/.test(l.text))) {
    return seqScalars(entry.body);
  }
  const obj = {};
  for (const child of mapEntries(entry.body)) obj[child.key] = child;
  return obj;
}

export function topLevel(text) {
  return mapEntries(yamlLines(text));
}

export function topLevelEntry(text, key) {
  return topLevel(text).find((e) => e.key === key) ?? null;
}

// ---------------------------------------------------------------------------
// Workflows.

export function workflowFiles() {
  const dir = rootPath('.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => ({ name: `.github/workflows/${f}`, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

// Every action or reusable workflow a workflow references through a `uses:`
// key, in step position or at job level, in block or flow style.
export function usesRefs(text) {
  const refs = [];
  const re = /(?:^|[\s{,])["']?uses["']?\s*:\s*("[^"]*"|'[^']*'|[^\s,}]+)/g;
  for (const line of yamlLines(text)) {
    for (const m of line.text.matchAll(re)) refs.push(unquote(m[1]));
  }
  return refs;
}

export function isRemoteRef(ref) {
  return !ref.startsWith('./') && !ref.startsWith('docker://');
}

export function isPinnedToFullSha(ref) {
  return /^[^@\s]+@[0-9a-fA-F]{40}$/.test(ref);
}

// The `on:` triggers of a workflow as { eventName: filterKeys[] }.
export function workflowTriggers(text) {
  const entry = topLevel(text).find((e) => e.key === 'on' || e.key === 'true');
  if (!entry) return null;
  const value = entryValue(entry);
  const triggers = {};
  if (typeof value === 'string') {
    triggers[value] = [];
  } else if (Array.isArray(value)) {
    for (const name of value) triggers[String(name)] = [];
  } else if (value && typeof value === 'object') {
    for (const [name, child] of Object.entries(value)) {
      let filters = [];
      if (child && typeof child === 'object' && 'body' in child) {
        const inner = entryValue(child);
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) filters = Object.keys(inner);
      } else if (child && typeof child === 'object' && !Array.isArray(child)) {
        filters = Object.keys(child);
      }
      triggers[name] = filters;
    }
  }
  return triggers;
}

// Jobs of a workflow as [{ id, lines, text }].
export function workflowJobs(text) {
  const jobs = topLevelEntry(text, 'jobs');
  if (!jobs) return [];
  return mapEntries(jobs.body).map((job) => ({
    id: job.key,
    lines: job.body,
    text: job.body.map((l) => l.text).join('\n'),
  }));
}

// ---------------------------------------------------------------------------
// Claude Code permission rules.

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

// Whether a file rule specifier covers a path relative to the project root.
// `./x` and `x` are relative to the project directory, `/x` is relative to
// the directory holding the settings file (also the project root here), and
// a pattern with no slash matches at any depth, as in gitignore.
export function pathRuleMatches(specifier, relPath) {
  let pattern = specifier.trim();
  if (pattern.startsWith('//') || pattern.startsWith('~')) return false;
  if (pattern.startsWith('./')) pattern = pattern.slice(2);
  else if (pattern.startsWith('/')) pattern = pattern.slice(1);
  if (pattern.endsWith('/')) pattern += '**';
  let source = globToRegExp(pattern);
  if (!pattern.replace(/\/\*\*$/, '').includes('/')) source = `(?:.*/)?${source}`;
  return new RegExp(`^${source}(?:/.*)?$`).test(relPath);
}

// Whether a Bash rule specifier covers a command line. `prefix:*` is a
// prefix match on a word boundary, and so is a trailing ` *`, which Claude
// Code treats as the same rule; `*` elsewhere matches any characters.
export function bashRuleMatches(specifier, command) {
  let pattern = specifier.trim();
  let source;
  if (pattern.endsWith(':*') || pattern.endsWith(' *')) {
    pattern = pattern.slice(0, -2).trimEnd();
    source = `${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}(?:\\s.*)?`;
  } else {
    source = pattern
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
  }
  return new RegExp(`^${source}$`).test(command.trim());
}

export function parseRule(rule) {
  const m = /^\s*([A-Za-z]+)\s*(?:\((.*)\))?\s*$/.exec(rule);
  if (!m) return null;
  return { tool: m[1], specifier: m[2] ?? null };
}

// Whether any rule in `rules` denies `tool` acting on `target`. `tools` lists
// the rule tool names Claude Code applies to that action.
export function denies(rules, tools, target, matcher) {
  return rules.some((rule) => {
    const parsed = parseRule(rule);
    if (!parsed || !tools.includes(parsed.tool)) return false;
    if (parsed.specifier === null || parsed.specifier.trim() === '' || parsed.specifier.trim() === '*') return true;
    return matcher(parsed.specifier, target);
  });
}
