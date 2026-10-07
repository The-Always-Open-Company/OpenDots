import pg from 'pg';

export const EMBEDDING_DIMENSIONS = 1536;

const schema = `CREATE EXTENSION IF NOT EXISTS vector;
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
CREATE INDEX IF NOT EXISTS document_chunks_tsv ON document_chunks USING gin (tsv);`;

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
  /** Creates the schema once; a failed attempt is retried on the next call. */
  ensureSchema(): Promise<void> {
    this.ready ??= this.pool
      .query(schema)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.ready = undefined;
        throw error;
      });
    return this.ready;
  }
  close() {
    return this.pool.end();
  }
}
