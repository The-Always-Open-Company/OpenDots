import { ComputerStore } from './computer-store.js';
import { Pages } from './pages.js';
import { ThreadHistory } from './thread-history.js';
import { Documents } from './documents.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CallReceipt, Conversation, Dot, Space } from '../shared/types.js';
export type ThreadKind = 'chat' | 'consultation';
export class WorkspaceStore {
  private db: DatabaseSync;
  readonly pages: Pages;
  readonly computers: ComputerStore;
  readonly threads: ThreadHistory;
  readonly documents: Documents;
  constructor(
    path: string,
    readonly ownerId: string,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    // Migrate only once: restarting must never restore a revoked grant.
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='dot_spaces'",
        )
        .get()
    ) {
      this.db.exec(`BEGIN;
        CREATE TABLE dot_spaces(dotId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(dotId, spaceId));
        INSERT INTO dot_spaces SELECT id, spaceId FROM dots;
        COMMIT;`);
    }
    this.computers = new ComputerStore(this.db);
    this.threads = new ThreadHistory(this.db, ownerId);
    this.pages = new Pages(this.db, (id) =>
      this.spaces().some((space) => space.id === id),
    );
    const addColumn = (table: string, column: string, definition: string) => {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((existing) => existing.name === column)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    addColumn('calls', 'anchorMessageId', 'TEXT');
    addColumn('dots', 'consultable', 'INTEGER NOT NULL DEFAULT 1');
    addColumn('dots', 'mascot', 'TEXT');
    addColumn('thread_bindings', 'kind', "TEXT NOT NULL DEFAULT 'chat'");
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS consultations(fromDotId TEXT NOT NULL, toDotId TEXT NOT NULL, threadId TEXT NOT NULL, PRIMARY KEY(fromDotId, toDotId))',
    );
    this.documents = new Documents(this.db, {
      dot: (id) => !!this.dot(id),
      space: (id) => this.spaces().some((space) => space.id === id),
    });
    if (!this.spaces().length) {
      const space = this.createSpace(
        'Everyday',
        'A little space for your day.',
      );
      this.createDot(
        space.id,
        'Dot',
        'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
        true,
        true,
      );
    }
  }
  close() {
    this.db.close();
  }
  spaces(): Space[] {
    return this.db
      .prepare('SELECT * FROM spaces ORDER BY createdAt')
      .all() as unknown as Space[];
  }
  createSpace(name: string, description: string): Space {
    const space = {
      id: randomUUID(),
      name,
      description,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)')
      .run(space.id, name, description, space.createdAt);
    return space;
  }
  dots(): Dot[] {
    return this.db
      .prepare(
        'SELECT id, spaceId, name, instructions, researchAllowed, memoryAllowed, consultable, mascot, createdAt FROM dots ORDER BY createdAt',
      )
      .all()
      .map((row) => ({
        ...row,
        spaceIds: this.db
          .prepare(
            'SELECT spaceId FROM dot_spaces WHERE dotId=? ORDER BY spaceId',
          )
          .all(String(row.id))
          .map((grant) => String(grant.spaceId)),
        researchAllowed: !!row.researchAllowed,
        memoryAllowed: !!row.memoryAllowed,
        consultable: !!row.consultable,
        mascot: typeof row.mascot === 'string' ? row.mascot : null,
      })) as unknown as Dot[];
  }
  dot(id: string) {
    return this.dots().find((dot) => dot.id === id);
  }
  createDot(
    spaceId: string,
    name: string,
    instructions: string,
    researchAllowed: boolean,
    memoryAllowed: boolean,
    spaceIds: string[] = [spaceId],
    consultable = true,
  ): Dot {
    this.validateSpaceAccess(spaceId, spaceIds);
    const dot: Dot = {
      id: randomUUID(),
      spaceId,
      spaceIds: [...new Set(spaceIds)].sort(),
      name,
      instructions,
      researchAllowed,
      memoryAllowed,
      consultable,
      mascot: null,
      createdAt: Date.now(),
    };
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, consultable, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          dot.id,
          spaceId,
          name,
          instructions,
          +researchAllowed,
          +memoryAllowed,
          +consultable,
          dot.createdAt,
        );
      for (const id of dot.spaceIds)
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(dot.id, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return dot;
  }
  canAccessSpace(dotId: string, spaceId: string) {
    return !!this.db
      .prepare('SELECT 1 FROM dot_spaces WHERE dotId=? AND spaceId=?')
      .get(dotId, spaceId);
  }
  private validateSpaceAccess(defaultSpace: string, spaceIds: string[]) {
    if (
      !spaceIds.includes(defaultSpace) ||
      spaceIds.some((id) => !this.spaces().some((space) => space.id === id))
    )
      throw new Error('Space access must include a valid default destination.');
  }
  updateDot(
    id: string,
    patch: Pick<
      Dot,
      'name' | 'instructions' | 'researchAllowed' | 'memoryAllowed'
    > & {
      spaceId?: string;
      spaceIds?: string[];
      consultable?: boolean;
      mascot?: string | null;
    },
  ): Dot {
    const current = this.dot(id);
    if (!current) throw new Error('Dot not found.');
    const defaultSpace = patch.spaceId ?? current.spaceId;
    const spaceIds = patch.spaceIds ?? current.spaceIds;
    this.validateSpaceAccess(defaultSpace, spaceIds);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'UPDATE dots SET name=?, instructions=?, researchAllowed=?, memoryAllowed=?, consultable=? WHERE id=?',
        )
        .run(
          patch.name,
          patch.instructions,
          +patch.researchAllowed,
          +patch.memoryAllowed,
          +(patch.consultable ?? current.consultable),
          id,
        );
      this.db
        .prepare('UPDATE dots SET spaceId=? WHERE id=?')
        .run(defaultSpace, id);
      this.db.prepare('DELETE FROM dot_spaces WHERE dotId=?').run(id);
      for (const space of new Set(spaceIds))
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(id, space);
      if (patch.mascot !== undefined) {
        if (
          patch.mascot !== null &&
          !['blue', 'mint', 'orange', 'purple'].includes(patch.mascot)
        )
          throw new Error('Choose a blue, mint, orange, or purple mascot.');
        this.db
          .prepare('UPDATE dots SET mascot=? WHERE id=?')
          .run(patch.mascot, id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.dot(id)!;
  }
  /** Chat conversations only; consultations between Dots are kept separately. */
  conversations(): Conversation[] {
    return this.db
      .prepare(
        "SELECT id, dotId, ownerId, title, createdAt FROM thread_bindings WHERE ownerId=? AND kind='chat' ORDER BY createdAt DESC",
      )
      .all(this.ownerId) as unknown as Conversation[];
  }
  bindThread(
    id: string,
    dotId: string,
    title: string,
    kind: ThreadKind = 'chat',
  ): Conversation {
    if (!this.dot(dotId)) throw new Error('Dot not found.');
    const value: Conversation = {
      id,
      dotId,
      ownerId: this.ownerId,
      title,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, kind) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, dotId, this.ownerId, title, value.createdAt, kind);
    return value;
  }
  /** Any thread this owner holds, including consultations. */
  requireThread(id: string, dotId?: string): Conversation {
    const thread = this.db
      .prepare(
        'SELECT id, dotId, ownerId, title, createdAt FROM thread_bindings WHERE id=? AND ownerId=?',
      )
      .get(id, this.ownerId) as unknown as Conversation | undefined;
    if (!thread || (dotId && thread.dotId !== dotId))
      throw new Error('Conversation does not belong to this Dot and owner.');
    return thread;
  }
  threadKind(id: string): ThreadKind {
    const row = this.db
      .prepare('SELECT kind FROM thread_bindings WHERE id=? AND ownerId=?')
      .get(id, this.ownerId);
    if (!row) throw new Error('Conversation does not belong to this owner.');
    return row.kind === 'consultation' ? 'consultation' : 'chat';
  }
  consultations(): {
    fromDotId: string;
    toDotId: string;
    threadId: string;
    createdAt: number;
  }[] {
    return this.db
      .prepare(
        'SELECT c.fromDotId, c.toDotId, c.threadId, b.createdAt FROM consultations c JOIN thread_bindings b ON b.id=c.threadId WHERE b.ownerId=? ORDER BY b.createdAt DESC',
      )
      .all(this.ownerId)
      .map((row) => ({
        fromDotId: String(row.fromDotId),
        toDotId: String(row.toDotId),
        threadId: String(row.threadId),
        createdAt: Number(row.createdAt),
      }));
  }
  /** The thread where `toDotId` answers `fromDotId`, created on first use. */
  consultationThread(fromDotId: string, toDotId: string): string {
    const existing = this.db
      .prepare(
        'SELECT threadId FROM consultations WHERE fromDotId=? AND toDotId=?',
      )
      .get(fromDotId, toDotId);
    if (typeof existing?.threadId === 'string') return existing.threadId;
    const from = this.dot(fromDotId);
    if (!from) throw new Error('Dot not found.');
    const id = randomUUID();
    this.db.exec('BEGIN');
    try {
      this.bindThread(id, toDotId, `Consulted by ${from.name}`, 'consultation');
      this.db
        .prepare('INSERT INTO consultations VALUES (?, ?, ?)')
        .run(fromDotId, toDotId, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return id;
  }
  bindTask(taskId: string, threadId: string) {
    this.requireThread(threadId);
    this.db
      .prepare('INSERT INTO task_threads VALUES (?, ?)')
      .run(taskId, threadId);
  }
  taskThread(taskId: string): string | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM task_threads WHERE taskId=?')
      .get(taskId);
    return typeof row?.threadId === 'string' ? row.threadId : undefined;
  }
  /** The Dot and conversation a legacy task ran in; the first Dot when it had none. */
  legacyTaskOwner(taskId: string): { actorId: string; threadId?: string } {
    const row = this.db
      .prepare(
        `SELECT b.id AS threadId, b.dotId FROM task_threads t
         JOIN thread_bindings b ON b.id=t.threadId AND b.ownerId=?
         WHERE t.taskId=?`,
      )
      .get(this.ownerId, taskId) as
      { threadId: string; dotId: string } | undefined;
    if (row) return { actorId: row.dotId, threadId: row.threadId };
    return { actorId: this.dots()[0]?.id ?? 'legacy' };
  }
  calls(threadId?: string): CallReceipt[] {
    if (threadId) this.requireThread(threadId);
    return this.db
      .prepare(
        `SELECT * FROM calls ${threadId ? 'WHERE threadId=?' : ''} ORDER BY startedAt DESC`,
      )
      .all(...(threadId ? [threadId] : [])) as unknown as CallReceipt[];
  }
  createCall(threadId: string): CallReceipt {
    this.requireThread(threadId);
    const call: CallReceipt = {
      id: randomUUID(),
      threadId,
      startedAt: Date.now(),
      endedAt: null,
      status: 'connecting',
      transcript: '',
      error: null,
    };
    this.db
      .prepare(
        'INSERT INTO calls(id, threadId, startedAt, endedAt, status, transcript, error) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
      )
      .run(call.id, threadId, call.startedAt, call.status, '');
    return call;
  }
  call(id: string): CallReceipt {
    const call = this.calls().find((call) => call.id === id);
    if (!call) throw new Error('Call not found.');
    this.requireThread(call.threadId);
    return call;
  }
  setCall(
    id: string,
    status: CallReceipt['status'],
    transcript: string,
    error: string | null = null,
  ) {
    const call = this.call(id);
    if (call.endedAt) return call;
    this.db
      .prepare(
        'UPDATE calls SET status=?, transcript=?, error=?, endedAt=? WHERE id=?',
      )
      .run(
        status,
        transcript,
        error,
        status === 'ended' || status === 'failed' ? Date.now() : null,
        id,
      );
    return this.call(id);
  }
  saveLateTranscript(id: string, transcript: string) {
    this.call(id);
    return (
      this.db
        .prepare(
          "UPDATE calls SET transcript=? WHERE id=? AND transcript='' AND endedAt IS NOT NULL",
        )
        .run(transcript, id).changes > 0
    );
  }
  anchorCall(id: string, anchor: string | undefined) {
    this.call(id);
    this.db
      .prepare('UPDATE calls SET anchorMessageId=? WHERE id=?')
      .run(anchor ?? null, id);
  }
  setCallError(id: string, error: string | null) {
    this.call(id);
    this.db.prepare('UPDATE calls SET error=? WHERE id=?').run(error, id);
  }
  saveCapture(threadId: string, value: unknown) {
    this.requireThread(threadId);
    this.db
      .prepare(
        'INSERT INTO captures VALUES (?, ?) ON CONFLICT(threadId) DO UPDATE SET value=excluded.value',
      )
      .run(threadId, JSON.stringify(value));
  }
  capture(threadId: string): unknown {
    this.requireThread(threadId);
    const row = this.db
      .prepare('SELECT value FROM captures WHERE threadId=?')
      .get(threadId);
    return typeof row?.value === 'string' ? JSON.parse(row.value) : null;
  }
  /**
   * Removes one chat and its transcript. Saved pages, documents, memories,
   * and schedules stay. A schedule that used this chat opens a new one next time.
   */
  deleteConversation(id: string) {
    const kind = this.db
      .prepare('SELECT kind FROM thread_bindings WHERE id=? AND ownerId=?')
      .get(id, this.ownerId);
    if (!kind) throw new Error('Conversation not found.');
    if (kind.kind !== 'chat') throw new Error('Only a chat can be deleted.');
    this.db.exec('BEGIN');
    try {
      for (const statement of [
        'DELETE FROM runner_messages WHERE threadId=?',
        'DELETE FROM runner_runs WHERE threadId=?',
        'DELETE FROM thread_summaries WHERE threadId=?',
        'DELETE FROM calls WHERE threadId=?',
        'DELETE FROM captures WHERE threadId=?',
        'DELETE FROM page_reviews WHERE threadId=?',
        'DELETE FROM page_threads WHERE threadId=?',
        'DELETE FROM task_threads WHERE threadId=?',
      ])
        this.db.prepare(statement).run(id);
      if (this.hasTable('work_items'))
        this.db
          .prepare(
            'UPDATE work_items SET workThreadId=NULL WHERE workThreadId=?',
          )
          .run(id);
      this.db
        .prepare('DELETE FROM thread_bindings WHERE id=? AND ownerId=?')
        .run(id, this.ownerId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private hasTable(name: string) {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
  }
}
