import type { ActionItem } from '../../src/shared/types';

let next = 0;
export function actionItem(patch: Partial<ActionItem> = {}): ActionItem {
  next += 1;
  return {
    id: `item-${next}`,
    statement: `Item ${next}`,
    details: '',
    context: 'From the weekly sync',
    status: 'open',
    priority: 'normal',
    dueAt: null,
    remindAt: null,
    labels: [],
    createdBy: 'dot',
    source: {
      kind: 'conversation',
      id: null,
      ref: null,
      title: null,
      excerpt: 'We agreed.',
      date: null,
      threadId: null,
    },
    entities: [],
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...patch,
  };
}
