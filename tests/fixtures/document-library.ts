import { expect, onTestFinished } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { WorkspaceStore } from '../../src/server/workspace.js';
import {
  DocumentLibrary,
  type StoredChunk,
} from '../../src/server/document-library.js';
import type { DocumentEnricher } from '../../src/server/document-enrichment.js';
import type {
  ChunkHit,
  ChunkIndex,
  ChunkLink,
  ChunkRef,
  IndexedChunk,
} from '../../src/server/chunk-index.js';

/** In-memory index: keyword matches rank first, tags match keywords and entities. */
export class FakeIndex implements ChunkIndex {
  chunks = new Map<string, { version: number; chunks: IndexedChunk[] }>();
  searched: string[][] = [];
  queries: (string | null)[] = [];
  linked: ChunkLink[] = [];
  async replace(documentId: string, version: number, chunks: IndexedChunk[]) {
    this.chunks.set(documentId, { version, chunks });
  }
  async remove(documentId: string) {
    this.chunks.delete(documentId);
  }
  private hits(documentIds: string[]): ChunkHit[] {
    return [...this.chunks.entries()]
      .filter(([id]) => documentIds.includes(id))
      .flatMap(([documentId, entry]) =>
        entry.chunks.map((chunk) => ({
          documentId,
          version: entry.version,
          ordinal: chunk.ordinal,
          text: chunk.text,
          context: chunk.context,
          section: chunk.section,
          headings: chunk.headings,
          pageFrom: chunk.pageFrom,
          pageTo: chunk.pageTo,
          score: 1,
        })),
      );
  }
  async search(
    query: string | null,
    _embedding: number[],
    documentIds: string[],
    limit: number,
  ): Promise<ChunkHit[]> {
    this.searched.push(documentIds);
    this.queries.push(query);
    const words = (query ?? '').toLowerCase().split(/\W+/).filter(Boolean);
    const matches = (hit: ChunkHit) =>
      words.some((word) => hit.text.toLowerCase().includes(word));
    return this.hits(documentIds)
      .sort((a, b) => Number(matches(b)) - Number(matches(a)))
      .slice(0, limit);
  }
  async tagSearch(terms: string[], documentIds: string[], limit: number) {
    return this.hits(documentIds)
      .filter((hit) => {
        const chunk = this.chunks
          .get(hit.documentId)!
          .chunks.find((entry) => entry.ordinal === hit.ordinal)!;
        return [...chunk.keywords, ...chunk.entities].some((term) =>
          terms.includes(term),
        );
      })
      .slice(0, limit);
  }
  async links(refs: ChunkRef[], documentIds: string[], perRef: number) {
    return this.linked
      .filter(
        (link) =>
          documentIds.includes(link.documentId) &&
          refs.some(
            (ref) =>
              ref.documentId === link.from.documentId &&
              ref.ordinal === link.from.ordinal,
          ),
      )
      .slice(0, perRef * refs.length);
  }
  async documentIds() {
    return [...this.chunks.keys()];
  }
}

export const embed = async (texts: string[]) => texts.map(() => [0.1, 0.2]);
export const pdf = (text: string) =>
  new TextEncoder().encode(`%PDF-1.7\n${text}\n%%EOF`);
export const markdown = (text: string) => new TextEncoder().encode(text);
export const chunk = (text: string, page: number): StoredChunk => ({
  ordinal: 0,
  text,
  headings: [],
  pageFrom: page,
  pageTo: page,
});

export function fixture(
  options: {
    maxUploadBytes?: number;
    enricher?: DocumentEnricher;
    embed?: typeof embed;
  } = {},
) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const dir = mkdtempSync(join(tmpdir(), 'opendots-docs-'));
  onTestFinished(() => {
    store.close();
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const index = new FakeIndex();
  const library = new DocumentLibrary(
    workspace,
    index,
    options.embed ?? embed,
    dir,
    undefined,
    options.enricher,
  );
  const [first] = workspace.dots();
  const research = workspace.createSpace('Research', '');
  const second = workspace.createDot(
    research.id,
    'Researcher',
    'Reads papers.',
    true,
    true,
  );
  const third = workspace.createDot(
    first.spaceId,
    'Writer',
    'Writes.',
    true,
    true,
  );
  return {
    store,
    workspace,
    library,
    index,
    dir,
    first,
    second,
    third,
    research,
    maxUploadBytes: options.maxUploadBytes,
  };
}

export type DocumentFixture = ReturnType<typeof fixture>;

/** Uploads and indexes a document as if the ingestor had converted it. */
export async function indexed(
  f: DocumentFixture,
  name: string,
  access: { allDots?: boolean; dotIds?: string[]; spaceIds?: string[] },
  text: string | StoredChunk[] = `About ${name}`,
) {
  const chunks = typeof text === 'string' ? [chunk(text, 1)] : text;
  const document = await f.library.upload(
    {
      name: `${name}.md`,
      bytes: markdown(chunks.map((item) => item.text).join('\n\n')),
    },
    {
      allDots: access.allDots ?? false,
      dotIds: access.dotIds ?? [],
      spaceIds: access.spaceIds ?? [],
    },
  );
  const claim = f.workspace.documents.claim()!;
  expect(claim.id).toBe(document.id);
  await f.library.saveConversion(
    claim,
    chunks,
    chunks.map((item) => item.text).join('\n\n'),
  );
  return document.id;
}
