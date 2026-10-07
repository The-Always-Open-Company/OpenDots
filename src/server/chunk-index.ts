import type { Postgres } from './postgres.js';

export interface IndexedChunk {
  ordinal: number;
  text: string;
  headings: string[];
  pageFrom: number | null;
  pageTo: number | null;
  embedding: number[];
}

export interface ChunkHit {
  documentId: string;
  version: number;
  ordinal: number;
  text: string;
  headings: string[];
  pageFrom: number | null;
  pageTo: number | null;
  score: number;
}

/** Searchable passages. Callers resolve access and pass allowed document IDs. */
export interface ChunkIndex {
  /** Atomically replaces every stored chunk of a document. */
  replace(
    documentId: string,
    version: number,
    chunks: IndexedChunk[],
  ): Promise<void>;
  remove(documentId: string): Promise<void>;
  search(
    query: string,
    embedding: number[],
    documentIds: string[],
    limit: number,
  ): Promise<ChunkHit[]>;
  documentIds(): Promise<string[]>;
}

const vector = (values: number[]) => `[${values.join(',')}]`;
// Reciprocal rank fusion constant; 60 is the value from the original paper.
const RRF_K = 60;
const CANDIDATES = 40;

export class PgChunkIndex implements ChunkIndex {
  constructor(private postgres: Postgres) {}
  async replace(documentId: string, version: number, chunks: IndexedChunk[]) {
    await this.postgres.ensureSchema();
    const client = await this.postgres.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM document_chunks WHERE document_id=$1', [
        documentId,
      ]);
      for (const chunk of chunks)
        await client.query(
          'INSERT INTO document_chunks(document_id, version, ordinal, text, headings, page_from, page_to, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)',
          [
            documentId,
            version,
            chunk.ordinal,
            chunk.text,
            chunk.headings,
            chunk.pageFrom,
            chunk.pageTo,
            vector(chunk.embedding),
          ],
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async remove(documentId: string) {
    await this.postgres.ensureSchema();
    await this.postgres.pool.query(
      'DELETE FROM document_chunks WHERE document_id=$1',
      [documentId],
    );
  }
  async search(
    query: string,
    embedding: number[],
    documentIds: string[],
    limit: number,
  ): Promise<ChunkHit[]> {
    if (!documentIds.length) return [];
    await this.postgres.ensureSchema();
    const result = await this.postgres.pool.query(
      `WITH vec AS (
        SELECT document_id, version, ordinal, row_number() OVER (ORDER BY distance) AS rank
        FROM (SELECT document_id, version, ordinal, embedding <=> $1::vector AS distance
          FROM document_chunks WHERE document_id = ANY($2)
          ORDER BY distance LIMIT ${CANDIDATES}) nearest
      ), txt AS (
        SELECT document_id, version, ordinal, row_number() OVER (ORDER BY score DESC) AS rank
        FROM (SELECT document_id, version, ordinal, ts_rank_cd(tsv, q) AS score
          FROM document_chunks, websearch_to_tsquery('english', $3) q
          WHERE document_id = ANY($2) AND tsv @@ q
          ORDER BY score DESC LIMIT ${CANDIDATES}) matched
      ), fused AS (
        SELECT document_id, version, ordinal, SUM(1.0 / (${RRF_K} + rank)) AS score
        FROM (SELECT * FROM vec UNION ALL SELECT * FROM txt) ranked
        GROUP BY document_id, version, ordinal
      )
      SELECT c.document_id, c.version, c.ordinal, c.text, c.headings, c.page_from, c.page_to, f.score
      FROM fused f JOIN document_chunks c USING (document_id, version, ordinal)
      ORDER BY f.score DESC LIMIT $4`,
      [vector(embedding), documentIds, query, limit],
    );
    return result.rows.map((row) => ({
      documentId: String(row.document_id),
      version: Number(row.version),
      ordinal: Number(row.ordinal),
      text: String(row.text),
      headings: (row.headings as string[] | null) ?? [],
      pageFrom: row.page_from === null ? null : Number(row.page_from),
      pageTo: row.page_to === null ? null : Number(row.page_to),
      score: Number(row.score),
    }));
  }
  async documentIds() {
    await this.postgres.ensureSchema();
    const result = await this.postgres.pool.query(
      'SELECT DISTINCT document_id FROM document_chunks',
    );
    return result.rows.map((row) => String(row.document_id));
  }
}
