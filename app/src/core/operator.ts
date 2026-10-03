// What the operator view computes from what the sandbox holds (PRD O2, O3,
// O8): the summary of the last 7 days, how long ago something was asked, and
// whether the draft differs from the latest snapshot. Pure: `now` is passed in.

import type { Reply, Section } from './types';

const MINUTE_MS = 60_000;
const WINDOW_MS = 7 * 24 * 60 * MINUTE_MS;
const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

export type Summary = { asked: number; percentAnswered: number; handoffs: number; urgent: number; openGaps: number };

// The questions asked in the 7 days ending at `now`. Percent answered counts
// replies whose reason is `answered`, as a whole percent of those asked.
export function summarize(questions: { askedAt: string; reply: Pick<Reply, 'outcome' | 'reason'> }[], openGaps: number, now: Date): Summary {
  const end = now.getTime();
  const inWindow = questions.filter((q) => {
    const at = Date.parse(q.askedAt);
    return at > end - WINDOW_MS && at <= end;
  });
  const count = (keep: (r: Pick<Reply, 'outcome' | 'reason'>) => boolean) => inWindow.filter((q) => keep(q.reply)).length;
  const answered = count((r) => r.reason === 'answered');
  return {
    asked: inWindow.length,
    percentAnswered: inWindow.length === 0 ? 0 : Math.round((100 * answered) / inWindow.length),
    handoffs: count((r) => r.outcome === 'handoff'),
    urgent: count((r) => r.outcome === 'urgent'),
    openGaps,
  };
}

// "30 minutes ago", "2 hours ago", "3 days ago": the largest whole unit.
export function timeAgo(askedAt: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(askedAt)) / MINUTE_MS));
  if (minutes < 60) return RELATIVE.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return RELATIVE.format(-hours, 'hour');
  return RELATIVE.format(-Math.floor(hours / 24), 'day');
}

// True while the draft would publish something the latest snapshot lacks.
// Dates are left out: publishing sets them.
export function hasUnpublishedChanges(draft: Section[], published: Section[]): boolean {
  const content = (sections: Section[]) => JSON.stringify(sections.map((s) => [s.id, s.title, s.visibility, s.text]));
  return content(draft) !== content(published);
}
