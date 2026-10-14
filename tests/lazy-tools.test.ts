import { afterEach, expect, it, vi } from 'vitest';
import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import { PluginService } from '../src/server/plugins.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  DISCOVERY_PROMPT,
  DISCOVERY_TOOL_NAME,
} from '../src/server/tool-exposure.js';
import { completion } from './fixtures/model-stream.js';

const databases: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

function fixture(lazyTools?: boolean) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const engine = new ExecutionEngine(store.database);
  const plugins = new PluginService(store.database);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Lazy tools');
  const agent = new DotAgent(
    store,
    workspace,
    {
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      voiceName: 'marin',
      slackUsers: [],
      lazyTools,
    },
    dot.id,
    false,
    { engine, plugins, skillsDir: '/nonexistent-skills' },
  );
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    messages: [{ id: 'user', role: 'user', content: 'What am I working on?' }],
    tools: [],
    forwardedProps: {},
  };
  return { engine, dot, agent, input };
}

const toolCall = (id: string, name: string, args: unknown) =>
  completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    'tool_calls',
  );

type Request = {
  messages: { role: string; content: string; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
};
const requestOf = (network: ReturnType<typeof vi.spyOn>, index: number) =>
  JSON.parse(String(network.mock.calls[index][1]?.body)) as Request;
const toolNames = (request: Request) =>
  (request.tools ?? []).map((tool) => tool.function.name);
const system = (request: Request) =>
  request.messages.find((message) => message.role === 'system')?.content ?? '';
const toolResult = (request: Request, id: string) =>
  request.messages.find((message) => message.tool_call_id === id)?.content;

it('sends common tools first and loads a deferred tool once the model discovers it', async () => {
  const f = fixture();
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      toolCall('discover', DISCOVERY_TOOL_NAME, { toolNames: ['list_work'] }),
    )
    .mockResolvedValueOnce(toolCall('list', 'list_work', {}))
    .mockResolvedValueOnce(
      completion({ role: 'assistant', content: 'Nothing open.' }),
    );
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(network).toHaveBeenCalledTimes(3);

  const first = requestOf(network, 0);
  expect(toolNames(first)).toEqual(
    expect.arrayContaining([
      DISCOVERY_TOOL_NAME,
      'start_objective',
      'load_skill',
      'create_space_page',
    ]),
  );
  expect(toolNames(first)).not.toContain('list_work');
  expect(toolNames(first)).not.toContain('complete_work');
  expect(system(first)).toContain(DISCOVERY_PROMPT);

  const second = requestOf(network, 1);
  expect(toolNames(second)).toContain('list_work');
  expect(toolResult(second, 'discover')).toContain('list_work');

  const third = requestOf(network, 2);
  expect(toolResult(third, 'list')).toBe('[]');
});

it('still authorizes a discovered tool on every call', async () => {
  const f = fixture();
  f.engine.saveRule({
    text: 'Do not list objectives.',
    mode: 'block',
    toolNames: ['list_work'],
  });
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      toolCall('discover', DISCOVERY_TOOL_NAME, { toolNames: ['list_work'] }),
    )
    .mockResolvedValueOnce(toolCall('list', 'list_work', {}))
    .mockResolvedValueOnce(
      completion({ role: 'assistant', content: 'I cannot list them.' }),
    );
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(toolResult(requestOf(network, 2), 'list')).toContain(
    'Rule blocked this action.',
  );
});

it('sends every tool when lazy tools are off', async () => {
  const f = fixture(false);
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(completion({ role: 'assistant', content: 'Hi.' }));
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  const request = requestOf(network, 0);
  expect(toolNames(request)).toEqual(
    expect.arrayContaining(['list_work', 'start_objective']),
  );
  expect(toolNames(request)).not.toContain(DISCOVERY_TOOL_NAME);
  expect(system(request)).not.toContain(DISCOVERY_PROMPT);
});
