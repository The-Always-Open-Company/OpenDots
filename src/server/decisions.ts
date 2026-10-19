import { z } from 'zod';

/** Decisions answers usually take 0.2 to 1.2 s end to end; past this, routing falls back. */
export const DECISIONS_TIMEOUT_MS = 2500;
/** With no answer by then, the same request is sent again and the first valid answer wins. */
export const DECISIONS_HEDGE_MS = 400;

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
  /** Overrides the client's timeout for this call. */
  timeoutMs?: number;
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

type Timing = { processingMs?: number; requestId?: string };
type Result = Timing &
  (
    | { answers: Record<string, DecisionAnswer> }
    | {
        outcome: Outcome;
        detail: Record<string, unknown>;
        /** Worth sending the duplicate request at once instead of waiting. */
        transient: boolean;
      }
  );
type Attempt = Result & { attempt: number };

function describe(error: unknown) {
  return error instanceof Error
    ? `${error.name}: ${error.message}`.slice(0, 200)
    : 'unknown';
}

/**
 * A client for `POST /decisions`. Any refusal, HTTP error, malformed answer or
 * timeout returns null, so callers fall back to their default. When the first
 * request is slow or fails transiently, one duplicate is sent; the first valid
 * answer wins and the other request is aborted. Every call logs one line with
 * its outcome and timing; inputs and keys are never logged.
 */
export function decisionsClient(
  config: {
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs?: number;
    hedgeMs?: number;
  },
  transport: typeof fetch = fetch,
  log: (line: string) => void = console.info,
): Decide {
  return async ({ input, questions, signal, purpose, timeoutMs }) => {
    const ms = timeoutMs ?? config.timeoutMs ?? DECISIONS_TIMEOUT_MS;
    const hedgeMs = config.hedgeMs ?? DECISIONS_HEDGE_MS;
    const deadline = AbortSignal.timeout(ms);
    const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const started = Date.now();
    const requests: AbortController[] = [];
    const report = (outcome: Outcome, detail: Record<string, unknown> = {}) =>
      log(
        `Decisions ${outcome}: ${JSON.stringify({
          purpose,
          model: config.model,
          questions: questions.map((question) => question.name),
          inputChars: input.length,
          ms: Date.now() - started,
          timeoutMs: ms,
          attempts: requests.length,
          ...detail,
        })}`,
      );
    const send = (): Promise<Attempt> => {
      const request = new AbortController();
      requests.push(request);
      const attempt = requests.length;
      return ask(AbortSignal.any([stop, request.signal])).then(
        (result) => ({ attempt, ...result }),
        (error: unknown) => ({
          attempt,
          outcome: 'error' as const,
          detail: { error: describe(error) },
          transient: true,
        }),
      );
    };

    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    let onStop: (() => void) | undefined;
    const stopped = new Promise<'stop'>((resolve) => {
      onStop = () => resolve('stop');
      if (stop.aborted) onStop();
      else stop.addEventListener('abort', onStop, { once: true });
    });
    const hedge = new Promise<'hedge'>((resolve) => {
      hedgeTimer = setTimeout(() => resolve('hedge'), hedgeMs);
    });
    const pending = new Map<number, Promise<Attempt>>();
    const launch = () => {
      const next = send();
      pending.set(requests.length, next);
    };
    try {
      launch();
      while (true) {
        const next = await Promise.race([
          ...pending.values(),
          ...(requests.length < 2 ? [hedge] : []),
          stopped,
        ]);
        if (next === 'stop' || stop.aborted) {
          report(signal?.aborted ? 'aborted' : 'timeout', {
            error: describe(stop.reason),
          });
          return null;
        }
        if (next === 'hedge') {
          launch();
          continue;
        }
        pending.delete(next.attempt);
        if ('answers' in next) {
          report('ok', {
            winner: next.attempt,
            processingMs: next.processingMs,
            requestId: next.requestId,
            answers: summary(next.answers),
          });
          return next.answers;
        }
        if (next.transient && requests.length < 2) launch();
        if (!pending.size) {
          report(next.outcome, {
            ...next.detail,
            processingMs: next.processingMs,
            requestId: next.requestId,
          });
          return null;
        }
      }
    } finally {
      clearTimeout(hedgeTimer);
      if (onStop) stop.removeEventListener('abort', onStop);
      for (const request of requests) request.abort();
    }

    async function ask(requestSignal: AbortSignal): Promise<Result> {
      const reply = await transport(
        `${config.baseUrl.replace(/\/$/, '')}/decisions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: config.model, input, questions }),
          signal: requestSignal,
        },
      );
      const processing = Number(reply.headers.get('openai-processing-ms'));
      const timing: Timing = {
        processingMs:
          Number.isFinite(processing) && processing > 0
            ? processing
            : undefined,
        requestId: reply.headers.get('x-request-id') ?? undefined,
      };
      const fail = (
        outcome: Outcome,
        detail: Record<string, unknown>,
        transient = false,
      ): Result => ({ ...timing, outcome, detail, transient });
      if (!reply.ok)
        return fail(
          'http_error',
          {
            status: reply.status,
            error: errorMessage(await reply.text().catch(() => '')),
          },
          reply.status === 429 || reply.status >= 500,
        );
      const parsed = response.safeParse(await reply.json());
      if (!parsed.success)
        return fail('bad_response', {
          issues: parsed.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        });
      const answers: Record<string, DecisionAnswer> = {};
      for (const item of parsed.data.answers) {
        if (item.type === 'refusal')
          return fail('refusal', { refused: item.name ?? null });
        answers[item.name] = item;
      }
      const missing = questions
        .map((question) => question.name)
        .filter((name) => !answers[name]);
      if (missing.length)
        return fail('missing_answer', { missing, answers: summary(answers) });
      return { ...timing, answers };
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
