import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { VoiceService } from '../src/server/voice.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import {
  appendPieces,
  type LiveSocketFactory,
  type LiveSocketHandlers,
} from '../src/server/live-call-controller.js';
const resources: (() => void)[] = [];
afterEach(() => {
  resources.splice(0).forEach((close) => close());
  vi.useRealTimers();
});
class FakeSocket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
    readonly handlers: LiveSocketHandlers,
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  emit(event: Record<string, unknown>) {
    this.handlers.message(JSON.stringify(event));
  }
  types() {
    return this.sent.map((event) => event.type);
  }
}
function fixture(overrides: Partial<PlatformConfig> = {}) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  workspace.bindThread('thread', workspace.dots()[0].id, 'A conversation');
  resources.push(() => {
    store.close();
    workspace.close();
  });
  const config: PlatformConfig = {
    baseUrl: 'https://example.com',
    voiceKey: 'test-secret',
    voiceProvider: 'realtime',
    voiceModel: 'voice-model',
    voiceName: 'marin',
    voiceTaskLimit: 6,
    slackUsers: [],
    ...overrides,
  };
  const turn = vi.fn(
    async (
      _thread: string,
      _prompt: string,
      _signal: AbortSignal,
      _metadata?: Record<string, unknown>,
      _options?: { model?: string },
    ) => 'Current answer',
  );
  const history = vi.fn(async () => 'user: Earlier topic');
  const historyMessages = vi.fn(async () => [
    { role: 'user' as const, text: 'Earlier topic' },
    { role: 'assistant' as const, text: 'Earlier answer' },
  ]);
  const transport = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/hangup')
      ? new Response(null, { status: 200 })
      : String(url).endsWith('/v1/live/sessions')
        ? Response.json(
            {
              session: { id: 'live_test' },
              transport: { type: 'webrtc', sdp: offer },
            },
            { status: 201 },
          )
        : new Response(offer, {
            headers: { location: '/v1/realtime/calls/rtc_test' },
          }),
  );
  const sockets: FakeSocket[] = [];
  let socketBehaviour: 'open' | 'fail' = 'open';
  const socket: LiveSocketFactory = (url, headers, handlers) => {
    const fake = new FakeSocket(url, headers, handlers);
    sockets.push(fake);
    queueMicrotask(() =>
      socketBehaviour === 'open'
        ? handlers.open()
        : handlers.error(new Error('refused')),
    );
    return fake;
  };
  const voice = new VoiceService(
    {
      workspace,
      store,
      config,
      turn,
      history,
      historyMessages,
      requireReady() {},
      setup: () => ({
        voice: true,
        model: true,
        browser: false,
        memory: false,
        documents: false,
        actionItems: false,
        slack: 'not_configured',
        missing: [],
      }),
    },
    transport,
    { socket, settleMs: 0, closeTimeoutMs: 50 },
  );
  return {
    voice,
    transport,
    workspace,
    store,
    turn,
    history,
    historyMessages,
    sockets,
    failSockets: () => {
      socketBehaviour = 'fail';
    },
  };
}
const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111';
it('binds voice history and compute to the existing thread, deduplicates tools and hangs up remotely', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  expect(f.history).toHaveBeenCalledWith('thread');
  const body = f.transport.mock.calls[0][1]?.body;
  expect(body).toBeInstanceOf(FormData);
  expect(String((body as FormData).get('session'))).toContain('Earlier topic');
  f.voice.activate(call.id);
  await Promise.all([
    f.voice.compute(call.id, 'tool-1', 'Research'),
    f.voice.compute(call.id, 'tool-1', 'Research'),
  ]);
  expect(f.turn).toHaveBeenCalledTimes(1);
  expect(f.turn.mock.calls[0]?.[0]).toBe('thread');
  await f.voice.end(call.id, 'Confirmed discussion');
  expect(
    f.transport.mock.calls.some(([url]) =>
      String(url).endsWith('/rtc_test/hangup'),
    ),
  ).toBe(true);
  expect(f.workspace.call(call.id).status).toBe('ended');
  expect(f.turn).toHaveBeenLastCalledWith(
    'thread',
    expect.stringContaining('Record a short call receipt'),
    expect.any(AbortSignal),
    { opendotsSource: 'voice_receipt' },
    { model: undefined },
  );
  await expect(f.voice.compute(call.id, 'late', 'Research')).rejects.toThrow(
    'ended',
  );
});
it('rejects unowned threads before provider contact and expires unactivated peers', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await expect(
    f.voice.begin('foreign', offer, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.transport).not.toHaveBeenCalled();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(30_001);
  expect(f.workspace.call(call.id).status).toBe('failed');
  expect(
    f.transport.mock.calls.some(([url]) => String(url).endsWith('/hangup')),
  ).toBe(true);
});
it('aborts a pending history lookup without starting a provider session', async () => {
  const f = fixture();
  f.history.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = f.voice.begin('thread', offer, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  expect(f.transport).not.toHaveBeenCalled();
});
it('fails visibly for provider errors and does not claim an active call', async () => {
  const f = fixture();
  f.transport.mockResolvedValue(
    new Response('provider error', { status: 429 }),
  );
  await expect(
    f.voice.begin('thread', offer, new AbortController().signal),
  ).rejects.toThrow('429');
  expect(f.workspace.calls()[0].status).toBe('failed');
});
it('hangs up a provisioned peer whose SDP is invalid', async () => {
  const f = fixture();
  f.transport.mockResolvedValueOnce(
    new Response('invalid SDP', {
      headers: { location: '/v1/realtime/calls/rtc_test' },
    }),
  );
  await expect(
    f.voice.begin('thread', offer, new AbortController().signal),
  ).rejects.toThrow('invalid SDP');
  expect(
    f.transport.mock.calls.some(([url]) =>
      String(url).endsWith('/rtc_test/hangup'),
    ),
  ).toBe(true);
});
it('saves a late transcript after expiry without changing the ended status or duration', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(30_001);
  const expired = f.workspace.call(call.id);
  await f.voice.end(call.id, 'Buffered speech at disconnect');
  await f.voice.end(call.id, 'Buffered speech at disconnect');
  expect(f.workspace.call(call.id)).toMatchObject({
    status: 'failed',
    endedAt: expired.endedAt,
    transcript: 'Buffered speech at disconnect',
  });
  expect(f.turn).toHaveBeenCalledTimes(1);
});
it('defers paused transcript synchronization and resumes it once without a duplicate turn', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.store.updateSettings({ paused: true });
  f.voice.abortAll();
  await f.voice.end(call.id, 'Speech saved while paused');
  expect(f.turn).not.toHaveBeenCalled();
  expect(f.workspace.call(call.id).transcript).toBe(
    'Speech saved while paused',
  );
  expect(f.workspace.call(call.id).error).toContain(
    'pending conversation sync',
  );
  f.store.updateSettings({ paused: false });
  await f.voice.resumePending();
  await f.voice.resumePending();
  expect(f.turn).toHaveBeenCalledTimes(1);
  expect(f.workspace.call(call.id).status).toBe('failed');
});

