import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import {
  ActionItemStore,
  entityKey,
  nearKeys,
} from '../src/server/action-item-store.js';
import type {
  ActionItemHit,
  ActionItemIndex,
  IndexedActionItem,
} from '../src/server/action-item-index.js';
import {
  ActionItemService,
  parseWhen,
  type ActionItemInput,
  type Actor,
  type SourceInput,
} from '../src/server/action-items.js';
import { actionItemTools } from '../src/server/action-item-tools.js';
import { consultationBlocked } from '../src/server/authorize.js';
import type { CompleteJson } from '../src/server/model-json.js';
import { fixture, indexed } from './fixtures/document-library.js';

const DIMENSIONS = 256;

/** Bag-of-words vector, so similar wording gives similar vectors. */
function vectorOf(text: string) {
  const values = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    values[hash % DIMENSIONS] += 1;
  }
  const length = Math.hypot(...values) || 1;
  return values.map((value) => value / length);
}

const cosine = (a: number[], b: number[]) =>
  a.reduce((sum, value, index) => sum + value * b[index], 0);

/** In-memory search copy: cosine similarity plus a bonus per matching keyword. */
class MemoryIndex implements ActionItemIndex {
  rows = new Map<string, IndexedActionItem>();
  fail = false;
  async upsert(item: IndexedActionItem) {
    if (this.fail) throw new Error('Postgres is down.');
    this.rows.set(item.id, item);
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
  async search(
    query: string | null,
    embedding: number[],
    ids: string[],
    limit: number,
  ): Promise<ActionItemHit[]> {
    if (this.fail) throw new Error('Postgres is down.');
    const words = (query ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return ids
      .map((id) => this.rows.get(id))
      .filter((row): row is IndexedActionItem => !!row)
      .map((row) => {
        const text = `${row.primary} ${row.context} ${row.body}`.toLowerCase();
        return {
          id: row.id,
          score:
            cosine(row.embedding, embedding) +
            0.1 * words.filter((word) => text.includes(word)).length,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  async nearest(embedding: number[], ids: string[], limit: number) {
    if (this.fail) throw new Error('Postgres is down.');
    return ids
      .map((id) => this.rows.get(id))
      .filter((row): row is IndexedActionItem => !!row)
      .map((row) => ({ id: row.id, score: cosine(row.embedding, embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

function setup(complete?: CompleteJson) {
  const f = fixture();
  const itemIndex = new MemoryIndex();
  const embedded: string[] = [];
  const ownerNames: string[] = [];
  const service = new ActionItemService(
    new ActionItemStore(f.store.database),
    itemIndex,
    async (texts) => {
      embedded.push(...texts);
      return texts.map(vectorOf);
    },
    f.workspace,
    complete,
    { ownerNames: () => [...ownerNames, ...f.store.settings().ownerNames] },
  );
  const owner: Actor = { id: 'owner', timeZone: 'UTC' };
  return { ...f, itemIndex, service, owner, embedded, ownerNames };
}

const chat: SourceInput = {
  kind: 'conversation',
  excerpt: 'From the notes the owner pasted.',
};

const companyAPricing: ActionItemInput & { source: SourceInput } = {
  statement: 'Send Company A the revised pricing for the topic B rollout',
  context:
    'Company A sync on topic B: they are comparing vendors and need numbers before their board meeting.',
  due: '2026-10-16',
  entities: [
    { name: 'Company A', kind: 'organization', role: 'about' },
    { name: 'Topic B', kind: 'topic', role: 'about' },
  ],
  source: chat,
};
const companyASecurity: ActionItemInput & { source: SourceInput } = {
  statement:
    'Book the security review with Company A for the topic C integration',
  context:
    'Company A wants a security review before the topic C integration goes live.',
  entities: [
    { name: 'Company A, Inc.', kind: 'organization', role: 'about' },
    { name: 'Topic C', kind: 'topic', role: 'about' },
  ],
  source: chat,
};
const owedByPersonJ: ActionItemInput & { source: SourceInput } = {
  statement: 'Person J owes contract redlines to Company F for topic G',
  context: 'Company F renewal on topic G; Person J promised the redlines.',
  due: '2025-10-01',
  entities: [
    { name: 'Person J', kind: 'person', role: 'assignee' },
    { name: 'Company F', kind: 'organization', role: 'about' },
    { name: 'Topic G', kind: 'topic', role: 'about' },
  ],
  source: chat,
};

const created = (
  result: Awaited<ReturnType<ActionItemService['create']>>,
  position = 0,
) => {
  const entry = result.results[position];
  if (entry.status !== 'created')
    throw new Error(`Not created: ${entry.status}`);
  return entry;
};

describe('entity names', () => {
  it('match across case, punctuation and company suffixes, and flag near names', () => {
    expect(entityKey('organization', 'Acme, Inc.')).toBe('acme');
    expect(entityKey('organization', 'The ACME Corporation')).toBe('acme');
    expect(entityKey('person', 'José  Núñez')).toBe('jose nunez');
    expect(entityKey('topic', 'Pricing & Packaging')).toBe(
      'pricing and packaging',
    );
    expect(nearKeys('acme', 'acme holdings')).toBe(true);
    expect(nearKeys('john smith', 'jon smith')).toBe(true);
    expect(nearKeys('acme', 'globex')).toBe(false);
  });

  it('renames the old owner role to assignee', () => {
    const f = fixture();
    const store = new ActionItemStore(f.store.database);
    const item = store.create({
      statement: 'Person J owes the redlines',
      details: '',
      context: 'Renewal',
      status: 'open',
      priority: 'normal',
      dueAt: null,
      remindAt: null,
      labels: [],
      createdBy: 'owner',
      source: {
        kind: 'owner',
        id: null,
        ref: null,
        title: null,
        excerpt: '',
        date: null,
        threadId: null,
      },
      links: [],
    });
    const person = store.createEntity('person', 'Person J');
    f.store.database
      .prepare("INSERT INTO action_item_entities VALUES (?, ?, 'owner')")
      .run(item.id, person.id);
    new ActionItemStore(f.store.database);
    expect(store.get(item.id)?.entities).toEqual([
      expect.objectContaining({ name: 'Person J', role: 'assignee' }),
    ]);
  });
});

describe('action items', () => {
  it('keeps each item findable by its company, topic, person, and meaning', async () => {
    const { service, owner } = setup();
    const filed = await service.create(
      [companyAPricing, companyASecurity, owedByPersonJ],
      owner,
    );
    expect(filed.results.map((result) => result.status)).toEqual([
      'created',
      'created',
      'created',
    ]);
    const [pricing, security, redlines] = filed.results.map(
      (_, position) => created(filed, position).item,
    );
    // "Company A, Inc." is the same organization as "Company A".
    const companyA = pricing.entities.find(
      (entity) => entity.kind === 'organization',
    )!;
    expect(security.entities).toContainEqual(
      expect.objectContaining({ id: companyA.id, name: 'Company A' }),
    );

    const aboutA = await service.search({ entities: ['Company A'] }, owner);
    expect(aboutA.items.map((item) => item.id).sort()).toEqual(
      [pricing.id, security.id].sort(),
    );
    const pricingForA = await service.search(
      { entities: ['company a'], query: 'pricing numbers' },
      owner,
    );
    expect(pricingForA.items[0].id).toBe(pricing.id);
    const fAndJ = await service.search(
      { entities: ['Company F', 'Person J'] },
      owner,
    );
    expect(fAndJ.items.map((item) => item.id)).toEqual([redlines.id]);
    expect((await service.search({ assignee: 'owed' }, owner)).items).toEqual([
      expect.objectContaining({ id: redlines.id }),
    ]);
    expect(
      (await service.search({ assignee: 'Person J' }, owner)).items.map(
        (item) => item.id,
      ),
    ).toEqual([redlines.id]);
    expect(
      (await service.search({ assignee: 'me' }, owner)).items.map(
        (item) => item.id,
      ),
    ).toEqual([pricing.id, security.id]);
    const byMeaning = await service.search(
      { query: 'contract redlines renewal' },
      owner,
    );
    expect(byMeaning.items[0].id).toBe(redlines.id);

    const unknown = await service.search(
      { entities: ['Company Z'], query: 'security review' },
      owner,
    );
    expect(unknown.unresolved).toEqual([
      { name: 'Company Z', suggestions: [] },
    ]);
    expect(unknown.items[0].id).toBe(security.id);
  });

  it('holds back a likely duplicate unless forced, and flags near entity names', async () => {
    const { service, owner } = setup();
    const first = created(await service.create([companyAPricing], owner)).item;
    const again = await service.create([companyAPricing], owner);
    expect(again.results[0]).toMatchObject({
      status: 'possible_duplicate',
      matches: [{ item: { id: first.id }, similarity: 1 }],
    });
    expect(service.store.filter()).toHaveLength(1);
    const forced = await service.create(
      [{ ...companyAPricing, force: true }],
      owner,
    );
    expect(forced.results[0].status).toBe('created');

    const holdings = created(
      await service.create(
        [
          {
            statement: 'Ask Company A Holdings for their tax certificate',
            context: 'Finance needs it before paying the invoice.',
            entities: [
              {
                name: 'Company A Holdings',
                kind: 'organization',
                role: 'about',
              },
            ],
          },
        ],
        owner,
      ),
    );
    expect(holdings.possibleEntityMatches).toEqual([
      expect.objectContaining({
        name: 'Company A Holdings',
        candidates: [expect.objectContaining({ name: 'Company A' })],
      }),
    ]);
    const companyA = first.entities.find(
      (entity) => entity.kind === 'organization',
    )!;
    const merged = await service.mergeEntities(
      holdings.possibleEntityMatches[0].createdEntityId,
      companyA.id,
    );
    expect(merged.entity.aliases).toEqual(['Company A Holdings']);
    expect(service.store.findEntity('company a holdings')?.id).toBe(
      companyA.id,
    );
    expect(
      (await service.search({ entities: ['Company A'] }, owner)).items,
    ).toHaveLength(3);
  });

  it('saves when search is down and catches the index up on the next search', async () => {
    const { service, owner, itemIndex } = setup();
    await service.create([companyAPricing], owner);
    itemIndex.fail = true;
    const filed = await service.create([companyASecurity], owner);
    expect(filed.warnings[0]).toMatch(/Duplicate checks were skipped/);
    const item = created(filed).item;
    expect(itemIndex.rows.has(item.id)).toBe(false);
    const unavailable = await service.search({ query: 'security' }, owner);
    expect(unavailable.note).toMatch(/unavailable/);
    expect(unavailable.items.map((entry) => entry.id)).toContain(item.id);
    itemIndex.fail = false;
    const found = await service.search({ query: 'security review' }, owner);
    expect(found.items[0].id).toBe(item.id);
    expect(itemIndex.rows.has(item.id)).toBe(true);
  });

  it('lets the model rerank, and keeps the ranked order when it fails', async () => {
    let fail = false;
    const complete: CompleteJson = async ({ user }) => {
      if (fail) throw new Error('Model is down.');
      const ids = [...user.matchAll(/<item id="(\d+)">\n([^\n]+)/g)];
      return {
        scores: ids.map(([, id, statement]) => ({
          id: Number(id),
          score: statement.includes('security') ? 3 : 0,
        })),
      };
    };
    const { service, owner } = setup(complete);
    await service.create([companyAPricing, companyASecurity], owner);
    const judged = await service.search({ query: 'Company A' }, owner);
    expect(judged.items.map((item) => item.statement)).toEqual([
      companyASecurity.statement,
    ]);
    fail = true;
    const fallback = await service.search({ query: 'Company A' }, owner);
    expect(fallback.items).toHaveLength(2);
  });

  it('keeps history, updates status and dates, and re-embeds notes', async () => {
    const { service, owner, embedded } = setup();
    const item = created(await service.create([companyAPricing], owner)).item;
    expect(item.dueAt).toBe(Date.parse('2026-10-16T23:59:00Z'));
    await service.addNote(
      item.id,
      'Company A moved their board meeting to November.',
      owner,
    );
    expect(embedded.at(-1)).toMatch(/November/);
    const updated = await service.update(
      item.id,
      {
        status: 'done',
        due: null,
        removeEntities: [{ entityId: item.entities[1].id }],
      },
      owner,
    );
    expect(updated.item).toMatchObject({ status: 'done', dueAt: null });
    expect(updated.item.completedAt).not.toBeNull();
    expect(updated.item.entities.map((entity) => entity.name)).toEqual([
      'Company A',
    ]);
    expect(service.detail(item.id)?.events.map((event) => event.kind)).toEqual([
      'created',
      'note',
      'update',
    ]);
    expect((await service.search({}, owner)).items).toEqual([]);
    expect(
      (await service.search({ statuses: ['done'] }, owner)).items.map(
        (entry) => entry.id,
      ),
    ).toEqual([item.id]);
  });

  it('reads date-only due dates in the given time zone', () => {
    expect(parseWhen('2026-10-16', 'America/Chicago', 23 * 60 + 59)).toBe(
      Date.parse('2026-10-17T04:59:00Z'),
    );
    expect(parseWhen('2026-10-16T09:30:00Z', 'America/Chicago', 0)).toBe(
      Date.parse('2026-10-16T09:30:00Z'),
    );
    expect(parseWhen(null, 'UTC', 0)).toBeNull();
    expect(() => parseWhen('next Friday', 'UTC', 0)).toThrow(/ISO date/);
  });

  it('groups follow-ups and gives each reminder once', async () => {
    const { service, owner } = setup();
    const now = Date.parse('2026-10-10T12:00:00Z');
    const filed = await service.create(
      [
        { ...companyAPricing, due: '2026-10-09' },
        {
          ...companyASecurity,
          due: '2026-10-12',
          remindAt: '2026-10-10T08:00:00Z',
        },
        owedByPersonJ,
      ],
      owner,
    );
    const [late, soon, owed] = filed.results.map(
      (_, position) => created(filed, position).item,
    );
    const first = service.review(owner, { now, markReminded: true });
    expect(first.overdue.map((item) => item.id)).toEqual([late.id]);
    expect(first.dueSoon.map((item) => item.id)).toEqual([soon.id]);
    expect(first.reminders.map((item) => item.id)).toEqual([soon.id]);
    expect(first.owedToYouOverdue.map((item) => item.id)).toEqual([owed.id]);
    const second = service.review(owner, { now });
    expect(second.reminders).toEqual([]);
    expect(second.dueSoon[0]).toMatchObject({ id: soon.id, remindersGiven: 1 });
    const later = service.review(owner, { now: now + 15 * 86_400_000 });
    expect(later.stale).toEqual([]);
    expect(later.overdue.map((item) => item.id).sort()).toEqual(
      [late.id, soon.id].sort(),
    );
  });

  it("leaves the owner off items under any of the owner's names", async () => {
    const { service, owner, ownerNames } = setup();
    ownerNames.push('Andre Smart', 'Andre');
    const andre = { name: 'andre', kind: 'person' as const };
    const filed = await service.create(
      [
        {
          ...owedByPersonJ,
          statement: 'Andre to deliver the capacity matrix for topic G',
          entities: [
            { ...andre, role: 'assignee' },
            { name: 'Topic G', kind: 'topic', role: 'about' },
          ],
        },
        {
          ...companyAPricing,
          statement: 'Person J to send the redlines Andre asked for',
          entities: [
            { name: 'Person J', kind: 'person', role: 'assignee' },
            { name: 'Andre Smart', kind: 'person', role: 'requester' },
          ],
        },
        {
          ...companyASecurity,
          statement: 'Person K to review the grant letter for Person L',
          entities: [
            { name: 'Person K', kind: 'person', role: 'assignee' },
            { name: 'Person L', kind: 'person', role: 'requester' },
          ],
        },
      ],
      owner,
    );
    const [mine, owed, between] = filed.results.map(
      (_, position) => created(filed, position).item,
    );
    expect(mine.entities.map((entity) => entity.name)).toEqual(['Topic G']);
    expect(owed.entities.map((entity) => entity.role)).toEqual(['assignee']);
    const ids = async (assignee: string) =>
      (await service.search({ assignee }, owner)).items.map((item) => item.id);
    expect(await ids('me')).toEqual([mine.id]);
    expect(await ids('owed')).toEqual([owed.id]);
    expect(await ids('others')).toEqual([between.id]);
    const updated = await service.update(
      between.id,
      { addEntities: [{ ...andre, role: 'about' }] },
      owner,
    );
    expect(updated.item.entities).toHaveLength(2);
  });

  it('recognises the owner on items filed before their names were known', async () => {
    const { service, owner, ownerNames, itemIndex } = setup();
    const filed = created(
      await service.create(
        [
          {
            ...owedByPersonJ,
            statement: 'Andre to confirm access to the dev environment',
            entities: [{ name: 'Andre', kind: 'person', role: 'assignee' }],
          },
        ],
        owner,
      ),
    ).item;
    expect((await service.search({ assignee: 'owed' }, owner)).items).toEqual([
      expect.objectContaining({ id: filed.id }),
    ]);
    ownerNames.push('Andre');
    expect(await service.recogniseOwner(owner)).toBe(1);
    const item = service.detail(filed.id)!;
    expect(item.entities).toEqual([]);
    expect(item.events.at(-1)).toMatchObject({
      kind: 'update',
      text: 'Recognised Andre as you.',
    });
    expect(itemIndex.rows.get(filed.id)?.updatedAt).toBe(item.updatedAt);
    expect((await service.search({ assignee: 'me' }, owner)).items).toEqual([
      expect.objectContaining({ id: filed.id }),
    ]);
    expect(await service.recogniseOwner(owner)).toBe(0);
  });

  it('only lets a Dot cite documents it can read', async () => {
    const f = setup();
    const documentId = await indexed(f, 'Company A sync', {
      dotIds: [f.first.id],
    });
    const source: SourceInput = {
      kind: 'document',
      documentId,
      ref: `${documentId}#0`,
      excerpt: 'Send revised pricing by Friday.',
      date: '2026-10-03',
    };
    const reader = created(
      await f.service.create([{ ...companyAPricing, source }], {
        id: f.first.id,
        dotId: f.first.id,
      }),
    ).item;
    expect(reader.source).toMatchObject({
      kind: 'document',
      id: documentId,
      title: 'Company A sync',
      date: '2026-10-03',
    });
    expect(reader.createdBy).toBe(f.first.id);
    await expect(
      f.service.create([{ ...companyASecurity, source }], {
        id: f.second.id,
        dotId: f.second.id,
      }),
    ).rejects.toThrow(/not shared with you/);
  });
});

describe('action item tools', () => {
  it('blocks changes from consulted Dots and only marks reminders in scheduled runs', async () => {
    for (const name of [
      'create_action_items',
      'update_action_item',
      'add_action_item_note',
      'review_action_items',
      'merge_entities',
    ])
      expect(consultationBlocked(name)).toBe(true);
    expect(consultationBlocked('search_action_items')).toBe(false);

    const { service, first, owner } = setup();
    await service.create(
      [{ ...companyASecurity, remindAt: '2020-01-01T00:00:00Z' }],
      owner,
    );
    const tools = (inWork: boolean) =>
      actionItemTools(service, {
        dotId: first.id,
        threadId: 'thread-1',
        timeZone: 'America/Chicago',
        inWork,
        check: () => undefined,
        signal: new AbortController().signal,
      });
    const review = (inWork: boolean) =>
      tools(inWork).find((tool) => tool.name === 'review_action_items')!
        .execute!({} as never) as Promise<{ reminders: unknown[] }>;
    expect((await review(false)).reminders).toHaveLength(1);
    expect((await review(false)).reminders).toHaveLength(1);
    expect((await review(true)).reminders).toHaveLength(1);
    expect((await review(true)).reminders).toHaveLength(0);

    const search = tools(false).find(
      (tool) => tool.name === 'search_action_items',
    )!;
    const found = (await search.execute!({
      entities: ['Company A'],
    } as never)) as {
      items: { owner: string; due: string | null }[];
    };
    expect(found.items[0]).toMatchObject({ assignee: 'you', due: null });
    const parameters = (search as unknown as { parameters: z.ZodType })
      .parameters;
    expect(parameters.safeParse({ limit: 50 }).success).toBe(true);
    expect(parameters.safeParse({ limit: 51 }).success).toBe(false);
  });
});

describe('action item API', () => {
  it('creates, searches, updates, notes, merges and deletes', async () => {
    const { service, store } = setup();
    const app = createApp({
      store,
      runner: new Runner(store, { mode: 'sample', baseUrl: '' }),
      config: { mode: 'sample', baseUrl: '' },
      actionItems: service,
    });
    const send = (path: string, method: string, body: unknown) =>
      app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const posted = await send('/api/action-items', 'POST', {
      ...companyAPricing,
      source: undefined,
      timezone: 'America/Chicago',
    });
    expect(posted.status).toBe(201);
    const { results } = (await posted.json()) as {
      results: { status: string; item: { id: string; dueAt: number } }[];
    };
    expect(results[0].item.dueAt).toBe(Date.parse('2026-10-17T04:59:00Z'));
    const id = results[0].item.id;
    expect(
      (await send('/api/action-items', 'POST', { items: [owedByPersonJ] }))
        .status,
    ).toBe(201);
    expect(
      (await send('/api/action-items', 'POST', { statement: 'x' })).status,
    ).toBe(400);

    const listed = (await (
      await app.request('/api/action-items?entity=Company%20A&q=pricing')
    ).json()) as { items: { id: string }[] };
    expect(listed.items.map((item) => item.id)).toEqual([id]);
    expect((await app.request('/api/action-items?status=bogus')).status).toBe(
      400,
    );
    expect((await app.request('/api/action-items?limit=200')).status).toBe(200);
    expect((await app.request('/api/action-items?limit=201')).status).toBe(400);

    expect(
      (await send(`/api/action-items/${id}`, 'PATCH', { status: 'done' }))
        .status,
    ).toBe(200);
    expect(
      (await send(`/api/action-items/${id}/notes`, 'POST', { note: 'Sent.' }))
        .status,
    ).toBe(201);
    const detail = (await (
      await app.request(`/api/action-items/${id}`)
    ).json()) as {
      status: string;
      events: { kind: string }[];
    };
    expect(detail.status).toBe('done');
    expect(detail.events.map((event) => event.kind)).toEqual([
      'created',
      'update',
      'note',
    ]);
    const done = (await (
      await app.request('/api/action-items?status=done')
    ).json()) as { items: unknown[] };
    expect(done.items).toHaveLength(1);

    const review = (await (
      await app.request('/api/action-items/review?timezone=America/Chicago')
    ).json()) as {
      owedToYouOverdue: { statement: string }[];
    };
    expect(review.owedToYouOverdue.map((item) => item.statement)).toEqual([
      owedByPersonJ.statement,
    ]);
    expect(
      (await app.request('/api/action-items/review?timezone=Mars/Base')).status,
    ).toBe(400);

    const entities = (await (
      await app.request('/api/entities?kind=organization')
    ).json()) as {
      id: string;
      name: string;
    }[];
    expect(entities.map((entity) => entity.name)).toEqual([
      'Company A',
      'Company F',
    ]);
    const merged = await send('/api/entities/merge', 'POST', {
      fromEntityId: entities[1].id,
      intoEntityId: entities[0].id,
    });
    expect(merged.status).toBe(200);
    expect(
      (
        await send('/api/entities/merge', 'POST', {
          fromEntityId: entities[1].id,
          intoEntityId: entities[0].id,
        })
      ).status,
    ).toBe(404);

    expect((await send(`/api/action-items/${id}`, 'DELETE', {})).status).toBe(
      200,
    );
    expect((await app.request(`/api/action-items/${id}`)).status).toBe(404);
    expect(
      (await send(`/api/action-items/${id}`, 'PATCH', { status: 'open' }))
        .status,
    ).toBe(404);
  });

  it("recognises the owner's names saved in settings", async () => {
    const { service, store, owner } = setup();
    const app = createApp({
      store,
      runner: new Runner(store, { mode: 'sample', baseUrl: '' }),
      config: { mode: 'sample', baseUrl: '' },
      actionItems: service,
    });
    await service.create(
      [
        {
          ...owedByPersonJ,
          entities: [{ name: 'Andre', kind: 'person', role: 'assignee' }],
        },
      ],
      owner,
    );
    const saved = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerNames: ['Andre Smart', 'Andre', 'Andre'] }),
    });
    expect(await saved.json()).toMatchObject({
      ownerNames: ['Andre Smart', 'Andre'],
    });
    const mine = (await (
      await app.request('/api/action-items?assignee=me')
    ).json()) as { items: { entities: unknown[] }[] };
    expect(mine.items).toEqual([expect.objectContaining({ entities: [] })]);
  });
});
