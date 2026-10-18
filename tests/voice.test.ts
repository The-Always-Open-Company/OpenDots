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
import { SqliteThreadRunner } from '../src/server/thread-runner.js';
import { NotificationService } from '../src/server/notifications.js';
import type {
  Routing,
  TaskBrief,
  TaskPlanner,
} from '../src/server/task-brief.js';
import type { DeliveryTiming } from '../src/server/call-tasks.js';
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
function fixture(
  overrides: Partial<PlatformConfig> = {},
  options: { planner?: TaskPlanner; delivery?: Partial<DeliveryTiming> } = {},
) {
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
  const notifications = new NotificationService(store.database);
  const runner = new SqliteThreadRunner(workspace.threads);
  const voice = new VoiceService(
    {
      workspace,
      store,
      config,
      turn,
      history,
      historyMessages,
      runner,
      services: { notifications },
      requireReady() {},
      setup: () => ({
        voice: true,
        voiceNotes: true,
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
    {
      socket,
      settleMs: 0,
      closeTimeoutMs: 50,
      planner: options.planner ?? {
        route: async () => null,
        brief: async () => null,
      },
      delivery: {
        quietMs: 0,
        speechWaitMs: 0,
        batchMs: 0,
        ackGraceMs: 1000,
        idleUpgradeMs: 60_000,
        tickMs: 5,
        ...options.delivery,
      },
    },
  );
  return {
    voice,
    transport,
    workspace,
    store,
    notifications,
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

const delegate = (socket: FakeSocket, id: string, extra = {}) =>
  socket.emit({
    type: 'session.delegation.created',
    delegation: { id, target: 'client', ...extra },
  });
const appends = (socket: FakeSocket, type: string, id?: string) =>
  socket.sent.filter(
    (event) =>
      event.type === `session.${type}.append` &&
      (id === undefined || event.delegation_id === id) &&
      !String(event.content).startsWith('The backend is working'),
  );
const brief = (label: string, task = label): TaskBrief => ({
  label,
  task,
  context: '',
});
const routing = (patch: Partial<Routing> = {}): Routing => ({
  relatesTo: null,
  isCorrection: 0,
  needsClarification: 0,
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

it('runs a delegation once on its own child thread and speaks the result to a waiting owner', async () => {
  const f = fixture({ ...live, voiceTaskModel: 'task-model' });
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.voice.activate(call.id);
  const socket = f.sockets[0];
  socket.emit({ type: 'session.input_transcript.delta', delta: 'What is ' });
  socket.emit({ type: 'session.input_transcript.delta', delta: 'on today?' });
  delegate(socket, 'item_1');
  delegate(socket, 'item_1');
  await vi.waitFor(() =>
    expect(appends(socket, 'commentary', 'item_1')).toHaveLength(1),
  );
  expect(f.turn).toHaveBeenCalledTimes(1);
  const [thread, prompt, , metadata, options] = f.turn.mock.calls[0];
  const [task] = f.workspace.callTasks(call.id);
  expect(thread).toBe(task.childThreadId);
  expect(f.workspace.threadKind(thread)).toBe('call_task');
  expect(f.workspace.conversations().map((item) => item.id)).toEqual([
    'thread',
  ]);
  expect(prompt).toContain('What is on today?');
  expect(prompt).toContain('report_call_result');
  expect(metadata).toMatchObject({
    opendotsSource: 'call_task',
    callId: call.id,
  });
  expect(options).toEqual({ model: 'task-model' });
  expect(String(appends(socket, 'commentary', 'item_1')[0].content)).toMatch(
    /^\[Task 1: What is on today\?\] Status: done\. Facts: Current answer/,
  );
  expect(f.workspace.callTask(task.id)?.status).toBe('done');
  await f.voice.end(call.id, '');
});

it('appends a compact exchange for each finished task to the main thread', async () => {
  const f = fixture(live, {
    planner: {
      route: async () => routing(),
      brief: async () => brief('Acme renewal', 'Find the Acme renewal date.'),
    },
  });
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.turn.mockImplementation(async (childThreadId) => {
    f.workspace.saveCallTaskReport(childThreadId, {
      status: 'needs_owner',
      facts: 'Renewal is on 3 March.',
      spoken: 'Acme renews on 3 March.',
      details: 'Acme renews on **3 March**.',
      needsOwner: 'Should I draft the renewal email?',
    });
    return 'Reported.';
  });
  const socket = f.sockets[0];
  socket.emit({
    type: 'session.input_transcript.delta',
    delta: 'When does Acme renew?',
  });
  delegate(socket, 'item_1');
  await vi.waitFor(() =>
    expect(appends(socket, 'commentary', 'item_1')).toHaveLength(1),
  );
  const messages = f.workspace.threads.messages('thread');
  expect(messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
  ]);
  expect(messages[0].id).toMatch(/^opendots:call_task:/);
  expect(messages[0].content).toBe(
    'Call task 1: Acme renewal\n\nFind the Acme renewal date.',
  );
  expect(messages[1].content).toBe(
    'Acme renews on **3 March**.\n\n**Question for you:** Should I draft the renewal email?',
  );
  expect(f.workspace.threads.runs('thread')).toHaveLength(1);
  expect(String(appends(socket, 'commentary', 'item_1')[0].content)).toContain(
    'Owner needs to: Should I draft the renewal email?',
  );
  await f.voice.end(call.id, '');
});

it("picks each delegation's words by offset_ms and leaves later speech for the next", async () => {
  const f = fixture(live);
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const socket = f.sockets[0];
  socket.emit({
    type: 'session.input_transcript.delta',
    delta: 'Check the weather. ',
    start_ms: 1000,
    end_ms: 2000,
  });
  socket.emit({
    type: 'session.input_transcript.delta',
    delta: 'Also book a table.',
    start_ms: 6000,
    end_ms: 7000,
  });
  delegate(socket, 'item_1', { offset_ms: 2100 });
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(1));
  delegate(socket, 'item_2', { offset_ms: 7100 });
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(2));
  const prompts = f.turn.mock.calls.map(([, prompt]) => prompt);
  expect(prompts[0]).toContain('latest words: Check the weather.');
  expect(prompts[0]).not.toContain('latest words: Check the weather. Also');
  expect(prompts[1]).toContain('latest words: Also book a table.');
  await f.voice.end(call.id, '');
});

it('does not start a task for a repeat delegation with no new speech', async () => {
  const f = fixture(live);
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const socket = f.sockets[0];
  socket.emit({ type: 'session.input_transcript.delta', delta: 'Question' });
  delegate(socket, 'item_1');
  delegate(socket, 'item_2');
  await vi.waitFor(() =>
    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        type: 'session.thinking.append',
        delegation_id: 'item_2',
        content: expect.stringContaining(
          'tasks already started cover this one',
        ),
      }),
    ),
  );
  expect(f.turn).toHaveBeenCalledTimes(1);
  await f.voice.end(call.id, '');
});

it('writes the brief and routes at the same time, using the brief for the prompt', async () => {
  const route = deferred<Routing | null>();
  const written = deferred<TaskBrief | null>();
  const started: string[] = [];
  const f = fixture(live, {
    planner: {
      route: () => (started.push('route'), route.promise),
      brief: () => (started.push('brief'), written.promise),
    },
  });
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const socket = f.sockets[0];
  socket.emit({
    type: 'session.input_transcript.delta',
    delta: 'uh the second one',
  });
  delegate(socket, 'item_1');
  await vi.waitFor(() => expect(started).toEqual(['route', 'brief']));
  written.resolve({
    label: 'Move the Acme call',
    task: 'Move the Acme call to Friday at 3pm.',
    context: 'The owner has two calls with Acme this week.',
  });
  await settle();
  expect(f.turn).not.toHaveBeenCalled();
  route.resolve(routing());
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(1));
  const prompt = f.turn.mock.calls[0][1];
  expect(prompt).toContain('Task: Move the Acme call to Friday at 3pm.');
  expect(prompt).toContain('The owner has two calls with Acme this week.');
  expect(prompt).not.toContain('uh the second one');
  expect(f.workspace.callTasks(call.id)[0].label).toBe('Move the Acme call');
  await f.voice.end(call.id, '');
});

