import { DISCOVERY_TOOL_NAME } from '@tanstack/ai';

export { DISCOVERY_TOOL_NAME };

/**
 * Tools sent to the model on every call. Prompts name these, or most turns
 * use them; every other tool is listed by name and loaded when discovered.
 */
export const EAGER_TOOLS: ReadonlySet<string> = new Set([
  'search_web',
  'read_public_page',
  'remember',
  'search_memories',
  'ask_dot',
  'list_authorized_spaces',
  'list_space_pages',
  'read_space_page',
  'create_space_page',
  'edit_space_page',
  'search_documents',
  'read_passage',
  'load_skill',
  'start_objective',
  'complete_work',
  'fail_work',
  'create_action_items',
  'search_action_items',
  'read_action_item',
  'update_action_item',
  'report_call_result',
]);

export function isLazy(name: string) {
  return !EAGER_TOOLS.has(name);
}

export const DISCOVERY_PROMPT = `Tools not in your tool list are listed by name in ${DISCOVERY_TOOL_NAME}. Call it with their names to load them before calling them.`;
