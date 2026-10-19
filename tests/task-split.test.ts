import { afterEach, expect, it, vi } from 'vitest';
import {
  classifyTurn,
  joinBriefs,
  routedModel,
  splitRequest,
  taskModel,
  type TaskInput,
} from '../src/server/task-brief.js';
import { taskRoute } from '../src/server/task-queue.js';
import { taskSplitFromEnv } from '../src/server/platform-config.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import {
  decide,
  TASK_APPROVAL_BLOCKED,
  type AuthSnapshot,
  type ExecutionContext,
} from '../src/server/authorize.js';
import { ChatTaskService, chatTaskReply } from '../src/server/chat-tasks.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { SqliteThreadRunner } from '../src/server/thread-runner.js';
import { NotificationService } from '../src/server/notifications.js';
import { chatTaskMessagePrefix } from '../src/shared/call-task.js';
import type { CompleteJson } from '../src/server/model-json.js';
import type { Decide } from '../src/server/decisions.js';

const resources: (() => void)[] = [];
afterEach(() => {
  resources.splice(0).forEach((close) => close());
  vi.restoreAllMocks();
});

const input: TaskInput = {
  words: 'Check the weather and book a table, then text Sam the time',
  transcript: '',
  chat: '',
  openTasks: [],
};

it('splits a request into tasks with earlier-task dependencies and complexity labels', async () => {
  const complete = vi.fn<CompleteJson>(async () => ({
    tasks: [
      { label: 'Weather', task: 'Check the weather.', complexity: 'simple' },
      { label: 'Book a table', task: 'Book a table.', complexity: 'deep' },
      {
        label: 'Text Sam',
        task: 'Text Sam the booking time.',
        after: [2, 3, 9, 2],
        complexity: 'reasoning',
      },
      { label: 'Extra', task: 'One more.' },
      { label: 'Too many', task: 'Over the cap.' },
    ],
    clarify: null,
  }));
  const split = await splitRequest(complete, input, { source: 'chat' });
  expect(split?.tasks.map((task) => task.label)).toEqual([
    'Weather',
    'Book a table',
    'Text Sam',
    'Extra',
  ]);
  expect(split?.tasks[0]).toMatchObject({ complexity: 'simple' });
  expect(split?.tasks[1].complexity).toBeUndefined();
  expect(split?.tasks[2]).toMatchObject({
    after: [1],
    complexity: 'reasoning',
  });
  expect(split?.tasks[0].after).toBeUndefined();
  expect(split?.clarify).toBeUndefined();
  const [request] = complete.mock.calls[0];
  expect(request.system).toContain('at most 4');
  expect(request.user).toContain("The owner's latest message");
});

it('asks for exactly one task when splitting is off, and falls back to null on failure', async () => {
  const complete = vi.fn<CompleteJson>(async () => ({
    tasks: [
      { label: 'One', task: 'First.' },
      { label: 'Two', task: 'Second.' },
    ],
  }));
  const one = await splitRequest(complete, input, { maxTasks: 1 });
  expect(one?.tasks).toHaveLength(1);
  expect(complete.mock.calls[0][0].system).toContain('exactly one task');
  expect(complete.mock.calls[0][0].system).not.toContain('"after"');
  await expect(
    splitRequest(async () => ({ tasks: [] }), input),
  ).resolves.toBeNull();
  await expect(
    splitRequest(async () => ({ nope: true }), input),
  ).resolves.toBeNull();
  await expect(
    splitRequest(() => new Promise(() => {}), input, { timeoutMs: 10 }),
  ).resolves.toBeNull();
});

it('joins split briefs back into one task', () => {
  expect(
    joinBriefs([
      { label: 'Book 8pm', task: 'Book for 8pm.', context: 'Two people.' },
      { label: 'Tell Sam', task: 'Tell Sam.', context: 'Two people.' },
    ]),
  ).toEqual({
    label: 'Book 8pm and Tell Sam',
    task: '1. Book for 8pm.\n2. Tell Sam.',
    context: 'Two people.',
  });
});

