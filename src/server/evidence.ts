import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

/**
 * What a background run looked up, which sources the Pod said the objective
 * needs, and what is still missing. The harness checks declared sources
 * against logged calls; it does not grade the written answer.
 *
 * `runId` scopes everything: empty for one-off work, which keeps its record
 * across attempts, and the first attempt's id for one run of scheduled work.
 */

export type Constraint = string | number | boolean;

export interface SourceInput {
  key: string;
  label: string;
  tool: string;
  match?: Record<string, Constraint>;
}

export interface Requirement {
  key: string;
  label: string;
  toolName: string;
  constraints: Record<string, Constraint>;
  status: 'pending' | 'satisfied' | 'withdrawn' | 'superseded';
  reason: string | null;
  callId: string | null;
}

export interface Gap {
  kind: 'source' | 'write' | 'undeclared' | 'stalled';
  text: string;
}

/** Tools that manage the run itself; their calls are not evidence. */
const NOT_EVIDENCE = new Set([
  'complete_work',
  'fail_work',
  'declare_requirements',
  'load_skill',
  'record_reconciliation',
  'report_call_result',
]);

type Row = Record<string, SQLInputValue>;

/** Equal after trimming and ignoring case, so "#Sales" matches "#sales". */
function same(a: unknown, b: Constraint) {
  if (typeof b === 'string' && typeof a === 'string')
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  return a === b;
}

export function matches(
  constraints: Record<string, Constraint>,
  args: Record<string, unknown>,
) {
  return Object.entries(constraints).every(([key, value]) =>
    same(args[key], value),
  );
}

/** How many records a result holds, when it says. */
export function resultCount(result: unknown): number | null {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === 'object') {
    const value = result as Record<string, unknown>;
    for (const key of ['items', 'results', 'messages', 'records', 'data'])
      if (Array.isArray(value[key])) return (value[key] as unknown[]).length;
  }
  return null;
}

export function hashResult(result: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(result ?? null))
    .digest('hex');
}

