import { defineChatMiddleware, maxIterations } from '@tanstack/ai';

export const FINAL_TURN_PROMPT =
  'You have used every tool step for this reply. Answer now from what you already found, and say plainly what is still unchecked.';

/**
 * Bounds model turns per reply. The last allowed turn keeps the tools defined
 * but forbids calling them, so a limited reply still ends with an answer.
 */
export function turnLimit(limit: number | undefined) {
  if (limit == null) return { agentLoopStrategy: () => true, middleware: [] };
  return {
    agentLoopStrategy: maxIterations(limit),
    middleware: [
      defineChatMiddleware({
        name: 'opendots-turn-limit',
        onConfig(ctx, config) {
          if (ctx.phase !== 'beforeModel' || ctx.iteration < limit - 1) return;
          return {
            systemPrompts: [...config.systemPrompts, FINAL_TURN_PROMPT],
            modelOptions: { ...config.modelOptions, tool_choice: 'none' },
          };
        },
      }),
    ],
  };
}

export const STALLED_PROMPT =
  'Your last tool calls all failed. Stop calling tools. Tell the owner what failed, what you tried, and what you need from them.';

/** Rounds in a row in which every tool call failed before the turn must answer. */
export const STALLED_ROUNDS = 3;

const callKey = (name: string, args: unknown) =>
  `${name}|${JSON.stringify(args ?? {})}`;

function failure(info: { ok: boolean; result?: unknown; error?: unknown }) {
  if (!info.ok)
    return info.error instanceof Error
      ? info.error.message
      : String(info.error ?? 'The call failed.');
  let value = info.result;
  if (typeof value === 'string')
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  const error =
    value && typeof value === 'object'
      ? (value as { error?: unknown }).error
      : undefined;
  return error ? String(error) : null;
}

/**
 * Stops a turn from spending calls on work that is not progressing. An
 * identical call that already failed in this turn is not run again; the model
 * is told to change it. After `rounds` model calls in a row whose tool calls
 * all failed, the next call must answer in text.
 */
export function stallGuard(rounds = STALLED_ROUNDS) {
  const failed = new Map<string, string>();
  let calls = 0;
  let failures = 0;
  let streak = 0;
  return defineChatMiddleware({
    name: 'opendots-stall-guard',
    onConfig(ctx, config) {
      if (ctx.phase !== 'beforeModel') return;
      if (calls) streak = failures === calls ? streak + 1 : 0;
      calls = 0;
      failures = 0;
      if (streak < rounds) return;
      return {
        systemPrompts: [...config.systemPrompts, STALLED_PROMPT],
        modelOptions: { ...config.modelOptions, tool_choice: 'none' },
      };
    },
    onBeforeToolCall(_ctx, hook) {
      const earlier = failed.get(callKey(hook.toolName, hook.args));
      if (earlier === undefined) return;
      return {
        type: 'skip',
        result: {
          error: `This exact call already failed in this turn: ${earlier.slice(0, 300)} It was not run again. Change the arguments or try another approach.`,
        },
      };
    },
    onAfterToolCall(_ctx, info) {
      calls += 1;
      const error = failure(info);
      if (error === null) return;
      failures += 1;
      failed.set(
        callKey(
          info.toolName,
          info.toolCall.function.arguments
            ? safeArgs(info.toolCall.function.arguments)
            : {},
        ),
        error,
      );
    },
  });
}

function safeArgs(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
