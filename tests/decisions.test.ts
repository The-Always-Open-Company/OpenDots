import { expect, it, vi } from 'vitest';
import { decisionsClient } from '../src/server/decisions.js';
import { classifyTurn, routeTask } from '../src/server/task-brief.js';

const config = {
  apiKey: 'key',
  baseUrl: 'https://api.example.test/v1/',
  model: 'gpt-6-luna',
};
const questions = [
  {
    type: 'predicate' as const,
    name: 'is_correction',
    instructions: 'Is this a correction?',
  },
  {
    type: 'choice' as const,
    name: 'complexity',
    instructions: 'How hard is it?',
    choices: [{ value: 'simple' }, { value: 'reasoning' }],
  },
];

it('posts the model, input and questions and returns answers keyed by name', async () => {
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({
      answers: [
        { type: 'predicate', name: 'is_correction', probability: 0.2 },
        {
          type: 'choice',
          name: 'complexity',
          choice: 'simple',
          confidence: 0.9,
          probabilities: [
            { value: 'simple', probability: 0.95 },
            { value: 'reasoning', probability: 0.05 },
          ],
        },
      ],
    }),
  );
  const decide = decisionsClient(config, transport);
  const answers = await decide({ input: 'What time is it?', questions });
  const [url, init] = transport.mock.calls[0];
  expect(url).toBe('https://api.example.test/v1/decisions');
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer key');
  expect(JSON.parse(String(init?.body))).toEqual({
    model: 'gpt-6-luna',
    input: 'What time is it?',
    questions,
  });
  expect(answers?.is_correction).toMatchObject({ probability: 0.2 });
  expect(answers?.complexity).toMatchObject({
    choice: 'simple',
    confidence: 0.9,
  });
});

it('returns null for a refusal, an HTTP error, a malformed or missing answer, and a timeout', async () => {
  const reply = (body: unknown, status = 200) =>
    decisionsClient(config, async () => Response.json(body, { status }))({
      input: 'x',
      questions,
    });
  await expect(
    reply({
      answers: [
        { type: 'predicate', name: 'is_correction', probability: 0.1 },
        { type: 'refusal', name: 'complexity' },
      ],
    }),
  ).resolves.toBeNull();
  await expect(reply({ error: 'nope' }, 500)).resolves.toBeNull();
  await expect(reply({ answers: [{ type: 'predicate' }] })).resolves.toBeNull();
  await expect(
    reply({
      answers: [{ type: 'predicate', name: 'is_correction', probability: 0.1 }],
    }),
  ).resolves.toBeNull();
  const hung = decisionsClient(
    { ...config, timeoutMs: 20 },
    () => new Promise<Response>(() => {}),
  );
  await expect(hung({ input: 'x', questions })).resolves.toBeNull();
  const offline = decisionsClient(config, async () => {
    throw new TypeError('fetch failed');
  });
  await expect(offline({ input: 'x', questions })).resolves.toBeNull();
});

it('routes a call task and ignores a relation to a task that is not open', async () => {
  const decide = vi.fn(async () => ({
    complexity: {
      type: 'choice' as const,
      name: 'complexity',
      choice: 'reasoning',
      confidence: 0.7,
    },
    relates_to: {
      type: 'choice' as const,
      name: 'relates_to',
      choice: 'task_9',
      confidence: 0.8,
    },
    is_correction: {
      type: 'predicate' as const,
      name: 'is_correction',
      probability: 0.9,
    },
    needs_clarification: {
      type: 'predicate' as const,
      name: 'needs_clarification',
      probability: 0.1,
    },
  }));
  const routed = await routeTask(decide, {
    words: 'Make it 8pm',
    transcript: '',
    chat: '',
    openTasks: [{ id: 'task_1', label: 'Book dinner' }],
  });
  expect(routed).toEqual({
    complexity: { choice: 'reasoning', confidence: 0.7 },
    relatesTo: null,
    isCorrection: 0.9,
    needsClarification: 0.1,
  });
  const relation = (
    decide.mock.calls[0] as unknown as [
      { questions: { name: string; choices?: { value: string }[] }[] },
    ]
  )[0].questions.find((question) => question.name === 'relates_to');
  expect(relation?.choices?.map((choice) => choice.value)).toEqual([
    'task_1',
    'none',
  ]);
  await expect(
    classifyTurn(async () => null, { latest: 'Hi', history: '' }),
  ).resolves.toBeNull();
});
