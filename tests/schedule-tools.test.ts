import { afterEach, expect, it } from 'vitest';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import { PluginService } from '../src/server/plugins.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { workTools, type WorkDeps } from '../src/server/work-tools.js';
import { describeSchedule, scheduleFor } from '../src/server/schedule-tools.js';
import { applyApprovedAction } from '../src/server/approved-actions.js';
import { snapshotFor } from '../src/server/work-tools.js';

const MINUTE = 60_000;
const NOW = Date.parse('2026-11-06T17:00:00Z');

const databases: Array<{ close(): void }> = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

async function world(mode: 'ask' | 'allow' = 'ask') {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  let clock = Date.now();
  const engine = new ExecutionEngine(store.database, () => clock);
  const sent: unknown[] = [];
  const plugins = new PluginService(store.database, {
    listTools: async () => [
      {
        name: 'send',
        description: 'Post a message to a chat.',
        schema: {
          type: 'object',
          properties: { chat: { type: 'string' }, text: { type: 'string' } },
          required: ['chat', 'text'],
        },
      },
      {
        name: 'archive',
        description: 'Archive a chat.',
        schema: {
          type: 'object',
          properties: { chat: { type: 'string' } },
          required: ['chat'],
        },
      },
    ],
    callTool: async (_plugin, _name, args) => {
      sent.push(args);
      return { ok: true };
    },
  });
  plugins.save({ id: 'cliq', name: 'Cliq', url: 'http://127.0.0.1/mcp' });
  await plugins.refresh('cliq');
  const dot = workspace.dots()[0];
  plugins.grant(dot.id, 'cliq', 'send', mode);
  plugins.grant(dot.id, 'cliq', 'archive', 'ask');
  workspace.bindThread('thread-1', dot.id, 'Chat');
  const deps = (ownerPresent: boolean): WorkDeps => ({
    engine,
    workspace,
    store,
    plugins,
    skillsDir: '/nonexistent-skills',
    dot,
    threadId: 'thread-1',
    check: () => undefined,
    ownerPresent,
    context: () => ({
      actorId: dot.id,
      ownerId: workspace.ownerId,
      executionId: '',
      threadId: 'thread-1',
      mode: 'interactive',
      cause: 'model',
    }),
  });
  const call = async (
    ownerPresent: boolean,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const tool = workTools(deps(ownerPresent)).find(
      (item) => item.name === name,
    );
    if (!tool?.execute) throw new Error(`${name} is missing.`);
    return tool.execute(args as never) as Promise<Record<string, unknown>>;
  };
  return {
    store,
    workspace,
    engine,
    plugins,
    dot,
    sent,
    call,
    at: (ms: number) => (clock = ms),
  };
}

it('reads once, interval and calendar times the way the model writes them', () => {
  const min = 15 * MINUTE;
  expect(scheduleFor({ kind: 'once', inMinutes: 60 }, NOW, min)).toEqual({
    spec: { kind: 'once', at: NOW + 60 * MINUTE },
    nextRunAt: NOW + 60 * MINUTE,
  });
  expect(
    scheduleFor({ kind: 'once', at: '2026-11-06T13:43:00-05:00' }, NOW, min)
      .nextRunAt,
  ).toBe(Date.parse('2026-11-06T18:43:00Z'));
  expect(() =>
    scheduleFor({ kind: 'once', at: '2026-11-06T13:43:00' }, NOW, min),
  ).toThrow(/UTC offset/);
  expect(() =>
    scheduleFor({ kind: 'once', inMinutes: 0 } as never, NOW, min),
  ).toThrow();
  expect(() =>
    scheduleFor({ kind: 'once', at: '2026-11-05T13:43:00Z' }, NOW, min),
  ).toThrow(/past/);
  expect(() =>
    scheduleFor({ kind: 'every', every: 5, unit: 'minutes' }, NOW, min),
  ).toThrow(/every 15 minutes/);
  const hourly = scheduleFor(
    { kind: 'every', every: 2, unit: 'hours' },
    NOW,
    min,
  );
  expect(hourly).toEqual({
    spec: { kind: 'interval', seconds: 7200 },
    nextRunAt: NOW + 120 * MINUTE,
  });
  expect(describeSchedule(hourly.spec)).toBe('every 2 hours');
  const weekdays = scheduleFor(
    {
      kind: 'calendar',
      time: '09:00',
      weekdays: [1, 2, 3, 4, 5],
      timezone: 'America/Jamaica',
    },
    NOW,
    min,
  );
  // Friday 6 November at 12:00 in Jamaica: the next weekday 9:00 is Monday.
  expect(weekdays.nextRunAt).toBe(Date.parse('2026-11-09T14:00:00Z'));
  expect(describeSchedule(weekdays.spec)).toBe(
    'at 09:00 on Mon, Tue, Wed, Thu, Fri (America/Jamaica)',
  );
  expect(() =>
    scheduleFor(
      { kind: 'calendar', time: '09:00', timezone: 'Mars/Base' },
      NOW,
      min,
    ),
  ).toThrow(/timezone/);
});

