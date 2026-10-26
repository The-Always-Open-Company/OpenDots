import { expect, it } from 'vitest';
import type { Message } from '@ag-ui/core';
import {
  buildTranscriptItems,
  traceSummary,
  workPhrase,
} from '../src/client/agent-trace';

const call = (id: string, name: string) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: '{}' },
});

it('names a run of tool steps without listing every one', () => {
  expect(workPhrase(['Searching the web'])).toBe('Searching the web');
  expect(workPhrase(['Searching the web', 'Searching the web'])).toBe(
    'Searching the web · 2 steps',
  );
  expect(workPhrase(['Searching the web', 'Reading a web page'])).toBe(
    'Searching the web and Reading a web page',
  );
  expect(
    workPhrase([
      'Searching the web',
      'Reading a web page',
      'Reading a document',
    ]),
  ).toBe('Searching the web, Reading a web page, and 1 more');
});

it('keeps computer and review cards out of the folded trace', () => {
  const items = buildTranscriptItems([
    { id: 'ask', role: 'user', content: 'Look' },
    {
      id: 'thought',
      role: 'reasoning',
      content: 'Checking.',
    },
    {
      id: 'work',
      role: 'assistant',
      content: 'Done.',
      toolCalls: [
        call('search', 'search_web'),
        call('screen', 'computer_navigate'),
        call('review', 'review_space_page'),
      ],
    },
  ] as Message[]);
  expect(items.map((item) => item.kind)).toEqual([
    'message',
    'trace',
    'message',
    'cards',
  ]);
  const trace = items[1];
  expect(trace.kind).toBe('trace');
  if (trace.kind === 'trace')
    expect(traceSummary(trace.steps)).toBe('Thought · Searching the web');
  const cards = items[3];
  expect(cards.kind).toBe('cards');
  if (cards.kind === 'cards')
    expect(cards.calls.map((tool) => tool.function.name)).toEqual([
      'computer_navigate',
      'review_space_page',
    ]);
});