it('falls back to a templated prompt and the reasoning model when the brief and routing fail', async () => {
  const f = fixture(
    { ...live, fastModel: 'fast', voiceTaskModel: 'reasoning' },
    {
      planner: {
        route: async () => null,
        brief: async () => {
          throw new Error('brief model down');
        },
      },
    },
  );
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const socket = f.sockets[0];
  socket.emit({
    type: 'session.input_transcript.delta',
    delta: 'Plan my week',
  });
  delegate(socket, 'item_1');
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(1));
  expect(f.turn.mock.calls[0][1]).toContain(
    'Work out what the owner wants from their latest words and handle it. Their latest words: Plan my week',
  );
  expect(f.turn.mock.calls[0][4]).toEqual({ model: 'reasoning' });
  await f.voice.end(call.id, '');
});

it('sends confident simple tasks to the fast model and the rest to the reasoning model', async () => {
  const answers = [
    routing({ complexity: { choice: 'simple', confidence: 0.95 } }),
    routing({ complexity: { choice: 'simple', confidence: 0.6 } }),
    routing({ complexity: { choice: 'reasoning', confidence: 0.99 } }),
  ];
  const f = fixture(
    { ...live, fastModel: 'fast', voiceTaskModel: 'reasoning' },
    {
      planner: {
        route: async () => answers.shift()!,
        brief: async () => null,
      },
    },
  );
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const socket = f.sockets[0];
  for (const [index, words] of ['Time?', 'Weather?', 'Plan a trip'].entries()) {
    socket.emit({ type: 'session.input_transcript.delta', delta: words });
    delegate(socket, `item_${index}`);
    await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(index + 1));
  }
  expect(f.turn.mock.calls.map((args) => args[4]?.model)).toEqual([
    'fast',
    'reasoning',
    'reasoning',
  ]);
  expect(f.turn.mock.calls[0][1]).toContain('set escalate');
  expect(f.turn.mock.calls[1][1]).not.toContain('set escalate');
  await f.voice.end(call.id, '');
});

