import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useVoiceNote, VOICE_NOTE_LIMIT_MS } from '../src/client/useVoiceNote';
const upload = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ upload }));
let note: ReturnType<typeof useVoiceNote>;
let root: ReactTestRenderer;
const transcripts: string[] = [];
const track = { stop: vi.fn() };
let recorder: FakeRecorder | undefined;
class FakeRecorder {
  static isTypeSupported = (type: string) => type === 'audio/webm;codecs=opus';
  state = 'inactive';
  mimeType: string;
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  constructor(_stream: unknown, options: { mimeType?: string }) {
    this.mimeType = options.mimeType ?? '';
    // The test drives the recorder the hook created, like a browser constructor.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    recorder = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob(['spoken audio'], { type: this.mimeType }),
    });
    this.onstop?.();
  }
}
function Hook() {
  note = useVoiceNote('thread', (text) => transcripts.push(text));
  return null;
}
beforeEach(async () => {
  vi.useFakeTimers();
  transcripts.length = 0;
  track.stop.mockReset();
  upload.mockReset();
  recorder = undefined;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
  });
  await act(async () => {
    root = create(createElement(Hook));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function record(ms: number) {
  await act(async () => {
    await note.start();
  });
  expect(note.status).toBe('recording');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it('records, lets the owner review, then transcribes and hands over the text once', async () => {
  await record(4000);
  expect(note.elapsedMs).toBe(4000);
  await act(async () => note.stop());
  expect(note.status).toBe('review');
  expect(note.audioUrl).toMatch(/^blob:/);
  expect(track.stop).toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  upload.mockResolvedValue({ text: 'Call Sam tomorrow.' });
  await act(async () => {
    await note.send();
  });
  const [path, file, fields] = upload.mock.calls[0];
  expect(path).toBe('/voice/notes/transcribe');
  expect(file).toBeInstanceOf(File);
  expect(file.type).toBe('audio/webm;codecs=opus');
  expect(fields).toEqual({ threadId: 'thread', durationMs: '4000' });
  expect(transcripts).toEqual(['Call Sam tomorrow.']);
  expect(note.status).toBe('idle');
  expect(note.audioUrl).toBe('');
});

it('never uploads or delivers text for a cancelled or discarded note', async () => {
  await record(2000);
  await act(async () => note.cancel());
  expect(note.status).toBe('idle');
  expect(track.stop).toHaveBeenCalled();
  await record(1000);
  await act(async () => note.stop());
  await act(async () => note.cancel());
  expect(note.status).toBe('idle');
  await act(async () => {
    await note.send();
  });
  expect(upload).not.toHaveBeenCalled();
  expect(transcripts).toEqual([]);
});

it('stops recording on its own at five minutes', async () => {
  await record(VOICE_NOTE_LIMIT_MS + 1000);
  expect(recorder?.state).toBe('inactive');
  expect(note.status).toBe('review');
  expect(note.elapsedMs).toBe(VOICE_NOTE_LIMIT_MS);
  expect(track.stop).toHaveBeenCalled();
});

it('keeps the recording after a failed upload and retries with the same audio', async () => {
  await record(3000);
  await act(async () => note.stop());
  upload.mockRejectedValueOnce(new Error('Voice provider returned HTTP 500.'));
  await act(async () => {
    await note.send();
  });
  expect(note.status).toBe('failed');
  expect(note.error).toBe('Voice provider returned HTTP 500.');
  expect(note.audioUrl).toMatch(/^blob:/);
  expect(transcripts).toEqual([]);
  upload.mockResolvedValueOnce({ text: 'Second try.' });
  await act(async () => {
    await note.send();
  });
  expect(upload).toHaveBeenCalledTimes(2);
  expect(await upload.mock.calls[1][1].text()).toBe(
    await upload.mock.calls[0][1].text(),
  );
  expect(transcripts).toEqual(['Second try.']);
  expect(note.status).toBe('idle');
});

it('ignores a transcript that arrives after the note was cancelled', async () => {
  await record(1000);
  await act(async () => note.stop());
  let finish: (value: { text: string }) => void = () => {};
  upload.mockImplementation(
    (_path, _file, _fields, signal: AbortSignal) =>
      new Promise((resolve, reject) => {
        finish = resolve;
        signal.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  );
  let sending: Promise<void> = Promise.resolve();
  await act(async () => {
    sending = note.send();
  });
  expect(note.status).toBe('transcribing');
  expect(upload.mock.calls[0][3].aborted).toBe(false);
  await act(async () => note.cancel());
  expect(upload.mock.calls[0][3].aborted).toBe(true);
  finish({ text: 'Too late' });
  await act(async () => {
    await sending;
  });
  expect(transcripts).toEqual([]);
  expect(note.status).toBe('idle');
});

it('releases the microphone when the chat closes mid-recording', async () => {
  await record(1000);
  await act(async () => root.unmount());
  expect(track.stop).toHaveBeenCalled();
  await act(async () => {
    root = create(createElement(Hook));
  });
});
