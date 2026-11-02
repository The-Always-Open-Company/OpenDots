import { afterEach, expect, it, vi } from 'vitest';
import type { Message, RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { CUT_OFF_RESULT, DotAgent } from '../src/server/dot-agent.js';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import { PluginService } from '../src/server/plugins.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { pageReviewTool } from '../src/shared/page-review.js';
import { completion } from './fixtures/model-stream.js';

const databases: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

const call = (id: string, name: string, args: object) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

async function world() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const engine = new ExecutionEngine(store.database);
  let sends = 0;
  const plugins = new PluginService(store.database, {
    listTools: async () => [
      {
        name: 'send',
        description: 'Post a message to a channel.',
        schema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ],
    callTool: async () => {
      sends += 1;
      return { ok: true };
    },
  });
  plugins.save({ id: 'cliq', name: 'Cliq', url: 'http://127.0.0.1/mcp' });
  await plugins.refresh('cliq');
  const dot = workspace.dots()[0];
  plugins.grant(dot.id, 'cliq', 'send', 'allow');
  workspace.bindThread('thread', dot.id, 'Cut off');
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
  return { workspace, agent, sends: () => sends };
}

it('answers a call a stopped run left open instead of running it again', async () => {
  const { workspace, agent, sends } = await world();
  // A run that was cut off while posting, and one with a browser tool waiting.
  const history: Message[] = [
    { id: 'u1', role: 'user', content: 'Post hello to #sales.' },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [call('send-1', 'plugin_cliq_send', { text: 'hello' })],
    },
    { id: 'u2', role: 'user', content: 'Review this page.' },
    {
      id: 'a2',
      role: 'assistant',
      content: '',
      toolCalls: [call('review-1', pageReviewTool.name, {})],
    },
  ] as Message[];
  workspace.threads.appendRun(
    {
      runId: 'old',
      threadId: 'thread',
      agentId: 'dot',
      parentRunId: null,
      events: [],
      createdAt: 1,
    },
    history,
    new Set(),
  );
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(completion({ role: 'assistant', content: 'Okay.' }));
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'next',
    state: {},
    context: [],
    messages: [{ id: 'u3', role: 'user', content: 'Anything else?' }],
    tools: [],
    forwardedProps: {},
  };
  await lastValueFrom(agent.run(input).pipe(toArray()));

  expect(sends()).toBe(0);
  const stored = workspace.threads.messages('thread');
  const at = stored.findIndex((message) => message.id === 'a1');
  expect(stored[at + 1]).toMatchObject({
    role: 'tool',
    toolCallId: 'send-1',
    content: CUT_OFF_RESULT,
  });
  // The browser tool's call is left for the browser to answer.
  expect(
    stored.some(
      (message) => message.role === 'tool' && message.toolCallId === 'review-1',
    ),
  ).toBe(false);
  // The model saw the cut-off result in order.
  const body = JSON.parse(String(network.mock.calls[0]?.[1]?.body));
  const sent = body.messages as { role: string; tool_call_id?: string }[];
  const callAt = sent.findIndex((message) =>
    JSON.stringify(message).includes('send-1'),
  );
  expect(sent[callAt + 1]).toMatchObject({
    role: 'tool',
    tool_call_id: 'send-1',
  });
  // A call already answered is not answered again.
  expect(
    workspace.threads.closeOpenCalls(
      'thread',
      CUT_OFF_RESULT,
      (name) => name === pageReviewTool.name,
    ),
  ).toBe(0);
});
