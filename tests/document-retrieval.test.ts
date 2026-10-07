import { afterEach, expect, it, vi } from 'vitest';
import type { ChunkHit } from '../src/server/chunk-index.js';
import { DocumentEnricher } from '../src/server/document-enrichment.js';
import { DocumentIngestor } from '../src/server/document-ingestor.js';
import {
  INDEX_FORMAT,
  type StoredChunk,
} from '../src/server/document-library.js';
import {
  diversify,
  DocumentRetriever,
  fuse,
  type RetrievalOptions,
} from '../src/server/document-retrieval.js';
import { documentTools } from '../src/server/document-tools.js';
import {
  modelJson,
  parseJsonObject,
  type CompleteJson,
} from '../src/server/model-json.js';
import { completion } from './fixtures/model-stream.js';
import {
  fixture,
  indexed,
  type DocumentFixture,
} from './fixtures/document-library.js';

afterEach(() => {
  vi.restoreAllMocks();
});

type Request = Parameters<CompleteJson>[0];

/** A fake model that answers by prompt kind and records every request. */
function model(answers: {
  profile?: (request: Request) => unknown;
  passages?: (request: Request) => unknown;
  plan?: (request: Request) => unknown;
  rerank?: (request: Request) => unknown;
}) {
  const calls: { kind: string; request: Request }[] = [];
  const complete: CompleteJson = async (request) => {
    const kind = request.system.includes('index documents')
      ? 'profile'
      : request.system.includes('prepare passages')
        ? 'passages'
        : request.system.includes('plan searches')
          ? 'plan'
          : 'rerank';
    calls.push({ kind, request });
    const answer = answers[kind as keyof typeof answers];
    if (!answer) throw new Error(`No ${kind} answer`);
    return answer(request);
  };
  return { complete, calls };
}

const passage = (
  ordinal: number,
  text: string,
  headings: string[] = [],
  page = 1,
): StoredChunk => ({
  ordinal,
  text,
  headings,
  pageFrom: page,
  pageTo: page,
});

/** Passage ids the enrichment model was asked about, in order. */
const passageIds = (request: Request) =>
  [...request.user.matchAll(/<passage id="(\d+)">/g)].map((match) =>
    Number(match[1]),
  );

const hit = (
  documentId: string,
  ordinal: number,
  text = `passage ${documentId} ${ordinal}`,
  section = '',
): ChunkHit => ({
  documentId,
  version: 1,
  ordinal,
  text,
  context: '',
  section,
  headings: [],
  pageFrom: null,
  pageTo: null,
  score: 0,
});

// Enrichment

it('writes a document profile and per-passage context, batched by section', async () => {
  const chunks = [
    ...Array.from({ length: 10 }, (_, i) =>
      passage(i, `Leave rule ${i}`, ['Policy', 'Leave']),
    ),
    passage(10, 'Expenses are reimbursed monthly.', ['Policy', 'Expenses']),
  ];
  const { complete, calls } = model({
    profile: () => ({
      summary: '  The staff   handbook. ',
      tags: ['HR', 'hr', 'Leave', 42],
      entities: [
        { name: 'Acme Ltd', type: 'Organization' },
        { name: 'acme ltd', type: 'organization' },
        null,
        { name: 'Payroll' },
      ],
    }),
    passages: (request) => ({
      passages: passageIds(request).map((id) => ({
        id,
        context: `Context for ${id}.`,
        keywords: ['Holiday', 'holiday', 'time off'],
        entities: ['Acme Ltd'],
      })),
    }),
  });
  const { profile, chunks: enriched } = await new DocumentEnricher(
    complete,
  ).enrich('Handbook', '# Policy', chunks);
  expect(profile).toEqual({
    summary: 'The staff handbook.',
    tags: ['hr', 'leave'],
    entities: [
      { name: 'Acme Ltd', type: 'organization' },
      { name: 'Payroll', type: 'other' },
    ],
    note: null,
  });
  // Ten passages in one section need two calls of at most eight; the next section gets its own.
  const batches = calls
    .filter((call) => call.kind === 'passages')
    .map((call) => passageIds(call.request))
    .sort((a, b) => a[0] - b[0]);
  expect(batches).toEqual([[0, 1, 2, 3, 4, 5, 6, 7], [8, 9], [10]]);
  const first = calls.find((call) => call.kind === 'passages')!.request.user;
  expect(first.startsWith('<title>Handbook</title>\n<summary>The staff handbook.'))
    .toBe(true);
  expect(enriched[10]).toMatchObject({
    section: 'Policy > Expenses',
    context: 'Context for 10.',
    keywords: ['holiday', 'time off'],
    entities: ['acme ltd'],
  });
});

