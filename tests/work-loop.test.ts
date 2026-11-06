import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import { Runner, TICK_MS } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const databases: Array<{ close(): void }> = [];
afterEach(() => {
  vi.useRealTimers();
  databases.splice(0).forEach((db) => db.close());
});

function world() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  let clock = Date.now();
  const engine = new ExecutionEngine(store.database, () => clock);
  const dot = workspace.dots()[0];
  const item = (title = 'Job') =>
    String(
      engine.createWorkItem({
        actorId: dot.id,
        title,
        objective: title,
        source: 'owner',
      }).id,
    );
  return { store, engine, dot, item, at: (ms: number) => (clock = ms) };
}

it('says when work is ready to run: on queueing and approval, not for later work', () => {
  const { engine, dot, item } = world();
  const queued = vi.fn();
  engine.onQueued = queued;
  engine.enqueueExecution(item());
  expect(queued).toHaveBeenCalledTimes(1);

  const now = engine.proposeAction({
    executionId: null,
    workItemId: null,
    actorId: dot.id,
    threadId: 'thread',
    toolName: 'plugin_cliq_send',
    arguments: {},
  });
  engine.approveAction(now.pendingActionId, true);
  expect(queued).toHaveBeenCalledTimes(2);

  // An action approved for later waits for the loop to reach its time.
  const later = engine.proposeAction({
    executionId: null,
    workItemId: null,
    actorId: dot.id,
    threadId: 'thread',
    toolName: 'plugin_cliq_send',
    arguments: {},
    notBefore: Date.now() + 3_600_000,
  });
  engine.approveAction(later.pendingActionId, true);
  expect(queued).toHaveBeenCalledTimes(2);
});

it('finds nothing to claim on an idle tick without taking a write lock', () => {
  const { store, engine } = world();
  const exec = vi.spyOn(store.database, 'exec');
  expect(engine.claimExecution()).toBeNull();
  expect(engine.claimApprovedAction()).toBeNull();
  expect(exec).not.toHaveBeenCalledWith('BEGIN IMMEDIATE');
});

it('still recovers a run whose lease expired, and claims queued work', () => {
  const { engine, item, at } = world();
  const start = Date.now();
  const id = item();
  engine.enqueueExecution(id);
  const claim = engine.claimExecution();
  expect(claim?.workItemId).toBe(id);
  // Nothing is queued now, but the running lease expires.
  at(start + 10 * 60_000);
  engine.claimExecution();
  expect(engine.execution(String(claim!.id))?.status).not.toBe('running');
});

it('ticks once a minute, and at once when kicked', async () => {
  vi.useFakeTimers();
  const { store } = world();
  const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
  const tick = vi.fn(async () => {});
  runner.attachWork({
    tick,
    abort: () => {},
    abortAll: () => {},
    stop: () => {},
  } as never);
  runner.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(tick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(TICK_MS / 2);
  expect(tick).toHaveBeenCalledTimes(1);
  runner.kick();
  runner.kick();
  await vi.advanceTimersByTimeAsync(0);
  expect(tick).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(TICK_MS / 2);
  expect(tick).toHaveBeenCalledTimes(3);
  runner.stop();
});

it('runs one tick at a time, and one more when asked during a tick', async () => {
  const { store } = world();
  const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
  let release: () => void = () => {};
  let calls = 0;
  runner.attachWork({
    tick: () => {
      calls += 1;
      return calls === 1
        ? new Promise<void>((resolve) => (release = resolve))
        : Promise.resolve();
    },
    abort: () => {},
    abortAll: () => {},
    stop: () => {},
  } as never);
  const first = runner.tick();
  void runner.tick();
  void runner.tick();
  expect(calls).toBe(1);
  release();
  await first;
  expect(calls).toBe(2);
});