it('reports rejected provider hangup status without exposing its response body', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.transport.mockResolvedValueOnce(
    new Response('sensitive provider details', { status: 409 }),
  );
  const ended = await f.voice.end(call.id, 'Confirmed discussion');
  expect(ended.status).toBe('ended');
  expect(ended.error).toContain('HTTP 409');
  expect(ended.error).not.toContain('sensitive provider details');
});
it('reports transport hangup failures without exposing transport errors', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.transport.mockRejectedValueOnce(new Error('sensitive transport details'));
  const ended = await f.voice.end(call.id, 'Confirmed discussion');
  expect(ended.error).toBe(
    'The local call stopped, but provider hangup failed (Error).',
  );
});

it('distinguishes provider hangup timeout from transport failure', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.transport.mockRejectedValueOnce(
    new DOMException('sensitive timeout details', 'TimeoutError'),
  );
  const ended = await f.voice.end(call.id, 'Confirmed discussion');
  expect(ended.error).toBe(
    'The local call stopped, but provider hangup timed out.',
  );
});
it('sanitizes custom provider transport error names', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const error = new Error('sensitive transport details');
  error.name = 'sensitive provider identifier';
  f.transport.mockRejectedValueOnce(error);
  const ended = await f.voice.end(call.id, 'Confirmed discussion');
  expect(ended.error).toBe(
    'The local call stopped, but provider hangup failed (transport error).',
  );
});
it('allows a rejected compute call to be retried with the same tool ID', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.voice.activate(call.id);
  f.turn.mockRejectedValueOnce(new Error('Provider unavailable'));
  await expect(f.voice.compute(call.id, 'retry', 'Research')).rejects.toThrow(
    'Provider unavailable',
  );
  await expect(f.voice.compute(call.id, 'retry', 'Research')).resolves.toBe(
    'Current answer',
  );
  expect(f.turn).toHaveBeenCalledTimes(2);
  await f.voice.end(call.id, '');
});
it('counts failed compute attempts toward the per-call limit', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.voice.activate(call.id);
  for (let i = 0; i < 6; i++) {
    f.turn.mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(
      f.voice.compute(call.id, `failed-${i}`, 'Research'),
    ).rejects.toThrow('Provider unavailable');
  }
  await expect(f.voice.compute(call.id, 'success', 'Research')).rejects.toThrow(
    'limit of 6 delegated turns',
  );
  expect(f.turn).toHaveBeenCalledTimes(6);
  await f.voice.end(call.id, '');
});
it('counts a retry of the same tool ID as another attempt', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.voice.activate(call.id);
  for (let i = 0; i < 6; i++) {
    f.turn.mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(f.voice.compute(call.id, 'same', 'Research')).rejects.toThrow(
      'Provider unavailable',
    );
  }
  await expect(f.voice.compute(call.id, 'same', 'Research')).rejects.toThrow(
    'limit of 6 delegated turns',
  );
  expect(f.turn).toHaveBeenCalledTimes(6);
  await f.voice.end(call.id, '');
});
it('keeps successful compute turns cached and enforces the per-call limit', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.voice.activate(call.id);
  for (let i = 0; i < 6; i++) {
    await expect(f.voice.compute(call.id, String(i), 'Research')).resolves.toBe(
      'Current answer',
    );
  }
  await expect(f.voice.compute(call.id, '0', 'Research')).resolves.toBe(
    'Current answer',
  );
  expect(f.turn).toHaveBeenCalledTimes(6);
  await expect(f.voice.compute(call.id, 'extra', 'Research')).rejects.toThrow(
    'limit of 6 delegated turns',
  );
  await f.voice.end(call.id, '');
});

