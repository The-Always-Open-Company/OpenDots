import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import type { Dot, HandoffTarget } from '../shared/types';
import { sendToDot } from './send-to-dot';

/** Button and popover that hand a document or page to a Dot to read in the background. */
export function SendToDot({
  dots,
  target,
  emptyHint,
  beforeSend,
}: {
  /** Dots that can read the target. */
  dots: Dot[];
  target: HandoffTarget;
  emptyHint: string;
  /** Saves unsaved edits so the Dot reads the latest version. */
  beforeSend?: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [dotId, setDotId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const chosen = dots.find((dot) => dot.id === dotId) ?? dots[0];
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setOpen(false);
      } else if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => setSent(''), 6000);
    return () => clearTimeout(timer);
  }, [sent]);
  const submit = async () => {
    if (!chosen) return;
    setBusy(true);
    setError('');
    try {
      if ((await beforeSend?.()) === false) {
        setError('Your latest changes are not saved yet. Save, then send.');
        return;
      }
      const result = await sendToDot(chosen.id, target, note);
      setSent(
        result.status === 'waiting'
          ? `${chosen.name} will start once it finishes processing.`
          : `Sent to ${chosen.name}. You’ll get a notification when it’s done.`,
      );
      setNote('');
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send it.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="send-to-dot" ref={root}>
      <button
        className="send-to-dot-button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setError('');
        }}
      >
        <Send size={14} /> Send to Dot
      </button>
      {sent && (
        <span className="send-to-dot-sent" role="status">
          {sent}
        </span>
      )}
      {open && (
        <form
          className="send-to-dot-popover"
          aria-label="Send to a Dot"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {dots.length ? (
            <>
              <p className="muted">
                The Dot reads it in the background, files action items, and lets
                you know when it’s done.
              </p>
              <label className="field-label" htmlFor="send-to-dot-dot">
                Dot
              </label>
              <select
                id="send-to-dot-dot"
                value={chosen?.id ?? ''}
                onChange={(event) => setDotId(event.target.value)}
              >
                {dots.map((dot) => (
                  <option key={dot.id} value={dot.id}>
                    {dot.name}
                  </option>
                ))}
              </select>
              <label className="field-label" htmlFor="send-to-dot-note">
                Note (optional)
              </label>
              <textarea
                id="send-to-dot-note"
                rows={2}
                maxLength={1000}
                placeholder="Anything to focus on?"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              {error && (
                <p className="chat-error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary full" disabled={busy || !chosen}>
                <Send size={14} />
                {busy ? 'Sending…' : `Send to ${chosen?.name ?? 'Dot'}`}
              </button>
            </>
          ) : (
            <p className="muted">{emptyHint}</p>
          )}
        </form>
      )}
    </div>
  );
}
