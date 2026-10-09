import type { Message } from '@ag-ui/core';
import { pageReviewTool } from '../shared/page-review';
import { workPromptKind } from '../shared/work-marker';

const hasText = (message: Message) =>
  typeof message.content === 'string' && !!message.content.trim();

/**
 * True when the latest owner request was followed only by tool calls. Background
 * work prompts and a page review waiting on the owner are not unanswered.
 */
export function endedWithoutAnswer(messages: Message[]) {
  let sawTool = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant') {
      if (hasText(message)) return false;
      const calls = message.toolCalls ?? [];
      if (calls.some((call) => call.function.name === pageReviewTool.name))
        return false;
      sawTool ||= calls.length > 0;
      continue;
    }
    if (message.role === 'user') return sawTool && !workPromptKind(message);
    if (message.role === 'system' || message.role === 'developer') return false;
  }
  return false;
}
