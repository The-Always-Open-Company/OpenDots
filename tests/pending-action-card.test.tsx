import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  actionFields,
  actionTitle,
  PendingActionCard,
} from '../src/client/PendingActionCard';
import type { PendingAction } from '../src/shared/types';

const plugins = [
  { id: 'zoho', name: 'Zoho' },
  { id: 'linear', name: 'Linear' },
];

function pending(toolName: string, args: unknown): PendingAction {
  return {
    id: 'action',
    toolName,
    status: 'pending',
    argumentsJson: JSON.stringify(args),
    workItemId: null,
    createdAt: 0,
  };
}

it('shows a plugin approval as a readable title and labelled fields', () => {
  const html = renderToStaticMarkup(
    <PendingActionCard
      action={pending('plugin_zoho_ZohoCliq_send_message_to_chat', {
        body: { text: 'Hi Nadia,\nCan we meet Monday?' },
        path_variables: { CHAT_ID: 'CT_123' },
      })}
      plugins={plugins}
    />,
  );
  expect(html).toContain('Waiting for you · Zoho Cliq');
  expect(html).toContain('<h2>Send message to chat</h2>');
  expect(html).toContain(
    '<dt>Text</dt><dd>Hi Nadia,\nCan we meet Monday?</dd>',
  );
  expect(html).toContain('<summary>Technical details</summary>');
  expect(html).toContain('<dt>Chat ID</dt><dd>CT_123</dd>');
  expect(html).not.toContain('plugin_zoho');
  expect(html).not.toContain('path_variables');
  expect(html).not.toContain('{&quot;');
});

it('names the plugin when the tool has no product prefix', () => {
  expect(actionTitle('plugin_linear_save_issue', plugins)).toEqual({
    title: 'Save issue',
    source: 'Linear',
  });
  expect(actionTitle('plugin_acme_Calendar_list_events', [])).toEqual({
    title: 'List events',
    source: 'Acme · Calendar',
  });
  expect(actionTitle('arm_trigger')).toEqual({ title: 'Start a schedule' });
  expect(actionTitle('update_action_item')).toEqual({
    title: 'Update action item',
  });
});

it('flattens nested arguments and formats values for people', () => {
  const fields = actionFields(
    JSON.stringify({
      workItemId: 'w1',
      spec: { kind: 'interval', seconds: 3600 },
      dotCanManage: false,
      labels: ['EMIS', 'Urgent'],
      items: [{ statement: 'Call John' }, { statement: 'Email Nadia' }],
      empty: '',
      team: 'c46112c5-355a-4461-93cc-4e7b9d306f9b',
    }),
  );
  expect(fields).toEqual([
    { label: 'Work item ID', value: 'w1', technical: true },
    { label: 'Spec · Kind', value: 'interval', technical: false },
    { label: 'Spec · Seconds', value: '3600', technical: false },
    { label: 'Dot can manage', value: 'No', technical: false },
    { label: 'Labels', value: 'EMIS, Urgent', technical: false },
    { label: 'Items 1 · Statement', value: 'Call John', technical: false },
    { label: 'Items 2 · Statement', value: 'Email Nadia', technical: false },
    {
      label: 'Team',
      value: 'c46112c5-355a-4461-93cc-4e7b9d306f9b',
      technical: true,
    },
  ]);
  expect(actionFields('not json')).toEqual([
    { label: 'Details', value: 'not json', technical: false },
  ]);
});

it('labels a schedule card for the owner and tucks away its internals', () => {
  const fields = actionFields(
    JSON.stringify({
      title: 'Morning follow-ups',
      runs: 'at 08:00 on Mon, Tue, Wed, Thu, Fri (America/Jamaica)',
      instructions: 'Message each owner about open items.',
      allowTools: ['plugin_zoho_ZohoCliq_send_message_to_chat'],
      spec: { kind: 'calendar', minuteOfDay: 480 },
      dotCanManage: true,
    }),
    'arm_trigger',
  );
  expect(fields.filter((field) => !field.technical)).toEqual([
    { label: 'Title', value: 'Morning follow-ups', technical: false },
    {
      label: 'Runs',
      value: 'at 08:00 on Mon, Tue, Wed, Thu, Fri (America/Jamaica)',
      technical: false,
    },
    {
      label: 'Instructions',
      value: 'Message each owner about open items.',
      technical: false,
    },
    {
      label: 'May use without asking',
      value: 'Send message to chat (Zoho Cliq)',
      technical: false,
    },
  ]);
});

it('keeps an answered request as history, with how it was answered and no buttons', () => {
  const sent = { ...pending('plugin_zoho_ZohoCliq_send', { text: 'Hi' }) };
  const card = (patch: Partial<PendingAction>) =>
    renderToStaticMarkup(
      <PendingActionCard action={{ ...sent, ...patch }} plugins={plugins} />,
    );
  const waiting = card({});
  expect(waiting).toContain('Waiting for you');
  expect(waiting).toContain('Approve');
  const done = card({ status: 'executed' });
  expect(done).toContain('Approved · done');
  expect(done).not.toContain('<button');
  expect(done).toContain('answered');
  expect(card({ status: 'declined' })).toContain('Declined');
  expect(
    card({
      status: 'failed',
      resultJson: JSON.stringify({ error: 'Chat not found.' }),
    }),
  ).toContain('Approved · failed: Chat not found.');
  expect(
    card({ status: 'approved', notBefore: Date.now() + 3_600_000 }),
  ).toMatch(/Approved · runs at/);
  expect(card({ status: 'uncertain' })).toContain('outcome unknown');
});
