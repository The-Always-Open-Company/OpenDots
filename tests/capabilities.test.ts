import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toJSONSchema, type ZodType } from 'zod';
import { createApp } from '../src/server/app.js';
import { decide, consultationBlocked } from '../src/server/authorize.js';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import type { MemoryProvider, MemoryScope } from '../src/server/memory.js';
import {
  assertPublicUrl,
  isBlockedAddress,
  PluginService,
  pluginFetch,
  pollFingerprint,
} from '../src/server/plugins.js';
import { Runner } from '../src/server/runner.js';
import {
  capabilityPrompt,
  proposeSchedule,
  workTools,
  type WorkDeps,
} from '../src/server/work-tools.js';
import {
  applyApprovedAction,
  approvalDenied,
} from '../src/server/approved-actions.js';
import { Store } from '../src/server/store.js';
import { deliverInternal, watchDecision } from '../src/server/watches.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  mentionedSkills,
  skillInstructions,
  loadSkills,
} from '../src/server/skills.js';
import { WorkRunner } from '../src/server/work-runner.js';

const cleanup: { close: () => void; dir?: string }[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.MAIL_TOKEN;
  cleanup.splice(0).forEach(({ close, dir }) => {
    close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
});

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-capabilities-'));
  const store = new Store(join(dir, 'open.sqlite'));
  const workspace = new WorkspaceStore(join(dir, 'open.sqlite'), 'owner');
  const engine = new ExecutionEngine(store.database);
  const plugins = new PluginService(store.database);
  const dot = workspace.dots()[0];
  cleanup.push({
    close: () => {
      store.close();
      workspace.close();
    },
    dir,
  });
  const scopes: MemoryScope[] = [];
  const notes = new Map<string, string>([['n1', 'tea']]);
  const memory: MemoryProvider = {
    search: async () => [],
    list: async (scope) => {
      scopes.push(scope);
      return [...notes].map(([id, text]) => ({
        id,
        text,
        createdAt: null,
        updatedAt: null,
      }));
    },
    add: async (scope) => {
      scopes.push(scope);
    },
    get: async (_scope, id) =>
      notes.has(id)
        ? { id, text: notes.get(id)!, createdAt: null, updatedAt: null }
        : null,
    update: async (scope, id, text) => {
      scopes.push(scope);
      if (!notes.has(id)) return false;
      notes.set(id, text);
      return true;
    },
    delete: async (scope, id) => {
      scopes.push(scope);
      return notes.delete(id);
    },
  };
  const deps = (): WorkDeps => ({
    engine,
    workspace,
    store,
    plugins,
    memory,
    skillsDir: join(dir, 'skills'),
    dot,
    threadId: 'thread-1',
    check: () => undefined,
    context: () => ({
      actorId: dot.id,
      ownerId: workspace.ownerId,
      executionId: '',
      threadId: 'thread-1',
      mode: 'interactive',
      cause: 'model',
    }),
  });
  return { dir, store, workspace, engine, plugins, dot, memory, scopes, deps };
}

