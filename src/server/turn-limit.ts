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
