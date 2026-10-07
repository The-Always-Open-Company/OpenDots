import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ChunkHit,
  ChunkIndex,
  ChunkLink,
  ChunkRef,
  IndexedChunk,
} from './chunk-index.js';
import { DocumentEnricher, sectionOf } from './document-enrichment.js';
import type { DocumentClaim } from './documents.js';
import type { Embed } from './embeddings.js';
import type { WorkspaceStore } from './workspace.js';
import type { DocumentSummary } from '../shared/types.js';

/** Allowed uploads. The browser's MIME type is ignored; the extension and content decide. */
export const DOCUMENT_TYPES: Record<
  string,
  { mime: string; check: (bytes: Uint8Array) => boolean }
> = {
  pdf: {
    mime: 'application/pdf',
    check: (b) => starts(b, [0x25, 0x50, 0x44, 0x46]),
  },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    check: zip,
  },
  pptx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    check: zip,
  },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    check: zip,
  },
  html: { mime: 'text/html', check: text },
  htm: { mime: 'text/html', check: text },
  md: { mime: 'text/markdown', check: text },
  txt: { mime: 'text/plain', check: text },
  csv: { mime: 'text/csv', check: text },
  png: { mime: 'image/png', check: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47]) },
  jpg: { mime: 'image/jpeg', check: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  jpeg: { mime: 'image/jpeg', check: (b) => starts(b, [0xff, 0xd8, 0xff]) },
};
function starts(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value);
}
function zip(bytes: Uint8Array) {
  return starts(bytes, [0x50, 0x4b, 0x03, 0x04]);
}
function text(bytes: Uint8Array) {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    // A multi-byte character can straddle the sample boundary.
    return bytes.length > sample.length;
  }
}

export interface UploadedFile {
  name: string;
  bytes: Uint8Array;
}

export interface StoredChunk {
  ordinal: number;
  /** Passage with its heading path, as embedded and searched. */
  text: string;
  /** Passage without headings, for reading; absent in older conversions. */
  raw?: string;
  headings: string[];
  pageFrom: number | null;
  pageTo: number | null;
  /** Enrichment, absent before the passage was enriched. */
  section?: string;
  context?: string;
  keywords?: string[];
  entities?: string[];
}

/** Bumped when indexing changes; older documents are re-indexed on start. */
export const INDEX_FORMAT = 2;

/** Text embedded for a passage: where it sits, what it is about, then the passage. */
export function embeddingText(title: string, chunk: StoredChunk) {
  return [title, chunk.section, chunk.context, chunk.text]
    .filter(Boolean)
    .join('\n');
}

export const pageLabel = (from: number | null, to: number | null) =>
  from === null ? null : from === to ? String(from) : `${from}-${to}`;

/** Rebuilds readable Markdown from passages, emitting each heading once. */
export function chunksToMarkdown(chunks: StoredChunk[]) {
  const parts: string[] = [];
  let previous: string[] = [];
  for (const chunk of chunks) {
    const common = chunk.headings.findIndex(
      (heading, index) => previous[index] !== heading,
    );
    const start = common === -1 ? chunk.headings.length : common;
    chunk.headings
      .slice(start)
      .forEach((heading, index) =>
        parts.push(`${'#'.repeat(Math.min(start + index + 1, 6))} ${heading}`),
      );
    previous = chunk.headings;
    parts.push(chunk.raw ?? chunk.text);
  }
  return parts.join('\n\n');
}

export interface DocumentPassage extends ChunkHit {
  title: string;
}

/** A document as the Dot sees it in its catalog. */
export interface CatalogEntry {
  id: string;
  title: string;
  status: string;
  /** Has an indexed version, so it can be searched even while re-indexing. */
  searchable: boolean;
  summary: string | null;
  tags: string[];
}

export const MAX_READ_CHARS = 24_000;

export function fileType(name: string, bytes: Uint8Array) {
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const type = DOCUMENT_TYPES[extension];
  if (!type)
    throw new Error(
      'Unsupported file type. Upload PDF, Word, PowerPoint, Excel, HTML, Markdown, text, CSV, PNG or JPEG.',
    );
  if (!bytes.length) throw new Error('The file is empty.');
  if (!type.check(bytes))
    throw new Error(
      `The file content does not match its .${extension} extension.`,
    );
  return { extension, mimeType: type.mime };
}