it('schedules a one-off task at once when the owner asks, runs it once, then stops', async () => {
  const { engine, dot, call, at } = await world();
  const start = Date.now();
  const result = await call(true, 'schedule', {
    title: 'Follow up with Kimone',
    instructions: 'Ask Kimone for the validation test update.',
    when: { kind: 'once', inMinutes: 60 },
  });
  expect(result).toMatchObject({ scheduled: true });
  expect(String(result.when)).toMatch(/^once at /);
  const [schedule] = engine.schedulesFor(dot.id);
  expect(schedule).toMatchObject({
    id: result.id,
    title: 'Follow up with Kimone',
  });
  expect(engine.workItem(String(result.workItemId))).toMatchObject({
    source: 'schedule',
    recurring: 0,
  });

  at(start + 30 * MINUTE);
  expect(engine.fireDueTriggers()).toHaveLength(0);
  at(start + 61 * MINUTE);
  expect(engine.fireDueTriggers()).toHaveLength(1);
  // Done: it no longer appears and does not fire again.
  expect(engine.schedulesFor(dot.id)).toHaveLength(0);
  at(start + 10 * 24 * 60 * MINUTE);
  expect(engine.fireDueTriggers()).toHaveLength(0);
});

it('retries a one-off a minute later when its objective is busy, instead of losing it', async () => {
  const { engine, dot, call, at } = await world();
  const start = Date.now();
  const result = await call(true, 'schedule', {
    title: 'Check',
    instructions: 'Check the board.',
    when: { kind: 'once', inMinutes: 30 },
  });
  engine.enqueueExecution(String(result.workItemId));
  at(start + 31 * MINUTE);
  expect(engine.fireDueTriggers()).toHaveLength(0);
  expect(engine.schedulesFor(dot.id)).toHaveLength(1);
  expect(Number(engine.schedulesFor(dot.id)[0].nextRunAt)).toBe(
    start + 32 * MINUTE,
  );
});

it('repeats an interval schedule, and lists, changes and cancels it for the owner', async () => {
  const { engine, dot, call, at } = await world();
  const start = Date.now();
  const result = await call(true, 'schedule', {
    title: 'Ticket sweep',
    instructions: 'Check new Desk tickets and summarize them.',
    when: { kind: 'every', every: 2, unit: 'hours' },
  });
  expect(result).toMatchObject({ scheduled: true, when: 'every 2 hours' });
  at(start + 121 * MINUTE);
  expect(engine.fireDueTriggers()).toHaveLength(1);
  expect(engine.schedulesFor(dot.id)).toHaveLength(1);

  const listed = (await call(true, 'list_schedules')) as {
    schedules: { id: string; when: string }[];
  };
  expect(listed.schedules).toEqual([
    expect.objectContaining({ id: result.id, when: 'every 2 hours' }),
  ]);
  const changed = await call(true, 'change_schedule', {
    id: result.id,
    when: {
      kind: 'calendar',
      time: '08:30',
      timezone: 'America/Jamaica',
    },
    instructions: 'Check new Desk tickets and list the urgent ones first.',
  });
  expect(changed).toMatchObject({
    changed: true,
    when: 'at 08:30 every day (America/Jamaica)',
  });
  expect(engine.workItem(String(result.workItemId))?.objective).toBe(
    'Check new Desk tickets and list the urgent ones first.',
  );
  expect(await call(true, 'cancel_schedule', { id: result.id })).toMatchObject({
    cancelled: true,
  });
  expect(engine.schedulesFor(dot.id)).toHaveLength(0);
  expect(engine.workItem(String(result.workItemId))?.status).toBe('cancelled');
});

