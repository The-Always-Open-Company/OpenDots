import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { checkVoiceNote } from '../src/server/voice-notes.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function fixture(overrides: Partial<PlatformConfig> = {}) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Notes');
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, workspace, {
    apiKey: 'model-key',
    model: 'model',
    baseUrl: config.baseUrl,
    voiceKey: 'voice-key',
    voiceName: 'marin',
    slackUsers: [],
    ...overrides,
  });
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
  });
  return { app, store, workspace, dot };
}

const note = (
  fields: Record<string, string> = { threadId: 'thread', durationMs: '4000' },
  file: File = new File([new Uint8Array(64)], 'voice-note.webm', {
    type: 'audio/webm;codecs=opus',
  }),
) => {
  const data = new FormData();
  data.append('file', file);
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return { method: 'POST', body: data };
};

it('forwards the recording to OpenAI transcription and returns only the text', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ text: '  Book the dentist for Tuesday.  ' }),
    );
  vi.stubGlobal('fetch', fetch);
  const { app, workspace } = fixture({ voiceTranscribeModel: 'transcriber' });
  const response = await app.request('/api/voice/notes/transcribe', note());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    text: 'Book the dentist for Tuesday.',
  });
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
  expect(init.headers).toEqual({ Authorization: 'Bearer voice-key' });
  const form = init.body as FormData;
  expect(form.get('model')).toBe('transcriber');
  expect((form.get('file') as File).name).toBe('voice-note.webm');
  expect((form.get('file') as File).size).toBe(64);
  // Transcribing never adds a message or starts a turn by itself.
  expect(workspace.threads.messages('thread')).toEqual([]);
});

it('defaults to gpt-4o-mini-transcribe and needs only the voice key', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ text: 'Hello' }));
  vi.stubGlobal('fetch', fetch);
  const { app } = fixture({ voiceModel: undefined });
  expect(
    (await app.request('/api/voice/notes/transcribe', note())).status,
  ).toBe(200);
  expect((fetch.mock.calls[0][1].body as FormData).get('model')).toBe(
    'gpt-4o-mini-transcribe',
  );
});

it('refuses voice notes without setup, while paused, or for unknown conversations', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const unconfigured = fixture({ voiceKey: undefined });
  const missing = await unconfigured.app.request(
    '/api/voice/notes/transcribe',
    note(),
  );
  expect(missing.status).toBe(409);
  expect((await missing.json()).error).toMatch(/VOICE_API_KEY/);
  const paused = fixture();
  paused.store.updateSettings({ paused: true });
  expect(
    (await paused.app.request('/api/voice/notes/transcribe', note())).status,
  ).toBe(409);
  const unknown = await fixture().app.request(
    '/api/voice/notes/transcribe',
    note({ threadId: 'missing', durationMs: '1000' }),
  );
  expect(unknown.status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects notes that are not audio, too long, or too large', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { app } = fixture();
  const text = await app.request(
    '/api/voice/notes/transcribe',
    note(
      undefined,
      new File(['hi'], 'note.txt', {
        type: 'text/plain',
      }),
    ),
  );
  expect(text.status).toBe(400);
  expect((await text.json()).error).toMatch(/WebM/);
  const long = await app.request(
    '/api/voice/notes/transcribe',
    note({ threadId: 'thread', durationMs: String(6 * 60_000) }),
  );
  expect(long.status).toBe(400);
  expect((await long.json()).error).toMatch(/5 minutes/);
  const large = await app.request(
    '/api/voice/notes/transcribe',
    note(
      undefined,
      new File([new Uint8Array(10_200_000)], 'note.webm', {
        type: 'audio/webm',
      }),
    ),
  );
  expect(large.status).toBe(413);
  expect(fetch).not.toHaveBeenCalled();
  expect(() =>
    checkVoiceNote(new Blob([], { type: 'audio/webm' }), 1000),
  ).toThrow(/empty/);
  expect(() =>
    checkVoiceNote(new Blob(['a'], { type: 'audio/mp4' }), 300_000),
  ).not.toThrow();
});

it("surfaces OpenAI's reason when transcription fails, so the owner can retry", async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { message: 'Audio file might be corrupted.' } },
          { status: 400 },
        ),
      ),
  );
  const { app } = fixture();
  const response = await app.request('/api/voice/notes/transcribe', note());
  expect(response.status).toBe(503);
  expect((await response.json()).error).toBe(
    'Voice provider returned HTTP 400: Audio file might be corrupted.',
  );
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ text: '   ' })),
  );
  expect(
    (await (await app.request('/api/voice/notes/transcribe', note())).json())
      .error,
  ).toMatch(/^Voice note transcription returned no words/);
});

it('only accepts multipart for the transcription route; other routes still need JSON', async () => {
  const { app } = fixture();
  const plain = await app.request('/api/voice/notes/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'audio',
  });
  expect(plain.status).toBe(415);
  const data = new FormData();
  data.append('text', 'hello');
  expect(
    (await app.request('/api/voice/speech', { method: 'POST', body: data }))
      .status,
  ).toBe(415);
});

it('speaks a reply with the configured voice and returns audio', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'audio/mpeg' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const { app } = fixture({ voiceName: 'cedar' });
  const response = await app.request('/api/voice/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Your dentist is booked.' }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('audio/mpeg');
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://api.openai.com/v1/audio/speech');
  expect(JSON.parse(init.body)).toMatchObject({
    model: 'gpt-4o-mini-tts',
    voice: 'cedar',
    input: 'Your dentist is booked.',
  });
  const tooLong = await app.request('/api/voice/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(4097) }),
  });
  expect(tooLong.status).toBe(400);
});

it('stores the per-Dot reply mode and the auto-send setting, with text and review as defaults', async () => {
  const { app, store, dot, workspace } = fixture();
  expect(dot.replyMode).toBe('text');
  expect(store.settings().voiceNoteAutoSend).toBe(false);
  const updated = await app.request(`/api/dots/${dot.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: dot.name,
      instructions: dot.instructions,
      researchAllowed: dot.researchAllowed,
      memoryAllowed: dot.memoryAllowed,
      replyMode: 'voice',
    }),
  });
  expect(updated.status).toBe(200);
  expect((await updated.json()).replyMode).toBe('voice');
  expect(workspace.dot(dot.id)?.replyMode).toBe('voice');
  const invalid = await app.request(`/api/dots/${dot.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: dot.name,
      instructions: dot.instructions,
      researchAllowed: true,
      memoryAllowed: true,
      replyMode: 'singing',
    }),
  });
  expect(invalid.status).toBe(400);
  const created = await app.request('/api/dots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spaceId: dot.spaceId,
      name: 'Speaker',
      instructions: 'Talk to me.',
      researchAllowed: true,
      memoryAllowed: true,
      replyMode: 'voice',
    }),
  });
  expect((await created.json()).replyMode).toBe('voice');
  const settings = await app.request('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voiceNoteAutoSend: true }),
  });
  expect((await settings.json()).voiceNoteAutoSend).toBe(true);
  expect(store.settings().voiceNoteAutoSend).toBe(true);
});