const live = { voiceProvider: 'live', voiceModel: 'gpt-live-1' } as const;
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

it('creates a GPT-Live session with client delegation and seeded history, then attaches', async () => {
  const f = fixture(live);
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  expect(call.provider).toBe('live');
  expect(f.workspace.call(call.id).provider).toBe('live');
  const [url, init] = f.transport.mock.calls[0];
  expect(String(url)).toBe('https://api.openai.com/v1/live/sessions');
  const body = JSON.parse(String(init?.body));
  expect(body.transport).toEqual({ type: 'webrtc', sdp: offer });
  expect(body.session).toMatchObject({
    model: 'gpt-live-1',
    audio: { output: { voice: 'marin' } },
    delegation: { type: 'client' },
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Earlier topic' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Earlier answer' }],
      },
    ],
  });
  expect(f.history).not.toHaveBeenCalled();
  expect(f.sockets[0].url).toBe(
    'wss://api.openai.com/v1/live/sessions/live_test/attach',
  );
  expect(f.sockets[0].headers.Authorization).toBe('Bearer test-secret');
  await f.voice.end(call.id, '');
});

it('answers a delegation once with the task model and speaks the result', async () => {
  const f = fixture({ ...live, voiceTaskModel: 'fast-model' });
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.voice.activate(call.id);
  const socket = f.sockets[0];
  socket.emit({ type: 'session.input_transcript.delta', delta: 'What is ' });
  socket.emit({ type: 'session.input_transcript.delta', delta: 'on today?' });
  const delegation = {
    type: 'session.delegation.created',
    delegation: { id: 'item_1', type: 'delegation', target: 'client' },
  };
  socket.emit(delegation);
  socket.emit(delegation);
  await vi.waitFor(() =>
    expect(socket.types()).toContain('session.commentary.append'),
  );
  expect(f.turn).toHaveBeenCalledTimes(1);
  const [thread, prompt, , , options] = f.turn.mock.calls[0];
  expect(thread).toBe('thread');
  expect(prompt).toContain('What is on today?');
  expect(options).toEqual({ model: 'fast-model' });
  expect(socket.sent).toContainEqual(
    expect.objectContaining({
      type: 'session.thinking.append',
      delegation_id: 'item_1',
    }),
  );
  expect(socket.sent).toContainEqual(
    expect.objectContaining({
      type: 'session.commentary.append',
      delegation_id: 'item_1',
      content: 'Current answer',
    }),
  );
  await f.voice.end(call.id, '');
});