const safeName = (name: string) =>
  name.replace(/[\\/\r\n"]/g, '_').slice(0, 200) || 'document';
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * Files, search and reading for the document library. Access is resolved
 * through `Documents.readableIds` on every Dot-facing call.
 */
export class DocumentLibrary {
  constructor(
    private workspace: WorkspaceStore,
    private index: ChunkIndex,
    private embed: Embed,
    readonly dir: string,
    readonly onQueued: () => void = () => undefined,
    private enricher = new DocumentEnricher(),
  ) {}
  private get documents() {
    return this.workspace.documents;
  }
  private versionDir(id: string, version: number) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Document not found.');
    return join(this.dir, id, `v${version}`);
  }
  originalPath(id: string, version: number, extension: string) {
    return join(this.versionDir(id, version), `original.${extension}`);
  }
  private async writeOriginal(
    id: string,
    version: number,
    extension: string,
    bytes: Uint8Array,
  ) {
    await mkdir(this.versionDir(id, version), { recursive: true });
    await writeFile(this.originalPath(id, version, extension), bytes);
  }
  async readOriginal(id: string) {
    const document = this.documents.require(id);
    const extension = this.documents.extension(id);
    return {
      document,
      bytes: await readFile(this.originalPath(id, document.version, extension)),
      fileName: safeName(document.fileName),
    };
  }
  async upload(
    file: UploadedFile,
    options: {
      title?: string;
      allDots: boolean;
      dotIds: string[];
      spaceIds: string[];
      sourceThreadId?: string | null;
      sourceDotId?: string | null;
    },
  ): Promise<DocumentSummary> {
    const { extension, mimeType } = fileType(file.name, file.bytes);
    const hash = sha256(file.bytes);
    const existing = this.documents.findByHash(hash);
    // Same content again: share the existing document instead of re-indexing it.
    if (existing) {
      const shared = this.documents.share(
        existing.id,
        options.dotIds,
        options.spaceIds,
      );
      const document =
        options.allDots && !shared.allDots
          ? this.documents.update(existing.id, { allDots: true })
          : shared;
      return document.status === 'failed'
        ? this.reprocess(document.id)
        : document;
    }
    const id = randomUUID();
    await this.writeOriginal(id, 1, extension, file.bytes);
    try {
      const document = this.documents.create(
        {
          title:
            options.title?.trim() ||
            file.name.replace(/\.[^.]+$/, '').slice(0, 200) ||
            'Untitled document',
          fileName: safeName(file.name),
          mimeType,
          extension,
          size: file.bytes.length,
          sha256: hash,
          allDots: options.allDots,
          dotIds: options.dotIds,
          spaceIds: options.spaceIds,
          uploadedBy: this.workspace.ownerId,
          sourceThreadId: options.sourceThreadId,
          sourceDotId: options.sourceDotId,
        },
        id,
      );
      this.onQueued();
      return document;
    } catch (error) {
      await rm(join(this.dir, id), { recursive: true, force: true });
      throw error;
    }
  }
  async addVersion(id: string, file: UploadedFile) {
    const current = this.documents.require(id);
    const { extension, mimeType } = fileType(file.name, file.bytes);
    await this.writeOriginal(id, current.version + 1, extension, file.bytes);
    const document = this.documents.newVersion(id, {
      fileName: safeName(file.name),
      mimeType,
      extension,
      size: file.bytes.length,
      sha256: sha256(file.bytes),
    });
    this.onQueued();
    return document;
  }
  reprocess(id: string) {
    const document = this.documents.reprocess(id);
    this.onQueued();
    return document;
  }
  /** Hides the document immediately, then removes its chunks and files. */
  async remove(id: string) {
    this.documents.markDeleted(id);
    await this.purge(id);
  }
  private async purge(id: string) {
    await this.index.remove(id);
    await rm(join(this.dir, id), { recursive: true, force: true });
    this.documents.purge(id);
  }
  /** Finishes interrupted deletes and removes chunks or files nothing refers to. */
  async sweep() {
    for (const id of this.documents.deletedIds()) await this.purge(id);
    const live = this.documents.liveIds();
    for (const id of await this.index.documentIds())
      if (!live.has(id)) await this.index.remove(id);
    const folders = await readdir(this.dir).catch(() => [] as string[]);
    for (const folder of folders)
      if (/^[0-9a-f-]{36}$/.test(folder) && !live.has(folder))
        await rm(join(this.dir, folder), { recursive: true, force: true });
  }
  async readClaimed(claim: DocumentClaim) {
    return readFile(
      this.originalPath(claim.id, claim.version, claim.extension),
    );
  }
  /** Stores converted output for a claimed version and makes it searchable. */
  async saveConversion(
    claim: DocumentClaim,
    chunks: StoredChunk[],
    markdown: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const title = this.documents.get(claim.id)?.title ?? claim.fileName;
    const { profile, chunks: enriched } = await this.enricher.enrich(
      title,
      markdown,
      chunks,
      signal,
    );
    signal?.throwIfAborted();
    const embeddings = enriched.length
      ? await this.embed(
          enriched.map((chunk) => embeddingText(title, chunk)),
          signal,
        )
      : [];
    const folder = this.versionDir(claim.id, claim.version);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'converted.md'), markdown);
    await writeFile(join(folder, 'chunks.json'), JSON.stringify(enriched));
    signal?.throwIfAborted();
    if (!this.documents.owns(claim)) return false;
    await this.index.replace(
      claim.id,
      claim.version,
      enriched.map(
        (chunk, index): IndexedChunk => ({
          ordinal: chunk.ordinal,
          text: chunk.text,
          context: chunk.context ?? '',
          section: chunk.section ?? sectionOf(chunk),
          keywords: chunk.keywords ?? [],
          entities: chunk.entities ?? [],
          headings: chunk.headings,
          pageFrom: chunk.pageFrom,
          pageTo: chunk.pageTo,
          embedding: embeddings[index],
        }),
      ),
    );
    const pages = enriched.flatMap((chunk) =>
      chunk.pageTo === null ? [] : [chunk.pageTo],
    );
    const finished = this.documents.finish(claim, {
      pageCount: pages.length ? Math.max(...pages) : null,
      convertedChars: markdown.length,
      chunkCount: enriched.length,
      indexFormat: INDEX_FORMAT,
      profile,
    });
    if (finished) await this.pruneVersions(claim.id, claim.version);
    return finished;
  }
  private async pruneVersions(id: string, keep: number) {
    const current = this.documents.get(id);
    const folders = await readdir(join(this.dir, id)).catch(
      () => [] as string[],
    );
    for (const folder of folders) {
      const version = Number(folder.slice(1));
      // Keep the indexed version and any newer upload still waiting to index.
      if (version < keep && version !== current?.version)
        await rm(join(this.dir, id, folder), { recursive: true, force: true });
    }
  }
  /** Converted text of the indexed version, for the explorer preview. */
  async text(id: string): Promise<string> {
    const document = this.documents.require(id);
    if (document.indexedVersion === null) return '';
    return readFile(
      join(this.versionDir(id, document.indexedVersion), 'converted.md'),
      'utf8',
    ).catch(() => '');
  }
  private async chunks(id: string, version: number): Promise<StoredChunk[]> {
    const raw = await readFile(
      join(this.versionDir(id, version), 'chunks.json'),
      'utf8',
    ).catch(() => '[]');
    return JSON.parse(raw) as StoredChunk[];
  }
  /**
   * A conversion already stored for the claimed version, so re-indexing can
   * skip docling. Null when that version has not been converted.
   */
  async storedConversion(
    claim: DocumentClaim,
  ): Promise<{ chunks: StoredChunk[]; markdown: string } | null> {
    const folder = this.versionDir(claim.id, claim.version);
    const raw = await readFile(join(folder, 'chunks.json'), 'utf8').catch(
      () => null,
    );
    if (raw === null) return null;
    const chunks = (JSON.parse(raw) as StoredChunk[]).map((chunk) => ({
      ordinal: chunk.ordinal,
      text: chunk.text,
      raw: chunk.raw,
      headings: chunk.headings,
      pageFrom: chunk.pageFrom,
      pageTo: chunk.pageTo,
    }));
    if (!chunks.length) return null;
    const markdown = await readFile(join(folder, 'converted.md'), 'utf8').catch(
      () => chunksToMarkdown(chunks),
    );
    return { chunks, markdown };
  }
  /** Every document this Dot may read, including ones still processing. */
  catalog(dotId: string): CatalogEntry[] {
    return this.documents.list({ dotId }).map((document) => ({
      id: document.id,
      title: document.title,
      status: document.status,
      searchable: document.indexedVersion !== null,
      summary: document.summary,
      tags: document.tags,
    }));
  }
  readableIds(dotId: string): string[] {
    return this.documents.readableIds(dotId);
  }
  title(id: string): string {
    return this.documents.get(id)?.title ?? 'Document';
  }
  embedTexts(texts: string[], signal?: AbortSignal) {
    return this.embed(texts, signal);
  }
  hybridSearch(
    query: string | null,
    embedding: number[],
    allowed: string[],
    limit: number,
  ) {
    return this.index.search(query, embedding, allowed, limit);
  }
  tagSearch(terms: string[], allowed: string[], limit: number) {
    return this.index.tagSearch(terms, allowed, limit);
  }
  related(
    refs: ChunkRef[],
    allowed: string[],
    perRef: number,
  ): Promise<ChunkLink[]> {
    return this.index.links(refs, allowed, perRef);
  }
  /** Passages of the indexed version, in order, for expansion and reading. */
  async passages(id: string): Promise<StoredChunk[]> {
    const document = this.documents.get(id);
    if (!document || document.indexedVersion === null) return [];
    return this.chunks(id, document.indexedVersion);
  }
  list(dotId: string, query?: string) {
    const readable = new Set(this.documents.readableIds(dotId));
    const needle = query?.trim().toLocaleLowerCase();
    return this.documents
      .list()
      .filter((document) => readable.has(document.id))
      .filter(
        (document) =>
          !needle ||
          `${document.title} ${document.fileName} ${document.tags.join(' ')}`
            .toLocaleLowerCase()
            .includes(needle),
      )
      .map((document) => ({
        id: document.id,
        title: document.title,
        fileName: document.fileName,
        summary: document.summary,
        tags: document.tags,
        pageCount: document.pageCount,
        updatedAt: new Date(document.updatedAt).toISOString(),
      }));
  }
  async search(
    dotId: string,
    query: string,
    documentIds?: string[],
    limit = 8,
    signal?: AbortSignal,
  ): Promise<DocumentPassage[]> {
    const readable = this.documents.readableIds(dotId);
    const allowed = documentIds?.length
      ? readable.filter((id) => documentIds.includes(id))
      : readable;
    if (!allowed.length) return [];
    const [embedding] = await this.embed([query], signal);
    const hits = await this.index.search(query, embedding, allowed, limit);
    // Re-check after the query: access may have changed while it ran.
    const still = new Set(this.documents.readableIds(dotId));
    return hits
      .filter((hit) => still.has(hit.documentId))
      .map((hit) => ({
        ...hit,
        title: this.documents.get(hit.documentId)?.title ?? 'Document',
      }));
  }
  async read(dotId: string, id: string, fromPage?: number, toPage?: number) {
    if (!this.documents.canRead(dotId, id))
      throw new Error(
        'Document not found, still processing, or not shared with this Dot.',
      );
    const document = this.documents.require(id);
    const version = document.indexedVersion!;
    const ranged = fromPage !== undefined || toPage !== undefined;
    let text: string;
    if (ranged) {
      const start = fromPage ?? 1;
      const end = toPage ?? Number.MAX_SAFE_INTEGER;
      text = chunksToMarkdown(
        (await this.chunks(id, version)).filter(
          (chunk) =>
            chunk.pageFrom !== null &&
            chunk.pageTo !== null &&
            chunk.pageTo >= start &&
            chunk.pageFrom <= end,
        ),
      );
    } else text = await this.text(id);
    return {
      id,
      title: document.title,
      pageCount: document.pageCount,
      fromPage: fromPage ?? null,
      toPage: toPage ?? null,
      truncated: text.length > MAX_READ_CHARS,
      text: text.slice(0, MAX_READ_CHARS),
    };
  }
}
