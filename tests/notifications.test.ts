import { afterEach, expect, it } from 'vitest';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import {
  NotificationService,
  notifyWork,
} from '../src/server/notifications.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { AppNotification } from '../src/shared/types.js';

const open: { close(): void }[] = [];
afterEach(() => open.splice(0).forEach((db) => db.close()));

function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  open.push(store, workspace);
  let clock = 1_000;
  const engine = new ExecutionEngine(store.database);
  const notifications = new NotificationService(
    store.database,
    () => (clock += 1),
  );
  notifyWork(engine, workspace, notifications);
  const dot = workspace.dots()[0];
  return { store, workspace, engine, notifications, dot };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

it('stores, lists, marks read, and delivers to channels', async () => {
  const { notifications } = fixture();
  const delivered: AppNotification[] = [];
  notifications.channels.push({
    name: 'test',
    send: async (item) => {
      delivered.push(item);
    },
  });
  const first = notifications.publish({
    kind: 'reply',
    title: 'Ava replied',
    body: `  Lots\n of   text ${'x'.repeat(500)}`,
    threadId: 'thread',
  });
  const second = notifications.publish({ kind: 'reply', title: 'Again' });
  expect(first.body.startsWith('Lots of text')).toBe(true);
  expect(first.body.length).toBe(400);
  expect(first.body.endsWith('…')).toBe(true);
  expect(delivered.map((item) => item.id)).toEqual([first.id, second.id]);
  expect(notifications.list({ unread: true }).map((item) => item.id)).toEqual([
    second.id,
    first.id,
  ]);
  expect(notifications.markRead(first.id)).toBe(true);
  expect(notifications.markRead(first.id)).toBe(false);
  expect(notifications.list({ unread: true }).map((item) => item.id)).toEqual([
    second.id,
  ]);
  expect(notifications.markAllRead()).toBe(1);
  expect(notifications.list({ unread: true })).toEqual([]);
  expect(notifications.list()).toHaveLength(2);
});

it('notifies when background work finishes, with the Dot’s last reply', async () => {
  const { engine, workspace, notifications, dot } = fixture();
  workspace.bindThread('work-thread', dot.id, 'Read notes');
  workspace.threads.appendRun(
    {
      runId: 'run',
      threadId: 'work-thread',
      agentId: dot.id,
      parentRunId: null,
      events: [],
      createdAt: 1,
    },
    [
      { id: 'u', role: 'user', content: 'Objective: Read notes' },
      { id: 'a', role: 'assistant', content: 'Filed 3 action items.' },
    ],
    new Set(),
  );
  const item = engine.createWorkItem({
    actorId: dot.id,
    title: 'Read notes',
    objective: 'Read them.',
    source: 'owner',
    workThreadId: 'work-thread',
  });
  engine.enqueueExecution(String(item.id));
  const claim = engine.claimExecution()!;
  engine.setFinishIntent(String(claim.id), 'complete');
  engine.finishExecution(String(claim.id), 'completed');
  await settled();
  expect(notifications.list({ unread: true })).toEqual([
    expect.objectContaining({
      kind: 'work_finished',
      dotId: dot.id,
      title: `${dot.name} finished "Read notes"`,
      body: 'Filed 3 action items.',
      threadId: 'work-thread',
      workItemId: String(item.id),
    }),
  ]);
});

it('asks for approval, and stays quiet while a failed run will retry', async () => {
  const { engine, notifications, dot } = fixture();
  const item = engine.createWorkItem({
    actorId: dot.id,
    title: 'Send the report',
    objective: 'Send it.',
    source: 'owner',
    autoResume: true,
  });
  engine.enqueueExecution(String(item.id));
  const claim = engine.claimExecution()!;
  engine.proposeAction({
    executionId: String(claim.id),
    workItemId: String(item.id),
    actorId: dot.id,
    threadId: 'thread',
    toolName: 'plugin_mail_send',
    arguments: {},
  });
  await settled();
  expect(notifications.list({ unread: true })).toEqual([
    expect.objectContaining({
      kind: 'approval_needed',
      title: `${dot.name} needs your approval`,
      body: 'plugin mail send for "Send the report"',
      threadId: 'thread',
    }),
  ]);
  notifications.markAllRead();
  engine.finishExecution(String(claim.id), 'interrupted', 'Time limit.');
  const retried = engine.createWorkItem({
    actorId: dot.id,
    title: 'Read a long document',
    objective: 'Read it.',
    source: 'owner',
    autoResume: true,
  });
  engine.enqueueExecution(String(retried.id));
  const long = engine.claimExecution()!;
  expect(long.workItemId).toBe(retried.id);
  engine.finishExecution(String(long.id), 'interrupted', 'Time limit.');
  await settled();
  expect(notifications.list({ unread: true })).toEqual([]);
  expect(
    engine
      .detail(String(retried.id))
      ?.executions.some(
        (execution) => (execution as { status: string }).status === 'queued',
      ),
  ).toBe(true);
});

it('reports a failed run that will not retry, but not one the owner stopped', async () => {
  const { engine, notifications, dot } = fixture();
  const run = (title: string, error: string) => {
    const item = engine.createWorkItem({
      actorId: dot.id,
      title,
      objective: title,
      source: 'owner',
      autoResume: false,
    });
    engine.enqueueExecution(String(item.id));
    const claim = engine.claimExecution()!;
    engine.finishExecution(String(claim.id), 'failed', error);
  };
  run('Stopped', 'Run stopped.');
  run('Broken', 'The model is unavailable.');
  await settled();
  expect(notifications.list({ unread: true })).toEqual([
    expect.objectContaining({
      kind: 'work_failed',
      title: `${dot.name} could not finish "Broken"`,
      body: 'The model is unavailable.',
    }),
  ]);
});
