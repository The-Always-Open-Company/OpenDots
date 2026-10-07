import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EMBEDDING_DIMENSIONS, Postgres } from '../src/server/postgres.js';
import { PgChunkIndex, type IndexedChunk } from '../src/server/chunk-index.js';

// Runs against a disposable pgvector database, e.g. the one in compose.dev.yml:
// TEST_DATABASE_URL=postgres://opendots:<password>@127.0.0.1:5433/opendots npm test
const url = process.env.TEST_DATABASE_URL;

const vector = (hot: number) =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === hot ? 1 : 0));

const passage = (
  ordinal: number,
  text: string,
  hot: number,
  extra: Partial<IndexedChunk> = {},
): IndexedChunk => ({
  ordinal,
  text,
  context: '',
  section: '',
  keywords: [],
  entities: [],
  headings: [],
  pageFrom: null,
  pageTo: null,
  embedding: vector(hot),
  ...extra,
});

describe.skipIf(!url)('Postgres chunk index', () => {
  const postgres = new Postgres(url ?? 'postgres://unused');
  const index = new PgChunkIndex(postgres);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  afterAll(async () => {
    for (const id of ids) await index.remove(id);
    await postgres.close();
  });

  it('replaces chunks atomically and searches only allowed documents', async () => {
    await index.replace(ids[0], 1, [
      passage(0, 'The quarterly budget grew by ten percent.', 0, {
        headings: ['Finance'],
        section: 'Finance',
        pageFrom: 1,
        pageTo: 1,
      }),
    ]);
    await index.replace(ids[1], 1, [
      passage(0, 'A confidential budget for the other team.', 0),
    ]);
    const hits = await index.search('budget', vector(0), [ids[0]], 5);
    expect(hits.map((hit) => hit.documentId)).toEqual([ids[0]]);
    expect(hits[0]).toMatchObject({
      headings: ['Finance'],
      section: 'Finance',
      pageFrom: 1,
    });
    await index.replace(ids[0], 2, [
      passage(0, 'Revised: the budget shrank.', 1, { pageFrom: 1, pageTo: 1 }),
    ]);
    const revised = await index.search('budget', vector(1), [ids[0]], 5);
    expect(revised.map((hit) => [hit.version, hit.text])).toEqual([
      [2, 'Revised: the budget shrank.'],
    ]);
    expect(await index.search('budget', vector(0), [], 5)).toEqual([]);
    await index.remove(ids[1]);
    expect(await index.documentIds()).not.toContain(ids[1]);
  });

  it('matches enrichment keywords, searches by vector alone and by tags', async () => {
    await index.replace(ids[1], 1, [
      passage(0, 'Staff may claim travel costs within 30 days.', 200, {
        context: 'From the expenses policy, on reimbursement deadlines.',
        keywords: ['reimbursement', 'expenses'],
        entities: ['finance team'],
      }),
      passage(1, 'Unrelated passage about parking.', 201),
    ]);
    // "reimbursement" appears only in the keywords and context.
    const keyword = await index.search(
      'reimbursement',
      vector(999),
      [ids[1]],
      5,
    );
    expect(keyword[0]).toMatchObject({
      ordinal: 0,
      context: 'From the expenses policy, on reimbursement deadlines.',
    });
    const semantic = await index.search(null, vector(201), [ids[1]], 1);
    expect(semantic.map((hit) => hit.ordinal)).toEqual([1]);
    const tagged = await index.tagSearch(
      ['finance team', 'expenses'],
      [ids[1]],
      5,
    );
    expect(tagged.map((hit) => [hit.ordinal, hit.score])).toEqual([[0, 2]]);
    expect(await index.tagSearch([], [ids[1]], 5)).toEqual([]);
  });

  it('links similar and entity-sharing passages across documents, filtered by access', async () => {
    const [a, b] = [ids[1], ids[2]];
    await index.replace(a, 1, [
      passage(0, 'Alpha one', 300),
      passage(1, 'Alpha two', 301),
      passage(2, 'Alpha three', 302, { entities: ['acme', 'widget'] }),
      passage(3, 'Alpha four', 300, { section: 'Later', pageFrom: 4 }),
    ]);
    await index.replace(b, 1, [
      passage(0, 'Beta one', 301),
      passage(1, 'Beta two', 310),
      passage(2, 'Beta three', 311),
      passage(3, 'Beta four', 312, { entities: ['acme', 'widget', 'other'] }),
    ]);
    const all = await index.links(
      [
        { documentId: a, ordinal: 0 },
        { documentId: a, ordinal: 1 },
        { documentId: a, ordinal: 2 },
      ],
      [a, b],
      3,
    );
    const summary = all.map((link) => [
      `${link.from.documentId === a ? 'a' : 'b'}${link.from.ordinal}`,
      `${link.documentId === a ? 'a' : 'b'}${link.ordinal}`,
      link.kind,
    ]);
    // Same document but not adjacent; B was indexed later, so these are reverse links.
    expect(summary).toContainEqual(['a0', 'a3', 'similar']);
    expect(summary).toContainEqual(['a1', 'b0', 'similar']);
    expect(summary).toContainEqual(['a2', 'b3', 'entity']);
    expect(summary).not.toContainEqual(['a0', 'a1', 'similar']);
    expect(all.find((link) => link.ordinal === 3 && link.documentId === a))
      .toMatchObject({ section: 'Later', pageFrom: 4 });
    const onlyA = await index.links(
      [{ documentId: a, ordinal: 1 }],
      [a],
      3,
    );
    expect(onlyA.every((link) => link.documentId === a)).toBe(true);
    await index.remove(b);
    expect(
      await index.links([{ documentId: a, ordinal: 1 }], [a, b], 3),
    ).toEqual([]);
  });
});

describe.skipIf(!url)('Postgres schema migration', () => {
  const schema = `migrate_${randomUUID().replace(/-/g, '')}`;
  const admin = new Postgres(url ?? 'postgres://unused');
  const scoped = () => {
    const target = new URL(url ?? 'postgres://unused');
    target.searchParams.set('options', `-c search_path=${schema},public`);
    return new Postgres(target.toString());
  };
  afterAll(async () => {
    await admin.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.close();
  });

  it('upgrades a version 1 database in place and keeps its passages searchable', async () => {
    await admin.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.pool.query(`CREATE SCHEMA ${schema}`);
    await admin.pool.query(`CREATE TABLE ${schema}.document_chunks(
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
    )`);
    await admin.pool.query(
      `INSERT INTO ${schema}.document_chunks(document_id, version, ordinal, text, headings, embedding)
      VALUES ('old', 1, 0, 'Holiday allowance is 25 days.', ARRAY['Leave','Holidays'], $1::vector)`,
      [`[${vector(0).join(',')}]`],
    );
    const postgres = scoped();
    const index = new PgChunkIndex(postgres);
    try {
      const hits = await index.search('holiday', vector(5), ['old'], 5);
      expect(hits[0]).toMatchObject({
        documentId: 'old',
        section: 'Leave > Holidays',
        context: '',
      });
      expect(await index.links([{ documentId: 'old', ordinal: 0 }], ['old'], 3))
        .toEqual([]);
      const version = await postgres.pool.query(
        'SELECT version FROM rag_schema',
      );
      expect(version.rows).toEqual([{ version: 2 }]);
      // A second process migrating again is a no-op.
      const again = scoped();
      await again.ensureSchema();
      await again.close();
      expect(
        (await postgres.pool.query('SELECT count(*)::int AS n FROM rag_schema'))
          .rows,
      ).toEqual([{ n: 1 }]);
    } finally {
      await postgres.close();
    }
  });
});
