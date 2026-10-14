import { expect, it } from 'vitest';
import {
  DISCOVERY_PROMPT,
  DISCOVERY_TOOL_NAME,
  EAGER_TOOLS,
  isLazy,
} from '../src/server/tool-exposure.js';
import { modelDescription } from '../src/server/plugins.js';

it('sends tools the prompts rely on eagerly and defers the rest', () => {
  for (const name of [
    // System prompt
    'search_web',
    'list_authorized_spaces',
    'read_space_page',
    'create_space_page',
    // Capability prompt
    'load_skill',
    'start_objective',
    'complete_work',
    'fail_work',
    // Action item prompt: filed and updated without being asked
    'create_action_items',
    'search_action_items',
    'update_action_item',
    // List results are summaries that point at the full read
    'read_action_item',
  ])
    expect(isLazy(name), name).toBe(false);
  for (const name of [
    'plugin_linear_list_issues',
    'computer_snapshot',
    'list_work',
    'propose_schedule',
    'record_reconciliation',
    'merge_entities',
    'list_notes',
  ])
    expect(isLazy(name), name).toBe(true);
  expect(EAGER_TOOLS.size).toBeLessThan(25);
});

it('tells the model how to load deferred tools', () => {
  expect(DISCOVERY_PROMPT).toContain(DISCOVERY_TOOL_NAME);
});

it('cuts a long plugin description to its first paragraph for the model', () => {
  expect(modelDescription('  List issues.  ')).toBe('List issues.');
  const long = `List issues in a team.\n\n${'Details. '.repeat(100)}`;
  expect(modelDescription(long)).toBe('List issues in a team. …');
  const run = 'word '.repeat(200);
  const cut = modelDescription(run);
  expect(cut.length).toBeLessThanOrEqual(601);
  expect(cut.endsWith('…')).toBe(true);
});
