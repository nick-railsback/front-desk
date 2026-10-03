'use client';

// The section editor (PRD O6, O8): title, body and visibility, saved to the
// draft as the operator wrote them. Opened from "Answer this", it starts on a
// new section titled with the gap's label, beside every phrasing in the gap.
// A refused or failed save keeps the fields and says so inline.

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { OPERATOR } from '../../core/copy';
import type { Visibility } from '../../core/types';

export type Editing = { id: string | null; title: string; text: string; visibility: Visibility; phrasings: string[] };

const MAX_TITLE = 80;
const MAX_TEXT = 4000;
const VISIBILITIES: Visibility[] = ['parent', 'staff'];

export function Editor({ editing, onDone }: { editing: Editing; onDone: () => void }) {
  const router = useRouter();
  const [title, setTitle] = useState(editing.title);
  const [text, setText] = useState(editing.text);
  const [visibility, setVisibility] = useState<Visibility>(editing.visibility);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/sections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: editing.id, title, text, visibility }),
      });
      if (response.ok) {
        onDone();
        router.refresh();
        return;
      }
      setMessage(response.status === 400 ? OPERATOR.refused : OPERATOR.saveFailed);
    } catch {
      setMessage(OPERATOR.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="editor" aria-labelledby="editor-heading" onSubmit={save}>
      <h3 id="editor-heading">{editing.id === null ? OPERATOR.newSection : OPERATOR.editSection}</h3>
      {editing.phrasings.length > 0 && (
        <>
          <h4>{OPERATOR.phrasings}</h4>
          <ul className="phrasings">
            {editing.phrasings.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </>
      )}
      <label htmlFor="section-title">{OPERATOR.titleLabel}</label>
      <input id="section-title" type="text" autoFocus maxLength={MAX_TITLE} value={title} onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor="section-body">{OPERATOR.bodyLabel}</label>
      <textarea id="section-body" rows={8} maxLength={MAX_TEXT} value={text} onChange={(e) => setText(e.target.value)} />
      <fieldset className="choices">
        <legend>{OPERATOR.visibilityLabel}</legend>
        {VISIBILITIES.map((v) => (
          <label key={v}>
            <input type="radio" name="visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)} />
            {OPERATOR.visibility[v]}
          </label>
        ))}
      </fieldset>
      {message && (
        <p role="alert" className="notice">
          {message}
        </p>
      )}
      <div className="editor-actions">
        <button type="submit" disabled={busy}>
          {OPERATOR.save}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          {OPERATOR.cancel}
        </button>
      </div>
    </form>
  );
}