async function call(
  tools: ReturnType<typeof workTools>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const tool = tools.find((item) => item.name === name);
  if (!tool?.execute) throw new Error(`${name} is missing.`);
  return tool.execute(args as never);
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('skills', () => {
  it('refuses a disabled skill, names an @mention, and does not run scripts', async () => {
    const { dir, engine, dot, deps } = world();
    const folder = join(dir, 'skills', 'brief');
    mkdirSync(join(folder, 'scripts'), { recursive: true });
    writeFileSync(
      join(folder, 'SKILL.md'),
      '---\nname: brief\ndescription: Write a short brief\n---\nUse short sentences.\n',
    );
    writeFileSync(join(folder, 'scripts', 'run.py'), 'print("no")\n');
    const loaded = loadSkills(join(dir, 'skills'));
    expect(loaded.map((skill) => skill.name)).toEqual(['brief']);
    const instructions = skillInstructions(loaded[0]);
    expect(instructions.executed).toBe(false);
    expect(instructions.scripts).toContain('scripts/run.py');
    expect(instructions.note).toMatch(/never executed/);
    expect(mentionedSkills('@brief please', ['brief'])).toEqual(['brief']);
    const prompt = capabilityPrompt({
      engine,
      dot,
      latestUser: '@brief please',
      skillsDir: join(dir, 'skills'),
    });
    expect(prompt).toMatch(/@brief is not enabled/);
    expect(prompt).not.toMatch(/Call load_skill/);
    engine.grantSkill(dot.id, 'brief');
    const enabled = capabilityPrompt({
      engine,
      dot,
      latestUser: '@brief please',
      skillsDir: join(dir, 'skills'),
    });
    expect(enabled).toMatch(/Call load_skill/);
    expect(enabled).toMatch(/brief: Write a short brief/);
    expect(enabled).toMatch(/call start_objective instead/);
    const inWork = capabilityPrompt({
      engine,
      dot,
      latestUser: 'Continue.',
      skillsDir: join(dir, 'skills'),
      inWork: true,
    });
    expect(inWork).not.toMatch(/start_objective/);
    expect(inWork).toMatch(/complete_work or fail_work/);
    await expect(
      call(workTools(deps()), 'load_skill', { name: 'brief' }),
    ).resolves.toMatchObject({
      executed: false,
    });
    engine.revokeSkill(dot.id, 'brief');
    await expect(
      call(workTools(deps()), 'load_skill', { name: 'brief' }),
    ).rejects.toThrow(/not enabled/);
  });

  it('creates, edits, grants, and deletes skills through the API', async () => {
    const { dir, store, engine, plugins, dot } = world();
    const skillsDir = join(dir, 'skills');
    const app = createApp({
      store,
      runner: new Runner(store, { mode: 'sample', baseUrl: '' }),
      config: { mode: 'sample', baseUrl: '' },
      engine,
      plugins,
      skillsDir,
    });
    const skill = (description: string) =>
      `\uFEFF---\r\nname: brief\r\ndescription: ${description}\r\n---\r\nUse short sentences.\r\n`;
    const send = (path: string, method: string, body: unknown) =>
      app.request(path, { ...json(body), method });

    const created = await send('/api/skills', 'POST', {
      markdown: skill('Write a brief'),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      name: 'brief',
      description: 'Write a brief',
    });
    expect(
      (await send('/api/skills', 'POST', { markdown: skill('Again') })).status,
    ).toBe(409);
    expect(
      (
        await send('/api/skills', 'POST', {
          markdown: '---\nname: Bad Name\ndescription: x\n---\nBody\n',
        })
      ).status,
    ).toBe(400);

    expect(
      (await send(`/api/dots/${dot.id}/skills`, 'POST', { name: 'brief' }))
        .status,
    ).toBe(200);
    expect(
      (await send(`/api/dots/${dot.id}/skills`, 'POST', { name: 'missing' }))
        .status,
    ).toBe(404);
    const listed = (await (await app.request('/api/skills')).json()) as {
      name: string;
      dotIds: string[];
    }[];
    expect(listed).toEqual([
      expect.objectContaining({ name: 'brief', dotIds: [dot.id] }),
    ]);

    const renamed = await send('/api/skills/brief', 'PUT', {
      markdown: '---\nname: other\ndescription: x\n---\nBody\n',
    });
    expect(renamed.status).toBe(400);
    expect(
      (await send('/api/skills/nope', 'PUT', { markdown: skill('x') })).status,
    ).toBe(400);
    expect(
      (await send('/api/skills/brief', 'PUT', { markdown: skill('Updated') }))
        .status,
    ).toBe(200);
    const full = (await (await app.request('/api/skills/brief')).json()) as {
      description: string;
      markdown: string;
    };
    expect(full.description).toBe('Updated');
    expect(full.markdown).not.toMatch(/\r|\uFEFF/);

    expect((await send('/api/skills/brief', 'DELETE', {})).status).toBe(200);
    expect((await send('/api/skills/brief', 'DELETE', {})).status).toBe(404);
    expect((await app.request('/api/skills/brief')).status).toBe(404);
    expect(engine.skillGrants().size).toBe(0);
    expect(loadSkills(skillsDir)).toEqual([]);
  });
});

describe('plugins', () => {
  it('rejects private addresses and redirects, and drops a stale schema and tokens', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(assertPublicUrl('http://127.0.0.1/mcp')).rejects.toThrow(
        /production/,
      );
    } finally {
      process.env.NODE_ENV = previous;
    }
    await expect(assertPublicUrl('https://10.0.0.5/mcp')).rejects.toThrow(
      /private/,
    );
    await expect(
      assertPublicUrl('https://169.254.169.254/latest'),
    ).rejects.toThrow(/private/);
    await expect(
      assertPublicUrl('https://plugins.example/mcp', (async () => [
        { address: '192.168.1.9', family: 4 },
      ]) as never),
    ).rejects.toThrow(/private/);
    for (const mapped of ['::ffff:127.0.0.1', '::ffff:a00:5', '64:ff9b::a00:5'])
      expect(isBlockedAddress(mapped)).toBe(true);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await pluginFetch('http://127.0.0.1/mcp');
    const init = (
      fetchMock.mock.calls as unknown as [string, RequestInit][]
    )[0]?.[1];
    expect(init).toMatchObject({ redirect: 'error' });
    expect(init).toHaveProperty('dispatcher');

    const { store, engine, dot } = world();
    let version = 1;
    process.env.MAIL_TOKEN = 'super-secret-token';
    const plugins = new PluginService(store.database, {
      listTools: async () => [
        {
          name: 'send',
          description: version === 1 ? 'Send mail' : 'Send mail differently',
          schema: {
            type: 'object',
            properties:
              version === 1
                ? { text: { type: 'string' } }
                : { body: { type: 'string' } },
          },
        },
      ],
      callTool: async () => ({ note: 'token super-secret-token' }),
    });
    plugins.save({
      id: 'mail',
      name: 'Mail',
      url: 'http://127.0.0.1/mcp',
      tokenEnv: 'MAIL_TOKEN',
    });
    await plugins.refresh('mail');
    plugins.grant(dot.id, 'mail', 'send', 'allow');
    expect(plugins.definitions(dot.id)).toHaveLength(1);
    const result = await plugins.call(dot.id, 'mail', 'send', {});
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
    expect(JSON.stringify(result)).toContain('[redacted]');
    const item = engine.createWorkItem({
      actorId: dot.id,
      title: 'Mail',
      objective: 'Send it',
      source: 'owner',
    });
    const begun = engine.beginEffect(
      String(item.id),
      null,
      'plugin_mail_send',
      {},
      false,
    );
    if (begun.action !== 'run') throw new Error('expected a new operation');
    engine.completeEffect(
      String(item.id),
      'plugin_mail_send',
      begun.operationId,
      'succeeded',
      result,
    );
    expect(
      JSON.stringify(engine.detail(String(item.id))?.events),
    ).not.toContain('super-secret-token');
    version = 2;
    expect((await plugins.refresh('mail')).stale).toBe(true);
    expect(plugins.allowed(dot.id, 'mail', 'send')).toBe(false);
    expect(plugins.definitions(dot.id)).toHaveLength(0);
    await plugins.refresh('mail', true);
    expect(plugins.allowed(dot.id, 'mail', 'send')).toBe(false);
    plugins.grant(dot.id, 'mail', 'send', 'allow');
    expect(plugins.allowed(dot.id, 'mail', 'send')).toBe(true);
    expect(pollFingerprint({ n: 1, timestamp: 1, requestId: 'a' })).toBe(
      pollFingerprint({ n: 1, timestamp: 9, fetchedAt: 3 }),
    );
  });
});

