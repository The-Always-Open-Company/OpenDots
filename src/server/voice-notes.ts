import type { PlatformConfig } from './platform-config.js';
import { providerError } from './voice-live.js';

const transcriptions = 'https://api.openai.com/v1/audio/transcriptions';
const speech = 'https://api.openai.com/v1/audio/speech';

export const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
export const DEFAULT_SPEECH_MODEL = 'gpt-4o-mini-tts';
export const VOICE_NOTE_MAX_MS = 5 * 60_000;
export const VOICE_NOTE_MAX_BYTES = 10_000_000;
export { SPEECH_MAX_CHARS } from '../shared/voice-note.js';
const audioTypes = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
]);
const extensions: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

/** `audio/webm;codecs=opus` and similar reduce to their base type. */
export function voiceNoteType(type: string) {
  const base = type.split(';')[0].trim().toLowerCase();
  return audioTypes.has(base) ? base : null;
}

/** Rejects audio the transcription step would refuse or that exceeds note limits. */
export function checkVoiceNote(file: Blob, durationMs: number) {
  if (!voiceNoteType(file.type))
    throw new Error('Voice note audio must be WebM, Ogg, MP4, MP3, or WAV.');
  if (!file.size) throw new Error('Voice note is empty.');
  if (file.size > VOICE_NOTE_MAX_BYTES)
    throw new Error(
      `Voice notes can be up to ${VOICE_NOTE_MAX_BYTES / 1_000_000} MB.`,
    );
  // Recorders stop a little after the limit, so allow a short grace period.
  if (!Number.isFinite(durationMs) || durationMs > VOICE_NOTE_MAX_MS + 5_000)
    throw new Error(
      `Voice notes can be up to ${VOICE_NOTE_MAX_MS / 60_000} minutes.`,
    );
}

/** Sends the audio straight to OpenAI; OpenDots keeps no copy of it. */
export async function transcribeNote(
  config: PlatformConfig,
  transport: typeof fetch,
  file: Blob,
  signal: AbortSignal,
): Promise<string> {
  const type = voiceNoteType(file.type)!;
  const form = new FormData();
  form.set('model', config.voiceTranscribeModel ?? DEFAULT_TRANSCRIBE_MODEL);
  form.set('response_format', 'json');
  form.set('file', file, `voice-note.${extensions[type]}`);
  const response = await transport(transcriptions, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.voiceKey}` },
    body: form,
    signal,
    redirect: 'error',
  });
  if (!response.ok) throw await providerError(response);
  const body = (await response.json().catch(() => null)) as {
    text?: unknown;
  } | null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text)
    throw new Error(
      'Voice note transcription returned no words. Record again closer to the microphone.',
    );
  return text;
}

export async function speakText(
  config: PlatformConfig,
  transport: typeof fetch,
  text: string,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await transport(speech, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.voiceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.voiceSpeechModel ?? DEFAULT_SPEECH_MODEL,
      voice: config.voiceName,
      input: text,
      response_format: 'mp3',
    }),
    signal,
    redirect: 'error',
  });
  if (!response.ok) throw await providerError(response);
  return response.arrayBuffer();
}
