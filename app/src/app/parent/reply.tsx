// One reply, rendered by its outcome (PRD P6 to P11, P14):
// - answered: the text, a citation chip per cited section, Send to front desk;
// - grounding_failed: the handbook's own text for each cited section;
// - handoff: the fixed text with the phone link, Send to front desk;
// - urgent: the fixed text with the phone link, and no Send.
// A reply that was never stored (a limit notice, a failed request) has no ID,
// so it has nothing to send.

import { useId, useState } from 'react';
import { DEGRADED_PREFACE, PARENT } from '../../core/copy';
import { longDate } from '../../core/today';
import type { CitedSection, Reply } from '../../core/types';
import { PhoneText } from './phone';

export type Shown = { reply: Pick<Reply, 'text' | 'outcome' | 'reason'>; replyId: string | null; sections: CitedSection[] };

const TRUNCATE_AT = 600;

export function ReplyView({ shown }: { shown: Shown }) {
  const { reply, replyId, sections } = shown;
  return (
    <div className="reply">
      <span className="visually-hidden">{PARENT.frontDesk}</span>
      {reply.reason === 'answered' ? (
        <>
          <p className="reply-text">
            <PhoneText text={reply.text} />
          </p>
          <ul className="chips" aria-label={PARENT.sources}>
            {sections.map((s) => (
              <Chip key={s.id} section={s} />
            ))}
          </ul>
        </>
      ) : reply.reason === 'grounding_failed' ? (
        <>
          <p className="reply-text">{DEGRADED_PREFACE}</p>
          {sections.map((s) => (
            <HandbookText key={s.id} section={s} />
          ))}
        </>
      ) : (
        <p className="reply-text">
          <PhoneText text={reply.text} />
        </p>
      )}
      {replyId !== null && reply.outcome !== 'urgent' && <SendToFrontDesk replyId={replyId} />}
    </div>
  );
}

function Chip({ section }: { section: CitedSection }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <li>
      <button type="button" className="chip" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}>
        <span className="chip-title">{section.title}</span>
        <span className="chip-meta">{section.kind === 'policy' ? PARENT.updated(longDate(section.updatedOn)) : PARENT.fromRecords}</span>
      </button>
      <div id={panel} className="section-text" hidden={!open}>
        {section.text}
      </div>
    </li>
  );
}

// A cited section's verbatim text, cut at 600 characters with its own Show more.
function HandbookText({ section }: { section: CitedSection }) {
  const [whole, setWhole] = useState(section.text.length <= TRUNCATE_AT);
  return (
    <div className="section-text">
      <p className="section-title">{section.title}</p>
      {whole ? section.text : `${section.text.slice(0, TRUNCATE_AT)}…`}
      {!whole && (
        <button type="button" className="secondary" onClick={() => setWhole(true)}>
          {PARENT.showMore}
        </button>
      )}
    </div>
  );
}

function SendToFrontDesk({ replyId }: { replyId: string }) {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    try {
      const response = await fetch('/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replyId }),
      });
      // false means it was already sent: either way it is with the front desk.
      if (typeof (await response.json())?.sent === 'boolean') setSent(true);
    } catch {
      // The button stays, so the parent can try again.
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <p className="sent" role="status">
        {PARENT.sent}
      </p>
    );
  }
  return (
    <button type="button" className="secondary" disabled={busy} onClick={send}>
      {PARENT.sendToFrontDesk}
    </button>
  );
}
