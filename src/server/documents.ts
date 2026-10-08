import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  DocumentDetail,
  DocumentEntity,
  DocumentReader,
  DocumentStatus,
  DocumentSummary,
} from '../shared/types.js';

/** What enrichment learned about a whole document. */
export interface DocumentProfile {
  summary: string | null;
  tags: string[];
  entities: DocumentEntity[];
  /** Set when some passages could not be enriched. */
  note: string | null;
}

export interface NewDocument {
  title: string;
  fileName: string;
  mimeType: string;
  extension: string;
  size: number;
  sha256: string;
  allDots: boolean;
  dotIds: string[];
  spaceIds: string[];
  uploadedBy: string;
  sourceThreadId?: string | null;
  sourceDotId?: string | null;
}

export interface DocumentFilter {
  q?: string;
  spaceId?: string;
  dotId?: string;
  source?: 'upload' | 'chat';
  status?: DocumentStatus;
}

export interface DocumentClaim {
  id: string;
  version: number;
  extension: string;
  mimeType: string;
  fileName: string;
  lease: string;
}

interface Row {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  extension: string;
  size: number;
  sha256: string;
  version: number;
  indexedVersion: number | null;
  status: DocumentStatus;
  error: string | null;
  allDots: number;
  sourceThreadId: string | null;
  sourceDotId: string | null;
  pageCount: number | null;
  convertedChars: number | null;
  chunkCount: number | null;
  summary: string | null;
  tags: string | null;
  entities: string | null;
  enrichmentNote: string | null;
  createdAt: number;
  updatedAt: number;
}

