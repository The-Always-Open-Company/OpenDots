import { afterEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import { handoffRoutes } from '../src/server/handoff-routes.js';
import { HandoffService } from '../src/server/handoffs.js';
import { notificationRoutes } from '../src/server/notification-routes.js';
import { NotificationService } from '../src/server/notifications.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const open: { close(): void }[] = [];
afterEach(() => open.splice(0).forEach((db) => db.close()));

function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  open.push(store, workspace);
  const engine = new ExecutionEngine(store.database);
  const notifications = new NotificationService(store.database);
  const handoffs = new HandoffService(
    store.database,
    engine,
    workspace,
    notifications,
  );
  const dot = workspace.dots()[0];
  const document = (access: { allDots?: boolean; dotIds?: string[] } = {}) =>
    workspace.documents.create({
      title: 'Board notes',
      fileName: 'board.md',
      mimeType: 'text/markdown',
      extension: 'md',
      size: 10,
      sha256: crypto.randomUUID(),
      allDots: access.allDots ?? true,
      dotIds: access.dotIds ?? [],
      spaceIds: [],
      uploadedBy: 'owner',
    });
  const finish = () => {
    const claim = workspace.documents.claim()!;
    workspace.documents.finish(claim, {
      pageCount: 1,
      convertedChars: 10,
      chunkCount: 1,
      indexFormat: 1,
      profile: { summary: null, tags: [], entities: [], note: null },
    });
  };
  return {
    store,
    workspace,
    engine,
    notifications,
    handoffs,
    dot,
    document,
    finish,
  };
}

it('starts a page right away as a background objective', () => {
  const f = fixture();
  const page = f.workspace.pages.create(f.dot.spaceId, {
    title: 'Leadership sync',
    content: '# Notes',
  });
  const result = f.handoffs.create({
    dotId: f.dot.id,
    target: { kind: 'page', spaceId: f.dot.spaceId, pageId: page.id },
    note: 'Focus on budget items.',
  });
  expect(result.status).toBe('started');
  const item = f.engine.workItem(
    (result as { workItemId: string }).workItemId,
  )!;
  expect(item).toMatchObject({
    actorId: f.dot.id,
    title: 'Read Leadership sync',
    source: 'owner',
    autoResume: 1,
  });
  expect(String(item.objective)).toContain(
    `read_space_page (id ${page.id}, spaceId ${f.dot.spaceId})`,
  );
  expect(String(item.objective)).toContain('create_action_items');
  expect(String(item.objective)).toContain(
    'The owner added: Focus on budget items.',
  );
  expect(f.engine.claimExecution()?.workItemId).toBe(item.id);
});

it('waits for a document to finish indexing, then starts', () => {
  const f = fixture();
  const document = f.document();
  const result = f.handoffs.create({
    dotId: f.dot.id,
    target: { kind: 'document', documentId: document.id },
  });
  expect(result.status).toBe('waiting');
  expect(f.engine.listWork()).toEqual([]);
  f.handoffs.sweep(document.id);
  expect(f.engine.listWork()).toEqual([]);
  f.finish();
  f.handoffs.sweep(document.id);
  const work = f.engine.listWork();
  expect(work).toHaveLength(1);
  expect(String(work[0]?.workItem.objective)).toContain(
    `read_document (id ${document.id})`,
  );
  expect(f.handoffs.waiting()).toEqual([]);
  expect(
    f.handoffs.create({
      dotId: f.dot.id,
      target: { kind: 'document', documentId: document.id },
    }).status,
  ).toBe('started');
});

it('tells the owner when a waiting document could not be indexed', () => {
  const f = fixture();
  const document = f.document();
  f.handoffs.create({
    dotId: f.dot.id,
    target: { kind: 'document', documentId: document.id },
  });
  const claim = f.workspace.documents.claim()!;
  f.workspace.documents.fail(claim, 'Conversion failed.');
  f.handoffs.sweep(document.id);
  expect(f.engine.listWork()).toEqual([]);
  expect(f.notifications.list({ unread: true })).toEqual([
    expect.objectContaining({
      kind: 'handoff_failed',
      title: '"Board notes" could not be read',
      body: expect.stringContaining('Conversion failed.'),
    }),
  ]);
  expect(f.handoffs.waiting()).toEqual([]);
  expect(() =>
    f.handoffs.create({
      dotId: f.dot.id,
      target: { kind: 'document', documentId: document.id },
    }),
  ).toThrow(/Reprocess/);
});

it('serves handoffs and notifications over the API', async () => {
  const f = fixture();
  const app = new Hono();
  handoffRoutes(app, f.handoffs);
  notificationRoutes(app, f.notifications);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await post('/api/handoffs', { dotId: f.dot.id })).status).toBe(400);
  const missing = await post('/api/handoffs', {
    dotId: f.dot.id,
    target: { kind: 'document', documentId: 'nope' },
  });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: 'Document not found.' });
  const document = f.document();
  const waiting = await post('/api/handoffs', {
    dotId: f.dot.id,
    target: { kind: 'document', documentId: document.id },
    note: 'Budget first.',
  });
  expect(waiting.status).toBe(201);
  expect(await waiting.json()).toMatchObject({ status: 'waiting' });
  const published = f.notifications.publish({ kind: 'reply', title: 'Hi' });
  const unread = await app.request('/api/notifications?unread=1');
  expect(await unread.json()).toEqual([
    expect.objectContaining({ id: published.id }),
  ]);
  expect(
    await (await post(`/api/notifications/${published.id}/read`, {})).json(),
  ).toEqual({ updated: true });
  f.notifications.publish({ kind: 'reply', title: 'Again' });
  expect(await (await post('/api/notifications/read-all', {})).json()).toEqual({
    updated: 1,
  });
});

it('refuses a Dot that cannot read the document or use the Space', () => {
  const f = fixture();
  const document = f.document({ allDots: false });
  expect(() =>
    f.handoffs.create({
      dotId: f.dot.id,
      target: { kind: 'document', documentId: document.id },
    }),
  ).toThrow(/cannot read this document/);
  expect(() =>
    f.handoffs.create({
      dotId: f.dot.id,
      target: { kind: 'page', spaceId: 'elsewhere', pageId: 'page' },
    }),
  ).toThrow(/cannot use this Space/);
  expect(() =>
    f.handoffs.create({
      dotId: 'missing',
      target: { kind: 'document', documentId: document.id },
    }),
  ).toThrow(/Dot not found/);
});
