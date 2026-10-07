import type { DatabaseSync } from 'node:sqlite';
import type { BaseEvent, Message } from '@ag-ui/client';

export interface StoredRun {
  runId: string;
  threadId: string;
  agentId: string;
  parentRunId: string | null;
  events: BaseEvent[];
  createdAt: number;
}

export interface ThreadSummaryRecord {
  id: string;
  name: string | null;
  agentId: string;
  createdAt: number;
  updatedAt: number;
}

export interface PrefixSummary {
  messageCount: number;
  prefixHash: string;
  summary: string;
}

/**
 * Messages a client may add to a stored thread: new user messages, and tool
 * results that answer a still-open tool call. Assistant, system and developer
 * messages only enter history when this server's agent generates them.
 */
export function clientAdditions(
  stored: Message[],
  incoming: Message[],
): Message[] {
  const ids = new Set(stored.map((message) => message.id));
  const open = new Set<string>();
  for (const message of stored)
    if (message.role === 'assistant')
      for (const call of message.toolCalls ?? []) open.add(call.id);
    else if (message.role === 'tool') open.delete(message.toolCallId);
  return incoming.filter((message) => {
    if (ids.has(message.id)) return false;
    ids.add(message.id);
    if (message.role === 'user') return true;
    return message.role === 'tool' && open.delete(message.toolCallId);
  });
}

// Conversation history for local threads. Runs keep their compacted AG-UI
// events for replay; messages are the canonical transcript in arrival order.
export class ThreadHistory {
  constructor(
    private db: DatabaseSync,
    private ownerId: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS runner_runs(runId TEXT PRIMARY KEY, threadId TEXT NOT NULL, agentId TEXT NOT NULL, parentRunId TEXT, events TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS runner_runs_thread ON runner_runs(threadId, createdAt);
      CREATE TABLE IF NOT EXISTS runner_messages(threadId TEXT NOT NULL, messageId TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(threadId, messageId));
      CREATE TABLE IF NOT EXISTS thread_summaries(threadId TEXT NOT NULL, strategyKey TEXT NOT NULL, messageCount INTEGER NOT NULL, prefixHash TEXT NOT NULL, summary TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(threadId, strategyKey, messageCount));`);
  }

  runs(threadId: string): StoredRun[] {
    return this.db
      .prepare(
        'SELECT * FROM runner_runs WHERE threadId=? ORDER BY createdAt, rowid',
      )
      .all(threadId)
      .map((row) => ({
        runId: String(row.runId),
        threadId: String(row.threadId),
        agentId: String(row.agentId),
        parentRunId: row.parentRunId === null ? null : String(row.parentRunId),
        events: JSON.parse(String(row.events)) as BaseEvent[],
        createdAt: Number(row.createdAt),
      }));
  }

  lastRunId(threadId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT runId FROM runner_runs WHERE threadId=? ORDER BY createdAt DESC, rowid DESC LIMIT 1',
      )
      .get(threadId);
    return typeof row?.runId === 'string' ? row.runId : null;
  }

  messages(threadId: string): Message[] {
    return this.db
      .prepare('SELECT body FROM runner_messages WHERE threadId=? ORDER BY seq')
      .all(threadId)
      .map((row) => JSON.parse(String(row.body)) as Message);
  }

  messageIds(threadId: string): Set<string> {
    return new Set(
      this.db
        .prepare('SELECT messageId FROM runner_messages WHERE threadId=?')
        .all(threadId)
        .map((row) => String(row.messageId)),
    );
  }

  // Records a finished run. Existing messages keep their position; `replace`
  // lists messages whose stored content this run may update.
  appendRun(run: StoredRun, messages: Message[], replace: Set<string>) {
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO runner_runs VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          run.runId,
          run.threadId,
          run.agentId,
          run.parentRunId,
          JSON.stringify(run.events),
          run.createdAt,
        );
      const known = this.messageIds(run.threadId);
      let seq = Number(
        this.db
          .prepare(
            'SELECT COALESCE(MAX(seq), 0) AS seq FROM runner_messages WHERE threadId=?',
          )
          .get(run.threadId)?.seq ?? 0,
      );
      const insert = this.db.prepare(
        'INSERT INTO runner_messages VALUES (?, ?, ?, ?, ?, ?)',
      );
      const update = this.db.prepare(
        'UPDATE runner_messages SET body=?, role=?, updatedAt=? WHERE threadId=? AND messageId=?',
      );
      for (const message of messages) {
        const body = JSON.stringify(message);
        if (!known.has(message.id)) {
          insert.run(run.threadId, message.id, ++seq, message.role, body, now);
          known.add(message.id);
        } else if (replace.has(message.id))
          update.run(body, message.role, now, run.threadId, message.id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  threads(): ThreadSummaryRecord[] {
    return this.db
      .prepare(
        `SELECT b.id, b.title, b.dotId, b.createdAt,
          COALESCE((SELECT MAX(createdAt) FROM runner_runs r WHERE r.threadId=b.id), b.createdAt) AS updatedAt
        FROM thread_bindings b WHERE b.ownerId=? ORDER BY updatedAt DESC`,
      )
      .all(this.ownerId)
      .map((row) => ({
        id: String(row.id),
        name: typeof row.title === 'string' ? row.title : null,
        agentId: String(row.dotId),
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
      }));
  }

  /** Cached summaries of conversation prefixes, longest first. */
  summaries(threadId: string, strategyKey: string): PrefixSummary[] {
    return this.db
      .prepare(
        'SELECT messageCount, prefixHash, summary FROM thread_summaries WHERE threadId=? AND strategyKey=? ORDER BY messageCount DESC',
      )
      .all(threadId, strategyKey)
      .map((row) => ({
        messageCount: Number(row.messageCount),
        prefixHash: String(row.prefixHash),
        summary: String(row.summary),
      }));
  }

  saveSummary(threadId: string, strategyKey: string, entry: PrefixSummary) {
    this.db
      .prepare(
        'INSERT INTO thread_summaries VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET prefixHash=excluded.prefixHash, summary=excluded.summary, createdAt=excluded.createdAt',
      )
      .run(
        threadId,
        strategyKey,
        entry.messageCount,
        entry.prefixHash,
        entry.summary,
        Date.now(),
      );
  }
}
