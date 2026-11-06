import { afterEach, expect, it, vi } from 'vitest';
import type { Message, RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import { PluginService } from '../src/server/plugins.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { SqliteThreadRunner } from '../src/server/thread-runner.js';
import { postApprovalRequest } from '../src/server/approved-actions.js';
import { approvalMarkerId } from '../src/shared/approval-marker.js';
import { completion } from './fixtures/model-stream.js';

const databases: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

it('posts the approval card after the reply in progress finishes', async () => {
  let running = 2;
  const posted: { threadId: string; marker: Message }[] = [];
  await postApprovalRequest(
    {
      isRunning: async () => running-- > 0,
      post: (threadId, marker) => posted.push({ threadId, marker }),
      sleep: async () => {},
    },
    { id: 'a1', threadId: 'chat', toolName: 'plugin_cliq_send' },
  );
  expect(running).toBe(-1);
  expect(posted).toHaveLength(1);
  expect(posted[0].threadId).toBe('chat');
  expect(approvalMarkerId(posted[0].marker)).toBe('a1');
});

it('keeps approval cards in the chat history but out of what the model reads', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const engine = new ExecutionEngine(store.database);
  const plugins = new PluginService(store.database);
  const dot = workspace.dots()[0];
  workspace.bindThread('chat', dot.id, 'Chat');
  const runner = new SqliteThreadRunner(workspace.threads);
  runner.appendNotice('chat', dot.id, {
    id: 'opendots-approval:a1',
    role: 'user',
    content: 'Approval requested: plugin_cliq_send',
    metadata: { opendotsSource: 'approval_request', actionId: 'a1' },
  } as Message);
  expect(
    workspace.threads
      .messages('chat')
      .map((message) => approvalMarkerId(message)),
  ).toEqual(['a1']);

  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(completion({ role: 'assistant', content: 'Okay.' }));
  const agent = new DotAgent(
    store,
    workspace,
    {
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      voiceName: 'marin',
      slackUsers: [],
      lazyTools: false,
    },
    dot.id,
    false,
    { engine, plugins, skillsDir: '/nonexistent-skills' },
  );
  const input: RunAgentInput = {
    threadId: 'chat',
    runId: 'r1',
    state: {},
    context: [],
    messages: [{ id: 'u1', role: 'user', content: 'Anything new?' }],
    tools: [],
    forwardedProps: {},
  };
  await lastValueFrom(agent.run(input).pipe(toArray()));
  const body = String(network.mock.calls[0]?.[1]?.body);
  expect(body).toContain('Anything new?');
  expect(body).not.toContain('Approval requested');
});
