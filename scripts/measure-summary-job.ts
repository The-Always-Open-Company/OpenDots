/**
 * Replays a background job shaped like the 30 October summary job and
 * reports what the harness spends on it: attempts, model rounds, prompt size
 * per round, document-retrieval calls per attempt, and the outcome.
 *
 * The model is scripted. Each reply depends only on the request it receives:
 * which tools are offered and what earlier tool results say. It uses batched
 * searches and declares its sources when the tool schemas allow it, and pages
 * a single search otherwise. Round counts therefore reflect what each version
 * of the harness lets a model do, not what a real model would choose.
 * Prompt sizes are measured from the real requests; tokens are estimated at
 * four characters each. Output tokens are not measured, since the replies
 * are scripted.
 *
 * Usage: node --import tsx scripts/measure-summary-job.ts [recovers|down] [--json]
 *   recovers  Cliq hangs on the first read and answers later reads.
 *   down      Cliq hangs on the first read and fails every later read.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DotAgent } from '../src/server/dot-agent.js';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import { PluginService } from '../src/server/plugins.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { SqliteThreadRunner } from '../src/server/thread-runner.js';
import { runThreadTurn } from '../src/server/headless.js';
import { ensureWorkThread } from '../src/server/work-runner.js';
import { ActionItemStore } from '../src/server/action-item-store.js';
import { ActionItemService } from '../src/server/action-items.js';
import type { ActionItemIndex } from '../src/server/action-item-index.js';
import type { DocumentLibrary } from '../src/server/document-library.js';
import type { DocumentRetriever } from '../src/server/document-retrieval.js';

const scenario = process.argv.includes('down') ? 'down' : 'recovers';
const asJson = process.argv.includes('--json');
const MAX_ATTEMPTS = 30;
const DISCOVERY = '__lazy__tool__discovery__';
const CLIQ = 'plugin_cliq_get_messages';
const DAY = 24 * 60 * 60_000;
const today = new Date().toISOString().slice(0, 10);

// ---------- World ----------

const dir = mkdtempSync(join(tmpdir(), 'opendots-measure-'));
const file = join(dir, 'open.sqlite');
const store = new Store(file);
const workspace = new WorkspaceStore(file, 'owner');
let clock = Date.now();
const engine = new ExecutionEngine(store.database, () => clock);
const dot = workspace.dots()[0];

let attempt = 0;
let current: AbortController | undefined;
let cliqCalls = 0;
const plugins = new PluginService(store.database, {
  listTools: async () => [
    {
      name: 'get_messages',
      description: 'Get messages posted to a Cliq channel on a date.',
      schema: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          date: { type: 'string' },
        },
        required: ['channel'],
      },
    },
  ],
  callTool: async () => {
    cliqCalls += 1;
    if (cliqCalls === 1) {
      // The first read hangs until the attempt hits its time limit, and is
      // cut off with it, as an MCP request bound to the run would be.
      const stop = current!;
      setTimeout(
        () => stop.abort(new Error('Execution reached its time limit.')),
        20,
      );
      return new Promise((_, reject) =>
        stop.signal.addEventListener('abort', () =>
          reject(stop.signal.reason as Error),
        ),
      );
    }
    if (scenario === 'down')
      throw new Error('Cliq answered 503 Service Unavailable.');
    return {
      messages: [
        { from: 'Sam', text: 'Signed the Acme renewal.' },
        { from: 'Kai', text: 'Globex wants a revised quote by Friday.' },
      ],
    };
  },
});
plugins.save({ id: 'cliq', name: 'Cliq', url: 'http://127.0.0.1/mcp' });
await plugins.refresh('cliq');
plugins.grant(dot.id, 'cliq', 'get_messages', 'allow');
// What the deployed server does at startup after this change, when it exists.
(
  engine as unknown as {
    settleReadInvocations?: (isRead: (name: string) => boolean) => void;
  }
).settleReadInvocations?.(() => false);

// 40 shared documents, as in the incident's library.
const catalog = Array.from({ length: 40 }, (_, n) => ({
  id: `doc-${n + 1}`,
  title: `Account plan ${n + 1}: regional sales notes`,
  status: 'ready',
  searchable: true,
  summary:
    'Quarterly account plan with pipeline, renewal dates, named contacts, open risks and next steps for the regional sales team.',
  tags: ['sales', 'accounts', 'pipeline', `region-${n % 5}`],
}));
const library = {
  catalog: () => catalog,
  list: () => catalog,
  read: () => {
    throw new Error('Not in this fixture.');
  },
} as unknown as DocumentLibrary;
const retrievals = new Map<number, { prepared: number; tool: number }>();
const retriever = {
  retrieve: async (request: { force?: boolean }) => {
    const row = retrievals.get(attempt) ?? { prepared: 0, tool: 0 };
    if (request.force) row.tool += 1;
    else row.prepared += 1;
    retrievals.set(attempt, row);
    return [];
  },
  readPassage: async () => {
    throw new Error('Not in this fixture.');
  },
} as unknown as DocumentRetriever;

// 300 action items: 60 created today, 40 completed today, the rest older.
const items = new ActionItemStore(store.database);
const insert = store.database.prepare(
  `INSERT INTO action_items (id, statement, details, context, status, priority, labels, createdBy, sourceKind,
     sourceExcerpt, createdAt, updatedAt, completedAt, indexedAt)
   VALUES (?, ?, '', 'From the sales channel', ?, 'normal', '[]', 'dot', 'conversation', 'Seeded.', ?, ?, ?, ?)`,
);
const now = Date.now();
for (let n = 0; n < 300; n += 1) {
  const createdToday = n < 60;
  const doneToday = n >= 60 && n < 100;
  const createdAt = createdToday ? now - 60_000 * n : now - DAY * (2 + n / 10);
  insert.run(
    randomUUID(),
    `Follow up on account ${n + 1}`,
    doneToday ? 'done' : n % 7 === 0 ? 'waiting' : 'open',
    createdAt,
    doneToday ? now - 30_000 * n : createdAt,
    doneToday ? now - 30_000 * n : null,
    createdAt,
  );
}
const index: ActionItemIndex = {
  upsert: async () => {},
  remove: async () => {},
  search: async () => [],
  nearest: async () => [],
} as unknown as ActionItemIndex;
const actionItems = new ActionItemService(
  items,
  index,
  async (texts) => texts.map(() => [0.1, 0.2]),
  workspace,
);

// ---------- Scripted model ----------

type Call = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  thisAttempt: boolean;
};
type Round = {
  attempt: number;
  systemChars: number;
  toolChars: number;
  messageChars: number;
  tools: number;
  toolSizes: Record<string, number>;
  replied: string[];
};
const rounds: Round[] = [];
let callSeq = 0;

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('');
  return content == null ? '' : JSON.stringify(content);
}

function history(messages: Record<string, unknown>[]) {
  const start = messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      !text(message.content).startsWith('[Pods turn context]'),
  );
  const calls = new Map<string, Call>();
  messages.forEach((message, position) => {
    for (const call of (message.tool_calls as
      | { id: string; function: { name: string; arguments: string } }[]
      | undefined) ?? [])
      calls.set(call.id, {
        id: call.id,
        name: call.function.name,
        args: JSON.parse(call.function.arguments || '{}'),
        thisAttempt: position > start,
      });
    if (message.role === 'tool') {
      const call = calls.get(String(message.tool_call_id));
      if (call) call.result = text(message.content);
    }
  });
  return [...calls.values()];
}

/** No result, an error result, or an effect the harness marked failed or uncertain. */
function failed(call: Call) {
  if (!call.result) return true;
  if (/^Error/i.test(call.result)) return true;
  try {
    const value = JSON.parse(call.result) as Record<string, unknown>;
    return (
      !!value &&
      typeof value === 'object' &&
      ('error' in value ||
        value.status === 'failed' ||
        value.status === 'uncertain')
    );
  } catch {
    return false;
  }
}