it('runs a fast task again once on the reasoning model when it escalates', async () => {
  const f = fixture(
    { ...live, fastModel: 'fast', voiceTaskModel: 'reasoning' },
    {
      planner: {
        route: async () =>
          routing({ complexity: { choice: 'simple', confidence: 0.99 } }),
        brief: async () => null,
      },
    },
  );
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.turn.mockImplementation(
    async (childThreadId, _prompt, _signal, _meta, options) => {
      f.workspace.saveCallTaskReport(childThreadId, {
        status: 'done',
        facts: `Answer from ${options?.model}`,
        spoken: '',
        details: `Answer from ${options?.model}`,
        escalate: true,
      });
      return 'Reported.';
    },
  );
  const socket = f.sockets[0];
  socket.emit({
    type: 'session.input_transcript.delta',
    delta: 'Compare plans',
  });
  delegate(socket, 'item_1');
  await vi.waitFor(() =>
    expect(appends(socket, 'commentary', 'item_1')).toHaveLength(1),
  );
  expect(f.turn.mock.calls.map((args) => args[4]?.model)).toEqual([
    'fast',
    'reasoning',
  ]);
  expect(f.turn.mock.calls[0][0]).toBe(f.turn.mock.calls[1][0]);
  expect(String(appends(socket, 'commentary', 'item_1')[0].content)).toContain(
    'Answer from reasoning',
  );
  await f.voice.end(call.id, '');
});

it('runs unrelated tasks in parallel and makes a related task wait for the one it follows', async () => {
  const relations: (string | null)[] = [null, null, 'task_1'];
  const f = fixture(live, {
    planner: {
      route: async () => routing({ relatesTo: relations.shift() ?? null }),
      brief: async (input) => brief(input.words),
    },
  });
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const releases = new Map<string, () => void>();
  let running = 0;
  let peak = 0;
  f.turn.mockImplementation(async (_thread, prompt) => {
    running += 1;
    peak = Math.max(peak, running);
    const words = /Task: (\w+)/.exec(prompt)![1];
    await new Promise<void>((resolve) => releases.set(words, resolve));
    running -= 1;
    return `${words} done`;
  });
  const socket = f.sockets[0];
  for (const [index, words] of ['First', 'Second', 'Followup'].entries()) {
    socket.emit({ type: 'session.input_transcript.delta', delta: words });
    delegate(socket, `item_${index + 1}`);
    await settle();
  }
  await vi.waitFor(() => expect(releases.size).toBe(2));
  expect(peak).toBe(2);
  expect([...releases.keys()]).toEqual(['First', 'Second']);
  releases.get('Second')!();
  await settle();
  expect(releases.has('Followup')).toBe(false);
  releases.get('First')!();
  await vi.waitFor(() => expect(releases.has('Followup')).toBe(true));
  releases.get('Followup')!();
  await vi.waitFor(() =>
    expect(f.workspace.callTasks(call.id).map((task) => task.status)).toEqual([
      'done',
      'done',
      'done',
    ]),
  );
  await f.voice.end(call.id, '');
});

