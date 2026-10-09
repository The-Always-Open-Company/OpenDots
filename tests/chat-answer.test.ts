import { expect, it } from 'vitest';
import type { Message } from '@ag-ui/core';
import { endedWithoutAnswer } from '../src/client/chat-answer.js';
import { toolActivityLabel } from '../src/client/ToolActivity.js';

const call = (id: string, name: string) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: '{}' },
});
const ask: Message = { id: 'u', role: 'user', content: 'Check the migration.' };
const research: Message[] = [
  ask,
  { id: 'a1', role: 'assistant', toolCalls: [call('c1', 'search_web')] },
  { id: 't1', role: 'tool', toolCallId: 'c1', content: '{}' },
  { id: 'a2', role: 'assistant', toolCalls: [call('c2', 'read_public_page')] },
  { id: 't2', role: 'tool', toolCallId: 'c2', content: '{}' },
];

it('flags a request that was followed only by tool calls', () => {
  expect(endedWithoutAnswer(research)).toBe(true);
});

it('does not flag answered, empty, or waiting turns', () => {
  expect(endedWithoutAnswer([])).toBe(false);
  expect(endedWithoutAnswer([ask])).toBe(false);
  expect(
    endedWithoutAnswer([
      ...research,
      { id: 'a3', role: 'assistant', content: 'It is halfway done.' },
    ]),
  ).toBe(false);
  expect(
    endedWithoutAnswer([
      ask,
      {
        id: 'a1',
        role: 'assistant',
        toolCalls: [call('c1', 'review_space_page')],
      },
    ]),
  ).toBe(false);
  expect(
    endedWithoutAnswer([
      { ...ask, metadata: { opendotsSource: 'work' } } as Message,
      ...research.slice(1),
    ]),
  ).toBe(false);
});

it('labels known tools and humanizes the rest', () => {
  expect(toolActivityLabel('search_web')).toBe('Searching the web');
  expect(toolActivityLabel('plugin_fetch_issue')).toBe('Fetch issue');
});