function decide(body: {
  messages: Record<string, unknown>[];
  tools?: { function: { name: string; parameters?: unknown } }[];
}) {
  const offered = new Set((body.tools ?? []).map((tool) => tool.function.name));
  const schemaOf = (name: string) =>
    JSON.stringify(
      body.tools?.find((tool) => tool.function.name === name)?.function
        .parameters ?? {},
    );
  const calls = history(body.messages);
  const attemptCalls = calls.filter((call) => call.thisAttempt);
  const ofName = (list: Call[], name: string) =>
    list.filter((call) => call.name === name);
  const replies: { name: string; args: Record<string, unknown> }[] = [];
  const call = (name: string, args: Record<string, unknown>) => {
    if (offered.has(name) || !offered.has(DISCOVERY))
      replies.push({ name, args });
    else replies.push({ name: DISCOVERY, args: { toolNames: [name] } });
  };
  const declares = offered.has('declare_requirements');
  const declared = ofName(calls, 'declare_requirements').some(
    (item) => !failed(item),
  );
  const cliqOk = ofName(calls, CLIQ).some((item) => !failed(item));
  const cliqTried = ofName(attemptCalls, CLIQ).length > 0;
  const saved = ofName(calls, 'create_space_page').some(
    (item) => !failed(item),
  );

  if (saved) {
    const completes = ofName(attemptCalls, 'complete_work');
    const last = completes.at(-1);
    if (!last)
      return replies.concat({
        name: 'complete_work',
        args: { reason: 'Summary saved.' },
      });
    const refused = /"finishIntent":null/.test(last.result ?? '');
    if (refused && declares && completes.length < 3)
      return replies.concat({
        name: 'declare_requirements',
        args: { sources: sources() },
      });
    if (refused && completes.length < 3)
      return replies.concat({
        name: 'complete_work',
        args: { reason: 'Summary saved.' },
      });
    return 'The summary is saved as a page.';
  }

  if (
    declares &&
    !declared &&
    !ofName(attemptCalls, 'declare_requirements').length
  )
    call('declare_requirements', { sources: sources() });

  const searches = ofName(calls, 'search_action_items').filter(
    (item) => !failed(item),
  );
  const batched = /"searches"/.test(schemaOf('search_action_items'));
  const last = searches.at(-1);
  const nextOffset = last
    ? (JSON.parse(last.result!) as { nextOffset?: number | null }).nextOffset
    : undefined;
  if (!last || (!batched && nextOffset != null)) {
    call(
      'search_action_items',
      batched
        ? {
            searches: [
              { createdAfter: today, limit: 50 },
              { completedAfter: today, limit: 50 },
            ],
          }
        : {
            statuses: ['open', 'waiting', 'done'],
            limit: 20,
            offset: nextOffset ?? 0,
          },
    );
    return replies;
  }
  if (replies.length) return replies;

  if (!cliqOk && !cliqTried) {
    call(CLIQ, { channel: '#sales', date: today });
    return replies;
  }

  call('create_space_page', {
    title: `Sales summary ${today}`,
    content: cliqOk
      ? '# Sales today\n\n- Acme renewal signed.\n- Globex wants a revised quote.'
      : "# Sales today\n\nToday's #sales messages could not be read.",
  });
  return replies;
}

