import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import { PluginService } from '../src/server/plugins.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { WorkRunner } from '../src/server/work-runner.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { research, type Config } from '../src/server/research.js';
const config: Config = {
  mode: 'live',
  apiKey: 'test',
  model: 'test',
  browserUrl: 'http://browser:4311',
  browserSecret: 'test',
  baseUrl: 'https://model.example/v1',
};
afterEach(() => vi.unstubAllGlobals());
it('aborts research when permissions are revoked outside the runner instance', async () => {
  const store = new Store(':memory:');
  const runner = new Runner(store, config);
  let requestSignal: AbortSignal | undefined;
  const request = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        requestSignal = options.signal ?? undefined;
        requestSignal?.addEventListener(
          'abort',
          () => reject(new Error('Aborted')),
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', request);
  store.createTask('Read https://example.com');
  const tick = runner.tick();
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  store.updateSettings({ memoryAllowed: false });
  await tick;
  expect(requestSignal?.aborted).toBe(true);
  expect(request).toHaveBeenCalledOnce();
  expect(store.tasks()[0].status).toBe('interrupted');
  runner.stop();
  store.close();
});
it('checks abort again before sending source evidence or memories to the model', async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      title: 'Source',
      text: 'Page text',
      url: 'https://example.com',
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await expect(
    research(
      'Read https://example.com',
      [],
      config,
      controller.signal,
      (text) => {
        if (text.startsWith('Source captured')) controller.abort();
      },
    ),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
it('omits stored memories from research when memory permission is disabled', async () => {
  const store = new Store(':memory:');
  store.saveMemory('Sensitive preference');
  store.updateSettings({ memoryAllowed: false });
  const task = store.createTask('Read this sample');
  const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
  await runner.tick();
  expect(store.detail(task.id)?.runs[0].result?.text).not.toContain(
    'Sensitive preference',
  );
  store.close();
});
it('holds active work for review on graceful shutdown', async () => {
  const store = new Store(':memory:');
  const runner = new Runner(store, config);
  const fetch = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) =>
        options.signal?.addEventListener(
          'abort',
          () => reject(new Error('Aborted')),
          { once: true },
        ),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  store.createTask('Read https://example.com');
  const pending = runner.tick();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  runner.stop();
  await pending;
  expect(store.tasks()[0].status).toBe('interrupted');
  expect(store.claim()).toBeNull();
  store.action(store.tasks()[0].id, 'run');
  expect(store.claim()).toBeTruthy();
  store.close();
});
it('survives a claim failure and runs work on the next tick', async () => {
  const store = new Store(':memory:');
  const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const claim = vi.spyOn(store, 'claim').mockImplementationOnce(() => {
    throw new Error('SQLITE_BUSY');
  });
  const task = store.createTask('Read this sample');
  try {
    await expect(runner.tick()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    await runner.tick();
    expect(claim).toHaveBeenCalledTimes(2);
    expect(store.detail(task.id)?.runs[0].result).toBeTruthy();
  } finally {
    log.mockRestore();
    store.close();
  }
});
it('survives failure persistence errors and clears active work', async () => {
  const store = new Store(':memory:');
  const execute = vi
    .fn()
    .mockRejectedValueOnce(new Error('Provider failure'))
    .mockResolvedValueOnce({ text: 'Recovered', sources: [], memories: [] });
  const runner = new Runner(store, config, execute);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fail = vi.spyOn(store, 'fail').mockImplementationOnce(() => {
    throw new Error('SQLITE_BUSY');
  });
  store.createTask('First');
  try {
    await expect(runner.tick()).resolves.toBeUndefined();
    expect(fail).toHaveBeenCalledOnce();
    store.createTask('Second');
    await runner.tick();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
    store.close();
  }
});
it('aborts work instead of throwing from an ownership timer', async () => {
  const store = new Store(':memory:');
  store.createTask('First');
  const runner = new Runner(
    store,
    config,
    (_claim, _memories, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  vi.spyOn(store, 'owns').mockImplementationOnce(() => {
    throw new Error('Database unavailable');
  });
  try {
    await expect(runner.tick()).resolves.toBeUndefined();
    expect(store.tasks()[0].status).toBe('failed');
  } finally {
    store.close();
  }
});
it('runs three executions at once and resumes an expired lease as a new attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-runner-'));
  const store = new Store(join(dir, 'open.sqlite'));
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const plugins = new PluginService(store.database);
  store.updateSettings({ researchAllowed: false });
  const engine = new ExecutionEngine(store.database);
  const dot = workspace.dots()[0];
  engine.savePolicy(dot.id, { maxConcurrent: 3 });
  const ids = [0, 1, 2].map((index) =>
    String(
      engine.createWorkItem({
        actorId: dot.id,
        title: `Objective ${index}`,
        objective: 'Keep going',
        source: 'owner',
        autoResume: false,
      }).id,
    ),
  );
  for (const id of ids) engine.enqueueExecution(id);
  const started: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = new WorkRunner(
    engine,
    store,
    workspace,
    plugins,
    async (claim) => {
      started.push(claim.id);
      await gate;
    },
    async () => undefined,
  );
  try {
    await work.tick();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    await work.tick();
    expect(started).toHaveLength(3);
    expect(new Set(started.map((id) => engine.execution(id)?.workItemId)).size).toBe(3);
    release();
    await vi.waitFor(() => {
      for (const id of ids) {
        const executions = engine.detail(id)?.executions as { status: string }[];
        expect(
          executions.every((execution) =>
            ['completed', 'interrupted', 'failed', 'cancelled'].includes(
              execution.status,
            ),
          ),
        ).toBe(true);
      }
    });
  } finally {
    release();
    work.stop();
    store.close();
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  }
  let now = 1_700_000_000_000;
  const leased = new Store(':memory:');
  const clock = new ExecutionEngine(leased.database, () => now);
  const item = clock.createWorkItem({
    actorId: 'dot',
    title: 'Resume',
    objective: 'Continue after the lease',
    source: 'delegation',
  });
  const first = clock.enqueueExecution(String(item.id))!;
  clock.claimExecution();
  now += 180_000;
  const second = clock.claimExecution();
  expect(clock.execution(first)?.status).toBe('interrupted');
  expect(second?.id).not.toBe(first);
  expect(second?.resumeOf).toBe(first);
  expect(clock.workItem(String(item.id))?.status).toBe('open');
  leased.close();
});
