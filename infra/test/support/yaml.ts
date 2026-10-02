// Reading the production compose file and the deploy workflow without a YAML
// library, on top of the indentation helpers the repository tests already
// use. Not a test file.

import {
  mapEntries,
  parseFlow,
  topLevel,
  topLevelEntry,
  unquote,
  workflowJobs,
  yamlLines,
} from '../../../tests/repo/support/repo.mjs';

export type Line = { indent: number; text: string };
export type Entry = { key: string; value: string; body: Line[] };

export { mapEntries, parseFlow as parseFlowValue, topLevel, topLevelEntry, unquote, workflowJobs, yamlLines };

// Items of a block sequence, each as its first line (after `- `) and the
// lines nested under it.
export function seqItems(lines: Line[]): { head: string; body: Line[]; indent: number }[] {
  if (lines.length === 0) return [];
  const indent = Math.min(...lines.map((l) => l.indent));
  const items: { head: string; body: Line[]; indent: number }[] = [];
  for (const line of lines) {
    if (line.indent === indent && /^-(\s|$)/.test(line.text)) {
      const head = line.text.replace(/^-\s*/, '');
      items.push({ head, body: [], indent: indent + 2 });
    } else if (items.length > 0) {
      items[items.length - 1].body.push(line);
    }
  }
  return items;
}

// A sequence item that is a mapping (`- target: 5432` followed by more keys)
// as { key: scalar }.
export function itemMap(item: { head: string; body: Line[]; indent: number }): Record<string, string> {
  const lines: Line[] = [{ indent: item.indent, text: item.head }, ...item.body];
  const out: Record<string, string> = {};
  for (const e of mapEntries(lines) as Entry[]) out[e.key] = unquote(e.value);
  return out;
}

export function entries(lines: Line[]): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  for (const e of mapEntries(lines) as Entry[]) out[e.key] = e;
  return out;
}

// A field's raw values as a list: a flow sequence, a block sequence of
// scalars or mappings, or a single scalar.
export function listValues(entry: Entry | undefined): (string | Record<string, string>)[] {
  if (!entry) return [];
  if (entry.value !== '') {
    const v = parseFlow(entry.value);
    return Array.isArray(v) ? v : [v];
  }
  return seqItems(entry.body).map((item) =>
    /^("[^"]*"|'[^']*'|[^\s"'#:][^:]*?)\s*:(\s|$)/.test(item.head) && !/^["']?[\d.[\]:]+/.test(item.head)
      ? itemMap(item)
      : unquote(item.head),
  );
}

// YAML text without comments, so prose like "never AWS_ACCESS_KEY_ID" in a
// comment is not mistaken for a setting.
export function yamlWithoutComments(text: string): string {
  return (yamlLines(text) as Line[]).map((l) => l.text).join('\n');
}

// Dockerfile or env-file text without `#` comment lines.
export function hashCommentsRemoved(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

export function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
