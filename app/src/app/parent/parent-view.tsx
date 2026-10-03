'use client';

// The conversation: suggested questions, the message input, the typing
// indicator, and each exchange. The conversation lives here only; nothing
// keeps it across a reload.
//
// Each exchange keeps one stable key, and its reply mounts inside it whole,
// in one update, so the log announces each reply once (PRD A2).

import { type FormEvent, useRef, useState } from 'react';
import { FIXED_TEXT, PARENT } from '../../core/copy';
import type { Turn } from '../../core/types';
import { ReplyView, type Shown } from './reply';

const MAX_CHARS = 500;
const PRIOR_EXCHANGES = 2;

type Exchange = { id: number; message: string; shown: Shown | null };

// What a failed request shows: the system_error text, never stored.
const FAILED: Shown = { reply: { text: FIXED_TEXT.system_error, outcome: 'handoff', reason: 'system_error' }, replyId: null, sections: [] };

async function askFrontDesk(message: string, priorTurns: Turn[]): Promise<Shown> {
  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, priorTurns }),
    });
    const body = response.ok ? await response.json() : null;
    const reply = body?.reply;
    if (typeof reply?.text !== 'string' || typeof reply.outcome !== 'string' || typeof reply.reason !== 'string') return FAILED;
    return {
      reply,
      replyId: typeof body.replyId === 'string' ? body.replyId : null,
      sections: Array.isArray(body.sections) ? body.sections : [],
    };
  } catch {
    return FAILED;
  }
}

export function ParentView() {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);
  const tooLong = draft.length > MAX_CHARS;

  async function send(message: string) {
    if (pending || message.trim() === '' || message.length > MAX_CHARS) return;
    const priorTurns: Turn[] = exchanges
      .filter((e) => e.shown !== null)
      .slice(-PRIOR_EXCHANGES)
      .flatMap((e) => [
        { role: 'parent', text: e.message },
        { role: 'front_desk', text: e.shown!.reply.text },
      ]);
    const id = nextId.current++;
    setExchanges((list) => [...list, { id, message, shown: null }]);
    setDraft('');
    setPending(true);
    input.current?.focus();
    const shown = await askFrontDesk(message, priorTurns);
    // After New conversation, the exchange is gone and its reply is dropped.
    setExchanges((list) => list.map((e) => (e.id === id ? { ...e, shown } : e)));
    setPending(false);
    input.current?.focus();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send(draft);
  }

  function startOver() {
    setExchanges([]);
    input.current?.focus();
  }

  return (
    <div className="parent-view">
      <div role="log" aria-label={PARENT.conversation} className="log">
        {exchanges.map((e) => (
          <div key={e.id} className="exchange">
            <p className="message">
              <span className="visually-hidden">{PARENT.you}</span>
              {e.message}
            </p>
            {e.shown && <ReplyView shown={e.shown} />}
          </div>
        ))}
      </div>
      <div role="status" className="typing-slot">
        {pending && (
          <p className="typing">
            {PARENT.typing}
            <span className="dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </p>
        )}
      </div>
      {exchanges.length === 0 && (
        <ul className="suggestions" aria-label={PARENT.suggestionsLabel}>
          {PARENT.suggestions.map((q) => (
            <li key={q}>
              <button type="button" className="secondary" onClick={() => void send(q)}>
                {q}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="composer" onSubmit={submit}>
        <label htmlFor="message">{PARENT.inputLabel}</label>
        <div className="composer-row">
          <input
            id="message"
            ref={input}
            type="text"
            autoComplete="off"
            value={draft}
            placeholder={PARENT.placeholder}
            aria-invalid={tooLong}
            aria-describedby={tooLong ? 'too-long' : undefined}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" disabled={pending || tooLong || draft.trim() === ''}>
            {PARENT.send}
          </button>
        </div>
        {tooLong && (
          <p id="too-long" className="notice">
            {PARENT.tooLong}
          </p>
        )}
      </form>
      {exchanges.length > 0 && (
        <button type="button" className="secondary" onClick={startOver}>
          {PARENT.newConversation}
        </button>
      )}
    </div>
  );
}
