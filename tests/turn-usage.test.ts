import { afterEach, expect, it, vi } from 'vitest';
import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent, tokenUsage } from '../src/server/dot-agent.js';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import { PluginService } from '../src/server/plugins.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { TurnUsageLog, billedTokens } from '../src/server/turn-usage.js';

const databases: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

/** A streamed Chat Completions reply whose last chunk reports usage. */
function reply(
  delta: Record<string, unknown>,
  finishReason: string,
  usage: Record<string, unknown>,
) {
  const chunk = (body: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'custom-model', ...body })}\n\n`;
  return new Response(
    chunk({ choices: [{ index: 0, delta, finish_reason: null }] }) +
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      }) +
      chunk({ choices: [], usage }) +
      'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

async function world() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const engine = new ExecutionEngine(store.database);
  const plugins = new PluginService(store.database, {
    listTools: async () => [
      {
        name: 'lookup',
        description: 'Look up a record.',
        schema: { type: 'object', properties: { id: { type: 'string' } } },
        annotations: { readOnlyHint: true },
      },
    ],
    callTool: async () => ({ record: 'x'.repeat(400) }),
  });
  plugins.save({ id: 'crm', name: 'CRM', url: 'http://127.0.0.1/mcp' });
  await plugins.refresh('crm');
  const dot = workspace.dots()[0];
  plugins.grant(dot.id, 'crm', 'lookup', 'allow');
  workspace.bindThread('thread', dot.id, 'Usage');
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
  return { store, agent, dot, engine, workspace };
}

const input = (runId: string, text: string): RunAgentInput => ({
  threadId: 'thread',
  runId,
  state: {},
  context: [],
  messages: [{ id: `u-${runId}`, role: 'user', content: text }],
  tools: [],
  forwardedProps: {},
});

it('records each model call, its tokens and the tools a turn ran', async () => {
  const { store, agent, dot } = await world();
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      reply(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: {
                name: 'plugin_crm_lookup',
                arguments: '{"id":"7"}',
              },
            },
          ],
        },
        'tool_calls',
        {
          prompt_tokens: 1200,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 1000 },
        },
      ),
    )
    .mockResolvedValueOnce(
      reply({ role: 'assistant', content: 'Found it.' }, 'stop', {
        prompt_tokens: 1500,
        completion_tokens: 12,
        completion_tokens_details: { reasoning_tokens: 4 },
      }),
    );

  await lastValueFrom(agent.run(input('r1', 'Look up 7.')).pipe(toArray()));

  const [turn] = new TurnUsageLog(store.database).list(0);
  expect(turn).toMatchObject({
    runId: 'r1',
    threadId: 'thread',
    dotId: dot.id,
    kind: 'chat',
    model: 'custom-model',
    outcome: 'completed',
    error: null,
    modelCalls: 2,
    inputTokens: 2700,
    cachedTokens: 1000,
    outputTokens: 42,
    reasoningTokens: 4,
    toolCalls: 1,
    toolFailures: 0,
  });
  expect(turn.toolLog[0]).toMatchObject({
    name: 'plugin_crm_lookup',
    ok: true,
  });
  expect(turn.toolResultChars).toBeGreaterThan(400);
  // The request shape: the second call carries the tool call and its result.
  expect(turn.firstTools).toBeGreaterThan(0);
  expect(turn.firstToolTokens).toBeGreaterThan(0);
  expect(turn.calls[1].historyMessages).toBe(turn.calls[0].historyMessages + 2);
  expect(turn.calls[1].historyTokens).toBeGreaterThan(
    turn.calls[0].historyTokens,
  );
  expect(new TurnUsageLog(store.database).totals(0)[0]).toMatchObject({
    kind: 'chat',
    turns: 1,
    inputTokens: 2700,
    unfinished: 0,
  });
});

it('records a turn that ends in an error', async () => {
  const { store, agent } = await world();
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response('{"error":{"message":"overloaded"}}', { status: 500 }),
  );

  await expect(
    lastValueFrom(agent.run(input('r2', 'Hello')).pipe(toArray())),
  ).rejects.toThrow();

  const [turn] = new TurnUsageLog(store.database).list(0);
  expect(turn).toMatchObject({ runId: 'r2', outcome: 'error', modelCalls: 1 });
  expect(turn.error).toMatch(/overloaded|500/);
  expect(turn.error).toBeTruthy();
  expect(turn.inputTokens).toBe(0);
});

it('records a background turn the owner stopped', async () => {
  const { store, agent, dot, engine, workspace } = await world();
  const item = engine.createWorkItem({
    actorId: dot.id,
    title: 'Slow job',
    objective: 'Wait on a slow model.',
    source: 'delegation',
  });
  engine.enqueueExecution(String(item.id));
  const claim = engine.claimExecution()!;
  workspace.bindThread('work-thread', dot.id, 'Slow job');
  agent.workContext = {
    workItemId: String(item.id),
    executionId: String(claim.id),
  };
  // The model never answers; the owner stops the turn.
  let asked: () => void = () => {};
  const waiting = new Promise<void>((resolve) => (asked = resolve));
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    asked();
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError')),
      ),
    );
  });

  const finished = lastValueFrom(
    agent
      .run({ ...input('r3', 'Go'), threadId: 'work-thread' })
      .pipe(toArray()),
  ).catch(() => undefined);
  await waiting;
  agent.abortRun();
  await finished;

  const [turn] = new TurnUsageLog(store.database).list(0);
  expect(turn).toMatchObject({
    runId: 'r3',
    kind: 'work',
    workItemId: String(item.id),
    executionId: String(claim.id),
    outcome: 'stopped',
    modelCalls: 1,
  });
});

it('reads billed tokens from normalized, Chat Completions and Responses usage', () => {
  expect(
    billedTokens({
      promptTokens: 10,
      completionTokens: 2,
      promptTokensDetails: { cachedTokens: 6 },
      completionTokensDetails: { reasoningTokens: 1 },
    }),
  ).toEqual({
    inputTokens: 10,
    cachedTokens: 6,
    outputTokens: 2,
    reasoningTokens: 1,
  });
  expect(
    billedTokens({
      input_tokens: 9,
      output_tokens: 3,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens_details: { reasoning_tokens: 2 },
    }),
  ).toEqual({
    inputTokens: 9,
    cachedTokens: 5,
    outputTokens: 3,
    reasoningTokens: 2,
  });
  // The AG-UI run usage the cost event reads names the cache read differently.
  expect(
    tokenUsage([{ inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 }]),
  ).toMatchObject({ promptTokens: 100, cachedTokens: 80 });
});
