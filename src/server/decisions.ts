import { z } from 'zod';
import { withTimeout } from './model-json.js';

/** Decisions answers come back in about a quarter of a second; past this, routing falls back. */
export const DECISIONS_TIMEOUT_MS = 1000;

export type DecisionQuestion =
  | { type: 'predicate'; name: string; instructions: string }
  | {
      type: 'choice';
      name: string;
      instructions: string;
      choices: { value: string; description?: string }[];
    };

const answer = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('predicate'),
    name: z.string(),
    probability: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal('choice'),
    name: z.string(),
    choice: z.string(),
    confidence: z.number().min(0).max(1),
    probabilities: z
      .array(z.object({ value: z.string(), probability: z.number() }))
      .optional(),
  }),
  z.object({
    type: z.literal('score'),
    name: z.string(),
    score: z.number(),
    confidence: z.number().min(0).max(1),
  }),
  z.object({ type: z.literal('refusal'), name: z.string().optional() }),
]);
const response = z.object({ answers: z.array(answer) });

export type DecisionAnswer = Exclude<
  z.infer<typeof answer>,
  { type: 'refusal' }
>;

export type Decide = (request: {
  input: string;
  questions: DecisionQuestion[];
  signal?: AbortSignal;
}) => Promise<Record<string, DecisionAnswer> | null>;

/**
 * A client for `POST /decisions`. Any refusal, HTTP error, malformed answer or
 * timeout returns null, so callers fall back to their default.
 */
export function decisionsClient(
  config: {
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs?: number;
  },
  transport: typeof fetch = fetch,
): Decide {
  return ({ input, questions, signal }) => {
    const ms = config.timeoutMs ?? DECISIONS_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(ms);
    return withTimeout(ask(), ms).catch(() => null);
    async function ask() {
      const reply = await transport(
        `${config.baseUrl.replace(/\/$/, '')}/decisions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: config.model, input, questions }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        },
      );
      if (!reply.ok) return null;
      const parsed = response.safeParse(await reply.json());
      if (!parsed.success) return null;
      const answers: Record<string, DecisionAnswer> = {};
      for (const item of parsed.data.answers) {
        if (item.type === 'refusal') return null;
        answers[item.name] = item;
      }
      return questions.every((question) => answers[question.name])
        ? answers
        : null;
    }
  };
}

export function choiceAnswer(
  answers: Record<string, DecisionAnswer> | null,
  name: string,
) {
  const value = answers?.[name];
  return value?.type === 'choice' ? value : undefined;
}

export function predicateAnswer(
  answers: Record<string, DecisionAnswer> | null,
  name: string,
) {
  const value = answers?.[name];
  return value?.type === 'predicate' ? value.probability : 0;
}
