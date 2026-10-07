import { passageTsv, type Postgres } from './postgres.js';

export interface IndexedChunk {
  ordinal: number;
  text: string;
  /** Model-written sentence placing the passage in its document. */
  context: string;
  /** Heading path, joined with " > ". */
  section: string;
  /** Lower-case keywords and entity names, used for tag matching and links. */
  keywords: string[];
  entities: string[];
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
  context: string;
  section: string;
  headings: string[];
  pageFrom: number | null;
  pageTo: number | null;
  score: number;
}

export interface ChunkRef {
  documentId: string;
  ordinal: number;
}

export interface ChunkLink {
  from: ChunkRef;
  documentId: string;
  ordinal: number;
  kind: 'similar' | 'entity';
  score: number;
  section: string;
  pageFrom: number | null;
  pageTo: number | null;
}

/** Searchable passages. Callers resolve access and pass allowed document IDs. */
export interface ChunkIndex {
  /** Atomically replaces every stored chunk of a document and its links. */
  replace(
    documentId: string,
    version: number,
    chunks: IndexedChunk[],
  ): Promise<void>;
  remove(documentId: string): Promise<void>;
  /** Hybrid keyword and vector search; a null query searches by vector only. */
  search(
    query: string | null,
    embedding: number[],
    documentIds: string[],
    limit: number,
  ): Promise<ChunkHit[]>;
  /** Passages whose keywords or entities overlap the terms, most overlap first. */
  tagSearch(
    terms: string[],
    documentIds: string[],
    limit: number,
  ): Promise<ChunkHit[]>;
  /** Related passages of each ref, restricted to the allowed documents. */
  links(
    refs: ChunkRef[],
    documentIds: string[],
    perRef: number,
  ): Promise<ChunkLink[]>;
  documentIds(): Promise<string[]>;
}

const vector = (values: number[]) => `[${values.join(',')}]`;
// Reciprocal rank fusion constant; 60 is the value from the original paper.
export const RRF_K = 60;
const CANDIDATES = 40;
// Cosine similarity below which two passages are not worth linking.
const SIMILAR_MIN = 0.55;
const LINKS_PER_PASSAGE = 5;

const HIT_COLUMNS =
  'c.document_id, c.version, c.ordinal, c.text, c.context, c.section, c.headings, c.page_from, c.page_to';

const hit = (row: Record<string, unknown>): ChunkHit => ({
  documentId: String(row.document_id),
  version: Number(row.version),
  ordinal: Number(row.ordinal),
  text: String(row.text),
  context: String(row.context ?? ''),
  section: String(row.section ?? ''),
  headings: (row.headings as string[] | null) ?? [],
  pageFrom: row.page_from === null ? null : Number(row.page_from),
  pageTo: row.page_to === null ? null : Number(row.page_to),
  score: Number(row.score),
});

const INSERT_CHUNK = `INSERT INTO document_chunks(document_id, version, ordinal, text, headings, page_from, page_to, embedding, context, section, keywords, entities, tsv)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11, $12, ${passageTsv({ section: '$10', keywords: '$11', context: '$9', entities: '$12', text: '$4' })})`;

// Nearest passages anywhere except the passage itself and its neighbours.
const LINK_SIMILAR = `INSERT INTO chunk_links(document_id, ordinal, target_document_id, target_ordinal, kind, score)
SELECT c.document_id, c.ordinal, n.document_id, n.ordinal, 'similar', n.score
FROM document_chunks c
CROSS JOIN LATERAL (
  SELECT o.document_id, o.ordinal, 1 - (o.embedding <=> c.embedding) AS score
  FROM document_chunks o
  WHERE NOT (o.document_id = c.document_id AND abs(o.ordinal - c.ordinal) <= 1)
  ORDER BY o.embedding <=> c.embedding
  LIMIT ${LINKS_PER_PASSAGE}
) n
WHERE c.document_id = $1 AND n.score >= ${SIMILAR_MIN}
ON CONFLICT DO NOTHING`;

// Passages naming at least two of the same entities.
const LINK_ENTITY = `INSERT INTO chunk_links(document_id, ordinal, target_document_id, target_ordinal, kind, score)
SELECT document_id, ordinal, target_document_id, target_ordinal, 'entity', least(1, 0.4 + 0.15 * shared)
FROM (
  SELECT c.document_id, c.ordinal, o.document_id AS target_document_id, o.ordinal AS target_ordinal, s.shared,
    row_number() OVER (PARTITION BY c.ordinal ORDER BY s.shared DESC, o.document_id, o.ordinal) AS rank
  FROM document_chunks c
  JOIN document_chunks o ON o.entities && c.entities
    AND NOT (o.document_id = c.document_id AND abs(o.ordinal - c.ordinal) <= 1)
  CROSS JOIN LATERAL (
    SELECT cardinality(ARRAY(SELECT unnest(c.entities) INTERSECT SELECT unnest(o.entities))) AS shared
  ) s
  WHERE c.document_id = $1
) ranked
WHERE shared >= 2 AND rank <= ${LINKS_PER_PASSAGE}
ON CONFLICT DO NOTHING`;

