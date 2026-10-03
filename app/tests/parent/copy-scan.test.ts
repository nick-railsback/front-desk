// One home for user-facing strings.
//
// copy module: no user-facing string is written outside
// app/src/core/copy.ts. Scanned: every file under app/src/app/ and every .tsx
// file under app/src/ (the components the parent view renders), except
// copy.ts itself. A finding is JSX text with a letter in it, a JSX child that
// is a string literal (alone, or as a branch of ?: && || ??), a string
// literal in aria-label, placeholder, title or alt, and a literal page
// metadata title. Whitespace is collapsed first, so text wrapped across
// lines is still found.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(APP, 'src');
const COPY = path.join(SRC, 'core', 'copy.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function scannedFiles(): string[] {
  return walk(SRC)
    .filter((f) => f !== COPY)
    .filter((f) => (f.startsWith(path.join(SRC, 'app') + path.sep) && /\.(tsx?|jsx?|mjs)$/.test(f)) || /\.(tsx|jsx)$/.test(f))
    .sort();
}

// Source with comments removed and whitespace collapsed. Strings and template
// literals are kept as written.
function flatten(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      out += ' ';
    } else if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/\s+/g, ' ');
}

const LETTER = /[A-Za-z]/;
const ATTRS = ['aria-label', 'placeholder', 'title', 'alt'];
const STRING = String.raw`(?:"[^"]*"|'[^']*'|\x60[^\x60]*\x60)`;

// A template literal's text outside its ${...} parts.
function literalText(literal: string): string {
  return literal.slice(1, -1).replace(/\$\{[^}]*\}/g, '');
}

function findings(source: string): string[] {
  const flat = flatten(source);
  const found: string[] = [];

  // JSX text: what follows the end of an opening or closing tag, up to the
  // next tag or expression. A tag starts after a JSX position, never after an
  // identifier (a generic such as useState<string>).
  const tag = /(?:^|[(\s,=?:{}>&|[]|return)\s*<(\/?)(?:([A-Za-z][\w.:-]*)|(?=>))((?:[^<>{}"'`]|\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|'[^']*'|`[^`]*`)*?)(\/?)>/g;
  for (const m of flat.matchAll(tag)) {
    const end = m.index! + m[0].length;
    // User-facing attributes with a literal value.
    for (const attr of ATTRS) {
      const re = new RegExp(String.raw`(?:^|\s)${attr}\s*=\s*(?:(${STRING})|\{\s*(${STRING})\s*\})`, 'g');
      for (const a of (m[3] ?? '').matchAll(re)) {
        const lit = a[1] ?? a[2];
        if (LETTER.test(literalText(lit))) found.push(`${attr}=${lit.slice(0, 60)}`);
      }
    }
    if (m[4] === '/') continue;
    const rest = flat.slice(end);
    const text = rest.slice(0, rest.search(/[<{]|$/));
    if (LETTER.test(text.replace(/&(?:[a-z]+|#\w+);/gi, '')) && !/^\s*[)};,:?|&]/.test(text) && !/\b(?:const|return|function|=>)\b/.test(text)) found.push(`JSX text "${text.trim().slice(0, 60)}"`);
    // A child expression that is, or branches to, a string literal.
    const child = /^\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(rest.slice(text.length));
    if (child) {
      // Only top-level literals: a className ternary or an options object
      // inside a nested expression is not text.
      const expr = child[1].replace(/\{[^{}]*\}/g, '{}');
      const alone = new RegExp(String.raw`^\s*(${STRING})\s*$`).exec(expr);
      const branches = [...expr.matchAll(new RegExp(String.raw`(?:\?|:|&&|\|\||\?\?)\s*(${STRING})`, 'g'))].map((b) => b[1]);
      for (const lit of [alone?.[1], ...branches].filter(Boolean) as string[]) {
        if (LETTER.test(literalText(lit))) found.push(`JSX child ${lit.slice(0, 60)}`);
      }
    }
  }

  // The page metadata title.
  for (const m of flat.matchAll(new RegExp(String.raw`\btitle\s*:\s*(${STRING})`, 'g'))) {
    if (LETTER.test(literalText(m[1]))) found.push(`metadata title ${m[1].slice(0, 60)}`);
  }
  return found;
}

describe('copy module', () => {
  test('no user-facing string is written outside app/src/core/copy.ts', () => {
    // The scanner itself: it passes text from the copy module and flags inline text.
    const clean = `
      import { COPY } from '../core/copy';
      export const metadata = { title: COPY.title };
      export default function Card({ open }: { open: boolean }) {
        const [n, setN] = useState<number>(0);
        return (
          <section aria-label={COPY.today} className="card">
            {open ? COPY.open : COPY.closed}
            <input placeholder={COPY.ask} type="text" />
            <img alt={COPY.logo} src="/logo.png" />{' '}
            {items.map((i) => <li key={i.id} className={i.on ? 'on' : 'off'}>{i.label}</li>)}
            <span>{COPY.a}</span>&nbsp;&middot;&nbsp;<span>{fmt(d, { weekday: 'long' })}</span>
          </section>
        );
      }`;
    expect(findings(clean), 'the scanner flags a component that takes its strings from copy.ts').toEqual([]);
    const inline = `
      export const metadata = { title: 'Front Desk' };
      export default function Card({ open }: { open: boolean }) {
        return (
          <section aria-label="Today at the center">
            <h2>
              Today at
              the center
            </h2>
            {open ? 'Open' : COPY.closed}
            <input placeholder={'Ask a question'} />
            <img alt={\`Center logo\`} src="/logo.png" />
          </section>
        );
      }`;
    expect(findings(inline).sort(), 'the scanner misses inline strings').toEqual([
      'JSX text "Today at the center"',
      "JSX child 'Open'",
      'aria-label="Today at the center"',
      "placeholder='Ask a question'",
      'alt=`Center logo`',
      "metadata title 'Front Desk'",
    ].sort());

    const files = scannedFiles();
    expect(files.length, 'nothing to scan under app/src').toBeGreaterThan(0);
    const all = files.flatMap((f) => findings(fs.readFileSync(f, 'utf8')).map((x) => `${path.relative(APP, f)}: ${x}`));
    expect(all, 'user-facing strings outside app/src/core/copy.ts').toEqual([]);
  });
});
