import { expect, it, vi } from 'vitest';
import type { Message } from '@ag-ui/core';
import { WorkspaceStore } from '../src/server/workspace.js';
import { PageService } from '../src/server/page-service.js';
import { pageAccess } from '../src/server/page-tools.js';

function seed(ws: WorkspaceStore, threadId: string, messages: Message[]) {
  ws.threads.appendRun(
    {
      runId: crypto.randomUUID(),
      threadId,
      agentId: ws.dots()[0].id,
      parentRunId: null,
      events: [],
      createdAt: Date.now(),
    },
    messages,
    new Set(),
  );
}

it('reuses one conversation per page and Dot under concurrent requests', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.dots()[0];
  const page = ws.pages.create(dot.spaceId, { title: 'Design' });
  const service = new PageService(ws);
  const [a, b] = await Promise.all([
    service.conversation(dot.spaceId, page.id, dot.id),
    service.conversation(dot.spaceId, page.id, dot.id),
  ]);
  expect(a.id).toBe(b.id);
  expect(a.title).toBe('Design');
  expect((await service.conversation(dot.spaceId, page.id, dot.id)).id).toBe(
    a.id,
  );
  expect(ws.pages.forThread(a.id, dot.spaceId)?.id).toBe(page.id);
  expect(
    ws.conversations().filter((thread) => thread.id === a.id),
  ).toHaveLength(1);
  ws.close();
});
it('exports canonical user/assistant text and rejects empty or oversized history without creating a page', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.dots()[0];
  ws.bindThread('thread', dot.id, 'Thread');
  const service = new PageService(ws);
  await expect(
    service.saveConversation('thread', 'Empty', null),
  ).rejects.toThrow(/no persisted text/);
  seed(ws, 'thread', [
    {
      id: 'u',
      role: 'user',
      content: [{ type: 'text', text: 'Question' }],
    } as Message,
    { id: 'a', role: 'assistant', content: 'Answer' },
    { id: 't', role: 'tool', toolCallId: 'x', content: 'Secret tool response' },
  ]);
  const page = await service.saveConversation('thread', 'Saved', null);
  expect(page.content).toBe('## You\n\nQuestion\n\n## Dot\n\nAnswer');
  expect(page.sourceThreadId).toBe('thread');
  ws.bindThread('long', dot.id, 'Long');
  seed(ws, 'long', [
    { id: 'big', role: 'assistant', content: 'x'.repeat(100001) },
  ]);
  await expect(
    service.saveConversation('long', 'Too long', null),
  ).rejects.toThrow(/exceeds/);
  expect(ws.pages.list(dot.spaceId)).toHaveLength(1);
  ws.close();
});
it('scopes agent tools to the Dot Space and re-reads current context with CAS and pause enforcement', () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.dots()[0];
  const other = ws.createSpace('Other', '');
  const foreign = ws.pages.create(other.id, { title: 'Private' });
  const page = ws.pages.create(dot.spaceId, { title: 'Here' });
  ws.bindThread('thread', dot.id, 'Page');
  ws.pages.reserveThread(page.id, dot.id, 'thread');
  ws.pages.finishThread(page.id, dot.id);
  let paused = false;
  const access = pageAccess(ws, dot.spaceId, 'thread', () => {
    if (paused) throw new Error('Paused');
  });
  expect(() => access.read(foreign.id)).toThrow();
  access.edit(page.id, { expectedRevision: 1, content: 'Fresh' });
  expect(access.context()?.content).toBe('Fresh');
  expect(() =>
    access.edit(page.id, { expectedRevision: 1, content: 'Stale' }),
  ).toThrow();
  paused = true;
  expect(() => access.create({ title: 'No write' })).toThrow('Paused');
  expect(ws.pages.list(dot.spaceId)).toHaveLength(1);
  ws.close();
});
it('recovers the same reserved thread after a restart lease', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.dots()[0];
  const page = ws.pages.create(dot.spaceId, { title: 'Recover' });
  ws.pages.reserveThread(page.id, dot.id, 'stable-thread');
  const service = new PageService(ws);
  await expect(
    service.conversation(dot.spaceId, page.id, dot.id),
  ).rejects.toThrow(/being created/);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
  const result = await service.conversation(dot.spaceId, page.id, dot.id);
  expect(result.id).toBe('stable-thread');
  expect(ws.requireThread('stable-thread', dot.id).title).toBe('Recover');
  vi.restoreAllMocks();
  ws.close();
});
it('rejects a specialist in another Space before checking setup', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.dots()[0];
  const space = ws.createSpace('Other', '');
  const page = ws.pages.create(space.id, { title: 'Other' });
  const ready = vi.fn();
  const service = new PageService(ws, ready);
  await expect(service.conversation(space.id, page.id, dot.id)).rejects.toThrow(
    /specialist in this Space/,
  );
  expect(ready).not.toHaveBeenCalled();
  ws.close();
});
it('releases the reservation when setup is incomplete so a later attempt succeeds', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.dots()[0];
  const page = ws.pages.create(dot.spaceId, { title: 'Retry' });
  let configured = false;
  const service = new PageService(ws, () => {
    if (!configured) throw new Error('Setup required: OPENAI_API_KEY.');
  });
  await expect(
    service.conversation(dot.spaceId, page.id, dot.id),
  ).rejects.toThrow(/Setup required/);
  expect(ws.pages.thread(page.id, dot.id)).toBeUndefined();
  configured = true;
  const thread = await service.conversation(dot.spaceId, page.id, dot.id);
  expect(ws.pages.thread(page.id, dot.id)?.threadId).toBe(thread.id);
  ws.close();
});

it('grants multiple Spaces without changing thread identity and enforces revocation on existing tools', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.dots()[0];
  const other = ws.createSpace('Launch', '');
  const page = ws.pages.create(other.id, { title: 'Brief' });
  ws.updateDot(dot.id, { ...dot, spaceIds: [dot.spaceId, other.id] });
  const service = new PageService(ws);
  const thread = await service.conversation(other.id, page.id, dot.id);
  seed(ws, thread.id, [{ id: 'a', role: 'assistant', content: 'Saved text' }]);
  const access = pageAccess(ws, dot.spaceId, thread.id, () => {});
  expect(access.context()?.id).toBe(page.id);
  expect(access.read(page.id).title).toBe('Brief');
  expect(access.spaces()).toHaveLength(2);
  expect(
    (await service.saveConversation(thread.id, 'Copy', null)).spaceId,
  ).toBe(other.id);
  ws.updateDot(dot.id, { ...dot, spaceIds: [dot.spaceId] });
  expect(() => access.read(page.id, other.id)).toThrow(/access/);
  expect(() =>
    access.edit(page.id, { expectedRevision: 1, content: 'No' }, other.id),
  ).toThrow(/access/);
  await expect(
    service.conversation(other.id, page.id, dot.id),
  ).rejects.toThrow();
  await expect(service.saveConversation(thread.id, 'No', null)).rejects.toThrow(
    /revoked/,
  );
  ws.updateDot(dot.id, { ...dot, spaceIds: [dot.spaceId, other.id] });
  expect((await service.conversation(other.id, page.id, dot.id)).id).toBe(
    thread.id,
  );
  ws.close();
});
