import { useCallback, useEffect, useRef, useState } from 'react';
import { upload } from './api';

export const VOICE_NOTE_LIMIT_MS = 5 * 60_000;
export type VoiceNoteStatus =
  'idle' | 'recording' | 'review' | 'transcribing' | 'failed';

const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
const extension = (type: string) =>
  type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm';

export function recordingType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return preferredTypes.find((type) => MediaRecorder.isTypeSupported?.(type));
}

/**
 * Records one voice note at a time. Audio stays in memory until it is
 * transcribed, and is dropped on success, cancel, discard or unmount.
 */
export function useVoiceNote(
  threadId: string,
  onTranscript: (text: string) => void,
) {
  const [status, setStatus] = useState<VoiceNoteStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [audioUrl, setAudioUrl] = useState('');
  const [error, setError] = useState('');
  const deliver = useRef(onTranscript);
  deliver.current = onTranscript;
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const note = useRef<{ blob: Blob; durationMs: number } | null>(null);
  const request = useRef<AbortController | null>(null);
  // Bumped on cancel and unmount so a late recorder or microphone callback is ignored.
  const generation = useRef(0);
  const starting = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const url = useRef('');

  const release = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }, []);
  const clearNote = useCallback(() => {
    note.current = null;
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = '';
    setAudioUrl('');
  }, []);
  const reset = useCallback(() => {
    generation.current += 1;
    request.current?.abort();
    request.current = null;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
    release();
    clearNote();
    setElapsedMs(0);
  }, [clearNote, release]);

  const start = useCallback(async () => {
    if (recorder.current || note.current || starting.current) return;
    setError('');
    if (
      typeof MediaRecorder === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setError('This browser cannot record voice notes.');
      return;
    }
    const gen = generation.current;
    starting.current = true;
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (generation.current === gen)
        setError('Microphone access was blocked. Allow it to record a note.');
      return;
    } finally {
      starting.current = false;
    }
    if (generation.current !== gen) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    const type = recordingType();
    const active = new MediaRecorder(media, type ? { mimeType: type } : {});
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    stream.current = media;
    recorder.current = active;
    active.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    active.onstop = () => {
      if (recorder.current === active) recorder.current = null;
      if (generation.current !== gen) return;
      release();
      const durationMs = Math.min(Date.now() - startedAt, VOICE_NOTE_LIMIT_MS);
      const blob = new Blob(chunks, {
        type: active.mimeType || chunks[0]?.type || type || 'audio/webm',
      });
      if (!blob.size) {
        setStatus('idle');
        setError('Nothing was recorded. Check your microphone and try again.');
        return;
      }
      note.current = { blob, durationMs };
      url.current = URL.createObjectURL(blob);
      setAudioUrl(url.current);
      setElapsedMs(durationMs);
      setStatus('review');
    };
    active.start(1000);
    setElapsedMs(0);
    setStatus('recording');
    timer.current = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setElapsedMs(Math.min(elapsed, VOICE_NOTE_LIMIT_MS));
      if (elapsed >= VOICE_NOTE_LIMIT_MS && active.state === 'recording')
        active.stop();
    }, 250);
  }, [release]);

  const stop = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }, []);

  const cancel = useCallback(() => {
    reset();
    setError('');
    setStatus('idle');
  }, [reset]);

  const send = useCallback(async () => {
    const current = note.current;
    if (!current || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setError('');
    setStatus('transcribing');
    try {
      const { text } = await upload<{ text: string }>(
        '/voice/notes/transcribe',
        new File([current.blob], `voice-note.${extension(current.blob.type)}`, {
          type: current.blob.type,
        }),
        { threadId, durationMs: String(current.durationMs) },
        controller.signal,
      );
      if (controller.signal.aborted || note.current !== current) return;
      request.current = null;
      clearNote();
      setElapsedMs(0);
      setStatus('idle');
      deliver.current(text);
    } catch (e) {
      if (controller.signal.aborted) return;
      request.current = null;
      setError(
        e instanceof Error ? e.message : 'The voice note could not be sent.',
      );
      setStatus('failed');
    }
  }, [clearNote, threadId]);

  useEffect(() => reset, [reset, threadId]);

  return {
    status,
    elapsedMs,
    audioUrl,
    error,
    start,
    stop,
    cancel,
    send,
    clearError: () => setError(''),
  };
}
