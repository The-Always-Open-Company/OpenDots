import { DISCOVERY_TOOL_NAME, type ChatMiddleware } from '@tanstack/ai';

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
  'list_documents',
  'search_documents',
  'read_passage',
  'load_skill',
  'start_objective',
  'schedule',
  'list_schedules',
  'complete_work',
  'declare_requirements',
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

/** Tools loaded in this many most recent turns stay loaded; older ones are unloaded. */
export const LOADED_TOOL_TURNS = 2;

interface HistoryMessage {
  role: string;
  content?: unknown;
  toolCalls?: { id: string; function: { name: string } }[];
  toolCallId?: string;
}

/**
 * Tool search results load tools for the rest of a thread, because the chat
 * loop rebuilds the loaded set from every search result in its history. Keeps
 * the results from the last `keepTurns` turns, and replaces older ones with a
 * short note, so a tool loaded long ago stops being sent on every call until
 * the model searches for it again.
 */
export function unloadEarlierTools<T extends HistoryMessage>(
  messages: T[],
  keepTurns = LOADED_TOOL_TURNS,
): T[] {
  let turns = 0;
  let cutoff = 0;
  for (let at = messages.length - 1; at >= 0; at -= 1)
    if (messages[at].role === 'user' && (turns += 1) === keepTurns) {
      cutoff = at;
      break;
    }
  if (!cutoff) return messages;
  const searches = new Set<string>();
  for (const message of messages.slice(0, cutoff))
    for (const call of message.toolCalls ?? [])
      if (call.function.name === DISCOVERY_TOOL_NAME) searches.add(call.id);
  if (!searches.size) return messages;
  return messages.map((message, at) => {
    if (
      at >= cutoff ||
      message.role !== 'tool' ||
      !message.toolCallId ||
      !searches.has(message.toolCallId)
    )
      return message;
    let names: string[] = [];
    try {
      const parsed = JSON.parse(
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content),
      ) as { tools?: { name?: unknown }[] };
      names = (parsed.tools ?? [])
        .map((tool) => tool?.name)
        .filter((name): name is string => typeof name === 'string');
    } catch {
      // Not a search result we can read; unload it all the same.
    }
    return {
      ...message,
      content: JSON.stringify({
        unloaded: names,
        note: `Loaded in an earlier turn and no longer loaded. Call ${DISCOVERY_TOOL_NAME} again to use them.`,
      }),
    };
  });
}

/** The most characters of a plugin result the model sees. */
export const PLUGIN_RESULT_LIMIT = 24_000;

interface ExecutableTool {
  name: string;
  execute?: (args: never) => unknown;
}

/**
 * Prepares plugin results for the model: unpacks JSON that a plugin returns
 * as text, which would otherwise reach the model escaped at about twice the
 * size, and cuts long results with a note on how to get the rest. The harness
 * records the original result before this runs.
 */
export function limitPluginResults<T extends ExecutableTool>(
  tools: T[],
  limit = PLUGIN_RESULT_LIMIT,
): T[] {
  return tools.map((tool) => {
    const execute = tool.execute;
    if (!execute || !tool.name.startsWith('plugin_')) return tool;
    return {
      ...tool,
      execute: async (args: never) => limitResult(await execute(args), limit),
    };
  });
}

/** A plugin result as the model should read it: unpacked, and at most `limit` characters. */
export function limitResult(result: unknown, limit = PLUGIN_RESULT_LIMIT) {
  const parts =
    result &&
    typeof result === 'object' &&
    Array.isArray((result as { content?: unknown }).content) &&
    Object.keys(result).every((key) =>
      ['content', 'isError', 'structuredContent', '_meta'].includes(key),
    )
      ? ((result as { content: unknown[] }).content as {
          type?: unknown;
          text?: unknown;
        }[])
      : undefined;
  let value: unknown = result;
  if (parts?.length && parts.every((part) => part?.type === 'text')) {
    const text = parts.map((part) => String(part.text ?? '')).join('\n');
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  const sent =
    typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (sent.length <= limit) return value;
  // Plain text, so the cut JSON is not escaped a second time.
  return `${sent.slice(0, limit)}\n\n[Cut short: showing ${limit} of ${sent.length} characters. Narrow the request with filters, a field list, a smaller limit or a page to see the rest.]`;
}

/**
 * A tool search result carries each loaded tool's full schema, which the tool
 * list already sends on every later call. The model sees each result as just
 * the names it loaded; the stored result is unchanged, so the next turn still
 * knows which tools were loaded.
 */
export function toolSearchMiddleware(): ChatMiddleware {
  return {
    name: 'opendots-tool-search-results',
    onConfig: (ctx, config) => {
      if (ctx.phase !== 'beforeModel') return;
      const messages = config.providerMessages ?? config.messages;
      const searches = new Set<string>();
      for (const message of messages)
        for (const call of message.toolCalls ?? [])
          if (call.function.name === DISCOVERY_TOOL_NAME) searches.add(call.id);
      if (!searches.size) return;
      let changed = false;
      const next = messages.map((message) => {
        if (
          message.role !== 'tool' ||
          !message.toolCallId ||
          !searches.has(message.toolCallId) ||
          typeof message.content !== 'string'
        )
          return message;
        try {
          const parsed = JSON.parse(message.content) as {
            tools?: { name?: unknown }[];
          };
          if (!Array.isArray(parsed.tools)) return message;
          changed = true;
          return {
            ...message,
            content: JSON.stringify({
              loaded: parsed.tools
                .map((tool) => tool?.name)
                .filter((name) => typeof name === 'string'),
            }),
          };
        } catch {
          return message;
        }
      });
      return changed ? { providerMessages: next } : undefined;
    },
  };
}
