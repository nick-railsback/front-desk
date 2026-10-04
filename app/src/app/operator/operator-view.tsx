'use client';

// The operator view: the summary strip, the version with Publish, and the
// three areas (PRD O1). Writes go through /api/sections and /api/publish;
// after each, the page is refreshed from the server. A publish starts a
// replay, whose progress is polled until it is done.

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { OPERATOR, PARENT } from '../../core/copy';
import type { Summary } from '../../core/operator';
import type { Section } from '../../core/types';
import { Editor, type Editing } from './editor';
import { type QuestionRow, Questions } from './questions';

export type GapRow = {
  id: string;
  label: string;
  count: number;
  lastAsked: string | null;
  recent: string[];
  phrasings: string[];
  result: { answered: number; replayed: number } | null;
  resolved: boolean;
};

export type OperatorData = {
  version: number;
  // The latest snapshot's publish date, as a Denver calendar date.
  publishedOn: string;
  summary: Summary;
  unpublished: boolean;
  replay: { running: boolean; completed: number; total: number } | null;
  questions: QuestionRow[];
  gaps: GapRow[];
  sections: (Section & { updated: string })[];
  dataTitles: string[];
};

type Area = 'questions' | 'gaps' | 'center';

const AREAS: { area: Area; name: string }[] = [
  { area: 'questions', name: OPERATOR.questions },
  { area: 'gaps', name: OPERATOR.gaps },
  { area: 'center', name: OPERATOR.centerInfo },
];

