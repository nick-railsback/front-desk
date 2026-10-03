'use client';

// Questions (PRD O3): the sandbox's questions, newest first, filtered by
// outcome. Opening one shows its reply in a dialog, drawn by the parent
// view's own ReplyView, so it reads exactly as the parent saw it.

import { useEffect, useRef, useState } from 'react';
import { OPERATOR } from '../../core/copy';
import type { Outcome, Reason } from '../../core/types';
import { ReplyView, type Shown } from '../parent/reply';

export type QuestionRow = {
  id: string;
  message: string;
  ago: string;
  outcome: Outcome;
  reason: Reason;
  cited: string[];
  sent: boolean;
  shown: Shown;
};

type Filter = 'all' | Outcome;

const FILTERS: { filter: Filter; name: string }[] = [
  { filter: 'all', name: OPERATOR.all },
  { filter: 'answer', name: OPERATOR.outcomes.answer },
  { filter: 'handoff', name: OPERATOR.outcomes.handoff },
  { filter: 'urgent', name: OPERATOR.outcomes.urgent },
];

export function Questions({ questions }: { questions: QuestionRow[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const shown = filter === 'all' ? questions : questions.filter((q) => q.outcome === filter);
  const opened = questions.find((q) => q.id === openId);

  return (
    <section aria-label={OPERATOR.questions} className="area">
      <fieldset className="choices">
        <legend>{OPERATOR.outcome}</legend>
        {FILTERS.map((f) => (
          <label key={f.filter}>
            <input type="radio" name="outcome" value={f.filter} checked={filter === f.filter} onChange={() => setFilter(f.filter)} />
            {f.name}
          </label>
        ))}
      </fieldset>
      {shown.length === 0 && <p>{OPERATOR.noQuestions}</p>}
      <ul className="cards">
        {shown.map((q) => (
          <li key={q.id}>
            <button type="button" className="secondary question-open" onClick={() => setOpenId(q.id)}>
              {q.message}
            </button>
            <p className="meta">
              {q.ago} · {OPERATOR.outcomes[q.outcome]} · {q.reason.replace(/_/g, ' ')}
            </p>
            {q.cited.length > 0 && <p className="meta">{OPERATOR.cites(q.cited.join(', '))}</p>}
            {q.sent && <p className="badge">{OPERATOR.sentToFrontDesk}</p>}
          </li>
        ))}
      </ul>
      {opened && <ReplyDialog question={opened} onClose={() => setOpenId(null)} />}
    </section>
  );
}

function ReplyDialog({ question, onClose }: { question: QuestionRow; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="reply-dialog" aria-labelledby="reply-heading" onClose={onClose}>
      <h2 id="reply-heading">{OPERATOR.reply}</h2>
      <p className="asked">{question.message}</p>
      <ReplyView shown={question.shown} />
      <button type="button" className="secondary" onClick={() => dialog.current?.close()}>
        {OPERATOR.close}
      </button>
    </dialog>
  );
}