it('caps parallel tasks at VOICE_TASK_CONCURRENCY', async () => {
  const f = fixture({ ...live, voiceTaskConcurrency: 1 });
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const release = deferred<void>();
  f.turn.mockImplementationOnce(async () => {
    await release.promise;
    return 'First done';
  });
  const socket = f.sockets[0];
  socket.emit({ type: 'session.input_transcript.delta', delta: 'First' });
  delegate(socket, 'item_1');
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(1));
  socket.emit({ type: 'session.input_transcript.delta', delta: 'Second' });
  delegate(socket, 'item_2');
  await settle();
  expect(f.turn).toHaveBeenCalledTimes(1);
  release.resolve();
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(2));
  await f.voice.end(call.id, '');
});

it('supersedes a task the owner corrects and drops its late result', async () => {
  const answers = [
    routing(),
    routing({ relatesTo: 'task_1', isCorrection: 0.95 }),
  ];
  const f = fixture(live, {
    planner: {
      route: async () => answers.shift()!,
      brief: async (input) => brief(input.words),
    },
  });
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  let aborted = false;
  const late = deferred<void>();
  f.turn.mockImplementationOnce(async (_thread, _prompt, signal) => {
    signal.addEventListener('abort', () => (aborted = true));
    await late.promise;
    return 'Booked for 7pm';
  });
  f.turn.mockImplementationOnce(async () => 'Booked for 8pm');
  const socket = f.sockets[0];
  socket.emit({ type: 'session.input_transcript.delta', delta: 'Book 7pm' });
  delegate(socket, 'item_1');
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(1));
  socket.emit({
    type: 'session.input_transcript.delta',
    delta: 'No, make it 8pm',
  });
  delegate(socket, 'item_2');
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(2));
  expect(aborted).toBe(true);
  late.resolve();
  await vi.waitFor(() =>
    expect(appends(socket, 'commentary', 'item_2')).toHaveLength(1),
  );
  await settle();
  const content = String(appends(socket, 'commentary', 'item_2')[0].content);
  expect(content).toMatch(/^\[Task 1, revision 2: No, make it 8pm\]/);
  expect(content).toContain('Replaces: the earlier revision');
  expect(appends(socket, 'commentary', 'item_1')).toHaveLength(0);
  expect(appends(socket, 'thinking', 'item_1')).toHaveLength(0);
  expect(
    f.workspace.callTasks(call.id).map((task) => [task.status, task.revision]),
  ).toEqual([
    ['superseded', 1],
    ['done', 2],
  ]);
  expect(
    f.workspace.threads
      .messages('thread')
      .map((message) => message.content)
      .join('\n'),
  ).not.toContain('7pm');
  await f.voice.end(call.id, '');
});

it('asks a clarifying question instead of starting an unclear task', async () => {
  const f = fixture(live, {
    planner: {
      route: async () => routing({ needsClarification: 0.9 }),
      brief: async () => ({ ...brief('Unclear'), clarify: 'Which meeting?' }),
    },
  });
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const socket = f.sockets[0];
  socket.emit({ type: 'session.input_transcript.delta', delta: 'Move it' });
  delegate(socket, 'item_1');
  await vi.waitFor(() =>
    expect(appends(socket, 'thinking', 'item_1')).toContainEqual(
      expect.objectContaining({
        content: expect.stringContaining('Ask the owner: Which meeting?'),
      }),
    ),
  );
  expect(f.turn).not.toHaveBeenCalled();
  expect(f.workspace.callTasks(call.id)[0].status).toBe('clarify');
  await f.voice.end(call.id, '');
});

it('passes a result quietly once the conversation has moved on', async () => {
  const f = fixture(live);
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const release = deferred<void>();
  f.turn.mockImplementationOnce(async () => {
    await release.promise;
    return 'Found it';
  });
  const socket = f.sockets[0];
  socket.emit({ type: 'session.input_transcript.delta', delta: 'Look it up' });
  delegate(socket, 'item_1');
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  socket.emit({
    type: 'session.input_transcript.delta',
    delta: 'Anyway, about lunch',
  });
  release.resolve();
  await vi.waitFor(() =>
    expect(appends(socket, 'thinking', 'item_1')).toHaveLength(1),
  );
  expect(String(appends(socket, 'thinking', 'item_1')[0].content)).toContain(
    'do not announce them',
  );
  expect(appends(socket, 'commentary')).toHaveLength(0);
  await f.voice.end(call.id, '');
});