function sources() {
  return [
    {
      key: 'cliq',
      label: "Today's #sales messages",
      tool: CLIQ,
      match: { channel: '#sales' },
    },
    {
      key: 'items',
      label: "Today's action items",
      tool: 'search_action_items',
    },
  ];
}

function stream(delta: Record<string, unknown>, finish: string) {
  const chunk = (d: Record<string, unknown>, f: string | null) => ({
    id: 'completion',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'custom-model',
    choices: [{ index: 0, delta: d, finish_reason: f }],
  });
  return new Response(
    [chunk(delta, null), chunk({}, finish)]
      .map((item) => `data: ${JSON.stringify(item)}\n\n`)
      .join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (!String(url).endsWith('/chat/completions'))
    throw new Error(`Unexpected request to ${String(url)}`);
  const body = JSON.parse(String(init?.body));
  const system = (body.messages as Record<string, unknown>[]).filter(
    (message) => message.role === 'system' || message.role === 'developer',
  );
  const rest = (body.messages as Record<string, unknown>[]).filter(
    (message) => !system.includes(message),
  );
  const reply = decide(body);
  if (process.env.MEASURE_DEBUG)
    console.error(
      `[attempt ${attempt}] reply`,
      JSON.stringify(reply).slice(0, 300),
    );
  rounds.push({
    attempt,
    systemChars: JSON.stringify(system).length,
    toolChars: JSON.stringify(body.tools ?? []).length,
    messageChars: JSON.stringify(rest).length,
    tools: (body.tools ?? []).length,
    toolSizes: Object.fromEntries(
      (body.tools ?? []).map((tool: { function: { name: string } }) => [
        tool.function.name,
        Math.round(JSON.stringify(tool).length / 4),
      ]),
    ),
    replied:
      typeof reply === 'string' ? ['(text)'] : reply.map((item) => item.name),
  });
  if (typeof reply === 'string')
    return stream({ role: 'assistant', content: reply }, 'stop');
  return stream(
    {
      role: 'assistant',
      tool_calls: reply.map((item, position) => ({
        index: position,
        id: `call-${(callSeq += 1)}`,
        type: 'function',
        function: { name: item.name, arguments: JSON.stringify(item.args) },
      })),
    },
    'tool_calls',
  );
}) as typeof fetch;

// ---------- Harness loop, as WorkRunner runs it ----------

