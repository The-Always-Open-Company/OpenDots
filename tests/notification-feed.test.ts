import { expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import {
  takeNewNotifications,
  watchedThread,
} from '../src/client/notification-feed';
import { accessFor, dotCanRead } from '../src/client/send-to-dot';
import type { AppNotification } from '../src/shared/types';

const note = (id: string, threadId: string | null = null): AppNotification => ({
  id,
  kind: 'reply',
  dotId: 'dot',
  title: id,
  body: '',
  threadId,
  workItemId: null,
  createdAt: 1,
  readAt: null,
});

it('watches the open conversation only while the tab is visible', () => {
  expect(
    watchedThread({ view: 'chat', selectedThread: 't', pageVisible: true }),
  ).toBe('t');
  expect(
    watchedThread({ view: 'chat', selectedThread: 't', pageVisible: false }),
  ).toBeUndefined();
  expect(
    watchedThread({ view: 'tasks', selectedThread: 't', pageVisible: true }),
  ).toBeUndefined();
});

it('seeds on first load, then toasts new notifications oldest first', () => {
  const first = takeNewNotifications(null, [note('old')]);
  expect(first.fresh).toEqual([]);
  const next = takeNewNotifications(first.seen, [
    note('newer'),
    note('new'),
    note('old'),
  ]);
  expect(next.fresh.map((item) => item.id)).toEqual(['new', 'newer']);
  expect(
    takeNewNotifications(next.seen, [note('newer'), note('new')]).fresh,
  ).toEqual([]);
});

it('marks notifications for the conversation being watched read without a toast', () => {
  const first = takeNewNotifications(null, []);
  const result = takeNewNotifications(
    first.seen,
    [note('here', 'open'), note('elsewhere', 'other')],
    'open',
  );
  expect(result.silent.map((item) => item.id)).toEqual(['here']);
  expect(result.fresh.map((item) => item.id)).toEqual(['elsewhere']);
});

it('widens upload access just enough for the Dot it is sent to', () => {
  const dots = [
    { id: 'a', spaceIds: ['s1'] },
    { id: 'b', spaceIds: ['s2'] },
  ];
  const none = { mode: 'none' as const, dotIds: [], spaceIds: ['s1'] };
  expect(dotCanRead(dots[0], none)).toBe(true);
  expect(dotCanRead(dots[1], none)).toBe(false);
  expect(accessFor('a', dots, none)).toBe(none);
  expect(accessFor('b', dots, none)).toEqual({
    mode: 'dots',
    dotIds: ['b'],
    spaceIds: ['s1'],
  });
  expect(
    accessFor('b', dots, { mode: 'dots', dotIds: ['a'], spaceIds: [] }),
  ).toEqual({ mode: 'dots', dotIds: ['a', 'b'], spaceIds: [] });
  const all = { mode: 'all' as const, dotIds: [], spaceIds: [] };
  expect(accessFor('b', dots, all)).toBe(all);
  expect(accessFor(undefined, dots, none)).toBe(none);
});
