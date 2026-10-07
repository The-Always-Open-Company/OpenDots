import { afterEach, expect, it, vi } from 'vitest';
import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { completion } from './fixtures/model-stream.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import {
  describeDocuments,
  DocumentLibrary,
  fileType,
  type StoredChunk,
} from '../src/server/document-library.js';
import { DocumentIngestor } from '../src/server/document-ingestor.js';
import { documentTools } from '../src/server/document-tools.js';
import type {
  ChunkHit,
  ChunkIndex,
  IndexedChunk,
} from '../src/server/chunk-index.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.splice(0).forEach((fn) => fn());
});

class FakeIndex implements ChunkIndex {
  chunks = new Map<string, { version: number; chunks: IndexedChunk[] }>();
  searched: string[][] = [];
  async replace(documentId: string, version: number, chunks: IndexedChunk[]) {
    this.chunks.set(documentId, { version, chunks });
  }
  async remove(documentId: string) {
    this.chunks.delete(documentId);
  }
  async search(
    _query: string,
    _embedding: number[],
    documentIds: string[],
    limit: number,
  ): Promise<ChunkHit[]> {
    this.searched.push(documentIds);
    return [...this.chunks.entries()]
      .filter(([id]) => documentIds.includes(id))
      .flatMap(([documentId, entry]) =>
        entry.chunks.map((chunk) => ({
          documentId,
          version: entry.version,
          ordinal: chunk.ordinal,
          text: chunk.text,
          headings: chunk.headings,
          pageFrom: chunk.pageFrom,
          pageTo: chunk.pageTo,
          score: 1,
        })),
      )
      .slice(0, limit);
  }
  async documentIds() {
    return [...this.chunks.keys()];
  }
}

const embed = async (texts: string[]) => texts.map(() => [0.1, 0.2]);
const pdf = (text: string) =>
  new TextEncoder().encode(`%PDF-1.7\n${text}\n%%EOF`);
const markdown = (text: string) => new TextEncoder().encode(text);
const chunk = (text: string, page: number): StoredChunk => ({
  ordinal: 0,
  text,
  headings: [],
  pageFrom: page,
  pageTo: page,
});

function fixture(maxUploadBytes?: number) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const dir = mkdtempSync(join(tmpdir(), 'opendots-docs-'));
  cleanup.push(() => {
    store.close();
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const index = new FakeIndex();
  const library = new DocumentLibrary(workspace, index, embed, dir);
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
    maxUploadBytes,
  };
}

/** Uploads and indexes a document as if the ingestor had converted it. */
async function indexed(
  f: ReturnType<typeof fixture>,
  name: string,
  access: { allDots?: boolean; dotIds?: string[]; spaceIds?: string[] },
  text = `About ${name}`,
) {
  const document = await f.library.upload(
    { name: `${name}.md`, bytes: markdown(text) },
    {
      allDots: access.allDots ?? false,
      dotIds: access.dotIds ?? [],
      spaceIds: access.spaceIds ?? [],
    },
  );
  const claim = f.workspace.documents.claim()!;
  expect(claim.id).toBe(document.id);
  await f.library.saveConversion(claim, [chunk(text, 1)], text);
  return document.id;
}

it('grants read access through all Dots, a direct grant, or a linked Space', async () => {
  const f = fixture();
  const everyone = await indexed(f, 'everyone', { allDots: true });
  const granted = await indexed(f, 'granted', { dotIds: [f.second.id] });
  const spaced = await indexed(f, 'spaced', { spaceIds: [f.research.id] });
  const hidden = await indexed(f, 'hidden', {});
  const readable = (dotId: string) =>
    f.workspace.documents.readableIds(dotId).sort();
  expect(readable(f.second.id)).toEqual([everyone, granted, spaced].sort());
  expect(readable(f.first.id)).toEqual([everyone]);
  const later = f.workspace.createDot(
    f.first.spaceId,
    'Later',
    'Created after the upload.',
    true,
    true,
  );
  expect(readable(later.id)).toEqual([everyone]);
  expect(readable(f.second.id)).not.toContain(hidden);
  expect(f.workspace.documents.readers(spaced, f.workspace.dots())).toEqual([
    {
      dotId: f.second.id,
      reasons: ['space'],
      viaSpaceIds: [f.research.id],
    },
  ]);
});

