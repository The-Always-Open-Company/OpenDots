import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import { api } from '../src/client/api';
import {
  ActionItemList,
  ActionItems,
  actionItemQuery,
  EMPTY_FILTERS,
} from '../src/client/ActionItems';
import type { WorkspaceState } from '../src/shared/types';
import { actionItem } from './fixtures/action-item';

beforeEach(() => {
  vi.mocked(api).mockReset();
});

const now = new Date(2026, 9, 14, 12, 0).getTime();
const workspace = (actionItems: boolean) =>
  ({ setup: { actionItems }, dots: [] }) as unknown as WorkspaceState;
const noop = () => {};

it('explains the setup instead of loading when action items are unavailable', () => {
  const html = renderToStaticMarkup(
    <ActionItems
      workspace={workspace(false)}
      onOpenDocument={noop}
      onOpenPage={noop}
      onOpenThread={noop}
    />,
  );
  expect(html).toContain('Set DATABASE_URL');
  expect(html).not.toContain('Loading');
  expect(api).not.toHaveBeenCalled();
});

it('renders urgency groups with owners, due dates, entity and label chips', () => {
  const html = renderToStaticMarkup(
    <ActionItemList
      items={[
        actionItem({
          statement: 'Send Company A the revised pricing',
          dueAt: new Date(2026, 9, 13, 23, 59).getTime(),
          priority: 'urgent',
          labels: ['renewal'],
          entities: [
            { id: 'a', kind: 'organization', name: 'Company A', role: 'about' },
          ],
        }),
        actionItem({
          statement: 'Share the security questionnaire',
          entities: [
            { id: 'j', kind: 'person', name: 'Person J', role: 'assignee' },
          ],
        }),
      ]}
      now={now}
      grouped
      onSelect={noop}
      onEntity={noop}
      onLabel={noop}
    />,
  );
  expect(html).toContain('aria-label="Overdue"');
  expect(html).toContain('aria-label="Owed to you"');
  expect(html).toContain('1 day overdue');
  expect(html).toContain('Urgent');
  expect(html).toContain('Company A');
  expect(html).toContain('#renewal');
  expect(html).toContain('Person J owes you');
  expect(html).not.toContain('Best matches');
});

it('lists search results in ranked order without groups', () => {
  const html = renderToStaticMarkup(
    <ActionItemList
      items={[
        actionItem({ statement: 'First' }),
        actionItem({ statement: 'Second' }),
      ]}
      now={now}
      grouped={false}
      onSelect={noop}
      onEntity={noop}
      onLabel={noop}
    />,
  );
  expect(html).toContain('Best matches');
  expect(html.indexOf('First')).toBeLessThan(html.indexOf('Second'));
  expect(html).not.toContain('No due date');
});

it('builds the list query from filters', () => {
  const query = new URLSearchParams(
    actionItemQuery(
      {
        ...EMPTY_FILTERS,
        query: ' security ',
        entities: ['Company A', 'Person J'],
        assignee: 'owed',
        showCompleted: true,
        dueBefore: '2026-10-31',
      },
      'America/Chicago',
    ),
  );
  expect(query.get('q')).toBe('security');
  expect(query.getAll('entity')).toEqual(['Company A', 'Person J']);
  expect(query.get('assignee')).toBe('owed');
  expect(query.get('status')).toBe('open,waiting,done,dropped');
  expect(query.get('dueBefore')).toBe('2026-10-31');
  expect(query.get('limit')).toBe('200');
  expect(query.get('timezone')).toBe('America/Chicago');
  const defaults = new URLSearchParams(actionItemQuery(EMPTY_FILTERS, 'UTC'));
  expect(defaults.has('status')).toBe(false);
  expect(
    new URLSearchParams(
      actionItemQuery(
        { ...EMPTY_FILTERS, status: 'done', showCompleted: true },
        'UTC',
      ),
    ).get('status'),
  ).toBe('done');
});
