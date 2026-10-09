import { chat } from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import type { z } from 'zod';

/** One model call that must answer with a JSON object. */
export type CompleteJson = (request: {
  system: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}) => Promise<unknown>;

export function modelJson(config: {
  apiKey: string;
  baseUrl: string;
  model: string;
}): CompleteJson {
  const adapter = openaiCompatibleText(config.model, {
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    api: 'chat-completions',
    maxRetries: 1,
  });
  return async ({ system, user, maxTokens, signal }) => {
    const abortController = new AbortController();
    const abort = () => abortController.abort(signal?.reason);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const text = await chat({
        adapter,
        stream: false,
        abortController,
        // OpenAI rejects json_object mode unless the messages mention JSON.
        systemPrompts: [
          /json/i.test(system + user)
            ? system
            : `${system}\nAnswer with a JSON object.`,
        ],
        messages: [{ role: 'user', content: user }],
        modelOptions: {
          max_completion_tokens: maxTokens,
          response_format: { type: 'json_object' },
        },
      });
      return parseJsonObject(text);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  };
}

/** Parses a JSON object, tolerating code fences or prose around it. */
export function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model returned no JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

/** Calls the model and validates the answer, or throws. */
export async function completeWith<T>(
  complete: CompleteJson,
  schema: z.ZodType<T>,
  request: Parameters<CompleteJson>[0],
): Promise<T> {
  return schema.parse(await complete(request));
}

/** Rejects after `ms`, so a slow model call cannot hold up a turn. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out.')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