it('revokes access when grants, Space links or Space membership change', async () => {
  const f = fixture();
  const granted = await indexed(f, 'granted', { dotIds: [f.second.id] });
  const spaced = await indexed(f, 'spaced', { spaceIds: [f.research.id] });
  f.workspace.documents.update(granted, { dotIds: [] });
  expect(f.workspace.documents.canRead(f.second.id, granted)).toBe(false);
  f.workspace.updateDot(f.second.id, {
    ...f.second,
    spaceId: f.first.spaceId,
    spaceIds: [f.first.spaceId],
  });
  expect(f.workspace.documents.canRead(f.second.id, spaced)).toBe(false);
  await expect(f.library.read(f.second.id, spaced)).rejects.toThrow(
    /not shared with this Dot/,
  );
});

it('hides documents from Dots until a version is indexed, and keeps the old version searchable during an update', async () => {
  const f = fixture();
  const document = await f.library.upload(
    { name: 'draft.md', bytes: markdown('First draft') },
    { allDots: true, dotIds: [], spaceIds: [] },
  );
  expect(f.workspace.documents.readableIds(f.first.id)).toEqual([]);
  const claim = f.workspace.documents.claim()!;
  await f.library.saveConversion(claim, [chunk('First draft', 1)], 'First');
  expect(f.workspace.documents.readableIds(f.first.id)).toEqual([document.id]);
  await f.library.addVersion(document.id, {
    name: 'draft.md',
    bytes: markdown('Second draft'),
  });
  const updating = f.workspace.documents.require(document.id);
  expect(updating).toMatchObject({
    version: 2,
    indexedVersion: 1,
    status: 'queued',
  });
  expect(f.workspace.documents.readableIds(f.first.id)).toEqual([document.id]);
});

it('discards a conversion when a newer version or delete arrives mid-processing', async () => {
  const f = fixture();
  const document = await f.library.upload(
    { name: 'race.md', bytes: markdown('v1') },
    { allDots: true, dotIds: [], spaceIds: [] },
  );
  const stale = f.workspace.documents.claim()!;
  await f.library.addVersion(document.id, {
    name: 'race.md',
    bytes: markdown('v2'),
  });
  expect(await f.library.saveConversion(stale, [chunk('v1', 1)], 'v1')).toBe(
    false,
  );
  expect(f.index.chunks.has(document.id)).toBe(false);
  expect(f.workspace.documents.require(document.id)).toMatchObject({
    status: 'queued',
    indexedVersion: null,
  });
  const fresh = f.workspace.documents.claim()!;
  await f.library.remove(document.id);
  expect(await f.library.saveConversion(fresh, [chunk('v2', 1)], 'v2')).toBe(
    false,
  );
  expect(f.workspace.documents.get(document.id)).toBeUndefined();
  expect(existsSync(join(f.dir, document.id))).toBe(true);
  await f.library.sweep();
  expect(existsSync(join(f.dir, document.id))).toBe(false);
});

it('requeues a job whose lease expired, then fails it after three attempts', async () => {
  const f = fixture();
  const document = await f.library.upload(
    { name: 'stuck.md', bytes: markdown('stuck') },
    { allDots: false, dotIds: [], spaceIds: [] },
  );
  const documents = f.workspace.documents;
  let now = Date.now();
  expect(documents.claim(now, 1000)?.id).toBe(document.id);
  expect(documents.claim(now, 1000)).toBeNull();
  for (let attempt = 2; attempt <= 3; attempt++) {
    now += 1001;
    expect(documents.claim(now, 1000)?.id).toBe(document.id);
  }
  now += 1001;
  expect(documents.claim(now, 1000)).toBeNull();
  expect(documents.require(document.id)).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/Reprocess/),
  });
});

