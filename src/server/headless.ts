import type { AbstractAgent } from '@ag-ui/client';
import { EventType, type Message, type RunAgentInput } from '@ag-ui/core';
import type { AgentRunner } from '@copilotkit/runtime/v2';
import { randomUUID } from 'node:crypto';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';

export function currentTurnText(messages: Message[], error?: Error): string {
  if (error) throw error;
  const content = messages
    .filter((message) => message.role === 'assistant')
    .at(-1)?.content;
  if (typeof content !== 'string' || !content.trim())
    throw new Error('The current compute turn returned no assistant response.');
  return content;
}

/**
 * Runs one turn in a stored conversation through the same runner the browser
 * uses, so open chat windows see the turn live and history stays in one place.
 */
export async function runThreadTurn(
  runner: AgentRunner,
  agent: AbstractAgent,
  threadId: string,
  prompt: string,
  signal: AbortSignal,
  metadata?: Record<string, unknown>,
): Promise<string> {
  signal.throwIfAborted();
  const message = {
    id: `${metadata?.opendotsSource === 'voice_receipt' ? voiceReceiptMessagePrefix : ''}${randomUUID()}`,
    role: 'user',
    content: prompt,
    ...(metadata ? { metadata } : {}),
  } as Message;
  const input: RunAgentInput = {
    threadId,
    runId: randomUUID(),
    messages: [message],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
  agent.threadId = threadId;
  agent.setMessages([message]);
  if (await runner.isRunning({ threadId }))
    throw new Error(
      'This conversation is already answering. Try again when the current reply finishes.',
    );
  const stop = () => void runner.stop({ threadId, runId: input.runId });
  signal.addEventListener('abort', stop, { once: true });
  try {
    let runError: Error | undefined;
    await new Promise<void>((resolve, reject) =>
      runner.run({ threadId, agent, input }).subscribe({
        next: (event) => {
          if (event.type === EventType.RUN_ERROR)
            runError ??= new Error(
              String((event as { message?: unknown }).message ?? 'Run failed.'),
            );
        },
        error: reject,
        complete: resolve,
      }),
    );
    signal.throwIfAborted();
    return currentTurnText(
      agent.messages.filter((item) => item.id !== message.id),
      runError,
    );
  } finally {
    signal.removeEventListener('abort', stop);
  }
}
