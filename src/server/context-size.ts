import { convertSchemaToJsonSchema } from '@tanstack/ai';
import { pluginToolName } from './authorize.js';

interface SizedTool {
  name: string;
  description: string;
  parameters?: unknown;
}

/** Rough token estimate, matching the compaction default of characters / 4. */
export function textTokens(text: string) {
  return Math.ceil(text.length / 4);
}

/** Estimated tokens a tool's model-facing definition costs on every call. */
export function toolTokens(tool: SizedTool) {
  let parameters: unknown = {};
  try {
    parameters = tool.parameters
      ? convertSchemaToJsonSchema(
          tool.parameters as Parameters<typeof convertSchemaToJsonSchema>[0],
        )
      : {};
  } catch {
    // An unconvertible schema still costs its name and description.
  }
  return textTokens(
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters,
    }),
  );
}

export function toolGroup(name: string) {
  const plugin = pluginToolName(name);
  if (plugin) return `plugin:${plugin.pluginId}`;
  if (name.startsWith('computer_')) return 'computer';
  return 'built-in';
}

export interface ContextReport {
  promptTokens: number;
  eagerTools: number;
  eagerToolTokens: number;
  lazyTools: number;
  lazyToolTokens: number;
  groups: Record<string, { tools: number; tokens: number; lazy: number }>;
}

export function contextReport(
  prompt: string,
  tools: SizedTool[],
  isLazy: (name: string) => boolean = () => false,
): ContextReport {
  const report: ContextReport = {
    promptTokens: textTokens(prompt),
    eagerTools: 0,
    eagerToolTokens: 0,
    lazyTools: 0,
    lazyToolTokens: 0,
    groups: {},
  };
  for (const tool of tools) {
    const tokens = toolTokens(tool);
    const lazy = isLazy(tool.name);
    const group = (report.groups[toolGroup(tool.name)] ??= {
      tools: 0,
      tokens: 0,
      lazy: 0,
    });
    group.tools += 1;
    group.tokens += tokens;
    if (lazy) {
      group.lazy += 1;
      report.lazyTools += 1;
      report.lazyToolTokens += tokens;
    } else {
      report.eagerTools += 1;
      report.eagerToolTokens += tokens;
    }
  }
  return report;
}
