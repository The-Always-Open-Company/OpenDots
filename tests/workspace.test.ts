import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
it('persists spaces, specialist permissions, and canonical thread ownership', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const space = store.createSpace('Design', 'Design decisions');
  const dot = store.createDot(space.id, 'Scout', 'Be concise', false, true);
  store.bindThread('thread-1', dot.id, 'Design research');
  expect(store.requireThread('thread-1', dot.id).ownerId).toBe('owner');
  expect(() => store.requireThread('thread-1', 'another-dot')).toThrow();
  expect(() => store.requireThread('unknown')).toThrow();
  expect(store.dot(dot.id)?.researchAllowed).toBe(false);
  store.close();
});
it('rejects a dot in a nonexistent space and does not rebind an existing thread', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  expect(() => store.createDot('missing', 'Dot', 'Help', true, true)).toThrow();
  const dots = store.dots();
  store.bindThread('one', dots[0].id, 'First');
  expect(() => store.bindThread('one', dots[0].id, 'Second')).toThrow();
  store.close();
});

it('migrates legacy Space ownership once and never restores revoked access on restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-access-'));
  const path = join(dir, 'workspace.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      INSERT INTO spaces VALUES ('old', 'Original', '', 1), ('new', 'New', '', 2);
      INSERT INTO dots VALUES ('dot', 'old', 'Dot', 'Help', 1, 1, 1);`);
    legacy.close();
    const ws = new WorkspaceStore(path, 'owner');
    const dot = ws.dot('dot')!;
    expect(dot.spaceIds).toEqual(['old']);
    expect(ws.canAccessSpace('dot', 'new')).toBe(false);
    expect(() =>
      ws.updateDot('dot', { ...dot, spaceIds: ['missing'] }),
    ).toThrow();
    expect(ws.dot('dot')?.spaceIds).toEqual(['old']);
    ws.bindThread('existing-thread', 'dot', 'Keep me');
    ws.updateDot('dot', { ...dot, spaceId: 'new', spaceIds: ['new'] });
    ws.close();
    const reopened = new WorkspaceStore(path, 'owner');
    expect(reopened.dot('dot')?.spaceIds).toEqual(['new']);
    expect(reopened.canAccessSpace('dot', 'old')).toBe(false);
    expect(reopened.requireThread('existing-thread').dotId).toBe('dot');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('deletes a chat and leaves pages and the other chat', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const dot = store.dots()[0];
  store.bindThread('chat-a', dot.id, 'Keep me');
  store.bindThread('chat-b', dot.id, 'Remove me');
  store.threads.appendRun(
    {
      runId: 'run',
      threadId: 'chat-b',
      agentId: dot.id,
      parentRunId: null,
      events: [],
      createdAt: 1,
    },
    [{ id: 'message', role: 'user', content: 'Hello' }],
    new Set(),
  );
  store.createCall('chat-b');
  store.saveCapture('chat-b', { note: 'draft' });
  const page = store.pages.create(dot.spaceId, {
    title: 'Kept page',
    content: '',
  });
  store.pages.reserveThread(page.id, dot.id, 'chat-b');
  store.deleteConversation('chat-b');
  expect(store.conversations().map((item) => item.id)).toEqual(['chat-a']);
  expect(store.threads.messages('chat-b')).toEqual([]);
  expect(store.pages.list(dot.spaceId).map((item) => item.title)).toEqual([
    'Kept page',
  ]);
  expect(store.pages.thread(page.id, dot.id)).toBeUndefined();
  expect(() => store.deleteConversation('chat-b')).toThrow(
    /Conversation not found/,
  );
  store.bindThread('consult', dot.id, 'Ask', 'consultation');
  expect(() => store.deleteConversation('consult')).toThrow(
    /Only a chat can be deleted/,
  );
  store.close();
});

it('detaches a schedule from a deleted chat without cancelling it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opendots-delete-chat-'));
  const file = join(directory, 'workspace.sqlite');
  const sqlite = new Store(file);
  const store = new WorkspaceStore(file, 'owner');
  const engine = new ExecutionEngine(sqlite.database);
  try {
    const dot = store.dots()[0];
    store.bindThread('chat', dot.id, 'Scheduled');
    const item = engine.createWorkItem({
      actorId: dot.id,
      title: 'Hello',
      objective: 'Say hello',
      source: 'schedule',
      recurring: true,
      originThreadId: 'chat',
      workThreadId: 'chat',
    });
    store.deleteConversation('chat');
    expect(engine.workItem(String(item.id))?.workThreadId).toBeNull();
    expect(engine.workItem(String(item.id))?.status).toBe('open');
    expect(engine.workItem(String(item.id))?.originThreadId).toBe('chat');
  } finally {
    sqlite.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