it('routes tasks to the fast model unless the answer is an explicit reasoning', () => {
  const config = { fastModel: 'fast' };
  expect(taskModel('reasoning', config, 'deep')).toBe('deep');
  expect(taskModel('simple', config, 'deep')).toBe('fast');
  expect(taskModel(undefined, config, 'deep')).toBe('fast');
  expect(taskModel(undefined, {}, 'deep')).toBe('deep');
  const low = { complexity: { choice: 'simple' as const, confidence: 0.3 } };
  const routing = { relatesTo: null, isCorrection: 0, needsClarification: 0 };
  expect(
    taskRoute({ routing: { ...routing, ...low } }, config, 'deep'),
  ).toEqual({ model: 'fast', source: 'decisions', answer: 'simple' });
  expect(taskRoute({ routing: null }, config, 'deep')).toEqual({
    model: 'fast',
    source: 'default',
    answer: null,
  });
  expect(
    taskRoute(
      {
        split: true,
        brief: { label: 'x', task: 'x', context: '' },
        routing: {
          ...routing,
          complexity: { choice: 'reasoning', confidence: 1 },
        },
      },
      config,
      'deep',
    ),
  ).toEqual({ model: 'fast', source: 'default', answer: null });
  expect(
    taskRoute(
      {
        split: true,
        brief: { label: 'x', task: 'x', context: '', complexity: 'reasoning' },
      },
      config,
      'deep',
    ),
  ).toEqual({ model: 'deep', source: 'splitter', answer: 'reasoning' });
  expect(taskRoute({ routing: null }, {}, 'deep').model).toBe('deep');
  // Main chat turns cannot escalate, so they keep the confidence threshold.
  expect(routedModel(low.complexity, config, 'deep')).toBe('deep');
  expect(
    routedModel({ choice: 'simple', confidence: 0.8 }, config, 'deep'),
  ).toBe('fast');
});

it('reads TASK_SPLIT and asks multiple_requests only when splitting', async () => {
  expect(taskSplitFromEnv(undefined)).toBe(true);
  expect(taskSplitFromEnv('ON')).toBe(true);
  expect(taskSplitFromEnv('off')).toBe(false);
  expect(() => taskSplitFromEnv('maybe')).toThrow('TASK_SPLIT');
  const decideFn = vi.fn<Decide>(async ({ questions }) =>
    Object.fromEntries(
      questions.map((question) => [
        question.name,
        question.type === 'predicate'
          ? { type: 'predicate', name: question.name, probability: 0.9 }
          : {
              type: 'choice',
              name: question.name,
              choice: 'simple',
              confidence: 0.95,
            },
      ]),
    ),
  );
  await expect(
    classifyTurn(decideFn, { latest: 'Hi', history: '' }),
  ).resolves.toEqual({
    complexity: { choice: 'simple', confidence: 0.95 },
    multipleRequests: null,
  });
  await expect(
    classifyTurn(decideFn, { latest: 'A and B', history: '' }, undefined, {
      multipleRequests: true,
    }),
  ).resolves.toMatchObject({ multipleRequests: 0.9 });
  expect(
    decideFn.mock.calls.map(([request]) =>
      request.questions.map((question) => question.name),
    ),
  ).toEqual([['complexity'], ['complexity', 'multiple_requests']]);
});

it('blocks approval requests in task threads with a needs_owner instruction', () => {
  const ctx: ExecutionContext = {
    actorId: 'dot',
    ownerId: 'owner',
    executionId: '',
    threadId: 'child',
    mode: 'interactive',
    cause: 'model',
  };
  const snapshot: AuthSnapshot = {
    paused: false,
    cancelled: false,
    consultation: false,
    researchAllowed: true,
    memoryAllowed: true,
    spaceAllowed: () => true,
    documentAllowed: () => true,
    pluginAllowed: () => true,
    pluginPolicy: () => ({ ask: true, violation: null }),
    skillAllowed: () => true,
    rules: [
      {
        id: 'ask-edit',
        dotId: null,
        text: 'Ask before editing',
        mode: 'ask',
        toolNames: ['edit_space_page'],
      },
    ],
    blockedOnConsultation: new Set(),
  };
  expect(decide(ctx, 'edit_space_page', {}, snapshot)).toMatchObject({
    effect: 'pending',
  });
  const task = { ...snapshot, taskThread: true };
  expect(decide(ctx, 'edit_space_page', {}, task)).toEqual({
    effect: 'block',
    reason: TASK_APPROVAL_BLOCKED,
  });
  expect(decide(ctx, 'plugin_mail_send', {}, task)).toEqual({
    effect: 'block',
    reason: TASK_APPROVAL_BLOCKED,
  });
  expect(TASK_APPROVAL_BLOCKED).toContain('needs_owner');
  expect(decide(ctx, 'search_web', {}, task).effect).toBe('allow');
});