it('rejects unsupported, empty and mislabeled files', () => {
  expect(() => fileType('tool.exe', new Uint8Array([1]))).toThrow(
    /Unsupported file type/,
  );
  expect(() => fileType('empty.md', new Uint8Array())).toThrow(/empty/);
  expect(() => fileType('fake.pdf', markdown('not a pdf'))).toThrow(
    /does not match/,
  );
  expect(() => fileType('binary.txt', new Uint8Array([0x41, 0, 0x42]))).toThrow(
    /does not match/,
  );
  expect(fileType('Report.PDF', pdf('x'))).toEqual({
    extension: 'pdf',
    mimeType: 'application/pdf',
  });
});

it('shares an identical re-upload instead of indexing it twice', async () => {
  const f = fixture();
  const first = await f.library.upload(
    { name: 'same.md', bytes: markdown('identical') },
    { allDots: false, dotIds: [f.first.id], spaceIds: [] },
  );
  const again = await f.library.upload(
    { name: 'copy.md', bytes: markdown('identical') },
    { allDots: false, dotIds: [f.second.id], spaceIds: [f.research.id] },
  );
  expect(again.id).toBe(first.id);
  expect(again.dotIds.sort()).toEqual([f.first.id, f.second.id].sort());
  expect(again.spaceIds).toEqual([f.research.id]);
  expect(f.workspace.documents.list()).toHaveLength(1);
});

it('searches only documents the Dot may read, including when it names others', async () => {
  const f = fixture();
  const mine = await indexed(f, 'mine', { dotIds: [f.first.id] }, 'Budget');
  const theirs = await indexed(
    f,
    'theirs',
    { dotIds: [f.second.id] },
    'Secret budget',
  );
  const passages = await f.library.search(f.first.id, 'budget');
  expect(passages.map((passage) => passage.documentId)).toEqual([mine]);
  expect(f.index.searched.at(-1)).toEqual([mine]);
  expect(await f.library.search(f.first.id, 'budget', [theirs])).toEqual([]);
  const tools = documentTools(
    f.library,
    f.first.id,
    () => undefined,
    new AbortController().signal,
  );
  const list = tools.find((tool) => tool.name === 'list_documents')!;
  const execute = list.execute as (args: object) => Promise<unknown>;
  const listed = (await execute({})) as {
    id: string;
  }[];
  expect(listed.map((document) => document.id)).toEqual([mine]);
});

it('reads a page range from the indexed chunks', async () => {
  const f = fixture();
  const document = await f.library.upload(
    { name: 'book.md', bytes: markdown('book') },
    { allDots: true, dotIds: [], spaceIds: [] },
  );
  const claim = f.workspace.documents.claim()!;
  await f.library.saveConversion(
    claim,
    [
      { ...chunk('Chapter one', 1), ordinal: 0 },
      { ...chunk('Chapter two', 2), ordinal: 1 },
      { ...chunk('Chapter three', 3), ordinal: 2 },
    ],
    'Chapter one\n\nChapter two\n\nChapter three',
  );
  const read = await f.library.read(f.first.id, document.id, 2, 3);
  expect(read.text).toBe('Chapter two\n\nChapter three');
  expect(f.workspace.documents.require(document.id).pageCount).toBe(3);
});

function docling(responses: {
  status?: string;
  chunks?: {
    text: string;
    raw_text?: string;
    headings?: string[];
    page_numbers?: number[];
  }[];
}) {
  const calls: string[] = [];
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/v1/chunk/hybrid/file/async'))
        return Response.json({ task_id: 'task', task_status: 'pending' });
      if (url.includes('/v1/status/poll/'))
        return Response.json({
          task_id: 'task',
          task_status: responses.status ?? 'success',
          error_message: 'Corrupt file',
        });
      if (url.includes('/v1/result/'))
        return Response.json({ chunks: responses.chunks ?? [] });
      throw new Error(`Unexpected ${url}`);
    });
  return { spy, calls };
}

