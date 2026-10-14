import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  contextReport,
  textTokens,
  toolGroup,
  toolTokens,
} from '../src/server/context-size.js';
import { pluginParameters } from '../src/server/plugin-schema.js';

const zodTool = {
  name: 'search_documents',
  description: 'Search documents.',
  parameters: z.object({ query: z.string().describe('What to look for') }),
};

const pluginTool = {
  name: 'plugin_linear_list_issues',
  description: 'List issues.',
  parameters: pluginParameters(
    {
      type: 'object',
      properties: { teamIdentifier: { type: 'string' } },
    },
    'linear:list_issues:hash',
  ),
};

it('estimates a tool from its name, description, and JSON schema', () => {
  const tokens = toolTokens(zodTool);
  expect(tokens).toBeGreaterThan(textTokens('What to look for'));
  expect(
    toolTokens({ ...zodTool, description: 'Search documents. '.repeat(40) }),
  ).toBeGreaterThan(tokens + 100);
  expect(toolTokens(pluginTool)).toBeGreaterThan(textTokens('teamIdentifier'));
});

it('reports eager and lazy tools by group', () => {
  expect(toolGroup('plugin_linear_list_issues')).toBe('plugin:linear');
  expect(toolGroup('computer_exec')).toBe('computer');
  expect(toolGroup('list_work')).toBe('built-in');
  const report = contextReport('x'.repeat(400), [zodTool, pluginTool], (name) =>
    name.startsWith('plugin_'),
  );
  expect(report.promptTokens).toBe(100);
  expect(report.eagerTools).toBe(1);
  expect(report.lazyTools).toBe(1);
  expect(report.eagerToolTokens).toBe(toolTokens(zodTool));
  expect(report.groups['plugin:linear']).toEqual({
    tools: 1,
    tokens: toolTokens(pluginTool),
    lazy: 1,
  });
});
