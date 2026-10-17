import type { AssistantMessage } from '@ag-ui/core';
import {
  LoaderCircle,
  Mic,
  RotateCcw,
  Send,
  Square,
  Volume2,
  X,
} from 'lucide-react';
import { VOICE_NOTE_LIMIT_MS, type useVoiceNote } from './useVoiceNote';
import type { useSpokenReply } from './useSpokenReply';

type VoiceNote = ReturnType<typeof useVoiceNote>;

export function SpokenReplyButton({
  message,
  spoken,
}: {
  message: AssistantMessage;
  spoken: Pick<
    ReturnType<typeof useSpokenReply>,
    'playingId' | 'loadingId' | 'play' | 'stop'
  >;
}) {
  const busy =
    spoken.playingId === message.id || spoken.loadingId === message.id;
  return (
    <button
      type="button"
      className="spoken-reply"
      aria-label={busy ? 'Stop spoken reply' : 'Play spoken reply'}
      onClick={() => (busy ? spoken.stop() : void spoken.play(message))}
    >
      {spoken.loadingId === message.id ? (
        <LoaderCircle size={13} className="spin" />
      ) : busy ? (
        <Square size={13} />
      ) : (
        <Volume2 size={13} />
      )}
      <span>
        {spoken.loadingId === message.id
          ? 'Preparing…'
          : busy
            ? 'Stop'
            : 'Listen'}
      </span>
    </button>
  );
}

export function clock(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function VoiceNoteButton({
  note,
  disabled,
  title,
}: {
  note: VoiceNote;
  disabled: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label="Record a voice note"
      title={title ?? 'Record a voice note (up to 5 minutes)'}
      disabled={disabled || note.status !== 'idle'}
      onClick={() => void note.start()}
    >
      <Mic size={18} />
    </button>
  );
}

/** Recording, review, transcription and failure states for the voice note being composed. */
export function VoiceNotePanel({
  note,
  sendDisabled,
}: {
  note: VoiceNote;
  sendDisabled: boolean;
}) {
  if (note.status === 'idle')
    return note.error ? (
      <div className="voice-note-panel failed" role="alert">
        <span>{note.error}</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Dismiss voice note error"
          onClick={note.clearError}
        >
          <X size={14} />
        </button>
      </div>
    ) : null;
  if (note.status === 'recording')
    return (
      <div className="voice-note-panel recording" aria-live="polite">
        <span className="voice-note-dot" aria-hidden />
        <span>
          Recording {clock(note.elapsedMs)} / {clock(VOICE_NOTE_LIMIT_MS)}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="Stop recording"
          onClick={note.stop}
        >
          <Square size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Cancel voice note"
          onClick={note.cancel}
        >
          <X size={14} />
        </button>
      </div>
    );
  if (note.status === 'transcribing')
    return (
      <div className="voice-note-panel" aria-live="polite">
        <LoaderCircle size={14} className="spin" />
        <span>Transcribing voice note…</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Cancel voice note"
          onClick={note.cancel}
        >
          <X size={14} />
        </button>
      </div>
    );
  return (
    <div
      className={`voice-note-panel ${note.status === 'failed' ? 'failed' : ''}`}
      role={note.status === 'failed' ? 'alert' : undefined}
    >
      <audio controls src={note.audioUrl} aria-label="Voice note preview" />
      <small>{clock(note.elapsedMs)}</small>
      {note.status === 'failed' && <span>{note.error}</span>}
      <button
        type="button"
        className="icon-button"
        aria-label="Discard voice note"
        onClick={note.cancel}
      >
        <X size={14} />
      </button>
      {note.status === 'review' && (
        <button
          type="button"
          className="icon-button"
          aria-label="Record again"
          onClick={() => {
            note.cancel();
            void note.start();
          }}
        >
          <RotateCcw size={14} />
        </button>
      )}
      <button
        type="button"
        className="icon-button"
        aria-label={
          note.status === 'failed' ? 'Retry voice note' : 'Send voice note'
        }
        disabled={sendDisabled}
        onClick={() => void note.send()}
      >
        {note.status === 'failed' ? (
          <RotateCcw size={14} />
        ) : (
          <Send size={14} />
        )}
      </button>
    </div>
  );
}