it('runs split chat tasks in parallel, waits on earlier results, and posts each result as it finishes', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  resources.push(() => {
    store.close();
    workspace.close();
  });
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Chat');
  const runner = new SqliteThreadRunner(workspace.threads);
  const notifications = new NotificationService(store.database);
  const releases = new Map<string, () => void>();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const turn = vi.fn(
    async (
      childThreadId: string,
      prompt: string,
      _signal: AbortSignal,
      _metadata?: Record<string, unknown>,
      _options?: { model?: string },
    ) => {
      const label = /Task: (.*)/.exec(prompt)![1];
      await new Promise<void>((resolve) => releases.set(label, resolve));
      workspace.saveCallTaskReport(childThreadId, {
        status: 'done',
        facts: `${label} facts`,
        spoken: `${label} summary`,
        details: `${label} details`,
      });
      return 'Reported.';
    },
  );
  const service = new ChatTaskService(
    {
      workspace,
      store,
      config: {
        fastModel: 'fast',
        model: 'main',
        baseUrl: 'https://unused.invalid/v1',
        voiceName: 'marin',
        slackUsers: [],
      } as PlatformConfig,
      turn,
      runner,
      services: { notifications },
    },
    undefined,
  );
  const briefs = [
    {
      label: 'Weather',
      task: 'Weather',
      context: '',
      complexity: 'simple' as const,
    },
    {
      label: 'Booking',
      task: 'Booking',
      context: '',
      complexity: 'reasoning' as const,
    },
    { label: 'Reply', task: 'Reply', context: '', after: [0] },
  ];
  expect(chatTaskReply(briefs)).toBe(
    "Working on these separately:\n1. Weather\n2. Booking\n3. Reply\n\nEach result will appear here when it's ready.",
  );
  service.start({
    parentThreadId: 'thread',
    dotId: dot.id,
    runId: 'run-1',
    tasks: briefs,
  });
  await vi.waitFor(() => expect(releases.size).toBe(2));
  expect([...releases.keys()]).toEqual(['Weather', 'Booking']);
  expect(turn.mock.calls.map((call) => call[4]?.model)).toEqual([
    'fast',
    'main',
  ]);
  expect(turn.mock.calls[0][3]).toMatchObject({ opendotsSource: 'chat_task' });
  const records = workspace.callTasks('run-1');
  expect(records.map((record) => [record.source, record.label])).toEqual([
    ['chat', 'Weather'],
    ['chat', 'Booking'],
    ['chat', 'Reply'],
  ]);
  expect(workspace.threadKind(records[0].childThreadId)).toBe('call_task');

  releases.get('Weather')!();
  await vi.waitFor(() => expect(releases.has('Reply')).toBe(true));
  const messages = () => workspace.threads.messages('thread');
  expect(messages().map((message) => message.content)).toEqual([
    'Task 1: Weather\n\nWeather',
    'Weather details',
  ]);
  expect(messages()[0].id.startsWith(chatTaskMessagePrefix)).toBe(true);
  expect(turn.mock.calls[2][1]).toContain('- Weather: Weather facts');
  expect(turn.mock.calls[2][4]?.model).toBe('fast');
  expect(notifications.list()).toHaveLength(1);
  expect(notifications.list()[0]).toMatchObject({
    kind: 'reply',
    threadId: 'thread',
    title: expect.stringContaining('"Weather"'),
  });

  releases.get('Reply')!();
  releases.get('Booking')!();
  await service.settled();
  expect(service.open()).toHaveLength(0);
  expect(workspace.callTasks('run-1').map((record) => record.status)).toEqual([
    'done',
    'done',
    'done',
  ]);
  expect(messages()).toHaveLength(6);
  expect(notifications.list()).toHaveLength(3);
});