describe('delegation and consultation', () => {
  it('does not enqueue a parent for a non-blocking child, and waits on one child once', async () => {
    const { engine, dot, workspace, deps } = world();
    const other = workspace.createDot(
      dot.spaceId,
      'Expert',
      'Helps.',
      true,
      true,
      [dot.spaceId],
      true,
    );
    const quiet = workspace.createDot(
      dot.spaceId,
      'Quiet',
      'Private.',
      true,
      true,
      [dot.spaceId],
      false,
    );
    const parent = engine.createWorkItem({
      actorId: dot.id,
      title: 'Parent',
      objective: 'Own the outcome',
      source: 'owner',
      autoResume: false,
    });
    const ignored = engine.delegate({
      parentWorkItemId: String(parent.id),
      actorId: other.id,
      title: 'Aside',
      objective: 'Look around',
      blocking: false,
    });
    const waited = engine.delegate({
      parentWorkItemId: String(parent.id),
      actorId: other.id,
      title: 'Needed',
      objective: 'Answer this',
      blocking: false,
    });
    const aside = engine.claimExecution();
    expect(aside?.workItemId).toBe(ignored.workItemId);
    engine.setFinishIntent(String(aside?.id), 'complete');
    engine.finishExecution(String(aside?.id), 'completed');
    expect(engine.detail(String(parent.id))?.executions).toHaveLength(0);
    engine.waitFor(String(parent.id), [waited.workItemId]);
    expect(engine.workItem(String(parent.id))?.status).toBe(
      'waiting_for_dependency',
    );
    const needed = engine.claimExecution();
    expect(needed?.workItemId).toBe(waited.workItemId);
    engine.setFinishIntent(String(needed?.id), 'complete');
    engine.finishExecution(String(needed?.id), 'completed');
    expect(engine.detail(String(parent.id))?.executions).toHaveLength(1);
    expect(consultationBlocked('start_delegation')).toBe(true);
    expect(consultationBlocked('ask_dot')).toBe(false);
    expect(consultationBlocked('load_skill')).toBe(false);
    expect(
      decide(
        {
          actorId: dot.id,
          ownerId: 'owner',
          executionId: 'exec',
          threadId: 'consult',
          mode: 'interactive',
          cause: 'model',
        },
        'start_delegation',
        {},
        {
          paused: false,
          cancelled: false,
          consultation: true,
          researchAllowed: true,
          memoryAllowed: true,
          spaceAllowed: () => true,
          documentAllowed: () => true,
          pluginAllowed: () => true,
          skillAllowed: () => true,
          rules: [],
          blockedOnConsultation: new Set(),
        },
      ).effect,
    ).toBe('block');
    await expect(
      call(workTools(deps()), 'start_delegation', {
        dotId: quiet.id,
        title: 'Nope',
        objective: 'This should fail',
      }),
    ).rejects.toThrow(/not available/);
  });
});

