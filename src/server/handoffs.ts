import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { HandoffResult, HandoffTarget } from '../shared/types.js';
import type { ExecutionEngine } from './execution-engine.js';
import type { NotificationService } from './notifications.js';
import type { WorkspaceStore } from './workspace.js';

export interface HandoffInput {
  dotId: string;
  target: HandoffTarget;
  note?: string;
}

export class HandoffError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

const STEPS = (source: string) =>
  [
    `2. File action items with create_action_items for everything the owner has to do or is owed, with ${source} as the source. Update existing items instead when it shows something changed or was done.`,
    '3. Finish with a short reply for the owner: what it is, the key decisions, open questions, and what you filed. Then call complete_work.',
  ].join('\n');

function withNote(text: string, note?: string) {
  return note?.trim() ? `${text}\nThe owner added: ${note.trim()}` : text;
}

/**
 * The owner sends a Dot a document or page to read. It runs as a background
 * objective; a document still being indexed waits until it can be read.
 */
export class HandoffService {
  constructor(
    private db: DatabaseSync,
    private engine: ExecutionEngine,
    private workspace: WorkspaceStore,
    private notifications?: NotificationService,
    private now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS handoffs(
      id TEXT PRIMARY KEY, dotId TEXT NOT NULL, documentId TEXT NOT NULL,
      note TEXT, status TEXT NOT NULL, workItemId TEXT,
      createdAt INTEGER NOT NULL, settledAt INTEGER);
      CREATE INDEX IF NOT EXISTS handoffs_waiting ON handoffs(status, documentId);`);
  }

  create(input: HandoffInput): HandoffResult {
    const dot = this.workspace.dot(input.dotId);
    if (!dot) throw new HandoffError('Pod not found.', 404);
    const note = input.note?.trim().slice(0, 1000) || undefined;
    if (input.target.kind === 'page') {
      const { spaceId, pageId } = input.target;
      if (!this.workspace.canAccessSpace(dot.id, spaceId))
        throw new HandoffError(`${dot.name} cannot use this Space.`);
      let title: string;
      try {
        title = this.workspace.pages.get(spaceId, pageId).title;
      } catch {
        throw new HandoffError('Page not found.', 404);
      }
      return {
        status: 'started',
        workItemId: this.start(
          dot.id,
          `Read ${title}`,
          withNote(
            [
              `The owner sent you the page "${title}" to read.`,
              `1. Read all of it with read_space_page (id ${pageId}, spaceId ${spaceId}).`,
              STEPS('this page'),
            ].join('\n'),
            note,
          ),
        ),
      };
    }
    const { documentId } = input.target;
    const document = this.workspace.documents.get(documentId);
    if (!document) throw new HandoffError('Document not found.', 404);
    const readers = this.workspace.documents.readers(
      documentId,
      this.workspace.dots(),
    );
    if (!readers.some((reader) => reader.dotId === dot.id))
      throw new HandoffError(
        `${dot.name} cannot read this document. Share it with ${dot.name} first.`,
      );
    if (document.status === 'failed' && document.indexedVersion == null)
      throw new HandoffError(
        'This document could not be read. Reprocess it first.',
      );
    if (document.indexedVersion != null)
      return {
        status: 'started',
        workItemId: this.startDocument(dot.id, documentId, note),
      };
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO handoffs (id, dotId, documentId, note, status, createdAt) VALUES (?, ?, ?, ?, 'waiting', ?)",
      )
      .run(id, dot.id, documentId, note ?? null, this.now());
    return { status: 'waiting', handoffId: id };
  }

  /** Starts or settles handoffs whose document finished indexing, failed, or went away. */
  sweep(documentId?: string) {
    const rows = this.db
      .prepare(
        `SELECT * FROM handoffs WHERE status='waiting' ${documentId ? 'AND documentId=?' : ''} ORDER BY createdAt`,
      )
      .all(...(documentId ? [documentId] : [])) as Record<string, unknown>[];
    for (const row of rows) {
      const id = String(row.id);
      const dotId = String(row.dotId);
      const docId = String(row.documentId);
      const document = this.workspace.documents.get(docId);
      const dot = this.workspace.dot(dotId);
      if (!document || !dot) {
        this.settle(id, 'dropped');
        continue;
      }
      if (document.indexedVersion != null) {
        const readable = this.workspace.documents.canRead(dotId, docId);
        if (!readable) {
          this.settle(id, 'dropped');
          this.notifications?.publish({
            kind: 'handoff_failed',
            dotId,
            title: `${dot.name} can no longer read "${document.title}"`,
            body: 'Its access changed before indexing finished. Share it again and resend it.',
          });
          continue;
        }
        this.settle(
          id,
          'started',
          this.startDocument(
            dotId,
            docId,
            row.note == null ? undefined : String(row.note),
          ),
        );
        continue;
      }
      if (document.status === 'failed') {
        this.settle(id, 'failed');
        this.notifications?.publish({
          kind: 'handoff_failed',
          dotId,
          title: `"${document.title}" could not be read`,
          body: `${document.error ?? 'Indexing failed.'} ${dot.name} did not start on it.`,
        });
      }
    }
  }

  waiting() {
    return this.db
      .prepare("SELECT * FROM handoffs WHERE status='waiting'")
      .all() as Record<string, unknown>[];
  }

  private settle(id: string, status: string, workItemId?: string) {
    this.db
      .prepare(
        'UPDATE handoffs SET status=?, workItemId=?, settledAt=? WHERE id=?',
      )
      .run(status, workItemId ?? null, this.now(), id);
  }

  private startDocument(dotId: string, documentId: string, note?: string) {
    const title = this.workspace.documents.require(documentId).title;
    return this.start(
      dotId,
      `Read ${title}`,
      withNote(
        [
          `The owner sent you the document "${title}" to read.`,
          `1. Read all of it with read_document (id ${documentId}); read long documents in page ranges.`,
          STEPS('this document'),
        ].join('\n'),
        note,
      ),
    );
  }

  private start(dotId: string, title: string, objective: string) {
    const item = this.engine.createWorkItem({
      actorId: dotId,
      title: title.slice(0, 160),
      objective,
      source: 'owner',
      // A long read can outlast one run; later runs pick up where it stopped.
      autoResume: true,
    });
    this.engine.enqueueExecution(String(item.id));
    return String(item.id);
  }
}
