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
  /** Which caller asked, for the log line. */
  purpose?: string;
}) => Promise<Record<string, DecisionAnswer> | null>;

type Outcome =
  | 'ok'
  | 'http_error'
  | 'bad_response'
  | 'refusal'
  | 'missing_answer'
  | 'timeout'
  | 'aborted'
  | 'error';

/** The provider's error message, without echoing request content. */
function errorMessage(body: string) {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } })
      .error?.message;
    if (typeof message === 'string') return message.slice(0, 300);
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return body.slice(0, 300);
}

function summary(answers: Record<string, DecisionAnswer>) {
  return Object.fromEntries(
    Object.values(answers).map((item) => [
      item.name,
      item.type === 'predicate'
        ? { probability: item.probability }
        : item.type === 'choice'
          ? { choice: item.choice, confidence: item.confidence }
          : { score: item.score, confidence: item.confidence },
    ]),
  );
}

/**
 * A client for `POST /decisions`. Any refusal, HTTP error, malformed answer or
 * timeout returns null, so callers fall back to their default. Every call logs
 * one line with its outcome and timing; inputs and keys are never logged.
 */
export function decisionsClient(
  config: {
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs?: number;
  },
  transport: typeof fetch = fetch,
  log: (line: string) => void = console.info,
): Decide {
  return async ({ input, questions, signal, purpose }) => {
    const ms = config.timeoutMs ?? DECISIONS_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(ms);
    const started = Date.now();
    const report = (outcome: Outcome, detail: Record<string, unknown> = {}) =>
      log(
        `Decisions ${outcome}: ${JSON.stringify({
          purpose,
          model: config.model,
          questions: questions.map((question) => question.name),
          inputChars: input.length,
          ms: Date.now() - started,
          timeoutMs: ms,
          ...detail,
        })}`,
      );
    try {
      return await withTimeout(ask(), ms);
    } catch (error) {
      const outcome: Outcome = signal?.aborted
        ? 'aborted'
        : timeout.aborted || Date.now() - started >= ms
          ? 'timeout'
          : 'error';
      report(outcome, {
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`.slice(0, 200)
            : 'unknown',
      });
      return null;
    }
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
      if (!reply.ok) {
        report('http_error', {
          status: reply.status,
          error: errorMessage(await reply.text().catch(() => '')),
        });
        return null;
      }
      const parsed = response.safeParse(await reply.json());
      if (!parsed.success) {
        report('bad_response', {
          issues: parsed.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        });
        return null;
      }
      const answers: Record<string, DecisionAnswer> = {};
      for (const item of parsed.data.answers) {
        if (item.type === 'refusal') {
          report('refusal', { refused: item.name ?? null });
          return null;
        }
        answers[item.name] = item;
      }
      const missing = questions
        .map((question) => question.name)
        .filter((name) => !answers[name]);
      if (missing.length) {
        report('missing_answer', { missing, answers: summary(answers) });
        return null;
      }
      report('ok', { answers: summary(answers) });
      return answers;
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
