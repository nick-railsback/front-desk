// Which gap a reply is filed into (DESIGN 4.9). Pure: the database files it.

import { FALLBACK_GAP_LABEL } from './copy';

const MAX_LABEL_WORDS = 8;
const JOIN_THRESHOLD = 0.5;
const STOPWORDS = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'or', 'is', 'are', 'do', 'does', 'my', 'our', 'your', 'about', 'with']);

function tokens(label: string): Set<string> {
  return new Set(
    label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t !== '' && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const shared = [...a].filter((t) => b.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : shared / union;
}

// An open label the proposal matches exactly or closely, else the proposal
// itself, at most 8 words.
export function chooseGapLabel(proposed: string | null, topic: string | null, openLabels: string[]): string {
  const label = (proposed?.trim() || topic?.trim() || FALLBACK_GAP_LABEL).replace(/\s+/g, ' ');
  const exact = openLabels.find((l) => l.toLowerCase() === label.toLowerCase());
  if (exact) return exact;
  const want = tokens(label);
  let best: { label: string; score: number } | null = null;
  for (const l of openLabels) {
    const score = jaccard(want, tokens(l));
    if (score >= JOIN_THRESHOLD && (!best || score > best.score)) best = { label: l, score };
  }
  return best ? best.label : label.split(' ').slice(0, MAX_LABEL_WORDS).join(' ');
}