const runner = new SqliteThreadRunner(workspace.threads);
const item = engine.createWorkItem({
  actorId: dot.id,
  title: 'Daily sales summary',
  objective:
    "Summarise today's #sales messages in Cliq and the action items created or completed today, and save the summary as a page.",
  source: 'delegation',
});
const workItemId = String(item.id);
engine.enqueueExecution(workItemId);

const attempts: { attempt: number; outcome: string; error?: string }[] = [];
const HARNESS_STOPS = /^Server stopped|time limit/i;
while (attempt < MAX_ATTEMPTS) {
  clock += 60 * 60_000;
  const claim = engine.claimExecution();
  if (!claim) break;
  attempt += 1;
  const threadId = ensureWorkThread(
    workspace,
    engine,
    engine.workItem(workItemId)!,
  );
  const agent = new DotAgent(
    store,
    workspace,
    {
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://model.invalid/v1',
      voiceName: 'marin',
      slackUsers: [],
    },
    dot.id,
    false,
    {
      engine,
      plugins,
      documents: library,
      retriever,
      actionItems,
      skillsDir: join(dir, 'skills'),
    },
  );
  agent.workContext = { workItemId, executionId: String(claim.id) };
  current = new AbortController();
  let outcome = 'completed';
  let error: string | undefined;
  try {
    await runThreadTurn(
      runner,
      agent,
      threadId,
      engine.continuationPrompt(workItemId),
      current.signal,
      { opendotsSource: 'work', workItemId, executionId: String(claim.id) },
    );
  } catch (caught) {
    outcome = current.signal.aborted ? 'interrupted' : 'failed';
    error = current.signal.aborted
      ? (current.signal.reason as Error).message
      : caught instanceof Error
        ? caught.message
        : 'Execution failed.';
  }
  engine.finishExecution(String(claim.id), outcome as 'completed', error, {
    retry: HARNESS_STOPS.test(error ?? ''),
  });
  attempts.push({ attempt, outcome, ...(error ? { error } : {}) });
}

// ---------- Report ----------

const final = engine.workItem(workItemId)!;
const gaps = (
  engine as unknown as { gaps?: (id: string) => { text: string }[] }
).gaps?.(workItemId);
const tokens = (chars: number) => Math.round(chars / 4);
const perAttempt = attempts.map((row) => {
  const mine = rounds.filter((round) => round.attempt === row.attempt);
  const retrieval = retrievals.get(row.attempt) ?? { prepared: 0, tool: 0 };
  return {
    ...row,
    rounds: mine.length,
    inputTokens: tokens(
      mine.reduce(
        (sum, round) =>
          sum + round.systemChars + round.toolChars + round.messageChars,
        0,
      ),
    ),
    retrievals: retrieval.prepared + retrieval.tool,
    calls: mine.flatMap((round) => round.replied),
  };
});
const first = rounds[0];
const summary = {
  scenario,
  status: String(final.status),
  gaps: gaps?.map((gap) => gap.text) ?? null,
  attempts: attempts.length,
  modelRounds: rounds.length,
  inputTokens: perAttempt.reduce((sum, row) => sum + row.inputTokens, 0),
  firstRound: first && {
    systemTokens: tokens(first.systemChars),
    toolTokens: tokens(first.toolChars),
    messageTokens: tokens(first.messageChars),
    tools: first.tools,
    toolTokensByName: first.toolSizes,
  },
  actionItemSearchCalls: rounds
    .flatMap((round) => round.replied)
    .filter((name) => name === 'search_action_items').length,
  retrievalCalls: perAttempt.reduce((sum, row) => sum + row.retrievals, 0),
  perAttempt,
};

if (asJson) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(
    `Scenario: ${scenario}\nOutcome: ${summary.status}${summary.gaps?.length ? ` with gaps:\n  - ${summary.gaps.join('\n  - ')}` : ''}`,
  );
  console.log(
    `Attempts ${summary.attempts}, model rounds ${summary.modelRounds}, input tokens ~${summary.inputTokens}, action-item searches ${summary.actionItemSearchCalls}, document retrievals ${summary.retrievalCalls}`,
  );
  console.log(`First round: ${JSON.stringify(summary.firstRound)}`);
  for (const row of perAttempt)
    console.log(
      `  #${row.attempt} ${row.outcome}${row.error ? ` (${row.error})` : ''}: ${row.rounds} rounds, ~${row.inputTokens} tokens, ${row.retrievals} retrievals; ${row.calls.join(', ')}`,
    );
}

store.close();
workspace.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
