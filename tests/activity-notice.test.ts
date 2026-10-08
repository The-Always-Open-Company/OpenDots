import { expect, it } from 'vitest';
import {
  attemptHeadline,
  takeNewFinishes,
} from '../src/client/activity-notice';
import type { WorkView } from '../src/shared/types';

function view(
  execution: { id: string; status: string },
  source = 'schedule',
  kind = 'schedule',
): WorkView {
  return {
    workItem: {
      id: 'work',
      actorId: 'dot',
      title: 'Hello reminder',
      objective: 'Say hello',
      status: 'open',
      source,
      updatedAt: 1,
      workThreadId: 'thread',
    },
    executions: [{ ...execution, attempt: 1, error: null }],
    events: [],
    actions: [],
    children: [],
    triggers: [{ id: 'trigger', kind, enabled: 1, nextRunAt: 1 }],
  };
}

it('notices a new finished attempt once and skips runs still in progress', () => {
  const first = takeNewFinishes(null, [
    view({ id: 'old', status: 'completed' }),
    view({ id: 'queued', status: 'queued' }),
  ]);
  expect(first.fresh).toEqual([]);
  const next = takeNewFinishes(first.seen, [
    view({ id: 'old', status: 'completed' }),
    view({ id: 'done', status: 'failed' }),
    view({ id: 'cancelled', status: 'cancelled' }),
  ]);
  expect(next.fresh.map((item) => item.id)).toEqual(['done']);
  expect(
    takeNewFinishes(next.seen, [view({ id: 'done', status: 'failed' })]).fresh,
  ).toEqual([]);
  expect(attemptHeadline(next.fresh[0])).toEqual({
    title: 'Schedule ran',
    body: 'Hello reminder · failed',
  });
  expect(
    attemptHeadline({
      ...next.fresh[0],
      status: 'completed',
      source: 'responsibility',
      kinds: ['wake'],
    }).title,
  ).toBe('Woke up');
});
