'use client';

// The demo's own controls on both views: the Try this strip (PRD D5) and
// Reset demo (D2). The strip walks a visitor through the loop and can be
// dismissed for the sandbox; Reset demo stays after that, and brings the
// strip back with a fresh sandbox.
//
// The Reset confirmation is a native <dialog> opened with showModal(): the
// browser makes the page behind it inert, keeps focus inside it, and closes
// it on Escape.

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { DEMO } from '../core/copy';

// On the parent view, asks the question in place. Without it, the parent view
// asks it on arrival: see TRY_PARAM in parent/parent-view.tsx.
export function DemoStrip({ dismissed, onAsk }: { dismissed: boolean; onAsk?: (question: string) => void }) {
  const router = useRouter();
  const [hidden, setHidden] = useState(dismissed);
  const [dismissFailed, setDismissFailed] = useState(false);

  function ask() {
    if (onAsk) onAsk(DEMO.question);
    else router.push('/?try=1');
  }

  async function dismiss() {
    setDismissFailed(false);
    try {
      const response = await fetch('/api/dismiss', { method: 'POST' });
      if (response.ok) setHidden(true);
      else setDismissFailed(true);
    } catch {
      setDismissFailed(true);
    }
  }

  return (
    <div className="demo">
      {!hidden && (
        <section aria-label={DEMO.tryThis} className="try-this">
          <h2>{DEMO.tryThis}</h2>
          <ol>
            <li>
              {DEMO.firstStep}{' '}
              <button type="button" className="secondary" onClick={ask}>
                {DEMO.question}
              </button>
            </li>
            {DEMO.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <button type="button" className="secondary" onClick={dismiss}>
            {DEMO.dismiss}
          </button>
          {dismissFailed && (
            <p role="alert" className="notice">
              {DEMO.failed}
            </p>
          )}
        </section>
      )}
      <ResetDemo />
    </div>
  );
}

function ResetDemo() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function reset() {
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch('/api/reset', { method: 'POST' });
      if (response.ok) {
        // A full load, so every part of the view reads the new sandbox.
        window.location.assign(window.location.pathname);
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    }
    setBusy(false);
  }

  return (
    <>
      <button type="button" className="secondary" onClick={() => dialog.current?.showModal()}>
        {DEMO.reset}
      </button>
      {/* Cancel comes first, so showModal() focuses it. */}
      <dialog
        ref={dialog}
        role="alertdialog"
        className="reset-dialog"
        aria-labelledby="reset-heading"
        aria-describedby="reset-body"
        onClose={() => setFailed(false)}
      >
        <h2 id="reset-heading">{DEMO.resetTitle}</h2>
        <p id="reset-body">{DEMO.resetBody}</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={() => dialog.current?.close()}>
            {DEMO.cancel}
          </button>
          <button type="button" disabled={busy} onClick={reset}>
            {DEMO.confirm}
          </button>
        </div>
        {failed && (
          <p role="alert" className="notice">
            {DEMO.resetFailed}
          </p>
        )}
      </dialog>
    </>
  );
}