describe('approvals', () => {
  it('declines an approval whose permission was revoked, but not one that is only paused', () => {
    const { store, workspace, engine, plugins, dot } = world();
    const item = engine.createWorkItem({
      actorId: dot.id,
      title: 'Note',
      objective: 'Remember tea',
      source: 'owner',
    });
    const { pendingActionId } = engine.proposeAction({
      executionId: null,
      workItemId: String(item.id),
      actorId: dot.id,
      threadId: 'thread',
      toolName: 'remember',
      arguments: { text: 'Prefers tea.' },
    });
    const deps = { engine, workspace, store, plugins };
    const action = () => engine.action(pendingActionId)!;
    store.updateSettings({ paused: true });
    expect(approvalDenied(deps, action())).toBeNull();
    store.updateSettings({ paused: false, memoryAllowed: false });
    expect(approvalDenied(deps, action())).toMatch(/memor/i);
  });
});

describe('notes, profile, schedules, and wakes', () => {
  it('gives the model the interval and calendar schedule shapes', () => {
    const { deps } = world();
    const tools = workTools(deps());
    const propose = tools.find((tool) => tool.name === 'propose_schedule');
    const update = tools.find((tool) => tool.name === 'update_schedule');
    const proposeSchema = propose?.parameters as ZodType;
    const updateSchema = update?.parameters as ZodType;
    const minute = { kind: 'interval', seconds: 60 };
    const clock = {
      kind: 'calendar',
      timezone: 'America/New_York',
      weekdays: [1, 2, 3, 4, 5],
      minuteOfDay: 9 * 60,
    };
    expect(
      proposeSchema.safeParse({
        title: 'Hello',
        objective: 'Say hello',
        spec: minute,
      }).success,
    ).toBe(true);
    expect(
      proposeSchema.safeParse({
        title: 'Hello',
        objective: 'Say hello',
        spec: clock,
      }).success,
    ).toBe(true);
    expect(
      proposeSchema.safeParse({
        title: 'Hello',
        objective: 'Say hello',
        spec: { every: '1 minute' },
      }).success,
    ).toBe(false);
    expect(
      proposeSchema.safeParse({
        title: 'Hello',
        objective: 'Say hello',
        spec: { kind: 'interval', seconds: 30 },
      }).success,
    ).toBe(false);
    expect(
      updateSchema.safeParse({ triggerId: 't', spec: minute }).success,
    ).toBe(true);
    const published = JSON.stringify(toJSONSchema(proposeSchema));
    for (const field of [
      'interval',
      'calendar',
      'seconds',
      'timezone',
      'weekdays',
      'minuteOfDay',
    ])
      expect(published).toContain(field);
  });

  it('keeps note changes in this Dot’s scope and arms a schedule only after approval', async () => {
    const { engine, workspace, store, plugins, dot, deps, scopes, memory } =
      world();
    const tools = workTools(deps());
    await call(tools, 'list_notes');
    await call(tools, 'update_note', { id: 'n1', text: 'tea at four' });
    await call(tools, 'forget', { id: 'n1' });
    expect(
      scopes.every(
        (scope) => scope.userId === 'owner' && scope.dotId === dot.id,
      ),
    ).toBe(true);
    const pending = await proposeSchedule(deps(), {
      title: 'Digest',
      objective: 'Send the morning digest',
      spec: { kind: 'interval', seconds: 3600 },
    });
    expect(engine.detail(pending.workItemId)?.triggers).toHaveLength(0);
    const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
    const app = createApp({
      store,
      runner,
      config: { mode: 'sample', baseUrl: '' },
      engine,
      plugins,
    });
    const approved = await app.request(
      `/api/actions/${pending.actionId}/approve`,
      json({}),
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({
      status: 'approved',
      actionId: pending.actionId,
    });
    expect(engine.detail(pending.workItemId)?.triggers).toHaveLength(0);
    const claimed = engine.claimApprovedAction();
    expect(claimed?.status).toBe('executing');
    await applyApprovedAction(
      { engine, workspace, store, plugins, memory },
      claimed as Record<string, unknown>,
    );
    expect(engine.detail(pending.workItemId)?.triggers).toHaveLength(1);

    const before = workspace.dot(dot.id)!;
    const profile = await call(tools, 'propose_profile', {
      name: 'Nova',
      mascot: 'mint',
    });
    expect(workspace.dot(dot.id)?.name).toBe(before.name);
    expect(workspace.dot(dot.id)?.instructions).toBe(before.instructions);
    const actionId = (profile as { actionId: string }).actionId;
    const profileApproved = await app.request(
      `/api/actions/${actionId}/approve`,
      json({}),
    );
    expect((await profileApproved.json()) as { status: string }).toMatchObject({
      status: 'approved',
    });
    expect(workspace.dot(dot.id)?.name).toBe(before.name);
    const profileClaim = engine.claimApprovedAction();
    await applyApprovedAction(
      { engine, workspace, store, plugins, memory },
      profileClaim as Record<string, unknown>,
    );
    expect(workspace.dot(dot.id)?.name).toBe('Nova');
    expect(workspace.dot(dot.id)?.instructions).toBe(before.instructions);
    expect(workspace.dot(dot.id)?.mascot).toBe('mint');
  });

  it('rejects an early wake, then closes a responsibility without disarming the wake early', async () => {
    const { engine, dot, deps } = world();
    const tools = workTools(deps());
    await expect(
      call(tools, 'upsert_responsibility', {
        title: 'Standup',
        notes: 'Check the board',
        wakeAt: Date.now() + 5 * 60_000,
      }),
    ).rejects.toThrow(/15 minutes/);
    engine.savePolicy(dot.id, { minWakeIntervalMs: 5 * 60_000 });
    const saved = (await call(tools, 'upsert_responsibility', {
      title: 'Standup',
      notes: 'Check the board',
      wakeAt: Date.now() + 6 * 60_000,
    })) as { workItemId: string };
    expect(engine.workItem(saved.workItemId)?.source).toBe('responsibility');
    const listed = (await call(tools, 'list_responsibilities')) as {
      id: string;
    }[];
    expect(listed.map((item) => item.id)).toContain(saved.workItemId);

    const executionId = engine.enqueueExecution(saved.workItemId)!;
    engine.claimExecution();
    const trigger = engine.detail(saved.workItemId)?.triggers[0] as {
      enabled?: number;
    };
    await call(tools, 'close_responsibility', { id: saved.workItemId });
    expect(engine.execution(executionId)?.finishIntent).toBe('complete');
    expect(
      Number(
        engine.trigger(
          String(
            (engine.detail(saved.workItemId)?.triggers[0] as { id: string }).id,
          ),
        )?.enabled,
      ),
    ).toBe(1);
    expect(Number(trigger.enabled)).toBe(1);
    engine.finishExecution(executionId, 'completed');
    expect(engine.workItem(saved.workItemId)?.status).toBe('completed');
    expect(
      Number(
        engine.trigger(
          String(
            (engine.detail(saved.workItemId)?.triggers[0] as { id: string }).id,
          ),
        )?.enabled,
      ),
    ).toBe(0);
  });

  it('sets the default wake when an attempt ends without a next check', () => {
    const { engine, dot } = world();
    const item = engine.createWorkItem({
      actorId: dot.id,
      title: 'Watch the queue',
      objective: 'Look again later',
      source: 'responsibility',
      recurring: true,
    });
    engine.addTrigger({
      workItemId: String(item.id),
      actorId: dot.id,
      kind: 'wake',
      spec: { kind: 'interval', seconds: 3600 },
      nextRunAt: Date.now() - 1000,
      enabled: true,
      dotCanManage: true,
    });
    const executionId = engine.enqueueExecution(String(item.id))!;
    engine.claimExecution();
    engine.finishExecution(executionId, 'completed');
    const next = Number(
      (engine.detail(String(item.id))?.triggers[0] as { nextRunAt?: number })
        .nextRunAt,
    );
    expect(engine.workItem(String(item.id))?.status).toBe('open');
    expect(next).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
  });
});

describe('watches', () => {
  it('persists a webhook before enqueue, dedups, pauses, and dead-letters', async () => {
    const { store, workspace, engine, plugins, dot } = world();
    const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
    const app = createApp({
      store,
      runner,
      config: { mode: 'sample', baseUrl: '' },
      engine,
      plugins,
    });
    const created = await app.request(
      '/api/watches',
      json({
        dotId: dot.id,
        title: 'Inbox',
        objective: 'Read new mail',
        watchKind: 'webhook',
      }),
    );
    expect(created.status).toBe(201);
    const watch = (await created.json()) as { id: string; secret: string };
    const deliver = (key: string) =>
      app.request(`/api/hooks/${watch.id}`, {
        method: 'POST',
        headers: {
          'X-OpenDots-Token': watch.secret,
          'Idempotency-Key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: key, hello: true }),
      });
    const first = await deliver('evt-1');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, duplicate: false });
    const stored = store.database
      .prepare('SELECT status FROM inbound_events WHERE watchId=?')
      .all(watch.id) as { status: string }[];
    expect(stored).toEqual([{ status: 'stored' }]);
    expect(
      engine.enqueueStoredEvents((event) =>
        watchDecision(engine, store, workspace, event),
      ),
    ).toBe(1);
    expect(
      engine.detail(String(engine.trigger(watch.id)?.workItemId))?.executions,
    ).toHaveLength(1);
    const again = await deliver('evt-1');
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect(
      (
        store.database
          .prepare('SELECT COUNT(*) AS n FROM inbound_events WHERE watchId=?')
          .get(watch.id) as { n: number }
      ).n,
    ).toBe(1);

    store.updateSettings({ paused: true });
    const paused = await deliver('evt-2');
    expect(paused.status).toBe(200);
    expect(
      engine.enqueueStoredEvents((event) =>
        watchDecision(engine, store, workspace, event),
      ),
    ).toBe(0);
    const held = store.database
      .prepare("SELECT status FROM inbound_events WHERE dedupKey='evt-2'")
      .get() as { status: string };
    expect(held.status).toBe('stored');
    store.updateSettings({ paused: false });

    const other = workspace.createSpace('Other', '');
    engine.addTrigger({
      workItemId: String(
        engine.createWorkItem({
          actorId: dot.id,
          title: 'Pages',
          objective: 'Notice edits',
          source: 'watch',
        }).id,
      ),
      actorId: dot.id,
      kind: 'watch',
      spec: {
        watchKind: 'internal',
        event: 'page.updated',
        spaceId: dot.spaceId,
      },
      enabled: true,
    });
    workspace.updateDot(dot.id, {
      name: dot.name,
      instructions: dot.instructions,
      researchAllowed: dot.researchAllowed,
      memoryAllowed: dot.memoryAllowed,
      spaceId: other.id,
      spaceIds: [other.id],
    });
    deliverInternal(engine, workspace, 'page.updated', {
      id: 'page-1',
      spaceId: dot.spaceId,
      revision: 1,
    });
    expect(
      (
        store.database
          .prepare(
            "SELECT COUNT(*) AS n FROM inbound_events WHERE payload LIKE '%page-1%'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);

    const leftover = engine.claimExecution();
    if (leftover) engine.finishExecution(String(leftover.id), 'cancelled');
    const now = 1_800_000_000_000;
    const clock = new ExecutionEngine(store.database, () => now);
    const watched = clock.createWorkItem({
      actorId: dot.id,
      title: 'Retries',
      objective: 'Try the event',
      source: 'watch',
      autoResume: false,
    });
    const triggerId = clock.addTrigger({
      workItemId: String(watched.id),
      actorId: dot.id,
      kind: 'watch',
      spec: { watchKind: 'webhook' },
      enabled: true,
    });
    const inbound = clock.acceptWebhook(
      triggerId,
      'retry-me',
      '{"id":"retry-me"}',
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const executionId = clock.enqueueExecution(String(watched.id))!;
      store.database
        .prepare(
          "UPDATE inbound_events SET status='queued', executionId=?, nextAttemptAt=NULL WHERE id=?",
        )
        .run(executionId, inbound.id);
      const claim = clock.claimExecution();
      clock.finishExecution(String(claim?.id), 'failed', 'downstream failed');
      clock.settleInbound(String(claim?.id), 'failed');
    }
    const dead = store.database
      .prepare('SELECT status, attempts FROM inbound_events WHERE id=?')
      .get(inbound.id) as { status: string; attempts: number };
    expect(dead).toEqual({ status: 'dead', attempts: 4 });
    const replay = clock.replayInbound(String(inbound.id));
    expect(replay?.duplicate).toBe(false);
  });

  it('does not call a plugin poll that authorize rejects', async () => {
    const { store, workspace, engine, dot } = world();
    const calls: string[] = [];
    const plugins = new PluginService(store.database, {
      callTool: async () => {
        calls.push('called');
        return { ok: true };
      },
    });
    plugins.save({
      id: 'mail',
      name: 'Mail',
      url: 'http://127.0.0.1/mcp',
      tokenEnv: 'MAIL_TOKEN',
    });
    const item = engine.createWorkItem({
      actorId: dot.id,
      title: 'Poll',
      objective: 'Check mail',
      source: 'watch',
    });
    engine.addTrigger({
      workItemId: String(item.id),
      actorId: dot.id,
      kind: 'watch',
      spec: {
        watchKind: 'poll',
        pluginId: 'mail',
        toolName: 'send',
        intervalMs: 60_000,
      },
      nextRunAt: 0,
      enabled: true,
    });
    const work = new WorkRunner(
      engine,
      store,
      workspace,
      plugins,
      async () => undefined,
      async () => undefined,
    );
    await work.tick();
    await vi.waitFor(() =>
      expect(JSON.stringify(engine.detail(String(item.id))?.events)).toContain(
        'auth_denied',
      ),
    );
    expect(calls).toHaveLength(0);
    work.stop();
  });
});
