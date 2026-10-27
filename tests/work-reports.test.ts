import type { AbstractAgent } from '@ag-ui/client';
import { afterEach, expect, it } from 'vitest';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import { Store } from '../src/server/store.js';
import { SqliteThreadRunner } from '../src/server/thread-runner.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { reportWork } from '../src/server/work-reports.js';
import { workResultPrefix } from '../src/shared/work-marker.js';

const open: { close(): void }[] = [];
afterEach(() => open.splice(0).forEach((db) => db.close()));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  open.push(store, workspace);
  let now = 1_700_000_000_000;
  const engine = new ExecutionEngine(store.database, () => now);
  const dot = workspace.dots()[0];
  const chat = workspace.bindThread('chat', dot.id, 'Plans');
  const posts: { threadId: string; reply: string; label: string }[] = [];
  reportWork(engine, workspace, {
    appendExchange: (threadId, _dotId, prompt, reply) => {
      posts.push({
        threadId,
        reply,
        label: String(prompt.content).split('\n')[0],
      });
      return { id: 'posted', role: 'assistant' as const, content: reply };
    },
  });
  return {
    workspace,
    engine,
    dot,
    chat,
    posts,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function remember(
  workspace: WorkspaceStore,
  dotId: string,
  threadId: string,
  text: string,
) {
  workspace.bindThread(threadId, dotId, 'Work', 'work');
  workspace.threads.appendRun(
    {
      runId: `run-${threadId}`,
      threadId,
      agentId: dotId,
      parentRunId: null,
      events: [],
      createdAt: 1,
    },
    [
      { id: 'ask', role: 'user', content: 'Objective' },
      { id: 'answer', role: 'assistant', content: text },
    ],
    new Set(),
  );
}

it('posts a one-off objective once, when it settles', async () => {
  const { workspace, engine, dot, chat, posts, advance } = fixture();
  remember(workspace, dot.id, 'work', 'The comparison.');
  const id = String(
    engine.createWorkItem({
      actorId: dot.id,
      title: 'Research',
      objective: 'Compare the options',
      source: 'owner',
      originThreadId: chat.id,
      workThreadId: 'work',
      autoResume: true,
    }).id,
  );
  const first = engine.enqueueExecution(id)!;
  engine.claimExecution();
  engine.finishExecution(
    first,
    'interrupted',
    'Execution reached its time limit.',
    {
      retry: true,
    },
  );
  await flush();
  expect(posts).toEqual([]);
  expect(engine.claimExecution()).toBeNull();
  advance(30_000);
  const second = engine.claimExecution()!;
  engine.setFinishIntent(String(second.id), 'complete');
  engine.finishExecution(String(second.id), 'completed');
  await flush();
  expect(posts).toEqual([
    {
      threadId: chat.id,
      label: 'Objective finished: Research',
      reply: 'The comparison.',
    },
  ]);
});

it('posts every completed schedule run', async () => {
  const { workspace, engine, dot, chat, posts } = fixture();
  remember(workspace, dot.id, 'digest', 'Morning notes.');
  const id = String(
    engine.createWorkItem({
      actorId: dot.id,
      title: 'Digest',
      objective: 'Check the inbox',
      source: 'schedule',
      recurring: true,
      originThreadId: chat.id,
      workThreadId: 'digest',
      autoResume: false,
    }).id,
  );
  for (let run = 0; run < 2; run += 1) {
    const execution = engine.enqueueExecution(id)!;
    engine.claimExecution();
    engine.finishExecution(execution, 'completed');
    await flush();
  }
  expect(posts.map((post) => post.label)).toEqual([
    'Schedule ran: Digest',
    'Schedule ran: Digest',
  ]);
  expect(posts.every((post) => post.reply === 'Morning notes.')).toBe(true);
});

it('posts into a chat that already has an active run', async () => {
  const { workspace, engine, dot, chat } = fixture();
  remember(workspace, dot.id, 'work', 'Filed it.');
  const runner = new SqliteThreadRunner(workspace.threads);
  reportWork(engine, workspace, runner);
  let release: () => void = () => undefined;
  const hung = new Promise<void>((resolve) => {
    release = resolve;
  });
  runner.run({
    threadId: chat.id,
    agent: {
      agentId: dot.id,
      messages: [],
      runAgent: () => hung,
    } as unknown as AbstractAgent,
    input: {
      threadId: chat.id,
      runId: 'busy',
      messages: [{ id: 'hello', role: 'user', content: 'Hello' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    },
  });
  expect(await runner.isRunning({ threadId: chat.id })).toBe(true);
  const id = String(
    engine.createWorkItem({
      actorId: dot.id,
      title: 'Research',
      objective: 'Compare the options',
      source: 'owner',
      originThreadId: chat.id,
      workThreadId: 'work',
      autoResume: false,
    }).id,
  );
  const execution = engine.enqueueExecution(id)!;
  engine.claimExecution();
  engine.setFinishIntent(execution, 'complete');
  engine.finishExecution(execution, 'completed');
  await flush();
  const messages = workspace.threads.messages(chat.id);
  expect(
    messages.some((message) => String(message.id).startsWith(workResultPrefix)),
  ).toBe(true);
  expect(messages.some((message) => message.content === 'Filed it.')).toBe(
    true,
  );
  expect(await runner.isRunning({ threadId: chat.id })).toBe(true);
  release();
});
