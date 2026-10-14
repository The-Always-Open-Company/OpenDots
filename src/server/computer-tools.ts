import { defineTool } from '@copilotkit/runtime/v2';
import {
  computerInputs,
  type ComputerAction,
} from '../shared/computer-types.js';
import type { ComputerService } from './computer-service.js';

type AgentAction = Exclude<ComputerAction, `human_${string}`>;

/** Shared rules for these tools live in the Dot's system prompt. */
const descriptions: Record<AgentAction, string> = {
  navigate: "Open a URL in this Dot's computer browser.",
  read: "Read the text of the current page in this Dot's computer browser.",
  snapshot:
    "Snapshot the current page in this Dot's computer browser, returning element refs and a snapshotId.",
  screenshot: "Take a screenshot of this Dot's computer browser.",
  click:
    "Click an element in this Dot's computer browser by ref from a fresh snapshot.",
  type: "Type into an element in this Dot's computer browser by ref from a fresh snapshot.",
  key: "Press a key in this Dot's computer browser.",
  scroll: "Scroll the current page in this Dot's computer browser.",
  files_list: "List files in this Dot's computer workspace.",
  files_read: "Read a file in this Dot's computer workspace.",
  files_write: "Write or append to a file in this Dot's computer workspace.",
  exec: "Run a shell command inside this Dot's computer.",
};

export function computerTools(
  service: ComputerService,
  dotId: string,
  check: () => void,
  signal: AbortSignal,
) {
  return (Object.keys(descriptions) as AgentAction[]).map((name) =>
    defineTool({
      name: `computer_${name}`,
      description: descriptions[name],
      parameters: computerInputs[name],
      execute: async (input: unknown) => {
        check();
        return service.action(dotId, name, input, 'agent', signal);
      },
    }),
  );
}
