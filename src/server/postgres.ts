import pg from 'pg';

export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Weighted keyword index for one passage, over SQL expressions for each part:
 * section and keywords weigh most, then context and entities, then the text.
 */
export function passageTsv(sql: {
  section: string;
  keywords: string;
  context: string;
  entities: string;
  text: string;
}) {
  return `setweight(to_tsvector('english', coalesce(${sql.section}, '') || ' ' || array_to_string(${sql.keywords}::text[], ' ')), 'A')
  || setweight(to_tsvector('english', coalesce(${sql.context}, '') || ' ' || array_to_string(${sql.entities}::text[], ' ')), 'B')
  || setweight(to_tsvector('english', ${sql.text}), 'C')`;
}

/** Ordered migrations; each runs once, in a transaction. */
const MIGRATIONS = [
  `CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS document_chunks(
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  headings TEXT[] NOT NULL DEFAULT '{}',
  page_from INTEGER,
  page_to INTEGER,
  embedding vector(${EMBEDDING_DIMENSIONS}) NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  PRIMARY KEY(document_id, version, ordinal)
);
CREATE INDEX IF NOT EXISTS document_chunks_embedding ON document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS document_chunks_tsv ON document_chunks USING gin (tsv);`,
  // Enriched passages: context, tags and entities, a weighted keyword index
  // written on insert, and links between related passages.
  `ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS context TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS keywords TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS entities TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE document_chunks DROP COLUMN IF EXISTS tsv;
ALTER TABLE document_chunks ADD COLUMN tsv tsvector;
UPDATE document_chunks SET section = array_to_string(headings, ' > ');
UPDATE document_chunks SET tsv = ${passageTsv({ section: 'section', keywords: 'keywords', context: 'context', entities: 'entities', text: 'text' })};
CREATE INDEX IF NOT EXISTS document_chunks_tsv ON document_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS document_chunks_keywords ON document_chunks USING gin (keywords);
CREATE INDEX IF NOT EXISTS document_chunks_entities ON document_chunks USING gin (entities);
CREATE TABLE IF NOT EXISTS chunk_links(
  document_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  target_document_id TEXT NOT NULL,
  target_ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  score REAL NOT NULL,
  PRIMARY KEY(document_id, ordinal, target_document_id, target_ordinal, kind)
);
CREATE INDEX IF NOT EXISTS chunk_links_target ON chunk_links(target_document_id);`,
];

/** Shared pool for the searchable stores. App data stays in SQLite. */
export class Postgres {
  readonly pool: pg.Pool;
  private ready?: Promise<void>;
  constructor(readonly url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 5 });
    // An idle client losing its connection must not crash the server.
    this.pool.on('error', () =>
      console.error('Postgres connection dropped; it will reconnect.'),
    );
  }
  /** Migrates the schema once; a failed attempt is retried on the next call. */
  ensureSchema(): Promise<void> {
    this.ready ??= this.migrate().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }
  private async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serializes migrations across processes sharing the database.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('opendots_rag_schema'))");
      await client.query(
        'CREATE TABLE IF NOT EXISTS rag_schema(version INTEGER NOT NULL)',
      );
      const recorded = await client.query<{ version: number | null }>(
        'SELECT max(version) AS version FROM rag_schema',
      );
      let current = recorded.rows[0]?.version ?? null;
      if (current === null) {
        // Databases created before migrations were tracked are at version 1.
        const existing = await client.query<{ found: boolean }>(
          "SELECT to_regclass('document_chunks') IS NOT NULL AS found",
        );
        current = existing.rows[0]?.found ? 1 : 0;
      }
      for (let version = current + 1; version <= MIGRATIONS.length; version++)
        await client.query(MIGRATIONS[version - 1]);
      await client.query('DELETE FROM rag_schema');
      await client.query('INSERT INTO rag_schema(version) VALUES ($1)', [
        Math.max(current, MIGRATIONS.length),
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  close() {
    return this.pool.end();
  }
}