it('only proposes schedules made outside a conversation with the owner', async () => {
  const { engine, dot, call } = await world();
  const result = await call(false, 'schedule', {
    title: 'Digest',
    instructions: 'Send the digest.',
    when: { kind: 'every', every: 1, unit: 'days' },
  });
  expect(result).toMatchObject({ status: 'pending' });
  expect(engine.action(String(result.actionId))?.toolName).toBe('arm_trigger');
  expect(engine.schedulesFor(dot.id)).toHaveLength(0);
});

it('sends an approved message at its time, not before', async () => {
  const { engine, store, workspace, plugins, sent, call, at } =
    await world('ask');
  const start = Date.now();
  const result = await call(true, 'schedule', {
    title: 'Send',
    action: {
      tool: 'plugin_cliq_send',
      arguments: {
        chat: 'kimone',
        text: 'Any update on the validation tests?',
      },
    },
    when: { kind: 'once', inMinutes: 60 },
  });
  expect(result).toMatchObject({ status: 'pending' });
  const id = String(result.actionId);
  const notBefore = Number(engine.action(id)?.notBefore);
  expect(notBefore).toBeGreaterThanOrEqual(start + 60 * MINUTE);
  expect(notBefore).toBeLessThan(start + 60 * MINUTE + 5_000);

  // The owner approves now; nothing runs until the time comes.
  engine.approveAction(id, true);
  expect(engine.claimApprovedAction()).toBeNull();
  at(start + 61 * MINUTE);
  const claimed = engine.claimApprovedAction();
  expect(claimed?.id).toBe(id);
  await applyApprovedAction(
    { engine, workspace, store, plugins },
    claimed as Record<string, unknown>,
  );
  expect(sent).toEqual([
    { chat: 'kimone', text: 'Any update on the validation tests?' },
  ]);
});

it('stores an action the Pod may take without approval as approved, waiting for its time', async () => {
  const { engine, call, at } = await world('allow');
  const start = Date.now();
  const result = await call(true, 'schedule', {
    title: 'Send',
    action: {
      tool: 'functions.plugin_cliq_send',
      arguments: { chat: 'kimone', text: 'Hello' },
    },
    when: { kind: 'once', inMinutes: 30 },
  });
  expect(result).toMatchObject({ scheduled: true });
  expect(engine.action(String(result.actionId))?.status).toBe('approved');
  expect(engine.claimApprovedAction()).toBeNull();
  at(start + 31 * MINUTE);
  expect(engine.claimApprovedAction()?.id).toBe(result.actionId);
});

it('refuses to schedule an unknown tool or arguments that do not fit', async () => {
  const { call } = await world();
  await expect(
    call(true, 'schedule', {
      title: 'Send',
      action: { tool: 'plugin_cliq_delete_everything', arguments: {} },
      when: { kind: 'once', inMinutes: 30 },
    }),
  ).rejects.toThrow(/not a tool this Pod can use/);
  await expect(
    call(true, 'schedule', {
      title: 'Send',
      action: { tool: 'plugin_cliq_send', arguments: { chat: 'kimone' } },
      when: { kind: 'once', inMinutes: 30 },
    }),
  ).rejects.toThrow(/do not fit/);
});

