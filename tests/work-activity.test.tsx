import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkActivity } from '../src/client/WorkActivity';
import type { WorkView } from '../src/shared/types';

const view = (stalled: boolean, status: string): WorkView => ({
  stalled,
  workItem: {
    id: '1',
    actorId: 'dot',
    title: 'Zoho check',
    objective: 'Validate the account',
    status,
    source: 'owner',
    updatedAt: 1,
    originThreadId: 'chat',
    workThreadId: null,
  },
  executions: [],
  events: [],
  actions: [],
  children: [],
  triggers: [],
});

function html(item: WorkView) {
  return renderToStaticMarkup(
    <WorkActivity
      work={[item]}
      actions={[]}
      busy={false}
      onOpen={() => undefined}
      onAction={() => undefined}
      onApprove={() => undefined}
      onDecline={() => undefined}
      onDisableTrigger={() => undefined}
      onCreate={async () => undefined}
    />,
  );
}

it('offers retry for a stalled objective and for one that failed', () => {
  const stalled = html(view(true, 'open'));
  expect(stalled).toContain('stalled');
  expect(stalled).toContain('Retry objective');
  expect(stalled).toContain('Zoho check');
  const failed = html(view(false, 'failed'));
  expect(failed).toContain('failed');
  expect(failed).toContain('Retry objective');
  const running = html(view(false, 'open'));
  expect(running).not.toContain('Retry objective');
  expect(running).toContain('Pause objective');
});