export function OperatorView({ data }: { data: OperatorData }) {
  const [area, setArea] = useState<Area>('questions');
  const [editing, setEditing] = useState<(Editing & { key: number }) | null>(null);

  function edit(section: Editing) {
    setEditing((e) => ({ ...section, key: (e?.key ?? 0) + 1 }));
    setArea('center');
  }

  return (
    <div className="operator-view">
      <SummaryStrip summary={data.summary} />
      <PublishBar version={data.version} publishedOn={data.publishedOn} unpublished={data.unpublished} replay={data.replay} />
      <nav aria-label={OPERATOR.areas}>
        <ul className="areas">
          {AREAS.map((a) => (
            <li key={a.area}>
              <button type="button" className={a.area === area ? undefined : 'secondary'} aria-current={a.area === area ? 'true' : undefined} onClick={() => setArea(a.area)}>
                {a.name}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {area === 'questions' && <Questions questions={data.questions} />}
      {area === 'gaps' && (
        <Gaps gaps={data.gaps} onAnswer={(g) => edit({ id: null, title: g.label, text: '', visibility: 'parent', phrasings: g.phrasings, fromGap: true })} />
      )}
      {area === 'center' && (
        <section aria-label={OPERATOR.centerInfo} className="area">
          <button type="button" className="secondary" onClick={() => edit({ id: null, title: '', text: '', visibility: 'parent', phrasings: [], fromGap: false })}>
            {OPERATOR.addSection}
          </button>
          {editing && <Editor key={editing.key} editing={editing} onDone={() => setEditing(null)} />}
          <ul className="cards">
            {data.sections.map((s) => (
              <li key={s.id}>
                <h3>{s.title}</h3>
                <p className="meta">
                  {OPERATOR.visibility[s.visibility]} · {PARENT.updated(s.updated)}
                </p>
                <button
                  type="button"
                  className="secondary"
                  aria-label={OPERATOR.edit(s.title)}
                  onClick={() => edit({ id: s.id, title: s.title, text: s.text, visibility: s.visibility, phrasings: [], fromGap: false })}
                >
                  {OPERATOR.editLabel}
                </button>
              </li>
            ))}
            {data.dataTitles.map((title) => (
              <li key={title}>
                <h3>{title}</h3>
                <p className="meta">
                  {OPERATOR.visibility.parent} · {PARENT.fromRecords}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SummaryStrip({ summary }: { summary: Summary }) {
  const stats = [
    { n: String(summary.asked), label: OPERATOR.asked },
    { n: OPERATOR.percent(summary.percentAnswered), label: OPERATOR.answered },
    { n: String(summary.handoffs), label: OPERATOR.handoffs },
    { n: String(summary.urgent), label: OPERATOR.urgent },
    { n: String(summary.openGaps), label: OPERATOR.openGaps },
  ];
  return (
    <section aria-labelledby="summary-heading" className="summary">
      <h2 id="summary-heading">{OPERATOR.summary}</h2>
      <ul className="stats">
        {stats.map((s) => (
          <li key={s.label}>
            <span className="stat">{s.n}</span> {s.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

type Progress = { running: boolean; completed: number; total: number };

// The latest replay's progress, or null when it cannot be read or failed.
async function readProgress(): Promise<Progress | null> {
  try {
    const response = await fetch('/api/replay', { cache: 'no-store' });
    if (!response.ok) return null;
    const p = await response.json();
    if (typeof p?.running !== 'boolean' || typeof p.completed !== 'number' || typeof p.total !== 'number' || p.failed === true) return null;
    return { running: p.running, completed: p.completed, total: p.total };
  } catch {
    return null;
  }
}

function PublishBar({ version, publishedOn, unpublished, replay }: { version: number; publishedOn: string; unpublished: boolean; replay: Progress | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // A replay still running when the page loaded is followed, too.
  const [polling, setPolling] = useState(replay?.running === true);
  const [progress, setProgress] = useState<Progress | null>(replay?.running ? replay : null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const p = await readProgress();
      if (stopped) return;
      if (!p) {
        setFailure(OPERATOR.replayFailed);
        setPolling(false);
        return;
      }
      setProgress(p);
      if (p.running) {
        timer = setTimeout(poll, 1000);
      } else {
        setPolling(false);
        router.refresh();
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [polling, router]);

  async function publish() {
    setBusy(true);
    setFailure(null);
    setProgress(null);
    try {
      const response = await fetch('/api/publish', { method: 'POST' });
      if (!response.ok) {
        setFailure(OPERATOR.publishFailed);
        return;
      }
      router.refresh();
      setPolling(true);
    } catch {
      setFailure(OPERATOR.publishFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="publish-bar">
      <p className="version">{OPERATOR.version(version, publishedOn)}</p>
      {unpublished && <p className="unpublished">{OPERATOR.unpublished}</p>}
      <button type="button" disabled={busy || polling} aria-describedby="publish-help" onClick={publish}>
        {OPERATOR.publish}
      </button>
      <p id="publish-help" className="publish-help">
        {OPERATOR.publishHelp}
      </p>
      <div role="status" className="progress">
        {progress && progress.total > 0 && (
          <>
            <progress value={progress.completed} max={progress.total} aria-label={OPERATOR.progressLabel} />
            <span>{OPERATOR.progress(progress.completed, progress.total)}</span>
          </>
        )}
      </div>
      {failure && (
        <p role="alert" className="notice">
          {failure}
        </p>
      )}
    </div>
  );
}

function Gaps({ gaps, onAnswer }: { gaps: GapRow[]; onAnswer: (gap: GapRow) => void }) {
  return (
    <section aria-label={OPERATOR.gaps} className="area">
      {gaps.every((g) => g.resolved) && <p>{OPERATOR.noGaps}</p>}
      <ul className="cards">
        {gaps.map((g) => (
          <li key={g.id}>
            <h3>{g.label}</h3>
            <p className="meta">
              <span>{OPERATOR.questionCount(g.count)}</span>
              {g.lastAsked && <span> · {OPERATOR.lastAsked(g.lastAsked)}</span>}
            </p>
            <ul className="phrasings">
              {g.recent.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
            {g.result && <p className="result">{OPERATOR.result(g.result.answered, g.result.replayed)}</p>}
            {g.resolved ? (
              <p className="resolved">{OPERATOR.resolved}</p>
            ) : (
              <button type="button" onClick={() => onAnswer(g)}>
                {OPERATOR.answerThis}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