it('keeps headings only for passages whose enrichment failed, and says so', async () => {
  const chunks = [
    passage(0, 'Intro', ['A']),
    passage(1, 'Body', ['B']),
    passage(2, 'More body', ['B']),
  ];
  const { complete } = model({
    profile: () => {
      throw new Error('profile down');
    },
    passages: (request) => {
      if (request.user.includes('name="B"')) throw new Error('rate limited');
      // Unknown ids and empty contexts are ignored.
      return {
        passages: [
          { id: 0, context: 'About the intro.' },
          { id: 7, context: 'Not asked for.' },
        ],
      };
    },
  });
  const result = await new DocumentEnricher(complete).enrich(
    'Doc',
    'text',
    chunks,
  );
  expect(result.chunks.map((chunk) => [chunk.section, chunk.context])).toEqual(
    [
      ['A', 'About the intro.'],
      ['B', ''],
      ['B', ''],
    ],
  );
  expect(result.profile.summary).toBeNull();
  expect(result.profile.note).toMatch(
    /summary could not be written, and 2 of 3 passages kept their headings only.*reprocess/,
  );
});

it('indexes headings only, without a note, when no model is configured', async () => {
  const result = await new DocumentEnricher().enrich('Doc', 'x', [
    passage(0, 'Text', ['Top', 'Sub']),
  ]);
  expect(result.profile).toEqual({
    summary: null,
    tags: [],
    entities: [],
    note: null,
  });
  expect(result.chunks[0]).toMatchObject({ section: 'Top > Sub', context: '' });
});

it('stops enriching when the conversion is cancelled', async () => {
  const controller = new AbortController();
  const { complete } = model({
    profile: () => {
      controller.abort();
      throw new Error('aborted');
    },
  });
  await expect(
    new DocumentEnricher(complete).enrich(
      'Doc',
      'x',
      [passage(0, 'Text')],
      controller.signal,
    ),
  ).rejects.toThrow();
});

it('asks the model for a JSON object with a token cap', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { stream?: boolean };
      const content = '{"queries": ["a"]}';
      return body.stream
        ? completion({ role: 'assistant', content })
        : Response.json({
            id: 'completion',
            object: 'chat.completion',
            created: 1,
            model: 'small-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
              },
            ],
          });
    },
  );
  const complete = modelJson({
    apiKey: 'fixture',
    baseUrl: 'https://model.invalid/v1',
    model: 'small-model',
  });
  expect(
    await complete({ system: 'Plan.', user: 'Question', maxTokens: 123 }),
  ).toEqual({ queries: ['a'] });
  const request = JSON.parse(String(fetch.mock.calls[0][1]?.body)) as Record<
    string,
    unknown
  >;
  expect(request).toMatchObject({
    model: 'small-model',
    max_completion_tokens: 123,
    response_format: { type: 'json_object' },
  });
  expect(JSON.stringify(request.messages)).toContain('Plan.');
});