const parseList = <T>(value: string | null): T[] => {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

export const DOCUMENT_LEASE_MS = 20 * 60_000;
const MAX_ATTEMPTS = 3;

/**
 * Document metadata, Space links and direct Dot grants. A Dot can read a
 * document that is shared with all Dots, granted to it, or linked to one of
 * its Spaces, once a version has been indexed.
 */
export class Documents {
  onReady?: (id: string) => void;
  constructor(
    private db: DatabaseSync,
    private exists: {
      dot: (id: string) => boolean;
      space: (id: string) => boolean;
    },
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, title TEXT NOT NULL, fileName TEXT NOT NULL, mimeType TEXT NOT NULL, extension TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, version INTEGER NOT NULL, indexedVersion INTEGER, status TEXT NOT NULL, error TEXT, allDots INTEGER NOT NULL, uploadedBy TEXT NOT NULL, sourceThreadId TEXT, sourceDotId TEXT, pageCount INTEGER, convertedChars INTEGER, chunkCount INTEGER, deleted INTEGER NOT NULL DEFAULT 0, lease TEXT, leaseUntil INTEGER, attempts INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS documents_status ON documents(status, createdAt);
      CREATE TABLE IF NOT EXISTS space_documents(spaceId TEXT NOT NULL, documentId TEXT NOT NULL, PRIMARY KEY(spaceId, documentId));
      CREATE INDEX IF NOT EXISTS space_documents_document ON space_documents(documentId);
      CREATE TABLE IF NOT EXISTS dot_documents(dotId TEXT NOT NULL, documentId TEXT NOT NULL, PRIMARY KEY(dotId, documentId));
      CREATE INDEX IF NOT EXISTS dot_documents_document ON dot_documents(documentId);`);
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(documents)')
        .all()
        .map((row) => String(row.name)),
    );
    for (const [column, definition] of [
      ['summary', 'TEXT'],
      ['tags', 'TEXT'],
      ['entities', 'TEXT'],
      ['enrichmentNote', 'TEXT'],
      ['indexFormat', 'INTEGER NOT NULL DEFAULT 0'],
    ])
      if (!columns.has(column))
        db.exec(`ALTER TABLE documents ADD COLUMN ${column} ${definition}`);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private ids(table: 'space_documents' | 'dot_documents', id: string) {
    const column = table === 'space_documents' ? 'spaceId' : 'dotId';
    return this.db
      .prepare(
        `SELECT ${column} AS value FROM ${table} WHERE documentId=? ORDER BY ${column}`,
      )
      .all(id)
      .map((row) => String(row.value));
  }
  private summary(row: Row): DocumentSummary {
    return {
      id: row.id,
      title: row.title,
      fileName: row.fileName,
      mimeType: row.mimeType,
      size: Number(row.size),
      version: Number(row.version),
      indexedVersion:
        row.indexedVersion === null ? null : Number(row.indexedVersion),
      status: row.status,
      error: row.error,
      allDots: !!row.allDots,
      sourceThreadId: row.sourceThreadId,
      sourceDotId: row.sourceDotId,
      pageCount: row.pageCount === null ? null : Number(row.pageCount),
      convertedChars:
        row.convertedChars === null ? null : Number(row.convertedChars),
      chunkCount: row.chunkCount === null ? null : Number(row.chunkCount),
      summary: row.summary,
      tags: parseList<string>(row.tags),
      spaceIds: this.ids('space_documents', row.id),
      dotIds: this.ids('dot_documents', row.id),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }
  private row(id: string): Row | undefined {
    return this.db
      .prepare('SELECT * FROM documents WHERE id=? AND deleted=0')
      .get(id) as unknown as Row | undefined;
  }
  private validate(dotIds: string[], spaceIds: string[]) {
    if (dotIds.some((id) => !this.exists.dot(id)))
      throw new Error('Document access names a Dot that does not exist.');
    if (spaceIds.some((id) => !this.exists.space(id)))
      throw new Error('Document access names a Space that does not exist.');
  }
  private setLinks(id: string, dotIds: string[], spaceIds: string[]) {
    this.db.prepare('DELETE FROM dot_documents WHERE documentId=?').run(id);
    this.db.prepare('DELETE FROM space_documents WHERE documentId=?').run(id);
    for (const dotId of new Set(dotIds))
      this.db.prepare('INSERT INTO dot_documents VALUES (?, ?)').run(dotId, id);
    for (const spaceId of new Set(spaceIds))
      this.db
        .prepare('INSERT INTO space_documents VALUES (?, ?)')
        .run(spaceId, id);
  }
  get(id: string): DocumentSummary | undefined {
    const row = this.row(id);
    return row && this.summary(row);
  }
  require(id: string): DocumentSummary {
    const document = this.get(id);
    if (!document) throw new Error('Document not found.');
    return document;
  }
  /** Stored file extension of the latest version. */
  extension(id: string): string {
    const row = this.row(id);
    if (!row) throw new Error('Document not found.');
    return row.extension;
  }
  create(input: NewDocument, id: string = randomUUID()): DocumentSummary {
    this.validate(input.dotIds, input.spaceIds);
    const now = Date.now();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO documents(id, title, fileName, mimeType, extension, size, sha256, version, indexedVersion, status, error, allDots, uploadedBy, sourceThreadId, sourceDotId, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 'queued', NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.title,
          input.fileName,
          input.mimeType,
          input.extension,
          input.size,
          input.sha256,
          +input.allDots,
          input.uploadedBy,
          input.sourceThreadId ?? null,
          input.sourceDotId ?? null,
          now,
          now,
        );
      this.setLinks(id, input.dotIds, input.spaceIds);
    });
    return this.require(id);
  }
  /** Finds a live document with identical content, to avoid duplicate uploads. */
  findByHash(sha256: string): DocumentSummary | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM documents WHERE sha256=? AND deleted=0 ORDER BY createdAt LIMIT 1',
      )
      .get(sha256) as unknown as Row | undefined;
    return row && this.summary(row);
  }
  /** Adds grants and links without removing existing ones. */
  share(id: string, dotIds: string[], spaceIds: string[]): DocumentSummary {
    this.require(id);
    this.validate(dotIds, spaceIds);
    this.transaction(() => {
      for (const dotId of new Set(dotIds))
        this.db
          .prepare('INSERT OR IGNORE INTO dot_documents VALUES (?, ?)')
          .run(dotId, id);
      for (const spaceId of new Set(spaceIds))
        this.db
          .prepare('INSERT OR IGNORE INTO space_documents VALUES (?, ?)')
          .run(spaceId, id);
      this.touch(id);
    });
    return this.require(id);
  }
  update(
    id: string,
    patch: {
      title?: string;
      allDots?: boolean;
      dotIds?: string[];
      spaceIds?: string[];
    },
  ): DocumentSummary {
    const current = this.require(id);
    const dotIds = patch.dotIds ?? current.dotIds;
    const spaceIds = patch.spaceIds ?? current.spaceIds;
    this.validate(dotIds, spaceIds);
    this.transaction(() => {
      this.db
        .prepare(
          'UPDATE documents SET title=?, allDots=?, updatedAt=? WHERE id=?',
        )
        .run(
          patch.title ?? current.title,
          +(patch.allDots ?? current.allDots),
          Date.now(),
          id,
        );
      this.setLinks(id, dotIds, spaceIds);
    });
    return this.require(id);
  }
  private touch(id: string) {
    this.db
      .prepare('UPDATE documents SET updatedAt=? WHERE id=?')
      .run(Date.now(), id);
  }
  /** Records a new upload; the previous version stays searchable until it indexes. */
  newVersion(
    id: string,
    file: Pick<
      NewDocument,
      'fileName' | 'mimeType' | 'extension' | 'size' | 'sha256'
    >,
  ): DocumentSummary {
    const current = this.require(id);
    this.db
      .prepare(
        "UPDATE documents SET fileName=?, mimeType=?, extension=?, size=?, sha256=?, version=?, status='queued', error=NULL, lease=NULL, leaseUntil=NULL, attempts=0, updatedAt=? WHERE id=?",
      )
      .run(
        file.fileName,
        file.mimeType,
        file.extension,
        file.size,
        file.sha256,
        current.version + 1,
        Date.now(),
        id,
      );
    return this.require(id);
  }
  reprocess(id: string): DocumentSummary {
    this.require(id);
    this.db
      .prepare(
        "UPDATE documents SET status='queued', error=NULL, lease=NULL, leaseUntil=NULL, attempts=0, updatedAt=? WHERE id=?",
      )
      .run(Date.now(), id);
    return this.require(id);
  }
  list(filter: DocumentFilter = {}): DocumentSummary[] {
    const where = ['deleted=0'];
    const values: string[] = [];
    if (filter.q) {
      where.push('(title LIKE ? OR fileName LIKE ? OR tags LIKE ?)');
      const like = `%${filter.q.replace(/[%_]/g, '')}%`;
      values.push(like, like, like);
    }
    if (filter.status) {
      where.push('status=?');
      values.push(filter.status);
    }
    if (filter.source === 'chat') where.push('sourceThreadId IS NOT NULL');
    if (filter.source === 'upload') where.push('sourceThreadId IS NULL');
    if (filter.spaceId) {
      where.push(
        'id IN (SELECT documentId FROM space_documents WHERE spaceId=?)',
      );
      values.push(filter.spaceId);
    }
    if (filter.dotId) {
      where.push(`(allDots=1 OR id IN (SELECT documentId FROM dot_documents WHERE dotId=?)
        OR id IN (SELECT sd.documentId FROM space_documents sd JOIN dot_spaces ds ON ds.spaceId=sd.spaceId WHERE ds.dotId=?))`);
      values.push(filter.dotId, filter.dotId);
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY updatedAt DESC`,
        )
        .all(...values) as unknown as Row[]
    ).map((row) => this.summary(row));
  }
  /** IDs of indexed documents this Dot may search and read right now. */
  readableIds(dotId: string): string[] {
    return this.db
      .prepare(
        `SELECT id FROM documents WHERE deleted=0 AND indexedVersion IS NOT NULL AND (
          allDots=1
          OR id IN (SELECT documentId FROM dot_documents WHERE dotId=?)
          OR id IN (SELECT sd.documentId FROM space_documents sd JOIN dot_spaces ds ON ds.spaceId=sd.spaceId WHERE ds.dotId=?)
        ) ORDER BY updatedAt DESC`,
      )
      .all(dotId, dotId)
      .map((row) => String(row.id));
  }
  canRead(dotId: string, id: string) {
    return this.readableIds(dotId).includes(id);
  }
  /** Which Dots can read the document, and why. */
  readers(id: string, dots: { id: string; spaceIds: string[] }[]) {
    const document = this.require(id);
    return dots
      .map((dot): DocumentReader => {
        const viaSpaceIds = document.spaceIds.filter((spaceId) =>
          dot.spaceIds.includes(spaceId),
        );
        return {
          dotId: dot.id,
          reasons: [
            ...(document.allDots ? (['all'] as const) : []),
            ...(document.dotIds.includes(dot.id) ? (['granted'] as const) : []),
            ...(viaSpaceIds.length ? (['space'] as const) : []),
          ],
          viaSpaceIds,
        };
      })
      .filter((reader) => reader.reasons.length);
  }
  detail(
    id: string,
    dots: { id: string; spaceIds: string[] }[],
  ): DocumentDetail {
    const row = this.row(id);
    return {
      ...this.require(id),
      entities: parseList<DocumentEntity>(row?.entities ?? null),
      enrichmentNote: row?.enrichmentNote ?? null,
      readers: this.readers(id, dots),
    };
  }
  /**
   * Queues indexed documents built by an older pipeline. They stay searchable
   * at their current version until the new index replaces it.
   */
  requeueStale(format: number): number {
    return Number(
      this.db
        .prepare(
          "UPDATE documents SET status='queued', error=NULL, lease=NULL, leaseUntil=NULL, attempts=0 WHERE deleted=0 AND status IN ('ready', 'failed') AND indexedVersion IS NOT NULL AND indexedVersion=version AND indexFormat<?",
        )
        .run(format).changes,
    );
  }
  /** Hides the document at once; the files and chunks are purged afterwards. */
  markDeleted(id: string) {
    this.require(id);
    this.db
      .prepare(
        'UPDATE documents SET deleted=1, lease=NULL, updatedAt=? WHERE id=?',
      )
      .run(Date.now(), id);
  }
  deletedIds(): string[] {
    return this.db
      .prepare('SELECT id FROM documents WHERE deleted=1')
      .all()
      .map((row) => String(row.id));
  }
  liveIds(): Set<string> {
    return new Set(
      this.db
        .prepare('SELECT id FROM documents WHERE deleted=0')
        .all()
        .map((row) => String(row.id)),
    );
  }
  purge(id: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM dot_documents WHERE documentId=?').run(id);
      this.db.prepare('DELETE FROM space_documents WHERE documentId=?').run(id);
      this.db.prepare('DELETE FROM documents WHERE id=? AND deleted=1').run(id);
    });
  }
  /** Leases the oldest queued document, or one whose worker stopped. */
  claim(now = Date.now(), leaseMs = DOCUMENT_LEASE_MS): DocumentClaim | null {
    return this.transaction(() => {
      const expired = this.db
        .prepare(
          "SELECT id, attempts FROM documents WHERE deleted=0 AND status='processing' AND leaseUntil<=?",
        )
        .all(now);
      for (const row of expired)
        this.db
          .prepare(
            'UPDATE documents SET status=?, error=?, lease=NULL, leaseUntil=NULL WHERE id=?',
          )
          .run(
            Number(row.attempts) >= MAX_ATTEMPTS ? 'failed' : 'queued',
            Number(row.attempts) >= MAX_ATTEMPTS
              ? 'Processing stopped repeatedly. Reprocess to try again.'
              : null,
            String(row.id),
          );
      const row = this.db
        .prepare(
          "SELECT id, version, extension, mimeType, fileName FROM documents WHERE deleted=0 AND status='queued' ORDER BY updatedAt LIMIT 1",
        )
        .get();
      if (!row) return null;
      const lease = randomUUID();
      this.db
        .prepare(
          "UPDATE documents SET status='processing', lease=?, leaseUntil=?, attempts=attempts+1, error=NULL WHERE id=?",
        )
        .run(lease, now + leaseMs, String(row.id));
      return {
        id: String(row.id),
        version: Number(row.version),
        extension: String(row.extension),
        mimeType: String(row.mimeType),
        fileName: String(row.fileName),
        lease,
      };
    });
  }
  /** Extends a running job's lease; false when the job no longer owns it. */
  renew(claim: DocumentClaim, now = Date.now(), leaseMs = DOCUMENT_LEASE_MS) {
    return (
      this.db
        .prepare(
          "UPDATE documents SET leaseUntil=? WHERE id=? AND lease=? AND version=? AND status='processing' AND deleted=0",
        )
        .run(now + leaseMs, claim.id, claim.lease, claim.version).changes > 0
    );
  }
  owns(claim: DocumentClaim): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM documents WHERE id=? AND lease=? AND version=? AND status='processing' AND deleted=0",
      )
      .get(claim.id, claim.lease, claim.version);
  }
  finish(
    claim: DocumentClaim,
    stats: {
      pageCount: number | null;
      convertedChars: number;
      chunkCount: number;
      indexFormat: number;
      profile: DocumentProfile;
    },
  ): boolean {
    const ready = this.transaction(() => {
      if (!this.owns(claim)) return false;
      this.db
        .prepare(
          "UPDATE documents SET status='ready', indexedVersion=?, pageCount=?, convertedChars=?, chunkCount=?, indexFormat=?, summary=?, tags=?, entities=?, enrichmentNote=?, lease=NULL, leaseUntil=NULL, error=NULL, updatedAt=? WHERE id=?",
        )
        .run(
          claim.version,
          stats.pageCount,
          stats.convertedChars,
          stats.chunkCount,
          stats.indexFormat,
          stats.profile.summary,
          JSON.stringify(stats.profile.tags),
          JSON.stringify(stats.profile.entities),
          stats.profile.note,
          Date.now(),
          claim.id,
        );
      return true;
    });
    if (ready) this.onReady?.(claim.id);
    return ready;
  }
  fail(claim: DocumentClaim, error: string) {
    this.transaction(() => {
      if (!this.owns(claim)) return;
      this.db
        .prepare(
          "UPDATE documents SET status='failed', error=?, lease=NULL, leaseUntil=NULL, updatedAt=? WHERE id=?",
        )
        .run(error.slice(0, 500), Date.now(), claim.id);
    });
  }
  /** Requeues work that was running when the server stopped. */
  release(claim: DocumentClaim) {
    this.db
      .prepare(
        "UPDATE documents SET status='queued', lease=NULL, leaseUntil=NULL WHERE id=? AND lease=?",
      )
      .run(claim.id, claim.lease);
  }
}
