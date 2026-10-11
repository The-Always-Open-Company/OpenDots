import { describe, expect, it } from 'vitest';
import type { ActionItemEntity } from '../src/shared/types';
import { actionItem } from './fixtures/action-item';
import {
  dateInputValue,
  dueText,
  dueTone,
  groupActionItems,
  ownerLabel,
} from '../src/client/action-item-groups';

// Local noon, so day arithmetic holds in any timezone.
const now = new Date(2026, 9, 14, 12, 0).getTime();
const at = (days: number, hour = 23, minute = 59) =>
  new Date(2026, 9, 14 + days, hour, minute).getTime();

const personJ: ActionItemEntity = {
  id: 'j',
  kind: 'person',
  name: 'Person J',
  role: 'owner',
};

describe('groupActionItems', () => {
  it('sorts items into urgency sections in display order', () => {
    const items = [
      actionItem({ statement: 'later', dueAt: at(10) }),
      actionItem({ statement: 'no date' }),
      actionItem({ statement: 'today', dueAt: at(0) }),
      actionItem({ statement: 'yesterday', dueAt: at(-1) }),
      actionItem({ statement: 'waiting', status: 'waiting', dueAt: at(-3) }),
      actionItem({ statement: 'owed', entities: [personJ], dueAt: at(-2) }),
      actionItem({ statement: 'done', status: 'done' }),
      actionItem({ statement: 'dropped', status: 'dropped' }),
    ];
    expect(
      groupActionItems(items, now).map((group) => [
        group.label,
        group.items.map((item) => item.statement),
      ]),
    ).toEqual([
      ['Overdue', ['yesterday']],
      ['Due soon', ['today']],
      ['Upcoming', ['later']],
      ['No due date', ['no date']],
      ['Waiting', ['waiting']],
      ['Owed to you', ['owed']],
      ['Done and dropped', ['done', 'dropped']],
    ]);
  });

  it('counts an item due earlier today as overdue, and keeps server order', () => {
    const groups = groupActionItems(
      [
        actionItem({ statement: 'b', dueAt: at(0, 9, 0) }),
        actionItem({ statement: 'a', dueAt: at(-5) }),
      ],
      now,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((item) => item.statement)).toEqual(['b', 'a']);
  });

  it('treats requesters and topics as context, not owners', () => {
    const item = actionItem({
      entities: [
        { id: 'a', kind: 'organization', name: 'Company A', role: 'about' },
        { id: 'k', kind: 'person', name: 'Person K', role: 'requester' },
      ],
    });
    expect(groupActionItems([item], now)[0].key).toBe('noDate');
    expect(ownerLabel(item)).toBe('You');
    expect(ownerLabel(actionItem({ entities: [personJ] }))).toBe('Person J');
  });
});

describe('due labels', () => {
  it('describes due dates relative to today', () => {
    expect(dueText(null, now)).toBe('');
    expect(dueText(at(0), now)).toBe('Due today');
    expect(dueText(at(1), now)).toBe('Due tomorrow');
    expect(dueText(at(4), now)).toBe('Due in 4 days');
    expect(dueText(at(0, 9, 0), now)).toBe('Overdue');
    expect(dueText(at(-1), now)).toBe('1 day overdue');
    expect(dueText(at(-3), now)).toBe('3 days overdue');
    expect(dueText(at(20), now)).toMatch(/^Due /);
    expect(dueText(at(20), now)).not.toMatch(/2026/);
    expect(dueText(at(400), now)).toMatch(/2027/);
  });

  it('colours overdue and due-soon items', () => {
    expect(dueTone(at(-1), now)).toBe('overdue');
    expect(dueTone(at(2), now)).toBe('soon');
    expect(dueTone(at(5), now)).toBe('');
    expect(dueTone(null, now)).toBe('');
  });

  it('fills date inputs with the local day', () => {
    expect(dateInputValue(at(0))).toBe('2026-10-14');
    expect(dateInputValue(at(18, 0, 30))).toBe('2026-11-01');
    expect(dateInputValue(null)).toBe('');
  });
});