// Links are symmetric, so older documents also point at the new passages.
const LINK_REVERSE = `INSERT INTO chunk_links(document_id, ordinal, target_document_id, target_ordinal, kind, score)
SELECT target_document_id, target_ordinal, document_id, ordinal, kind, score
FROM chunk_links WHERE document_id = $1 AND target_document_id <> $1
ON CONFLICT DO NOTHING`;

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
      await client.query(
        'DELETE FROM chunk_links WHERE document_id=$1 OR target_document_id=$1',
        [documentId],
      );
      for (const chunk of chunks)
        await client.query(INSERT_CHUNK, [
          documentId,
          version,
          chunk.ordinal,
          chunk.text,
          chunk.headings,
          chunk.pageFrom,
          chunk.pageTo,
          vector(chunk.embedding),
          chunk.context,
          chunk.section,
          chunk.keywords,
          chunk.entities,
        ]);
      await client.query(LINK_SIMILAR, [documentId]);
      await client.query(LINK_ENTITY, [documentId]);
      await client.query(LINK_REVERSE, [documentId]);
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
      'DELETE FROM chunk_links WHERE document_id=$1 OR target_document_id=$1',
      [documentId],
    );
    await this.postgres.pool.query(
      'DELETE FROM document_chunks WHERE document_id=$1',
      [documentId],
    );
  }
  async search(
    query: string | null,
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
          FROM document_chunks, websearch_to_tsquery('english', $3::text) q
          WHERE $3::text IS NOT NULL AND document_id = ANY($2) AND tsv @@ q
          ORDER BY score DESC LIMIT ${CANDIDATES}) matched
      ), fused AS (
        SELECT document_id, version, ordinal, SUM(1.0 / (${RRF_K} + rank)) AS score
        FROM (SELECT * FROM vec UNION ALL SELECT * FROM txt) ranked
        GROUP BY document_id, version, ordinal
      )
      SELECT ${HIT_COLUMNS}, f.score
      FROM fused f JOIN document_chunks c USING (document_id, version, ordinal)
      ORDER BY f.score DESC LIMIT $4`,
      [vector(embedding), documentIds, query, limit],
    );
    return result.rows.map(hit);
  }
  async tagSearch(
    terms: string[],
    documentIds: string[],
    limit: number,
  ): Promise<ChunkHit[]> {
    if (!terms.length || !documentIds.length) return [];
    await this.postgres.ensureSchema();
    const result = await this.postgres.pool.query(
      `SELECT ${HIT_COLUMNS}, s.overlap AS score
      FROM document_chunks c
      CROSS JOIN LATERAL (
        SELECT cardinality(ARRAY(SELECT unnest(c.keywords || c.entities) INTERSECT SELECT unnest($1::text[]))) AS overlap
      ) s
      WHERE c.document_id = ANY($2) AND (c.keywords && $1::text[] OR c.entities && $1::text[])
      ORDER BY s.overlap DESC, c.document_id, c.ordinal
      LIMIT $3`,
      [terms, documentIds, limit],
    );
    return result.rows.map(hit);
  }
  async links(
    refs: ChunkRef[],
    documentIds: string[],
    perRef: number,
  ): Promise<ChunkLink[]> {
    if (!refs.length || !documentIds.length) return [];
    await this.postgres.ensureSchema();
    const result = await this.postgres.pool.query(
      `SELECT l.document_id, l.ordinal, l.target_document_id, l.target_ordinal, l.kind, l.score,
        c.section, c.page_from, c.page_to
      FROM chunk_links l
      JOIN unnest($1::text[], $2::int[]) AS r(document_id, ordinal)
        ON r.document_id = l.document_id AND r.ordinal = l.ordinal
      JOIN document_chunks c
        ON c.document_id = l.target_document_id AND c.ordinal = l.target_ordinal
      WHERE l.target_document_id = ANY($3)
      ORDER BY l.score DESC, l.target_document_id, l.target_ordinal`,
      [
        refs.map((ref) => ref.documentId),
        refs.map((ref) => ref.ordinal),
        documentIds,
      ],
    );
    const taken = new Map<string, Set<string>>();
    const links: ChunkLink[] = [];
    for (const row of result.rows) {
      const from = {
        documentId: String(row.document_id),
        ordinal: Number(row.ordinal),
      };
      const key = `${from.documentId}#${from.ordinal}`;
      const target = `${row.target_document_id}#${row.target_ordinal}`;
      const seen = taken.get(key) ?? new Set<string>();
      taken.set(key, seen);
      if (seen.size >= perRef || seen.has(target)) continue;
      seen.add(target);
      links.push({
        from,
        documentId: String(row.target_document_id),
        ordinal: Number(row.target_ordinal),
        kind: row.kind === 'entity' ? 'entity' : 'similar',
        score: Number(row.score),
        section: String(row.section ?? ''),
        pageFrom: row.page_from === null ? null : Number(row.page_from),
        pageTo: row.page_to === null ? null : Number(row.page_to),
      });
    }
    return links;
  }
  async documentIds() {
    await this.postgres.ensureSchema();
    const result = await this.postgres.pool.query(
      'SELECT DISTINCT document_id FROM document_chunks',
    );
    return result.rows.map((row) => String(row.document_id));
  }
}
