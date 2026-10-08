import '../src/server/disable-telemetry.js';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { completion } from './fixtures/model-stream.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.splice(0).forEach((fn) => fn());
});

function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    workspace.close();
  });
  const asker = workspace.dots()[0];
  const expert = workspace.createDot(
    asker.spaceId,
    'Expert',
    'Knows tax law.',
    true,
    true,
  );
  const platform = new Platform(store, workspace, {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    slackUsers: [],
  });
  workspace.bindThread('chat', asker.id, 'Taxes');
  return { store, workspace, platform, asker, expert };
}

const askCall = (dotId: string, question = 'Is this deductible?') =>
  completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'ask',
          type: 'function',
          function: {
            name: 'ask_dot',
            arguments: JSON.stringify({ dotId, question }),
          },
        },
      ],
    },
    'tool_calls',
  );
const body = (network: ReturnType<typeof vi.spyOn>, index: number) =>
  JSON.parse(String(network.mock.calls[index][1]?.body)) as {
    messages: { role: string; content: string; tool_call_id?: string }[];
    tools?: { function: { name: string } }[];
  };
const tools = (request: ReturnType<typeof body>) =>
  (request.tools ?? []).map((tool) => tool.function.name);

it('lets a Dot consult another in a separate consultation thread', async () => {
  const f = fixture();
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(askCall(f.expert.id))
    .mockResolvedValueOnce(
      completion({ role: 'assistant', content: 'Yes, up to 500.' }),
    )
    .mockResolvedValueOnce(
      completion({ role: 'assistant', content: 'The expert says yes.' }),
    );
  await f.platform.turn(
    'chat',
    'Ask the expert about my receipt.',
    new AbortController().signal,
  );
  expect(tools(body(network, 0))).toContain('ask_dot');
  const consulted = body(network, 1);
  expect(tools(consulted)).not.toContain('ask_dot');
  expect(tools(consulted)).not.toContain('create_space_page');
  expect(tools(consulted)).not.toContain('edit_space_page');
  expect(
    consulted.messages.find((m) => m.role === 'system')?.content,
  ).toContain('This conversation is a consultation');
  expect(
    body(network, 2).messages.find((m) => m.tool_call_id === 'ask')?.content,
  ).toContain('Yes, up to 500.');
  const [consultation] = f.workspace.consultations();
  expect(consultation).toMatchObject({
    fromDotId: f.asker.id,
    toDotId: f.expert.id,
  });
  expect(f.workspace.threadKind(consultation.threadId)).toBe('consultation');
  expect(
    f.workspace.conversations().map((conversation) => conversation.id),
  ).not.toContain(consultation.threadId);
  expect(f.workspace.consultationThread(f.asker.id, f.expert.id)).toBe(
    consultation.threadId,
  );
});

it('hides Dots that opted out and refuses to consult them', async () => {
  const f = fixture();
  f.workspace.updateDot(f.expert.id, { ...f.expert, consultable: false });
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(completion({ role: 'assistant', content: 'Ok.' }));
  await f.platform.turn('chat', 'Hello', new AbortController().signal);
  expect(tools(body(network, 0))).not.toContain('ask_dot');
  await expect(
    f.platform.consult(
      f.asker.id,
      f.expert.id,
      'Anyone there?',
      new AbortController().signal,
    ),
  ).rejects.toThrow(/not available to consult/);
  await expect(
    f.platform.consult(
      f.asker.id,
      f.asker.id,
      'Talking to myself',
      new AbortController().signal,
    ),
  ).rejects.toThrow(/not available to consult/);
  expect(f.workspace.consultations()).toEqual([]);
});

it('gives up on a consultation that runs past its time limit', async () => {
  const f = fixture();
  f.platform.consultationLimitMs = 50;
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        ),
      ),
  );
  await expect(
    f.platform.consult(
      f.asker.id,
      f.expert.id,
      'Slow question',
      new AbortController().signal,
    ),
  ).rejects.toThrow('Expert did not answer within 0 seconds.');
});

it('keeps consultation threads out of the browser runtime', async () => {
  const f = fixture();
  const threadId = f.workspace.consultationThread(f.asker.id, f.expert.id);
  const response = await f.platform.handle(
    new Request(
      `http://localhost/api/copilotkit/agent/${f.expert.id}/connect`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, runId: 'r', messages: [] }),
      },
    ),
  );
  expect(response.status).toBe(403);
});
