import { afterEach, expect, it, vi } from 'vitest';
import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DISCOVERY_TOOL_NAME } from '@tanstack/ai';
import { DotAgent } from '../src/server/dot-agent.js';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import { PluginService } from '../src/server/plugins.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  limitPluginResults,
  limitResult,
  toolSearchMiddleware,
  unloadEarlierTools,
} from '../src/server/tool-exposure.js';
import { STALLED_PROMPT } from '../src/server/turn-limit.js';
import { completion } from './fixtures/model-stream.js';

const databases: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

interface Message {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolCalls?: {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }[];
}

const search = (id: string, names: string[]): Message[] => [
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      {
        id,
        type: 'function',
        function: {
          name: DISCOVERY_TOOL_NAME,
          arguments: JSON.stringify({ toolNames: names }),
        },
      },
    ],
  },
  {
    role: 'tool',
    toolCallId: id,
    content: JSON.stringify({
      tools: names.map((name) => ({
        name,
        inputSchema: { big: 'x'.repeat(500) },
      })),
    }),
  },
];

it('unloads tools searched for before the last two turns', () => {
  const messages: Message[] = [
    { role: 'user', content: 'first' },
    ...search('old', ['plugin_desk_get']),
    { role: 'user', content: 'second' },
    ...search('recent', ['plugin_sprints_get']),
    { role: 'user', content: 'third' },
  ];
  const out = unloadEarlierTools(messages);
  const old = out.find((message) => message.toolCallId === 'old')!;
  expect(JSON.parse(String(old.content))).toMatchObject({
    unloaded: ['plugin_desk_get'],
  });
  expect(JSON.parse(String(old.content)).tools).toBeUndefined();
  // The previous turn's search still loads its tools.
  expect(out.find((message) => message.toolCallId === 'recent')).toBe(
    messages.find((message) => message.toolCallId === 'recent'),
  );
  // A short thread is left alone.
  const short: Message[] = [
    { role: 'user', content: 'only' },
    ...search('s', ['a']),
  ];
  expect(unloadEarlierTools(short)).toBe(short);
});

it('shows the model only the names a tool search loaded', async () => {
  const messages = [
    { role: 'user', content: 'go' },
    ...search('s1', ['plugin_desk_get', 'plugin_desk_list']),
  ];
  const middleware = toolSearchMiddleware();
  const result = await middleware.onConfig!(
    { phase: 'beforeModel' } as never,
    { messages, systemPrompts: [], tools: [] } as never,
  );
  const sent = (result as { providerMessages: typeof messages })
    .providerMessages;
  expect(JSON.parse(String(sent[2].content))).toEqual({
    loaded: ['plugin_desk_get', 'plugin_desk_list'],
  });
  // The stored message is unchanged, so the next turn still knows what loaded.
  expect(String(messages[2].content)).toContain('inputSchema');
});

it('unpacks JSON a plugin returns as text, so the model reads it unescaped', () => {
  const data = { data: [{ id: '1', subject: 'Console "broken"' }] };
  const result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
  expect(limitResult(result)).toEqual(data);
  // Plain text stays text.
  expect(limitResult({ content: [{ type: 'text', text: 'ok' }] })).toBe('ok');
  // A result with other fields is passed through as it is.
  const other = { content: [{ type: 'text', text: 'x' }], extra: 1 };
  expect(limitResult(other)).toBe(other);
});

it('cuts long plugin results and says how to get the rest', async () => {
  const text = 'y'.repeat(30_000);
  const cut = String(
    limitResult({ content: [{ type: 'text', text }] }, 24_000),
  );
  expect(cut.startsWith('y'.repeat(24_000) + '\n')).toBe(true);
  expect(cut).toMatch(/showing 24000 of 30000 characters\. Narrow the request/);
  // The limit applies to the size the model reads, escaping included.
  const quoted = JSON.stringify({ rows: Array(3_000).fill('"q"') });
  expect(
    String(limitResult({ content: [{ type: 'text', text: quoted }] }, 20_000)),
  ).toContain(`of ${JSON.stringify(JSON.parse(quoted)).length} characters`);
  // Only plugin tools are limited.
  const [plugin, builtIn] = limitPluginResults(
    [
      { name: 'plugin_crm_list', execute: async () => text },
      { name: 'search_documents', execute: async () => text },
    ],
    100,
  );
  expect(String(await plugin.execute!())).toMatch(/of 30000 characters/);
  expect(await builtIn.execute!()).toBe(text);
});

async function failingWorld() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const engine = new ExecutionEngine(store.database);
  let calls = 0;
  const plugins = new PluginService(store.database, {
    listTools: async () => [
      {
        name: 'lookup',
        description: 'Look up a record.',
        schema: { type: 'object', properties: { id: { type: 'string' } } },
        annotations: { readOnlyHint: true },
      },
    ],
    callTool: async () => {
      calls += 1;
      return {
        isError: true,
        content: [{ type: 'text', text: "The value for 'id' is not allowed." }],
      };
    },
  });
  plugins.save({ id: 'crm', name: 'CRM', url: 'http://127.0.0.1/mcp' });
  await plugins.refresh('crm');
  const dot = workspace.dots()[0];
  plugins.grant(dot.id, 'crm', 'lookup', 'allow');
  workspace.bindThread('thread', dot.id, 'Stalls');
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
  return { agent, calls: () => calls };
}

const lookup = (id: string) =>
  completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `call-${id}-${Math.random()}`,
          type: 'function',
          function: {
            name: 'plugin_crm_lookup',
            arguments: JSON.stringify({ id }),
          },
        },
      ],
    },
    'tool_calls',
  );

it('does not rerun a failed call, and makes a stalled turn answer', async () => {
  const { agent, calls } = await failingWorld();
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(lookup('7'))
    .mockResolvedValueOnce(lookup('7'))
    .mockResolvedValueOnce(lookup('9'))
    .mockResolvedValueOnce(
      completion({ role: 'assistant', content: 'The lookups keep failing.' }),
    );
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'r1',
    state: {},
    context: [],
    messages: [{ id: 'u1', role: 'user', content: 'Look up 7.' }],
    tools: [],
    forwardedProps: {},
  };

  await lastValueFrom(agent.run(input).pipe(toArray()));

  // The repeat of the failed lookup of 7 never reached the plugin.
  expect(calls()).toBe(2);
  const second = JSON.parse(String(network.mock.calls[2][1]?.body));
  expect(JSON.stringify(second.messages)).toContain(
    'This exact call already failed in this turn',
  );
  // Three rounds of failures: the fourth call must answer in text.
  const fourth = JSON.parse(String(network.mock.calls[3][1]?.body));
  expect(fourth.tool_choice).toBe('none');
  expect(JSON.stringify(fourth.messages)).toContain(STALLED_PROMPT);
  const third = JSON.parse(String(network.mock.calls[2][1]?.body));
  expect(third.tool_choice).toBeUndefined();
});