it('allows 20 delegated turns per call when no limit is configured', async () => {
  const f = fixture({ voiceTaskLimit: undefined });
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  for (let i = 0; i < 20; i++)
    await f.voice.compute(call.id, String(i), 'Research');
  await expect(f.voice.compute(call.id, 'extra', 'Research')).rejects.toThrow(
    'limit of 20 delegated turns',
  );
  await f.voice.end(call.id, '');
});

it('queues overlapping delegations instead of failing the second', async () => {
  const f = fixture(live);
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  let release!: () => void;
  let running = 0;
  let overlapped = false;
  f.turn.mockImplementation(async () => {
    running += 1;
    if (running > 1) overlapped = true;
    if (f.turn.mock.calls.length === 1)
      await new Promise<void>((resolve) => (release = resolve));
    running -= 1;
    return 'Current answer';
  });
  const socket = f.sockets[0];
  socket.emit({ type: 'session.input_transcript.delta', delta: 'First' });
  socket.emit({
    type: 'session.delegation.created',
    delegation: { id: 'item_1', target: 'client' },
  });
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(1));
  socket.emit({ type: 'session.input_transcript.delta', delta: 'Second' });
  socket.emit({
    type: 'session.delegation.created',
    delegation: { id: 'item_2', target: 'client' },
  });
  await settle();
  expect(f.turn).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(2));
  expect(overlapped).toBe(false);
  expect(f.turn.mock.calls[1][1]).toContain('Second');
  await vi.waitFor(() =>
    expect(
      socket.sent.filter(
        (event) =>
          event.type === 'session.commentary.append' &&
          event.delegation_id === 'item_2',
      ),
    ).toHaveLength(1),
  );
  await f.voice.end(call.id, '');
});

it('does not spend a turn on a repeat delegation with no new speech', async () => {
  const f = fixture(live);
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const socket = f.sockets[0];
  socket.emit({ type: 'session.input_transcript.delta', delta: 'Question' });
  for (const id of ['item_1', 'item_2'])
    socket.emit({
      type: 'session.delegation.created',
      delegation: { id, target: 'client' },
    });
  await vi.waitFor(() =>
    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        type: 'session.thinking.append',
        delegation_id: 'item_2',
        content: expect.stringContaining('already answers'),
      }),
    ),
  );
  expect(f.turn).toHaveBeenCalledTimes(1);
  await f.voice.end(call.id, '');
});

it('speaks a failed delegation instead of leaving the caller waiting', async () => {
  const f = fixture(live);
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.turn.mockRejectedValueOnce(new Error('Provider unavailable'));
  const socket = f.sockets[0];
  socket.emit({
    type: 'session.delegation.created',
    delegation: { id: 'item_1', target: 'client' },
  });
  await vi.waitFor(() =>
    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        type: 'session.commentary.append',
        content: expect.stringContaining('Provider unavailable'),
      }),
    ),
  );
  await f.voice.end(call.id, '');
});