it('speaks a failed delegation even when the conversation has moved on', async () => {
  const f = fixture(live);
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.turn.mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    throw new Error('Provider unavailable');
  });
  const socket = f.sockets[0];
  delegate(socket, 'item_1');
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(1));
  socket.emit({
    type: 'session.input_transcript.delta',
    delta: 'Something else',
  });
  await vi.waitFor(
    () =>
      expect(appends(socket, 'commentary', 'item_1')).toContainEqual(
        expect.objectContaining({
          content: expect.stringContaining('Provider unavailable'),
        }),
      ),
    { timeout: 3000 },
  );
  expect(f.workspace.callTasks(call.id)[0].status).toBe('failed');
  await f.voice.end(call.id, '');
});

it('keeps a task running after hangup, then posts its result to the chat with one notification', async () => {
  const f = fixture(live, {
    planner: {
      route: async () => routing(),
      brief: async () => brief('Acme research', 'Research Acme.'),
    },
  });
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const release = deferred<void>();
  let aborted = false;
  f.turn.mockImplementationOnce(async (_thread, _prompt, signal) => {
    signal.addEventListener('abort', () => (aborted = true));
    await release.promise;
    return 'Acme is growing.';
  });
  const socket = f.sockets[0];
  socket.emit({
    type: 'session.input_transcript.delta',
    delta: 'Research Acme',
  });
  delegate(socket, 'item_1');
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(1));
  await f.voice.end(call.id, '');
  expect(f.turn).toHaveBeenCalledTimes(2);
  expect(f.turn.mock.calls[1][0]).toBe('thread');
  expect(f.turn.mock.calls[1][1]).toContain('Still working on: Acme research.');
  expect(aborted).toBe(false);
  release.resolve();
  await vi.waitFor(() =>
    expect(f.workspace.callTasks(call.id)[0].status).toBe('done'),
  );
  expect(
    f.workspace.threads.messages('thread').map((message) => message.content),
  ).toContain('Acme is growing.');
  const notes = f.notifications.list();
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    kind: 'reply',
    threadId: 'thread',
    title: expect.stringContaining('"Acme research" after your call'),
  });
  expect(
    socket.sent.filter((event) => event.type === 'session.commentary.append'),
  ).toHaveLength(0);
});

it('sends spoken results still waiting at hangup to the chat', async () => {
  const f = fixture(live, { delivery: { quietMs: 60_000 } });
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const socket = f.sockets[0];
  socket.emit({
    type: 'session.input_transcript.delta',
    delta: 'Check the time',
  });
  delegate(socket, 'item_1');
  await vi.waitFor(() =>
    expect(f.workspace.callTasks(call.id)[0]?.status).toBe('done'),
  );
  expect(appends(socket, 'commentary')).toHaveLength(0);
  await f.voice.end(call.id, '');
  expect(f.notifications.list()).toHaveLength(1);
  expect(
    f.workspace.threads.messages('thread').map((message) => message.content),
  ).toContain('Current answer');
});

it('stops call tasks when the workspace is paused', async () => {
  const f = fixture(live);
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.turn.mockImplementationOnce(
    (_thread, _prompt, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  );
  const socket = f.sockets[0];
  socket.emit({ type: 'session.input_transcript.delta', delta: 'Long job' });
  delegate(socket, 'item_1');
  await vi.waitFor(() => expect(f.turn).toHaveBeenCalledTimes(1));
  f.store.updateSettings({ paused: true });
  f.voice.abortAll();
  await vi.waitFor(() =>
    expect(f.workspace.callTasks(call.id)[0].status).toBe('stopped'),
  );
});

it('marks running call tasks interrupted after a restart and posts a retry note', () => {
  const f = fixture(live);
  const call = f.workspace.createCall('thread', 'live');
  const task = f.workspace.createCallTask({
    callId: call.id,
    delegationId: 'item_1',
    parentThreadId: 'thread',
    label: 'Acme research',
  });
  f.workspace.updateCallTask(task.id, { status: 'running' });
  const done = f.workspace.createCallTask({
    callId: call.id,
    delegationId: 'item_2',
    parentThreadId: 'thread',
    label: 'Weather',
  });
  f.workspace.updateCallTask(done.id, { status: 'done' });
  f.voice.recoverCallTasks();
  f.voice.recoverCallTasks();
  expect(f.workspace.callTask(task.id)?.status).toBe('interrupted');
  expect(f.workspace.callTask(done.id)?.status).toBe('done');
  const messages = f.workspace.threads.messages('thread');
  expect(messages).toHaveLength(2);
  expect(messages[1].content).toContain('interrupted by a restart');
  expect(f.notifications.list()).toHaveLength(1);
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
