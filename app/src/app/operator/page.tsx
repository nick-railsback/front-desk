// The operator view (PRD O1 to O11): everything it shows, read from the
// sandbox in one pass and handed to the client view. The proxy has already
// put this browser in a sandbox; with no sandbox, or no database, the page
// shows a fixed message. Nothing here calls the model.

import { headers } from 'next/headers';
import { renderDataSections } from '../../core/assemble';
import { OPERATOR } from '../../core/copy';
import { hasUnpublishedChanges, summarize, timeAgo } from '../../core/operator';
import { calendarDate, longDate } from '../../core/today';
import { denverDate } from '../../seed/dates';
import { forSandbox } from '../../db/sandbox';
import { citedSections } from '../../server/ask';
import { SANDBOX_HEADER } from '../../server/sandbox-cookie';
import { DemoStrip } from '../demo-strip';
import { type GapRow, OperatorView, type OperatorData } from './operator-view';

export const dynamic = 'force-dynamic';

const RECENT_PHRASINGS = 3;

async function load(): Promise<{ data: OperatorData; dismissed: boolean } | null> {
  const sandboxId = (await headers()).get(SANDBOX_HEADER);
  if (!sandboxId) return null;
  try {
    const access = forSandbox(sandboxId);
    const [questions, gaps, snapshots, draft, replay, context, dismissed] = await Promise.all([
      access.questions(),
      access.gapsWithQuestions(),
      access.snapshots(),
      access.draft(),
      access.latestReplay(),
      access.context(),
      access.tryThisDismissed(),
    ]);
    const now = new Date();
    const latest = snapshots[snapshots.length - 1];
    const results = replay?.status === 'done' ? replay.results : [];
    const open = gaps.filter((g) => g.status === 'open');

    const gapRow = (g: (typeof gaps)[number]): GapRow => {
      const result = results.find((r) => r.gapId === g.id) ?? null;
      return {
        id: g.id,
        label: g.label,
        count: g.questions.length,
        lastAsked: g.questions.length > 0 ? timeAgo(g.questions[0].askedAt, now) : null,
        recent: g.questions.slice(0, RECENT_PHRASINGS).map((q) => q.message),
        phrasings: g.questions.map((q) => q.message),
        result: result && { answered: result.answered, replayed: result.replayed },
        resolved: g.status === 'resolved',
      };
    };
    // Open gaps by question count, highest first; then the gaps the latest
    // replay resolved, so the operator sees what their publish closed.
    const byCount = [...open].sort((a, b) => b.questions.length - a.questions.length);
    const resolved = gaps.filter((g) => g.status === 'resolved' && results.some((r) => r.gapId === g.id && r.resolved));

    const data: OperatorData = {
      version: latest.version,
      publishedOn: calendarDate(denverDate(new Date(latest.publishedAt))),
      summary: summarize(questions, open.length, now),
      unpublished: hasUnpublishedChanges(draft, latest.sections),
      replay: replay && { running: replay.status === 'running', completed: replay.completed, total: replay.total },
      questions: questions.map((q) => {
        const policy = snapshots.find((s) => s.version === q.reply.snapshotVersion)?.sections ?? [];
        // Structured data is never edited, so rendering it at the moment of
        // asking shows what the parent saw.
        const data = q.reply.citations.length > 0 ? renderDataSections(context.structured, new Date(q.askedAt)) : [];
        const sections = citedSections(q.reply, policy, data);
        return {
          id: q.id,
          message: q.message,
          ago: timeAgo(q.askedAt, now),
          outcome: q.reply.outcome,
          reason: q.reply.reason,
          cited: sections.map((s) => s.title),
          sent: q.sentToFrontDesk,
          shown: { reply: { text: q.reply.text, outcome: q.reply.outcome, reason: q.reply.reason }, replyId: null, sections },
        };
      }),
      gaps: [...byCount, ...resolved].map(gapRow),
      sections: draft.map((s) => ({ ...s, updated: longDate(s.updatedOn) })),
      dataTitles: renderDataSections(context.structured, now).map((s) => s.title),
    };
    return { data, dismissed };
  } catch (err) {
    console.error('operator view: could not load:', err);
    return null;
  }
}

export default async function OperatorPage() {
  const loaded = await load();
  if (!loaded) {
    return (
      <main>
        <p role="alert" className="unavailable">
          {OPERATOR.unavailable}
        </p>
      </main>
    );
  }
  return (
    <main>
      <DemoStrip dismissed={loaded.dismissed} />
      <OperatorView data={loaded.data} />
    </main>
  );
}