it('parses JSON wrapped in prose or code fences', () => {
  expect(parseJsonObject('Sure:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  expect(() => parseJsonObject('no json here')).toThrow(/no JSON/);
});

// Indexing and re-indexing

function enrichedFixture(embed?: (texts: string[]) => Promise<number[][]>) {
  const { complete } = model({
    profile: () => ({
      summary: 'Leave policy for staff.',
      tags: ['leave'],
      entities: [{ name: 'HR', type: 'organization' }],
    }),
    passages: (request) => ({
      passages: passageIds(request).map((id) => ({
        id,
        context: `Placed ${id}.`,
        keywords: ['holiday'],
        entities: [],
      })),
    }),
  });
  return fixture({ enricher: new DocumentEnricher(complete), embed });
}

it('embeds the title, section and context with each passage and stores the profile', async () => {
  const embedded: string[][] = [];
  const f = enrichedFixture(async (texts) => {
    embedded.push(texts);
    return texts.map(() => [0.1, 0.2]);
  });
  const id = await indexed(f, 'handbook', { allDots: true }, [
    passage(0, 'Staff get 25 days.', ['Leave']),
  ]);
  expect(embedded[0]).toEqual([
    'handbook\nLeave\nPlaced 0.\nStaff get 25 days.',
  ]);
  expect(f.index.chunks.get(id)!.chunks[0]).toMatchObject({
    section: 'Leave',
    context: 'Placed 0.',
    keywords: ['holiday'],
  });
  const detail = f.workspace.documents.detail(id, f.workspace.dots());
  expect(detail).toMatchObject({
    summary: 'Leave policy for staff.',
    tags: ['leave'],
    entities: [{ name: 'HR', type: 'organization' }],
    enrichmentNote: null,
  });
  // The title does not mention leave; the tag does.
  expect(f.library.list(f.first.id, 'LEAVE').map((doc) => doc.id)).toEqual([
    id,
  ]);
});

it('re-indexes documents from an older format from the stored conversion, without docling', async () => {
  const f = enrichedFixture();
  const id = await indexed(f, 'old', { allDots: true }, [
    passage(0, 'Old passage', ['Old']),
  ]);
  expect(f.workspace.documents.requeueStale(INDEX_FORMAT)).toBe(0);
  // Pretend the document was indexed by an older pipeline.
  expect(f.workspace.documents.requeueStale(INDEX_FORMAT + 1)).toBe(1);
  const queued = f.workspace.documents.require(id);
  expect(queued).toMatchObject({ status: 'queued', indexedVersion: 1 });
  // Still searchable while it waits.
  expect(f.workspace.documents.readableIds(f.first.id)).toEqual([id]);
  const fetch = vi.spyOn(globalThis, 'fetch');
  await new DocumentIngestor(
    f.workspace.documents,
    f.library,
    'http://docling.invalid',
    { pollMs: 1 },
  ).tick();
  expect(fetch).not.toHaveBeenCalled();
  expect(f.workspace.documents.require(id)).toMatchObject({
    status: 'ready',
    indexedVersion: 1,
    chunkCount: 1,
  });
  expect(f.index.chunks.get(id)!.chunks[0]).toMatchObject({
    text: 'Old passage',
    context: 'Placed 0.',
  });
});

// Planning

const planner = (plan: unknown) =>
  model({
    plan: () => plan,
    rerank: (request) => ({
      scores: [...request.user.matchAll(/<passage id="(\d+)">/g)].map(
        (match) => ({ id: Number(match[1]), score: 2 }),
      ),
    }),
  });

it('rewrites a follow-up as a standalone question and expands it into several queries', async () => {
  const f = fixture();
  const { complete, calls } = planner({
    needsDocuments: true,
    standalone: 'What is the notice period in the second contract?',
    queries: [
      'notice period second contract',
      'What is the notice period in the second contract?',
      'termination notice',
      'x',
    ],
    hypothetical: 'The contract requires three months notice.',
    tags: ['Contracts', 'contracts', 'notice'],
  });
  const retriever = new DocumentRetriever(f.library, complete);
  const plan = await retriever.plan(
    'and the second one?',
    [
      { role: 'user', content: 'What is the notice period in the first contract?' },
      { role: 'assistant', content: 'One month.' },
    ],
    [
      {
        id: 'd',
        title: 'Contracts',
        status: 'ready',
        searchable: true,
        summary: 'Two supplier contracts.',
        tags: ['contracts'],
      },
    ],
  );
  expect(plan).toEqual({
    needsDocuments: true,
    standalone: 'What is the notice period in the second contract?',
    queries: [
      'What is the notice period in the second contract?',
      'notice period second contract',
      'termination notice',
    ],
    hypothetical: 'The contract requires three months notice.',
    tags: ['contracts', 'notice'],
  });
  const prompt = calls[0].request.user;
  expect(prompt).toContain('user: What is the notice period in the first contract?');
  expect(prompt).toContain('"summary":"Two supplier contracts."');
  expect(prompt).toContain('<latest>\nand the second one?\n</latest>');
});

it('falls back to the message itself when planning fails or is slow', async () => {
  const f = fixture();
  const failing = new DocumentRetriever(
    f.library,
    model({
      plan: () => {
        throw new Error('down');
      },
    }).complete,
  );
  const fallback = {
    needsDocuments: true,
    standalone: 'refund window',
    queries: ['refund window'],
    hypothetical: null,
    tags: [],
  };
  expect(await failing.plan('refund window', [], [])).toEqual(fallback);
  const slow = new DocumentRetriever(
    f.library,
    () => new Promise(() => undefined),
    { plannerTimeoutMs: 5 },
  );
  expect(await slow.plan('refund window', [], [])).toEqual(fallback);
  expect(
    await new DocumentRetriever(f.library).plan('refund window', [], []),
  ).toEqual(fallback);
});

it('skips the search for small talk unless a tool asks for it', async () => {
  const f = fixture();
  await indexed(f, 'policy', { allDots: true }, 'Refunds within 30 days');
  const { complete } = planner({
    needsDocuments: false,
    standalone: 'thanks',
    queries: [],
  });
  const retriever = new DocumentRetriever(f.library, complete);
  expect(
    await retriever.retrieve({ dotId: f.first.id, message: 'thanks!' }),
  ).toEqual([]);
  expect(f.index.queries).toEqual([]);
  const forced = await retriever.retrieve({
    dotId: f.first.id,
    message: 'thanks!',
    force: true,
  });
  expect(forced.map((item) => item.text)).toEqual(['Refunds within 30 days']);
});

it('runs every planned query, the hypothetical answer and the tags', async () => {
  const f = fixture();
  await indexed(f, 'policy', { allDots: true }, 'Refunds within 30 days');
  const { complete } = planner({
    needsDocuments: true,
    standalone: 'How long do refunds take?',
    queries: ['refund time', 'refund policy'],
    hypothetical: 'Refunds are paid within 30 days.',
    tags: ['refunds'],
  });
  const tagSearch = vi.spyOn(f.index, 'tagSearch');
  await new DocumentRetriever(f.library, complete).retrieve({
    dotId: f.first.id,
    message: 'how long?',
    tags: ['Billing'],
  });
  expect(f.index.queries).toEqual([
    'How long do refunds take?',
    'refund time',
    'refund policy',
    null,
  ]);
  expect(tagSearch.mock.calls[0][0]).toEqual(['refunds', 'billing']);
});

// Fusion, reranking and diversity

it('fuses ranked lists so passages found by several queries rise', () => {
  const fused = fuse([
    [hit('a', 0), hit('a', 1), hit('b', 0)],
    [hit('b', 0), hit('a', 2)],
    [hit('b', 0)],
  ]);
  expect(fused.map((item) => `${item.documentId}${item.ordinal}`)).toEqual([
    'b0',
    'a0',
    'a1',
    'a2',
  ]);
  expect(fused[0].score).toBeCloseTo(1 / 63 + 1 / 61 + 1 / 61);
});

it('reorders by model relevance, drops irrelevant passages and keeps fused order on failure', async () => {
  const f = fixture();
  const candidates = [hit('a', 0), hit('a', 1), hit('a', 2), hit('a', 3)];
  const scored = new DocumentRetriever(
    f.library,
    model({
      rerank: () => ({
        scores: [
          { id: 0, score: 0 },
          { id: 1, score: 1 },
          { id: 2, score: 3 },
          { id: 9, score: 3 },
          { id: 3, score: '2' },
        ],
      }),
    }).complete,
  );
  expect(
    (await scored.rerank('q', candidates)).map((item) => item.ordinal),
  ).toEqual([2, 3, 1]);
  const none = new DocumentRetriever(
    f.library,
    model({
      rerank: () => ({ scores: candidates.map((_, id) => ({ id, score: 0 })) }),
    }).complete,
  );
  expect(
    (await none.rerank('q', candidates)).map((item) => item.ordinal),
  ).toEqual([0, 1]);
  const failing = new DocumentRetriever(
    f.library,
    model({ rerank: () => ({ nonsense: true }) }).complete,
  );
  expect(await failing.rerank('q', candidates)).toBe(candidates);
  const slow = new DocumentRetriever(
    f.library,
    () => new Promise(() => undefined),
    { rerankTimeoutMs: 5 },
  );
  expect(await slow.rerank('q', candidates)).toBe(candidates);
});

it('caps results per document and section and skips neighbours and near-duplicates', () => {
  const options: Pick<RetrievalOptions, 'limit' | 'perDocument' | 'perSection'> =
    { limit: 4, perDocument: 2, perSection: 1 };
  const picked = diversify(
    [
      hit('a', 0, 'alpha', 'One'),
      hit('a', 5, 'beta', 'One'),
      hit('a', 1, 'gamma', 'Two'),
      hit('a', 8, 'delta', 'Three'),
      hit('a', 12, 'epsilon', 'Four'),
      hit('b', 0, 'the quick brown fox jumps', ''),
      hit('c', 0, 'the quick brown fox jumps', ''),
      hit('d', 0, 'zeta', ''),
      hit('e', 0, 'eta', ''),
    ],
    options,
  );
  expect(picked.map((item) => `${item.documentId}${item.ordinal}`)).toEqual([
    'a0',
    'a8',
    'b0',
    'd0',
  ]);
});

// Expansion, related passages and access

async function library(f: DocumentFixture) {
  const handbook = await indexed(f, 'handbook', { dotIds: [f.first.id] }, [
    passage(0, 'Leave intro', ['Leave'], 1),
    passage(1, 'Holiday allowance is 25 days', ['Leave'], 2),
    passage(2, 'Carry over up to 5 days', ['Leave'], 2),
    passage(3, 'Expenses are monthly', ['Expenses'], 3),
  ]);
  const secret = await indexed(f, 'secret', { dotIds: [f.second.id] }, [
    passage(0, 'Executive holiday allowance is 40 days', ['Leave'], 1),
  ]);
  return { handbook, secret };
}

it('adds neighbouring passages from the same section and readable related references', async () => {
  const f = fixture();
  const { handbook, secret } = await library(f);
  const link = (documentId: string, ordinal: number) => ({
    from: { documentId: handbook, ordinal: 1 },
    documentId,
    ordinal,
    kind: 'similar' as const,
    score: 0.9,
    section: 'Leave',
    pageFrom: 1,
    pageTo: 1,
  });
  f.index.linked = [link(secret, 0), link(handbook, 3)];
  const links = vi.spyOn(f.index, 'links');
  const [best] = await new DocumentRetriever(f.library, undefined, {
    limit: 1,
  }).retrieve({ dotId: f.first.id, message: 'holiday allowance' });
  expect(best).toMatchObject({
    ref: `${handbook}#1`,
    title: 'handbook',
    section: 'Leave',
    pages: '2',
    before: 'Leave intro',
    text: 'Holiday allowance is 25 days',
    after: 'Carry over up to 5 days',
    related: [
      {
        ref: `${handbook}#3`,
        title: 'handbook',
        kind: 'similar',
      },
    ],
  });
  // The index is only asked about documents this Dot may read.
  expect(links.mock.calls[0][1]).toEqual([handbook]);
});

it('does not cross a section boundary and stops expanding at the budget', async () => {
  const f = fixture();
  const { handbook } = await library(f);
  const [carry] = await new DocumentRetriever(f.library, undefined, {
    limit: 1,
  }).retrieve({ dotId: f.first.id, message: 'carry' });
  expect(carry.ref).toBe(`${handbook}#2`);
  expect(carry.before).toBe('Holiday allowance is 25 days');
  // The next passage is under Expenses.
  expect(carry.after).toBeUndefined();
  const [holiday] = await new DocumentRetriever(f.library, undefined, {
    limit: 1,
    expansionChars: 8,
  }).retrieve({ dotId: f.first.id, message: 'holiday allowance' });
  expect(holiday.ref).toBe(`${handbook}#1`);
  expect(holiday.before).toBe('Leave in…');
  expect(holiday.after).toBeUndefined();
});

it('drops passages whose access is revoked while the model ranks them', async () => {
  const f = fixture();
  const { handbook } = await library(f);
  const { complete } = model({
    plan: () => ({ needsDocuments: true, standalone: 'holiday', queries: [] }),
    rerank: (request) => {
      f.workspace.documents.update(handbook, { dotIds: [] });
      return { scores: passageIds(request).map((id) => ({ id, score: 3 })) };
    },
  });
  expect(
    await new DocumentRetriever(f.library, complete).retrieve({
      dotId: f.first.id,
      message: 'holiday',
    }),
  ).toEqual([]);
});

it('limits a search to the named documents the Dot may read', async () => {
  const f = fixture();
  const { handbook, secret } = await library(f);
  const retriever = new DocumentRetriever(f.library);
  expect(
    await retriever.retrieve({
      dotId: f.first.id,
      message: 'holiday',
      documentIds: [secret],
    }),
  ).toEqual([]);
  const found = await retriever.retrieve({
    dotId: f.second.id,
    message: 'holiday',
    documentIds: [secret, handbook],
  });
  expect(found.map((item) => item.documentId)).toEqual([secret]);
});

// Tools

it('searches through the pipeline and opens related passages only when readable', async () => {
  const f = fixture();
  const { handbook, secret } = await library(f);
  const { complete } = planner({
    needsDocuments: false,
    standalone: 'carry over',
    queries: ['carry over'],
  });
  const tools = documentTools(
    f.library,
    new DocumentRetriever(f.library, complete),
    f.first.id,
    () => undefined,
    new AbortController().signal,
  );
  const run = (name: string, args: object) =>
    (tools.find((tool) => tool.name === name)!.execute as (
      args: object,
    ) => Promise<unknown>)(args);
  const found = (await run('search_documents', { query: 'carry over' })) as {
    ref: string;
  }[];
  expect(found[0].ref).toBe(`${handbook}#2`);
  const opened = (await run('read_passage', {
    ref: `${handbook}#2`,
    around: 0,
  })) as { text: string; section: string; pages: string };
  expect(opened).toMatchObject({
    text: '# Leave\n\nCarry over up to 5 days',
    section: 'Leave',
    pages: '2',
  });
  const wide = (await run('read_passage', { ref: `${handbook}#2` })) as {
    text: string;
  };
  expect(wide.text).toContain('Holiday allowance');
  expect(wide.text).toContain('# Expenses');
  await expect(run('read_passage', { ref: `${secret}#0` })).rejects.toThrow(
    /not shared with this Dot/,
  );
  await expect(run('read_passage', { ref: 'not-a-ref' })).rejects.toThrow(
    /not found/,
  );
  await expect(run('read_passage', { ref: `${handbook}#99` })).rejects.toThrow(
    /not found/,
  );
});
