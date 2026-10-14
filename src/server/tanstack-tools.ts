import { toolDefinition } from '@tanstack/ai';
import type { ToolDefinition } from '@copilotkit/runtime/v2';

/** A lazy tool is sent to the model only after it discovers the tool by name. */
export function tanstackTools(
  tools: ToolDefinition[],
  lazy: (name: string) => boolean = () => false,
) {
  return tools.map(({ name, description, parameters, execute }) => {
    if (!execute) throw new Error(`Server tool has no executor: ${name}`);
    return toolDefinition({
      name,
      description,
      inputSchema: parameters,
      lazy: lazy(name),
    }).server(execute);
  });
}