it('asks the owner once for the tools a recurring task may use, then lets its runs use them', async () => {
  const { engine, store, workspace, plugins, dot, call } = await world('ask');
  // Even when the owner asks in chat, standing permission goes to a card.
  const result = await call(true, 'schedule', {
    title: 'Morning follow-ups',
    instructions:
      'Pull open action items and message each owner on Cliq to follow up.',
    when: {
      kind: 'calendar',
      time: '08:00',
      weekdays: [1, 2, 3, 4, 5],
      timezone: 'America/Jamaica',
    },
    allowTools: ['functions.plugin_cliq_send'],
  });
  expect(result).toMatchObject({ status: 'pending' });
  const card = engine.action(String(result.actionId))!;
  expect(JSON.parse(String(card.argumentsJson))).toMatchObject({
    runs: 'at 08:00 on Mon, Tue, Wed, Thu, Fri (America/Jamaica)',
    allowTools: ['plugin_cliq_send'],
  });
  expect(engine.schedulesFor(dot.id)).toHaveLength(0);

  engine.approveAction(String(result.actionId), true);
  await applyApprovedAction(
    { engine, workspace, store, plugins },
    engine.claimApprovedAction() as Record<string, unknown>,
  );
  expect(engine.schedulesFor(dot.id)).toHaveLength(1);
  const workItemId = String(result.workItemId);
  expect(engine.allowedTools(workItemId)).toEqual(['plugin_cliq_send']);

  const run = (item: string) => ({
    actorId: dot.id,
    ownerId: workspace.ownerId,
    workItemId: item,
    executionId: 'execution-1',
    threadId: 'thread-1',
    mode: 'background' as const,
    cause: 'continuation' as const,
  });
  const gate = (item: string, tool: string, args: Record<string, unknown>) =>
    engine.gate(
      run(item),
      tool,
      args,
      snapshotFor({ engine, workspace, store, plugins }, dot, false, item),
    );
  // The approved tool runs without a card; anything else still asks.
  expect(
    gate(workItemId, 'plugin_cliq_send', { chat: 'juanita', text: 'Hi' }),
  ).toBeNull();
  expect(
    gate(workItemId, 'plugin_cliq_archive', { chat: 'juanita' }),
  ).toMatchObject({ status: 'pending' });
  // Another objective gets no such permission.
  const other = engine.createWorkItem({
    actorId: dot.id,
    title: 'Other',
    objective: 'Other work',
    source: 'owner',
  });
  expect(
    gate(String(other.id), 'plugin_cliq_send', { chat: 'juanita', text: 'Hi' }),
  ).toMatchObject({ status: 'pending' });
});

it('repeats one exact action after the owner approves the schedule once', async () => {
  const { engine, store, workspace, plugins, dot, sent, call, at } =
    await world('ask');
  const start = Date.now();
  const result = await call(true, 'schedule', {
    title: 'Friday reminder',
    action: {
      tool: 'plugin_cliq_send',
      arguments: { chat: 'team', text: 'Timesheets are due today.' },
    },
    when: { kind: 'every', every: 1, unit: 'weeks' },
  });
  expect(result).toMatchObject({ status: 'pending' });
  engine.approveAction(String(result.actionId), true);
  await applyApprovedAction(
    { engine, workspace, store, plugins },
    engine.claimApprovedAction() as Record<string, unknown>,
  );
  const [schedule] = engine.schedulesFor(dot.id);
  expect(schedule).toBeTruthy();

  for (const week of [1, 2]) {
    at(start + week * 7 * 24 * 60 * MINUTE + MINUTE);
    expect(engine.fireDueTriggers()).toHaveLength(1);
    const claimed = engine.claimApprovedAction();
    expect(claimed?.toolName).toBe('plugin_cliq_send');
    await applyApprovedAction(
      { engine, workspace, store, plugins },
      claimed as Record<string, unknown>,
    );
  }
  expect(sent).toEqual([
    { chat: 'team', text: 'Timesheets are due today.' },
    { chat: 'team', text: 'Timesheets are due today.' },
  ]);
  // The agent never ran: the schedule's objective has no executions.
  expect(
    engine.detail(String(result.workItemId))?.executions ?? [],
  ).toHaveLength(0);
});

it('starts a repeating action at once when the Pod may already make that call', async () => {
  const { engine, dot, call } = await world('allow');
  const result = await call(true, 'schedule', {
    title: 'Daily hello',
    action: {
      tool: 'plugin_cliq_send',
      arguments: { chat: 'team', text: 'Good morning.' },
    },
    when: { kind: 'every', every: 1, unit: 'days' },
  });
  expect(result).toMatchObject({ scheduled: true, when: 'every day' });
  expect(engine.schedulesFor(dot.id)).toHaveLength(1);
});

it('cancels a declined schedule instead of running it', async () => {
  const { engine, dot, call } = await world();
  const result = await call(false, 'schedule', {
    title: 'Digest',
    instructions: 'Send the digest.',
    when: { kind: 'every', every: 1, unit: 'days' },
  });
  engine.declineAction(String(result.actionId), 'Not now.');
  expect(engine.workItem(String(result.workItemId))?.status).toBe('cancelled');
  expect(engine.claimExecution()).toBeNull();
  expect(engine.schedulesFor(dot.id)).toHaveLength(0);
});

it('needs either instructions or an action', async () => {
  const { call } = await world();
  await expect(
    call(true, 'schedule', {
      title: 'Nothing',
      when: { kind: 'once', inMinutes: 30 },
    }),
  ).rejects.toThrow(/instructions or an action/);
});
