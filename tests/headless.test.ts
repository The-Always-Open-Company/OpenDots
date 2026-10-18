import '../src/server/disable-telemetry.js';
import { afterEach, expect, it, vi } from 'vitest';
import { currentTurnText } from '../src/server/headless.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { completion } from './fixtures/model-stream.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.splice(0).forEach((fn) => fn());
});

it('rejects a swallowed SDK failure rather than reusing a previous answer', () => {
  expect(() => currentTurnText([], new Error('Provider failed'))).toThrow(
    'Provider failed',
  );
  expect(() => currentTurnText([])).toThrow('current compute turn');
  expect(
    currentTurnText([
      { id: 'new', role: 'assistant', content: 'Current answer' },
    ]),
  ).toBe('Current answer');
});

it('runs a call task child thread while its parent thread is busy', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    workspace.close();
  });
  const platform = new Platform(store, workspace, {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    slackUsers: [],
  });
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Parent');
  const call = workspace.createCall('thread', 'live');
  const task = workspace.createCallTask({
    callId: call.id,
    delegationId: 'item_1',
    parentThreadId: 'thread',
    label: 'Child',
  });
  let releaseParent!: (response: Response) => void;
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementationOnce(
      () => new Promise<Response>((resolve) => (releaseParent = resolve)),
    )
    .mockResolvedValueOnce(
      completion({ role: 'assistant', content: 'Child done.' }),
    );
  const parent = platform.turn(
    'thread',
    'Long parent request',
    AbortSignal.timeout(10_000),
  );
  await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
  await expect(
    platform.turn('thread', 'Another', AbortSignal.timeout(10_000)),
  ).rejects.toThrow('already answering');
  await expect(
    platform.turn(
      task.childThreadId,
      'Child request',
      AbortSignal.timeout(10_000),
      { opendotsSource: 'call_task' },
    ),
  ).resolves.toBe('Child done.');
  releaseParent(completion({ role: 'assistant', content: 'Parent done.' }));
  await expect(parent).resolves.toBe('Parent done.');
});