it('converts a queued document with docling-serve and makes it searchable', async () => {
  const f = fixture();
  const document = await f.library.upload(
    { name: 'notes.txt', bytes: markdown('plain notes') },
    { allDots: true, dotIds: [], spaceIds: [] },
  );
  const { spy, calls } = docling({
    // Search uses the heading-prefixed text; reading uses raw text.
    chunks: [
      {
        text: 'Notes\nIntro',
        raw_text: 'Intro',
        headings: ['Notes'],
        page_numbers: [1],
      },
      { text: '   ' },
      {
        text: 'Notes\nUsage\nDetails',
        raw_text: 'Details',
        headings: ['Notes', 'Usage'],
        page_numbers: [2, 3],
      },
    ],
  });
  const ingestor = new DocumentIngestor(
    f.workspace.documents,
    f.library,
    'http://docling:5001/',
    { pollMs: 1 },
  );
  await ingestor.tick();
  expect(calls[0]).toBe('http://docling:5001/v1/chunk/hybrid/file/async');
  const form = spy.mock.calls[0][1]?.body as FormData;
  expect((form.get('files') as File).name).toBe('document.md');
  expect(form.get('chunking_include_raw_text')).toBe('true');
  expect(f.workspace.documents.require(document.id)).toMatchObject({
    status: 'ready',
    indexedVersion: 1,
    chunkCount: 2,
    pageCount: 3,
  });
  expect(
    f.index.chunks.get(document.id)?.chunks.map((item) => item.text),
  ).toEqual(['Notes\nIntro', 'Notes\nUsage\nDetails']);
  expect(await f.library.text(document.id)).toBe(
    '# Notes\n\nIntro\n\n## Usage\n\nDetails',
  );
  expect((await f.library.read(f.first.id, document.id, 2)).text).toBe(
    '# Notes\n\n## Usage\n\nDetails',
  );
});

it('records a docling failure on the document', async () => {
  const f = fixture();
  const document = await f.library.upload(
    { name: 'broken.pdf', bytes: pdf('broken') },
    { allDots: true, dotIds: [], spaceIds: [] },
  );
  docling({ status: 'failure' });
  await new DocumentIngestor(
    f.workspace.documents,
    f.library,
    'http://docling:5001',
    { pollMs: 1 },
  ).tick();
  expect(f.workspace.documents.require(document.id)).toMatchObject({
    status: 'failed',
    indexedVersion: null,
    error: expect.stringContaining('Corrupt file'),
  });
});

function routes(f: ReturnType<typeof fixture>) {
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(
    f.store,
    f.workspace,
    {
      baseUrl: config.baseUrl,
      voiceName: 'marin',
      slackUsers: [],
      maxUploadBytes: f.maxUploadBytes,
    },
    { documents: f.library },
  );
  return createApp({
    store: f.store,
    runner: new Runner(f.store, config),
    config,
    platform,
  });
}
const form = (
  file: { name: string; bytes: Uint8Array },
  fields: Record<string, string | string[]> = {},
) => {
  const data = new FormData();
  data.append('file', new File([new Uint8Array(file.bytes)], file.name));
  for (const [key, value] of Object.entries(fields))
    for (const item of Array.isArray(value) ? value : [value])
      data.append(key, item);
  return { method: 'POST', body: data };
};

it('uploads from the explorer with the chosen access', async () => {
  const f = fixture();
  const app = routes(f);
  const response = await app.request(
    '/api/documents',
    form(
      { name: 'Plan.md', bytes: markdown('# Plan') },
      { access: 'dots', dotIds: [f.second.id, f.third.id] },
    ),
  );
  expect(response.status).toBe(201);
  const document = await response.json();
  expect(document).toMatchObject({
    title: 'Plan',
    status: 'queued',
    allDots: false,
  });
  expect(document.dotIds.sort()).toEqual([f.second.id, f.third.id].sort());
  const unknown = await app.request(
    '/api/documents',
    form(
      { name: 'Other.md', bytes: markdown('# Other') },
      { access: 'dots', dotIds: ['missing'] },
    ),
  );
  expect(unknown.status).toBe(400);
});

