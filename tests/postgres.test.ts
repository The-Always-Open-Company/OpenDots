import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EMBEDDING_DIMENSIONS, Postgres } from '../src/server/postgres.js';
import { PgChunkIndex } from '../src/server/chunk-index.js';

// Runs against a disposable pgvector database, e.g. the one in compose.dev.yml:
// TEST_DATABASE_URL=postgres://opendots:<password>@127.0.0.1:5433/opendots npm test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Postgres chunk index', () => {
  const postgres = new Postgres(url ?? 'postgres://unused');
  const index = new PgChunkIndex(postgres);
  const ids = [randomUUID(), randomUUID()];
  afterAll(async () => {
    for (const id of ids) await index.remove(id);
    await postgres.close();
  });
  const vector = (hot: number) =>
    Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === hot ? 1 : 0));

  it('replaces chunks atomically and searches only allowed documents', async () => {
    await index.replace(ids[0], 1, [
      {
        ordinal: 0,
        text: 'The quarterly budget grew by ten percent.',
        headings: ['Finance'],
        pageFrom: 1,
        pageTo: 1,
        embedding: vector(0),
      },
    ]);
    await index.replace(ids[1], 1, [
      {
        ordinal: 0,
        text: 'A confidential budget for the other team.',
        headings: [],
        pageFrom: null,
        pageTo: null,
        embedding: vector(0),
      },
    ]);
    const hits = await index.search('budget', vector(0), [ids[0]], 5);
    expect(hits.map((hit) => hit.documentId)).toEqual([ids[0]]);
    expect(hits[0]).toMatchObject({ headings: ['Finance'], pageFrom: 1 });
    await index.replace(ids[0], 2, [
      {
        ordinal: 0,
        text: 'Revised: the budget shrank.',
        headings: [],
        pageFrom: 1,
        pageTo: 1,
        embedding: vector(1),
      },
    ]);
    const revised = await index.search('budget', vector(1), [ids[0]], 5);
    expect(revised.map((hit) => [hit.version, hit.text])).toEqual([
      [2, 'Revised: the budget shrank.'],
    ]);
    expect(await index.search('budget', vector(0), [], 5)).toEqual([]);
    await index.remove(ids[1]);
    expect(await index.documentIds()).not.toContain(ids[1]);
  });
});
