import { RRF_K } from './chunk-index.js';
import type { Postgres } from './postgres.js';

export interface IndexedActionItem {
  id: string;
  embedding: number[];
  /** Statement, entity names, and labels: weighs most in keyword search. */
  primary: string;
  context: string;
  /** Details, notes, and the quoted source. */
  body: string;
  updatedAt: number;
}

export interface ActionItemHit {
  id: string;
  score: number;
}

/** Searchable copy of action items. Callers filter first and pass the allowed IDs. */
export interface ActionItemIndex {
  upsert(item: IndexedActionItem): Promise<void>;
  remove(id: string): Promise<void>;
  /** Hybrid keyword and vector search; a null query searches by vector only. */
  search(
    query: string | null,
    embedding: number[],
    ids: string[],
    limit: number,
  ): Promise<ActionItemHit[]>;
  /** Most similar items by cosine similarity (1 is identical). */
  nearest(
    embedding: number[],
    ids: string[],
    limit: number,
  ): Promise<ActionItemHit[]>;
}

const vector = (values: number[]) => `[${values.join(',')}]`;
const CANDIDATES = 50;

export class PgActionItemIndex implements ActionItemIndex {
  constructor(private postgres: Postgres) {}
  async upsert(item: IndexedActionItem) {
    await this.postgres.ensureSchema();
    await this.postgres.pool.query(
      `INSERT INTO action_item_index(item_id, embedding, tsv, updated_at)
      VALUES ($1, $2::vector,
        setweight(to_tsvector('english', $3::text), 'A')
        || setweight(to_tsvector('english', $4::text), 'B')
        || setweight(to_tsvector('english', $5::text), 'C'), $6)
      ON CONFLICT (item_id) DO UPDATE SET embedding=excluded.embedding, tsv=excluded.tsv, updated_at=excluded.updated_at`,
      [
        item.id,
        vector(item.embedding),
        item.primary,
        item.context,
        item.body,
        item.updatedAt,
      ],
    );
  }
  async remove(id: string) {
    await this.postgres.ensureSchema();
    await this.postgres.pool.query(
      'DELETE FROM action_item_index WHERE item_id=$1',
      [id],
    );
  }
  async search(
    query: string | null,
    embedding: number[],
    ids: string[],
    limit: number,
  ) {
    if (!ids.length) return [];
    await this.postgres.ensureSchema();
    const result = await this.postgres.pool.query(
      `WITH vec AS (
        SELECT item_id, row_number() OVER (ORDER BY distance) AS rank
        FROM (SELECT item_id, embedding <=> $1::vector AS distance
          FROM action_item_index WHERE item_id = ANY($2)
          ORDER BY distance LIMIT ${CANDIDATES}) nearest
      ), txt AS (
        SELECT item_id, row_number() OVER (ORDER BY score DESC) AS rank
        FROM (SELECT item_id, ts_rank_cd(tsv, q) AS score
          FROM action_item_index, websearch_to_tsquery('english', $3::text) q
          WHERE $3::text IS NOT NULL AND item_id = ANY($2) AND tsv @@ q
          ORDER BY score DESC LIMIT ${CANDIDATES}) matched
      )
      SELECT item_id, SUM(1.0 / (${RRF_K} + rank)) AS score
      FROM (SELECT * FROM vec UNION ALL SELECT * FROM txt) ranked
      GROUP BY item_id ORDER BY score DESC LIMIT $4`,
      [vector(embedding), ids, query, limit],
    );
    return result.rows.map((row) => ({
      id: String(row.item_id),
      score: Number(row.score),
    }));
  }
  async nearest(embedding: number[], ids: string[], limit: number) {
    if (!ids.length) return [];
    await this.postgres.ensureSchema();
    const result = await this.postgres.pool.query(
      `SELECT item_id, 1 - (embedding <=> $1::vector) AS score
      FROM action_item_index WHERE item_id = ANY($2)
      ORDER BY embedding <=> $1::vector LIMIT $3`,
      [vector(embedding), ids, limit],
    );
    return result.rows.map((row) => ({
      id: String(row.item_id),
      score: Number(row.score),
    }));
  }
}