it('grants a chat attachment to the Dot and links the page’s Space', async () => {
  const f = fixture();
  const app = routes(f);
  const page = f.workspace.pages.create(f.research.id, {
    title: 'Paper',
    content: '',
  });
  f.workspace.bindThread('page-chat', f.second.id, 'Paper chat');
  f.workspace.pages.reserveThread(page.id, f.second.id, 'page-chat');
  f.workspace.pages.finishThread(page.id, f.second.id);
  const response = await app.request(
    '/api/documents',
    form(
      { name: 'figure.md', bytes: markdown('figure') },
      { threadId: 'page-chat', access: 'all' },
    ),
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    allDots: true,
    dotIds: [f.second.id],
    spaceIds: [f.research.id],
    sourceThreadId: 'page-chat',
    sourceDotId: f.second.id,
  });
  const consultation = f.workspace.consultationThread(f.first.id, f.second.id);
  expect(
    (
      await app.request(
        '/api/documents',
        form(
          { name: 'other.md', bytes: markdown('other') },
          { threadId: consultation },
        ),
      )
    ).status,
  ).toBe(400);
});

it('enforces the upload size limit and file type checks', async () => {
  const f = fixture(1000);
  const app = routes(f);
  const large = await app.request(
    '/api/documents',
    form({ name: 'big.md', bytes: markdown('x'.repeat(2000)) }),
  );
  expect(large.status).toBe(413);
  const fake = await app.request(
    '/api/documents',
    form({ name: 'fake.pdf', bytes: markdown('hello') }),
  );
  expect(fake.status).toBe(400);
  expect((await fake.json()).error).toMatch(/does not match/);
  const json = await app.request('/api/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello',
  });
  expect(json.status).toBe(415);
});

it('serves downloads as attachments that never render inline', async () => {
  const f = fixture();
  const app = routes(f);
  const created = await (
    await app.request(
      '/api/documents',
      form({ name: 'page.html', bytes: markdown('<script>alert(1)</script>') }),
    )
  ).json();
  const response = await app.request(`/api/documents/${created.id}/file`);
  expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
  expect(response.headers.get('Content-Disposition')).toMatch(/^attachment;/);
  expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
});

it('reports the library as unavailable without Postgres and docling', async () => {
  const f = fixture();
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const app = createApp({
    store: f.store,
    runner: new Runner(f.store, config),
    config,
    platform: new Platform(f.store, f.workspace, {
      baseUrl: config.baseUrl,
      voiceName: 'marin',
      slackUsers: [],
    }),
  });
  const response = await app.request(
    '/api/documents',
    form({ name: 'a.md', bytes: markdown('a') }),
  );
  expect(response.status).toBe(503);
});

it('describes shared documents and retrieved passages for the prompt', () => {
  const note = describeDocuments(
    [{ id: 'doc-1', title: 'Refund policy', status: 'ready' }],
    [
      {
        documentId: 'doc-1',
        version: 1,
        ordinal: 0,
        title: 'Refund policy',
        text: 'Refunds are available for 30 days.',
        headings: [],
        pageFrom: 2,
        pageTo: 2,
        score: 1,
      },
    ],
  );
  expect(note).toContain('Refund policy');
  expect(note).toContain('Refunds are available for 30 days.');
  expect(note).toContain('"pages":"2"');
  expect(describeDocuments([], [])).toContain('No documents are shared');
});

it('retrieves a shared document for the Dot before answering', async () => {
  const f = fixture();
  await indexed(
    f,
    'policy',
    { dotIds: [f.first.id] },
    'Refunds within 30 days',
  );
  f.workspace.bindThread('thread', f.first.id, 'Docs');
  const agent = new DotAgent(
    f.store,
    f.workspace,
    {
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      voiceName: 'marin',
      slackUsers: [],
    },
    f.first.id,
    false,
    { documents: f.library },
  );
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    messages: [
      { id: 'user', role: 'user', content: 'What is the refund window?' },
    ],
    tools: [],
    forwardedProps: {},
  };
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    completion({ role: 'assistant', content: 'Thirty days.' }),
  );
  await lastValueFrom(agent.run(input).pipe(toArray()));
  const request = JSON.parse(
    String(vi.mocked(fetch).mock.calls[0][1]?.body),
  ) as {
    messages: { role: string; content: string }[];
  };
  const system = request.messages.find(
    (message) => message.role === 'system',
  )!.content;
  expect(system).toContain('Refunds within 30 days');
  expect(system).toContain('policy');
});