it('closes gracefully on end and keeps the server transcript', async () => {
  const f = fixture(live);
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const socket = f.sockets[0];
  socket.emit({ type: 'session.input_transcript.delta', delta: 'Hello' });
  socket.emit({ type: 'session.output_transcript.delta', delta: 'Hi there' });
  const ending = f.voice.end(call.id, 'You: browser copy');
  await settle();
  expect(socket.types()).toContain('session.close');
  socket.emit({ type: 'session.closed', reason: 'close_requested' });
  const ended = await ending;
  expect(ended.status).toBe('ended');
  expect(ended.transcript).toBe('You: Hello\nDot: Hi there');
  expect(ended.error).toBeNull();
  expect(
    f.transport.mock.calls.some(([url]) => String(url).endsWith('/hangup')),
  ).toBe(false);
  expect(f.turn).toHaveBeenCalledTimes(1);
  expect(f.turn.mock.calls[0][1]).toContain('You: Hello');
});

it('hangs up when the session does not confirm close in time', async () => {
  const f = fixture(live);
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  await f.voice.end(call.id, '');
  expect(
    f.transport.mock.calls.some(([url]) =>
      String(url).endsWith('/v1/live/sessions/live_test/hangup'),
    ),
  ).toBe(true);
  expect(f.sockets[0].closed).toBe(true);
});

it('ends the call once when the provider closes the session', async () => {
  const f = fixture(live);
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.sockets[0].emit({ type: 'session.input_transcript.delta', delta: 'Bye' });
  f.sockets[0].emit({ type: 'session.closed', reason: 'expired' });
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(1));
  await f.voice.end(call.id, 'You: browser copy');
  const ended = f.workspace.call(call.id);
  expect(ended).toMatchObject({ status: 'ended', transcript: 'You: Bye' });
  expect(ended.error).toContain('duration limit');
  expect(f.turn).toHaveBeenCalledTimes(1);
});

it('ends the call and hangs up when the control connection drops', async () => {
  const f = fixture(live);
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.sockets[0].handlers.close();
  await vi.waitFor(() =>
    expect(f.workspace.call(call.id).status).toBe('ended'),
  );
  await vi.waitFor(() =>
    expect(
      f.transport.mock.calls.some(([url]) => String(url).endsWith('/hangup')),
    ).toBe(true),
  );
  expect(f.workspace.call(call.id).error).toContain('control connection');
});

it('fails the call and hangs up when the server cannot attach', async () => {
  const f = fixture(live);
  f.failSockets();
  await expect(
    f.voice.begin('thread', offer, new AbortController().signal),
  ).rejects.toThrow('control connection failed');
  expect(f.workspace.calls()[0]).toMatchObject({
    status: 'failed',
    provider: 'live',
  });
  expect(
    f.transport.mock.calls.some(([url]) =>
      String(url).endsWith('/v1/live/sessions/live_test/hangup'),
    ),
  ).toBe(true);
});

it("shows the provider's reason when GPT-Live rejects the session", async () => {
  const f = fixture(live);
  f.transport.mockResolvedValueOnce(
    Response.json(
      {
        error: {
          type: 'invalid_request_error',
          code: 'invalid_value',
          param: 'session.model',
          message: 'Model gpt-realtime-2.1 is not supported by GPT-Live.',
        },
      },
      { status: 400 },
    ),
  );
  await expect(
    f.voice.begin('thread', offer, new AbortController().signal),
  ).rejects.toThrow(
    'Voice provider returned HTTP 400 (invalid_value, session.model): Model gpt-realtime-2.1 is not supported by GPT-Live.',
  );
  expect(f.workspace.calls()[0].error).toContain('session.model');
});

it('splits long answers into appends and points to the chat', () => {
  const sentence = 'This is a sentence about the plan. ';
  const pieces = appendPieces(
    `## Plan\n\n**Bold** [link](https://x.test) ${sentence.repeat(200)}`,
  );
  expect(pieces.length).toBe(3);
  expect(pieces.every((piece) => piece.length <= 1800)).toBe(true);
  expect(pieces[0].startsWith('Plan\n\nBold link ')).toBe(true);
  expect(pieces.at(-1)).toContain('The full answer is in the chat.');
});
