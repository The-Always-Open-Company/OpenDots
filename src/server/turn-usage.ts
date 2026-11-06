/**
 * Records what each agent turn costs: one row per turn with its model calls,
 * tokens, cache use, request size and tool activity, and how it ended. Rows
 * are written however the turn ends, including an error or a stop, so spend
 * that never reached a final reply is still counted.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ChatMiddleware } from '@tanstack/ai';
import { textTokens, toolTokens } from './context-size.js';

export type TurnKind =
  | 'chat'
  | 'work'
  | 'approval'
  | 'chat_task'
  | 'consultation'
  | 'call'
  | 'channel';

export type TurnOutcome = 'completed' | 'error' | 'stopped';

/** One model call: the request as sent, and what the provider billed. */
export interface ModelCall {
  /** Estimated tokens, at four characters each, of each part of the request. */
  systemTokens: number;
  historyMessages: number;
  historyTokens: number;
  tools: number;
  toolTokens: number;
  /** Billed by the provider; absent when the call reported no usage. */
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export interface ToolCallRecord {
  name: string;
  ok: boolean;
  ms: number;
  resultChars: number;
}

export interface TurnUsageRow {
  runId: string;
  threadId: string;
  dotId: string;
  kind: TurnKind;
  workItemId: string | null;
  executionId: string | null;
  model: string;
  startedAt: number;
  finishedAt: number;
  outcome: TurnOutcome;
  error: string | null;
  modelCalls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  toolFailures: number;
  toolResultChars: number;
  firstHistoryMessages: number;
  firstHistoryTokens: number;
  firstTools: number;
  firstToolTokens: number;
  calls: ModelCall[];
  toolLog: ToolCallRecord[];
}

const ready = new WeakSet<DatabaseSync>();

/** The turn_usage table on the main database. */
export class TurnUsageLog {
  constructor(private readonly db: DatabaseSync) {
    if (ready.has(db)) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS turn_usage (
        runId TEXT PRIMARY KEY, threadId TEXT NOT NULL, dotId TEXT NOT NULL, kind TEXT NOT NULL,
        workItemId TEXT, executionId TEXT, model TEXT NOT NULL,
        startedAt INTEGER NOT NULL, finishedAt INTEGER NOT NULL, outcome TEXT NOT NULL, error TEXT,
        modelCalls INTEGER NOT NULL, inputTokens INTEGER NOT NULL, cachedTokens INTEGER NOT NULL,
        outputTokens INTEGER NOT NULL, reasoningTokens INTEGER NOT NULL,
        toolCalls INTEGER NOT NULL, toolFailures INTEGER NOT NULL, toolResultChars INTEGER NOT NULL,
        firstHistoryMessages INTEGER NOT NULL, firstHistoryTokens INTEGER NOT NULL,
        firstTools INTEGER NOT NULL, firstToolTokens INTEGER NOT NULL,
        callsJson TEXT NOT NULL, toolsJson TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS turn_usage_started ON turn_usage(startedAt);
      CREATE INDEX IF NOT EXISTS turn_usage_thread ON turn_usage(threadId, startedAt);
    `);
    ready.add(db);
  }

  record(row: TurnUsageRow) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO turn_usage VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.runId,
        row.threadId,
        row.dotId,
        row.kind,
        row.workItemId,
        row.executionId,
        row.model,
        row.startedAt,
        row.finishedAt,
        row.outcome,
        row.error,
        row.modelCalls,
        row.inputTokens,
        row.cachedTokens,
        row.outputTokens,
        row.reasoningTokens,
        row.toolCalls,
        row.toolFailures,
        row.toolResultChars,
        row.firstHistoryMessages,
        row.firstHistoryTokens,
        row.firstTools,
        row.firstToolTokens,
        JSON.stringify(row.calls),
        JSON.stringify(row.toolLog),
      );
  }

  /** Turns started at or after `since`, newest first. */
  list(since: number, limit = 200, threadId?: string): TurnUsageRow[] {
    const rows = (
      threadId
        ? this.db
            .prepare(
              'SELECT * FROM turn_usage WHERE startedAt >= ? AND threadId = ? ORDER BY startedAt DESC LIMIT ?',
            )
            .all(since, threadId, limit)
        : this.db
            .prepare(
              'SELECT * FROM turn_usage WHERE startedAt >= ? ORDER BY startedAt DESC LIMIT ?',
            )
            .all(since, limit)
    ) as Record<string, unknown>[];
    return rows.map(({ callsJson, toolsJson, ...rest }) => ({
      ...(rest as unknown as TurnUsageRow),
      calls: JSON.parse(String(callsJson)),
      toolLog: JSON.parse(String(toolsJson)),
    }));
  }

  /** Totals by kind and model for turns started at or after `since`. */
  totals(since: number) {
    return this.db
      .prepare(
        `SELECT kind, model, COUNT(*) turns, SUM(modelCalls) modelCalls,
           SUM(inputTokens) inputTokens, SUM(cachedTokens) cachedTokens,
           SUM(outputTokens) outputTokens, SUM(reasoningTokens) reasoningTokens,
           SUM(toolCalls) toolCalls, SUM(toolFailures) toolFailures,
           SUM(CASE WHEN outcome != 'completed' THEN 1 ELSE 0 END) unfinished
         FROM turn_usage WHERE startedAt >= ? GROUP BY kind, model ORDER BY inputTokens DESC`,
      )
      .all(since) as Record<string, number | string>[];
  }
}

const num = (value: unknown) => (typeof value === 'number' ? value : 0);

/** Reads billed tokens from normalized TanStack usage or raw provider usage. */
export function billedTokens(usage: unknown) {
  const entry = (usage ?? {}) as Record<string, unknown>;
  const prompt = (entry.promptTokensDetails ??
    entry.prompt_tokens_details ??
    entry.input_tokens_details ??
    {}) as Record<string, unknown>;
  const completion = (entry.completionTokensDetails ??
    entry.completion_tokens_details ??
    entry.output_tokens_details ??
    {}) as Record<string, unknown>;
  return {
    inputTokens:
      num(entry.promptTokens) ||
      num(entry.inputTokens) ||
      num(entry.prompt_tokens) ||
      num(entry.input_tokens),
    cachedTokens:
      num(prompt.cachedTokens) ||
      num(prompt.cached_tokens) ||
      num(entry.cachedInputTokens),
    outputTokens:
      num(entry.completionTokens) ||
      num(entry.outputTokens) ||
      num(entry.completion_tokens) ||
      num(entry.output_tokens),
    reasoningTokens:
      num(completion.reasoningTokens) ||
      num(completion.reasoning_tokens) ||
      num(entry.reasoningTokens),
  };
}

const chars = (value: unknown) => {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
};

/**
 * Collects one turn's usage. Its middleware must run after every middleware
 * that changes the request, so it sees what is actually sent.
 */
export class TurnUsageMeter {
  readonly calls: ModelCall[] = [];
  readonly toolLog: ToolCallRecord[] = [];
  readonly startedAt = Date.now();

  middleware(): ChatMiddleware {
    return {
      name: 'opendots-turn-usage',
      onConfig: (ctx, config) => {
        if (ctx.phase !== 'beforeModel') return;
        const messages = config.providerMessages ?? config.messages;
        this.calls.push({
          systemTokens: textTokens(
            config.systemPrompts
              .map((prompt) =>
                typeof prompt === 'string' ? prompt : chars(prompt),
              )
              .join('\n'),
          ),
          historyMessages: messages.length,
          historyTokens: Math.ceil(chars(messages) / 4),
          tools: config.tools.length,
          toolTokens: config.tools.reduce(
            (sum, tool) =>
              sum +
              toolTokens({
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              }),
            0,
          ),
        });
      },
      onUsage: (_ctx, usage) => {
        const call = this.calls.at(-1);
        if (!call || call.inputTokens !== undefined) return;
        Object.assign(call, billedTokens(usage));
      },
      onAfterToolCall: (_ctx, info) => {
        this.toolLog.push({
          name: info.toolName,
          ok: info.ok && !isErrorResult(info.result),
          ms: info.duration,
          resultChars: chars(
            info.ok
              ? info.result
              : info.error instanceof Error
                ? info.error.message
                : info.error,
          ),
        });
      },
    };
  }

  /** The row for this turn, given how it ended. */
  row(
    turn: Pick<
      TurnUsageRow,
      | 'runId'
      | 'threadId'
      | 'dotId'
      | 'kind'
      | 'workItemId'
      | 'executionId'
      | 'model'
      | 'outcome'
      | 'error'
    >,
  ): TurnUsageRow {
    const sum = (key: keyof ModelCall) =>
      this.calls.reduce((total, call) => total + num(call[key]), 0);
    const first = this.calls[0];
    return {
      ...turn,
      startedAt: this.startedAt,
      finishedAt: Date.now(),
      modelCalls: this.calls.length,
      inputTokens: sum('inputTokens'),
      cachedTokens: sum('cachedTokens'),
      outputTokens: sum('outputTokens'),
      reasoningTokens: sum('reasoningTokens'),
      toolCalls: this.toolLog.length,
      toolFailures: this.toolLog.filter((tool) => !tool.ok).length,
      toolResultChars: this.toolLog.reduce(
        (total, tool) => total + tool.resultChars,
        0,
      ),
      firstHistoryMessages: first?.historyMessages ?? 0,
      firstHistoryTokens: first?.historyTokens ?? 0,
      firstTools: first?.tools ?? 0,
      firstToolTokens: first?.toolTokens ?? 0,
      calls: this.calls,
      toolLog: this.toolLog,
    };
  }
}

/** Plugin and harness tools report failure as a result with an error field. */
function isErrorResult(result: unknown) {
  let value = result;
  if (typeof value === 'string')
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  return (
    !!value &&
    typeof value === 'object' &&
    'error' in value &&
    !!(value as { error?: unknown }).error
  );
}
