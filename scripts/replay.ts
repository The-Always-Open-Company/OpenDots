/**
 * Replays agent turns against a snapshot of a real database and reports what
 * each request would cost: model calls, and the system prompt, history and
 * tool definitions sent on each call. Use it to measure a change to the agent
 * loop before and after, on real threads.
 *
 * Nothing reaches a model or a plugin. Each scenario runs on a fresh copy of
 * the snapshot, so the snapshot itself is never changed.
 *
 *   turn   Sends one message (default "ok") on a thread; the model answers in
 *          text. Measures the base cost of a turn in that thread.
 *   run    Replays a recorded run. A scripted model makes the same tool calls,
 *          round by round, and every tool returns the result recorded then.
 *          Plugin calls still pass through authorization, approvals, effect
 *          records and result limits. When a tool the run used is not loaded,
 *          the model searches for it first, as a real model would.
 *
 * Token counts are estimates at four characters a token; billed tokens need a
 * real model. Take a snapshot of a server database with:
 *   ssh HOST 'docker exec APP node -e "new (require(\"node:sqlite\").DatabaseSync)(\"/data/opendots.sqlite\",{readOnly:true}).exec(\"VACUUM INTO \x27/tmp/snap.sqlite\x27\")"'
 * then copy /tmp/snap.sqlite out of the container.
 *
 * Usage:
 *   npm run replay -- --db snap.sqlite --scenarios scripts/replay-scenarios.json
 *   npm run replay -- --db snap.sqlite --thread <id> [--prompt "ok"]
 *   npm run replay -- --db snap.sqlite --run <runId>
 * Options: --owner <id> (default opendots-owner), --context <tokens>,
 *   --max-turns <n>, --json
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChatMiddleware } from '@tanstack/ai';
import { DotAgent } from '../src/server/dot-agent.js';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import { PluginService } from '../src/server/plugins.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { SqliteThreadRunner } from '../src/server/thread-runner.js';
import { runThreadTurn } from '../src/server/headless.js';
import { ActionItemStore } from '../src/server/action-item-store.js';
import { ActionItemService } from '../src/server/action-items.js';
import type { ActionItemIndex } from '../src/server/action-item-index.js';
import { TurnUsageLog, type TurnUsageRow } from '../src/server/turn-usage.js';

const DISCOVERY = '__lazy__tool__discovery__';
const MODEL = 'replay-model';

type Scenario =
  | { name: string; thread: string; prompt?: string }
  | { name: string; run: string };

interface Recorded {
  threadId: string;
  createdAt: number;
  prompt: string;
  metadata?: Record<string, unknown>;
  messageIds: Set<string>;
  rounds: { id: string; name: string; args: string }[][];
  results: Map<string, string>;
  text: string;
}

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const db = flag('db');
if (!db) {
  console.error('Pass --db <snapshot.sqlite>.');
  process.exit(1);
}
const owner = flag('owner') ?? 'opendots-owner';
const contextMaxTokens = flag('context') ? Number(flag('context')) : undefined;
const maxAgentTurns = flag('max-turns') ? Number(flag('max-turns')) : undefined;
const scenarios: Scenario[] = flag('scenarios')
  ? JSON.parse(readFileSync(flag('scenarios')!, 'utf8'))
  : flag('run')
    ? [{ name: flag('run')!, run: flag('run')! }]
    : flag('thread')
      ? [
          {
            name: flag('thread')!,
            thread: flag('thread')!,
            prompt: flag('prompt'),
          },
        ]
      : [];
if (!scenarios.length) {
  console.error('Pass --scenarios, --thread or --run.');
  process.exit(1);
}

/** Reads a recorded run's prompt, rounds and tool results from its events. */
function recorded(file: string, runId: string): Recorded {
  const source = new DatabaseSync(file, { readOnly: true });
  const row = source
    .prepare(
      'SELECT threadId, events, createdAt FROM runner_runs WHERE runId=?',
    )
    .get(runId) as
    { threadId: string; events: string; createdAt: number } | undefined;
  source.close();
  if (!row) throw new Error(`Run ${runId} is not in the snapshot.`);
  const events = JSON.parse(row.events) as Record<string, unknown>[];
  const started = events.find((event) => event.type === 'RUN_STARTED') as
    { input?: { messages?: Record<string, unknown>[] } } | undefined;
  const user = [...(started?.input?.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'user');
  const messageIds = new Set<string>(
    (started?.input?.messages ?? []).map((message) => String(message.id)),
  );
  // A tool call after tool results starts the next model call.
  const rounds: { id: string; name: string; args: string }[][] = [];
  let afterResults = true;
  const calls = new Map<string, { id: string; name: string; args: string }>();
  const results = new Map<string, string>();
  let text = '';
  for (const event of events) {
    for (const key of ['messageId', 'parentMessageId'])
      if (typeof event[key] === 'string') messageIds.add(event[key] as string);
    if (event.type === 'TOOL_CALL_START') {
      const call = {
        id: String(event.toolCallId),
        name: String(event.toolCallName),
        args: '',
      };
      calls.set(call.id, call);
      if (afterResults) rounds.push([]);
      afterResults = false;
      rounds.at(-1)!.push(call);
    }
    if (event.type === 'TOOL_CALL_ARGS') {
      const call = calls.get(String(event.toolCallId));
      if (call) call.args += String(event.delta ?? '');
    }
    if (event.type === 'TOOL_CALL_RESULT') {
      results.set(String(event.toolCallId), String(event.content ?? ''));
      afterResults = true;
    }
    if (event.type === 'TEXT_MESSAGE_CONTENT')
      text += String(event.delta ?? '');
  }
  return {
    threadId: row.threadId,
    createdAt: row.createdAt,
    prompt: String(user?.content ?? 'ok'),
    metadata: user?.metadata as Record<string, unknown> | undefined,
    messageIds,
    rounds,
    results,
    text: text || 'Done.',
  };
}

/** Removes a run and everything after it, so the thread is as it was before. */
function rewind(file: string, run: Recorded) {
  const target = new DatabaseSync(file);
  const ids = [...run.messageIds];
  const placeholders = ids.map(() => '?').join(',');
  const first = target
    .prepare(
      `SELECT MIN(seq) seq FROM runner_messages WHERE threadId=? AND messageId IN (${placeholders})`,
    )
    .get(run.threadId, ...ids) as { seq: number | null };
  if (first.seq != null)
    target
      .prepare('DELETE FROM runner_messages WHERE threadId=? AND seq>=?')
      .run(run.threadId, first.seq);
  target
    .prepare('DELETE FROM runner_runs WHERE threadId=? AND createdAt>=?')
    .run(run.threadId, run.createdAt);
  target.close();
}

/** A streamed Chat Completions reply. */
function stream(delta: Record<string, unknown>, finish: string) {
  const chunk = (body: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1, model: MODEL, ...body })}\n\n`;
  return new Response(
    chunk({ choices: [{ index: 0, delta, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) +
      'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

async function play(scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-replay-'));
  const file = join(dir, 'open.sqlite');
  copyFileSync(db!, file);
  const run = 'run' in scenario ? recorded(file, scenario.run) : undefined;
  if (run) rewind(file, run);
  const threadId = run ? run.threadId : (scenario as { thread: string }).thread;

  const store = new Store(file);
  const workspace = new WorkspaceStore(file, owner);
  const engine = new ExecutionEngine(store.database);
  const plugins = new PluginService(store.database, {
    listTools: async () => [],
    callTool: async () => ({}),
  } as never);
  const index = {
    upsert: async () => {},
    remove: async () => {},
    search: async () => [],
    nearest: async () => [],
  } as unknown as ActionItemIndex;
  const actionItems = new ActionItemService(
    new ActionItemStore(store.database),
    index,
    async (texts) => texts.map(() => [0.1]),
    workspace,
  );

  // Each replayed call answers with the result recorded for the original.
  const original = new Map<string, string>();
  let callSeq = 0;
  const resultFor = (id: string) => run?.results.get(original.get(id) ?? '');
  const pluginQueue = new Map<string, string[]>();
  const replayed = (text: string | undefined) => {
    if (text === undefined) return { note: 'No result was recorded.' };
    try {
      const parsed = JSON.parse(text);
      if (
        parsed &&
        typeof parsed === 'object' &&
        Object.keys(parsed).length === 1 &&
        'error' in parsed
      )
        throw new Error(String(parsed.error));
      return parsed;
    } catch (error) {
      if (error instanceof SyntaxError) return text;
      throw error;
    }
  };
  plugins.call = (async (_dot, pluginId, toolName, args) => {
    const key = `plugin_${pluginId}_${toolName}|${JSON.stringify(args)}`;
    const queue = pluginQueue.get(key) ?? [];
    return replayed(queue.shift());
  }) as PluginService['call'];
  const replay: ChatMiddleware = {
    name: 'replay-results',
    onBeforeToolCall: (_ctx, hook) => {
      if (hook.toolName === DISCOVERY) return;
      const text = resultFor(hook.toolCallId);
      if (hook.toolName.startsWith('plugin_')) {
        const key = `${hook.toolName}|${JSON.stringify(hook.args)}`;
        pluginQueue.set(key, [...(pluginQueue.get(key) ?? []), text ?? '']);
        return;
      }
      return {
        type: 'skip',
        result: text === undefined ? { note: 'No result was recorded.' } : text,
      };
    },
  };

  let round = 0;
  let discoveries = 0;
  const searched = new Set<string>();
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (!String(url).endsWith('/chat/completions'))
      return new Response('Not available in a replay.', { status: 503 });
    const body = JSON.parse(String(init?.body));
    if (body.model !== MODEL)
      return new Response('Not available in a replay.', { status: 503 });
    const offered = new Set(
      (body.tools ?? []).map(
        (tool: { function?: { name?: string }; name?: string }) =>
          tool.function?.name ?? tool.name,
      ),
    );
    const next = run?.rounds[round];
    if (!next)
      return stream(
        { role: 'assistant', content: run?.text ?? 'Okay.' },
        'stop',
      );
    // Search once for each tool; one that is still missing is not on offer.
    const missing = next
      .map((call) => call.name)
      .filter(
        (name) =>
          name !== DISCOVERY && !offered.has(name) && !searched.has(name),
      );
    missing.forEach((name) => searched.add(name));
    if (missing.length && offered.has(DISCOVERY)) {
      discoveries += 1;
      return stream(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `replay-discovery-${discoveries}`,
              type: 'function',
              function: {
                name: DISCOVERY,
                arguments: JSON.stringify({ toolNames: [...new Set(missing)] }),
              },
            },
          ],
        },
        'tool_calls',
      );
    }
    round += 1;
    return stream(
      {
        role: 'assistant',
        tool_calls: next.map((call, position) => {
          const id = `replay-${(callSeq += 1)}`;
          original.set(id, call.id);
          return {
            index: position,
            id,
            type: 'function',
            function: { name: call.name, arguments: call.args || '{}' },
          };
        }),
      },
      'tool_calls',
    );
  }) as typeof fetch;

  const thread = workspace.requireThread(threadId);
  const agent = new DotAgent(
    store,
    workspace,
    {
      apiKey: 'replay',
      model: MODEL,
      baseUrl: 'https://replay.invalid/v1',
      voiceName: 'marin',
      slackUsers: [],
      summaryModel: 'replay-summary',
      ...(contextMaxTokens ? { contextMaxTokens } : {}),
      ...(maxAgentTurns ? { maxAgentTurns } : {}),
    } as never,
    thread.dotId,
    false,
    {
      engine,
      plugins,
      actionItems,
      skillsDir: '/nonexistent',
      middleware: [replay],
    },
  );
  const work = run?.metadata;
  if (
    typeof work?.workItemId === 'string' &&
    typeof work.executionId === 'string'
  )
    agent.workContext = {
      workItemId: work.workItemId,
      executionId: work.executionId,
    };
  const quiet = console.info;
  console.info = () => {};
  try {
    await runThreadTurn(
      new SqliteThreadRunner(workspace.threads),
      agent,
      threadId,
      run ? run.prompt : ((scenario as { prompt?: string }).prompt ?? 'ok'),
      AbortSignal.timeout(300_000),
      run?.metadata,
    ).catch(() => undefined);
  } finally {
    console.info = quiet;
  }
  const [row] = new TurnUsageLog(store.database).list(0, 1);
  store.close();
  workspace.close();
  rmSync(dir, { recursive: true, force: true });
  return { scenario, row, discoveries, recordedRounds: run?.rounds.length };
}

const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;
const estimate = (row: TurnUsageRow) =>
  row.calls.reduce(
    (sum, call) =>
      sum + call.systemTokens + call.historyTokens + call.toolTokens,
    0,
  );

const results = [];
for (const scenario of scenarios) results.push(await play(scenario));

if (argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const { scenario, row, discoveries, recordedRounds } of results) {
    if (!row) {
      console.log(`${scenario.name}: no turn was recorded`);
      continue;
    }
    console.log(
      `\n${scenario.name}  ${row.outcome}${row.error ? ` (${row.error})` : ''}`,
    );
    console.log(
      `  model calls ${row.modelCalls}${recordedRounds !== undefined ? ` (recorded ${recordedRounds + 1}, extra tool searches ${discoveries})` : ''}  ~input ${k(estimate(row))}  tool calls ${row.toolCalls}  tool result chars ${row.toolResultChars}`,
    );
    const shown = row.calls.length > 6;
    for (const [at, call] of row.calls.entries()) {
      if (shown && at >= 3 && at < row.calls.length - 2) {
        if (at === 3) console.log('  …');
        continue;
      }
      console.log(
        `  call ${at + 1}: system ${k(call.systemTokens)}  history ${call.historyMessages} msgs ${k(call.historyTokens)}  tools ${call.tools} ${k(call.toolTokens)}`,
      );
    }
  }
}
process.exit(0);