export class EvidenceLedger {
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY, workItemId TEXT NOT NULL, executionId TEXT NOT NULL, runId TEXT NOT NULL,
        toolName TEXT NOT NULL, argumentsJson TEXT NOT NULL, status TEXT NOT NULL,
        resultHash TEXT, resultCount INTEGER, error TEXT, startedAt INTEGER NOT NULL, finishedAt INTEGER);
      CREATE INDEX IF NOT EXISTS tool_calls_run ON tool_calls(workItemId, runId, toolName);
      CREATE TABLE IF NOT EXISTS work_requirements (
        workItemId TEXT NOT NULL, runId TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL,
        toolName TEXT NOT NULL, constraintsJson TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
        callId TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY(workItemId, runId, key));
      CREATE TABLE IF NOT EXISTS work_declarations (
        workItemId TEXT NOT NULL, runId TEXT NOT NULL, executionId TEXT NOT NULL, createdAt INTEGER NOT NULL,
        PRIMARY KEY(workItemId, runId));
    `);
  }

  static isEvidence(toolName: string) {
    return !NOT_EVIDENCE.has(toolName);
  }

  startCall(input: {
    workItemId: string;
    executionId: string;
    runId: string;
    toolName: string;
    args: Record<string, unknown>;
  }) {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, workItemId, executionId, runId, toolName, argumentsJson, status, startedAt)
         VALUES (?, ?, ?, ?, ?, ?, 'started', ?)`,
      )
      .run(
        id,
        input.workItemId,
        input.executionId,
        input.runId,
        input.toolName,
        JSON.stringify(input.args ?? {}),
        this.now(),
      );
    return id;
  }

  finishCall(
    id: string,
    outcome: { result: unknown } | { error: string },
  ): void {
    if ('error' in outcome) {
      this.db
        .prepare(
          "UPDATE tool_calls SET status='failed', error=?, finishedAt=? WHERE id=?",
        )
        .run(outcome.error.slice(0, 500), this.now(), id);
      return;
    }
    this.db
      .prepare(
        "UPDATE tool_calls SET status='succeeded', resultHash=?, resultCount=?, finishedAt=? WHERE id=?",
      )
      .run(
        hashResult(outcome.result),
        resultCount(outcome.result),
        this.now(),
        id,
      );
    const call = this.call(id);
    if (call) this.satisfyFrom(call);
  }

  /** Calls still running when an attempt stops did not return evidence. */
  abandonCalls(executionId: string) {
    this.db
      .prepare(
        "UPDATE tool_calls SET status='failed', error='The attempt stopped before this call returned.', finishedAt=? WHERE executionId=? AND status='started'",
      )
      .run(this.now(), executionId);
  }

  private call(id: string) {
    return this.db.prepare('SELECT * FROM tool_calls WHERE id=?').get(id) as
      Row | undefined;
  }

  private satisfyFrom(call: Row) {
    const pending = this.db
      .prepare(
        "SELECT * FROM work_requirements WHERE workItemId=? AND runId=? AND toolName=? AND status='pending'",
      )
      .all(call.workItemId, call.runId, call.toolName) as Row[];
    const args = JSON.parse(String(call.argumentsJson)) as Record<
      string,
      unknown
    >;
    for (const row of pending)
      if (matches(JSON.parse(String(row.constraintsJson)), args))
        this.db
          .prepare(
            "UPDATE work_requirements SET status='satisfied', callId=?, updatedAt=? WHERE workItemId=? AND runId=? AND key=?",
          )
          .run(call.id, this.now(), row.workItemId, row.runId, row.key);
  }

  declared(workItemId: string, runId: string) {
    return !!this.db
      .prepare('SELECT 1 FROM work_declarations WHERE workItemId=? AND runId=?')
      .get(workItemId, runId);
  }

  /**
   * Records the sources the objective needs. An empty list is a declaration
   * that no external evidence is needed. Sources already looked up in this
   * run are satisfied at once.
   */
  declare(
    workItemId: string,
    runId: string,
    executionId: string,
    sources: SourceInput[],
    withdrawals: { key: string; reason: string; supersededBy?: string }[] = [],
  ) {
    const now = this.now();
    this.db
      .prepare('INSERT OR IGNORE INTO work_declarations VALUES (?, ?, ?, ?)')
      .run(workItemId, runId, executionId, now);
    for (const source of sources) {
      this.db
        .prepare(
          `INSERT INTO work_requirements (workItemId, runId, key, label, toolName, constraintsJson, status, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
           ON CONFLICT(workItemId, runId, key) DO UPDATE SET label=excluded.label, toolName=excluded.toolName,
             constraintsJson=excluded.constraintsJson, status='pending', reason=NULL, callId=NULL, updatedAt=excluded.updatedAt`,
        )
        .run(
          workItemId,
          runId,
          source.key,
          source.label,
          source.tool,
          JSON.stringify(source.match ?? {}),
          now,
          now,
        );
      const done = this.db
        .prepare(
          "SELECT * FROM tool_calls WHERE workItemId=? AND runId=? AND toolName=? AND status='succeeded' ORDER BY finishedAt DESC",
        )
        .all(workItemId, runId, source.tool) as Row[];
      const hit = done.find((call) =>
        matches(source.match ?? {}, JSON.parse(String(call.argumentsJson))),
      );
      if (hit) this.satisfyFrom(hit);
    }
    for (const withdrawal of withdrawals)
      this.db
        .prepare(
          `UPDATE work_requirements SET status=?, reason=?, updatedAt=? WHERE workItemId=? AND runId=? AND key=?
             AND status IN ('pending','satisfied')`,
        )
        .run(
          withdrawal.supersededBy ? 'superseded' : 'withdrawn',
          withdrawal.supersededBy
            ? `${withdrawal.reason} (replaced by ${withdrawal.supersededBy})`
            : withdrawal.reason,
          now,
          workItemId,
          runId,
          withdrawal.key,
        );
    return this.requirements(workItemId, runId);
  }

  requirements(workItemId: string, runId: string): Requirement[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM work_requirements WHERE workItemId=? AND runId=? ORDER BY createdAt, key',
        )
        .all(workItemId, runId) as Row[]
    ).map((row) => ({
      key: String(row.key),
      label: String(row.label),
      toolName: String(row.toolName),
      constraints: JSON.parse(String(row.constraintsJson)),
      status: row.status as Requirement['status'],
      reason: row.reason == null ? null : String(row.reason),
      callId: row.callId == null ? null : String(row.callId),
    }));
  }

  /** Active sources still unmet, each with why: never looked up, or the lookup failed. */
  unmet(workItemId: string, runId: string): Gap[] {
    return this.requirements(workItemId, runId)
      .filter((row) => row.status === 'pending')
      .map((row) => {
        const failed = (
          this.db
            .prepare(
              "SELECT argumentsJson, error FROM tool_calls WHERE workItemId=? AND runId=? AND toolName=? AND status='failed' ORDER BY startedAt DESC",
            )
            .all(workItemId, runId, row.toolName) as Row[]
        ).find((call) =>
          matches(row.constraints, JSON.parse(String(call.argumentsJson))),
        );
        return {
          kind: 'source' as const,
          text: failed
            ? `${row.label} could not be read (${String(failed.error ?? 'the lookup failed')}), so anything from it may be missing.`
            : `${row.label} was not looked up, so anything from it may be missing.`,
        };
      });
  }

  /**
   * Whether this attempt moved the work forward: a call returned something
   * this run had not seen, or a declared source was satisfied by it. The
   * same call returning the same result again is activity, not progress.
   */
  progressed(workItemId: string, runId: string, executionId: string) {
    const fresh = this.db
      .prepare(
        `SELECT 1 FROM tool_calls c WHERE c.executionId=? AND c.status='succeeded' AND NOT EXISTS (
           SELECT 1 FROM tool_calls p WHERE p.workItemId=c.workItemId AND p.runId=c.runId
             AND p.executionId<>c.executionId AND p.status='succeeded' AND p.startedAt<=c.startedAt
             AND p.toolName=c.toolName AND p.argumentsJson=c.argumentsJson AND p.resultHash=c.resultHash)
         LIMIT 1`,
      )
      .get(executionId);
    if (fresh) return true;
    return !!this.db
      .prepare(
        `SELECT 1 FROM work_requirements r JOIN tool_calls c ON c.id=r.callId
         WHERE r.workItemId=? AND r.runId=? AND c.executionId=? LIMIT 1`,
      )
      .get(workItemId, runId, executionId);
  }

  /** A successful logged read in this work item that can back a reconciliation. */
  supportingCall(workItemId: string, callId: string) {
    return this.db
      .prepare(
        "SELECT * FROM tool_calls WHERE id=? AND workItemId=? AND status='succeeded'",
      )
      .get(callId, workItemId) as Row | undefined;
  }
}
