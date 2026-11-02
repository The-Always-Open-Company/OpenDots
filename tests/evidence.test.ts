import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import {
  ExecutionEngine,
  type EffectAccess,
} from '../src/server/execution-engine.js';
import type { ExecutionContext } from '../src/server/authorize.js';
import {
  guardTools,
  retryRead,
  workTools,
  type WorkDeps,
} from '../src/server/work-tools.js';
import { workReport } from '../src/server/work-reports.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

const READ: EffectAccess = { access: 'read', source: 'annotation' };
const WRITE: EffectAccess = { access: 'write', source: 'default' };

/**
 * One engine, a job, and the tools a background attempt sees: logged plugin
 * tools that behave as scripted, plus the real work tools.
 */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-evidence-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  cleanup.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let clock = 1_000_000;
  const engine = new ExecutionEngine(db, () => clock);
  const workItemId = String(
    engine.createWorkItem({
      actorId: 'dot',
      title: 'Daily summary',
      objective: "Summarize today's Cliq messages",
      source: 'owner',
      autoResume: true,
      originThreadId: 'chat',
    }).id,
  );
  let executionId = '';
  const context = (): ExecutionContext => ({
    actorId: 'dot',
    ownerId: 'owner',
    executionId,
    workItemId,
    threadId: 'work-thread',
    mode: 'background',
    cause: 'continuation',
  });
  const behaviour: Record<string, (args: Record<string, unknown>) => unknown> =
    {};
  const plugin = (name: string) =>
    ({
      name,
      execute: async (args: Record<string, unknown>) => behaviour[name]!(args),
    }) as unknown as ToolDefinition;
  const deps = {
    engine,
    workspace: { ownerId: 'owner' },
    store: { settings: () => ({ memoryAllowed: false }) },
    plugins: {},
    skillsDir: dir,
    dot: { id: 'dot', memoryAllowed: false },
    threadId: 'work-thread',
    check: () => undefined,
    context,
  } as unknown as WorkDeps;
  const tools = () =>
    guardTools(
      [
        plugin('plugin_cliq_get_messages'),
        plugin('plugin_cliq_send_message'),
        ...workTools(deps),
      ],
      {
        engine,
        context,
        snapshot: () => ({
          paused: false,
          cancelled: false,
          consultation: false,
          researchAllowed: true,
          memoryAllowed: true,
          spaceAllowed: () => true,
          documentAllowed: () => true,
          pluginAllowed: () => true,
          skillAllowed: () => true,
          blockedOnConsultation: new Set<string>(),
        }),
        ensureWork: () => workItemId,
        idempotent: () => false,
        access: (name) => (name.includes('get_') ? READ : WRITE),
      },
    );
  const call = (name: string, args: Record<string, unknown> = {}) =>
    tools().find((tool) => tool.name === name)!.execute!(
      args as never,
    ) as Promise<Record<string, unknown>>;
  const start = () => {
    engine.enqueueExecution(workItemId);
    const claimed = engine.claimExecution();
    if (!claimed) throw new Error('Nothing to claim.');
    executionId = String(claimed.id);
    return executionId;
  };
  return {
    db,
    engine,
    workItemId,
    behaviour,
    call,
    start,
    claimRetry: () => {
      clock += 10_000_000;
      const claimed = engine.claimExecution();
      if (!claimed) throw new Error('No retry was queued.');
      executionId = String(claimed.id);
      return executionId;
    },
    finish: (outcome: 'completed' | 'interrupted' = 'completed') =>
      engine.finishExecution(executionId, outcome, undefined, {
        retry: outcome === 'interrupted',
      }),
    status: () => String(engine.workItem(workItemId)?.status),
  };
}

const sales = {
  key: 'sales',
  label: "Today's #sales messages",
  tool: 'plugin_cliq_get_messages',
  match: { channel: 'sales' },
};

describe('declared sources', () => {
  it('refuses completion before any declaration, inside the same attempt', async () => {
    const w = world();
    w.start();
    const first = await w.call('complete_work', {});
    expect(first).toMatchObject({ finishIntent: null });
    expect(String(first.error)).toMatch(/declare_requirements/);
    expect(w.engine.hasActiveExecution(w.workItemId)).toBe(true);
    await w.call('complete_work', {});
    // The third refusal records completion with the gap instead of arguing.
    const third = await w.call('complete_work', {});
    expect(third.finishIntent).toBe('complete');
    w.finish();
    expect(w.status()).toBe('completed');
    expect(w.engine.gaps(w.workItemId)[0]?.text).toMatch(/never named/);
  });

  it('completes with no tool calls after an explicit empty declaration', async () => {
    const w = world();
    w.start();
    await w.call('complete_work', { sources: [] });
    w.finish();
    expect(w.status()).toBe('completed');
    expect(w.engine.gaps(w.workItemId)).toEqual([]);
  });

  it('is satisfied by a call with matching arguments, even an empty result', async () => {
    const w = world();
    w.start();
    w.behaviour.plugin_cliq_get_messages = () => ({ messages: [] });
    await w.call('declare_requirements', { sources: [sales] });
    await w.call('plugin_cliq_get_messages', { channel: 'general' });
    let declared = (await w.call('declare_requirements', { sources: [] }))
      .sources as { status: string }[];
    expect(declared[0]?.status).toBe('pending');
    await w.call('plugin_cliq_get_messages', {
      channel: 'Sales',
      day: 'today',
    });
    declared = (await w.call('declare_requirements', { sources: [] }))
      .sources as { status: string }[];
    expect(declared[0]?.status).toBe('satisfied');
    const done = await w.call('complete_work', {});
    expect(done).not.toHaveProperty('unmet');
    w.finish();
    expect(w.status()).toBe('completed');
    expect(w.engine.gaps(w.workItemId)).toEqual([]);
  });

  it('satisfies a source declared after it was already read', async () => {
    const w = world();
    w.start();
    w.behaviour.plugin_cliq_get_messages = () => ({ messages: [{ id: 1 }] });
    await w.call('plugin_cliq_get_messages', { channel: 'sales' });
    await w.call('complete_work', { sources: [sales] });
    w.finish();
    expect(w.engine.gaps(w.workItemId)).toEqual([]);
  });

  it('closes with a gap, not a false success, when a declared read fails', async () => {
    const w = world();
    w.start();
    w.behaviour.plugin_cliq_get_messages = () => {
      throw new Error('Cliq timed out');
    };
    await w.call('declare_requirements', { sources: [sales] });
    await expect(
      w.call('plugin_cliq_get_messages', { channel: 'sales' }),
    ).rejects.toThrow('Cliq timed out');
    const done = await w.call('complete_work', {});
    expect(done.unmet).toHaveLength(1);
    w.finish();
    // One attempt: the job closes and the report names what is missing.
    expect(w.status()).toBe('completed');
    expect(w.engine.hasActiveExecution(w.workItemId)).toBe(false);
    const gaps = w.engine.gaps(w.workItemId);
    expect(gaps).toEqual([
      {
        kind: 'source',
        text: "Today's #sales messages could not be read (Cliq timed out), so anything from it may be missing.",
      },
    ]);
  });

  it('does not count a withdrawn source', async () => {
    const w = world();
    w.start();
    await w.call('declare_requirements', { sources: [sales] });
    await w.call('declare_requirements', {
      sources: [],
      withdraw: [{ key: 'sales', reason: 'The owner left #sales.' }],
    });
    await w.call('complete_work', {});
    w.finish();
    expect(w.engine.gaps(w.workItemId)).toEqual([]);
  });

  it('lets work created before this change finish without a declaration', async () => {
    const w = world();
    w.db.prepare('UPDATE work_items SET evidenceRequired=0').run();
    w.start();
    expect((await w.call('complete_work', {})).finishIntent).toBe('complete');
    w.finish();
    expect(w.status()).toBe('completed');
  });
});

describe('writes that may have happened', () => {
  it('reports an unconfirmed write instead of queuing more attempts', async () => {
    const w = world();
    w.start();
    w.behaviour.plugin_cliq_send_message = () => {
      throw new Error('socket hang up');
    };
    expect(
      await w.call('plugin_cliq_send_message', { text: 'Summary' }),
    ).toMatchObject({ status: 'uncertain' });
    await w.call('complete_work', { sources: [] });
    w.finish();
    expect(w.status()).toBe('completed');
    expect(w.engine.hasActiveExecution(w.workItemId)).toBe(false);
    expect(w.engine.gaps(w.workItemId)[0]).toMatchObject({
      kind: 'write',
      text: expect.stringMatching(/cannot confirm/),
    });
  });

  it('settles a write only with a logged read, not a sentence', async () => {
    const w = world();
    w.start();
    w.behaviour.plugin_cliq_send_message = () => {
      throw new Error('socket hang up');
    };
    const sent = await w.call('plugin_cliq_send_message', { text: 'Hi' });
    const reconcile = (checkedWith?: string) =>
      w.call('record_reconciliation', {
        workItemId: w.workItemId,
        operationId: sent.operationId,
        evidence: 'It was sent.',
        ...(checkedWith ? { checkedWith } : {}),
      });
    expect(await reconcile('plugin_cliq_get_messages')).toMatchObject({
      reconciled: false,
    });
    w.behaviour.plugin_cliq_get_messages = () => ({ messages: [{ id: 9 }] });
    await w.call('plugin_cliq_get_messages', { channel: 'sales' });
    expect(await reconcile('plugin_cliq_get_messages')).toEqual({
      reconciled: true,
    });
    await w.call('complete_work', { sources: [] });
    w.finish();
    expect(w.engine.gaps(w.workItemId)).toEqual([]);
  });
});

describe('retries', () => {
  it('tells a timed-out attempt what it already saved', async () => {
    const w = world();
    w.start();
    w.behaviour.plugin_cliq_send_message = () => ({ ok: true });
    await w.call('plugin_cliq_send_message', { text: 'Summary' });
    w.finish('interrupted');
    w.claimRetry();
    expect(w.engine.continuationPrompt(w.workItemId)).toMatch(
      /Already done in earlier attempts\. Do not repeat these:\nplugin_cliq_send_message/,
    );
  });

  it('stops after two attempts in a row that find nothing new', async () => {
    const w = world();
    w.behaviour.plugin_cliq_get_messages = () => ({ messages: [{ id: 1 }] });
    w.start();
    await w.call('plugin_cliq_get_messages', { channel: 'sales' });
    w.finish('interrupted');
    // Same search, same result: activity, not progress.
    w.claimRetry();
    await w.call('plugin_cliq_get_messages', { channel: 'sales' });
    w.finish('interrupted');
    w.claimRetry();
    await w.call('plugin_cliq_get_messages', { channel: 'sales' });
    w.finish('interrupted');
    expect(w.status()).toBe('failed');
    expect(w.engine.hasActiveExecution(w.workItemId)).toBe(false);
    expect(w.engine.gaps(w.workItemId).at(-1)?.kind).toBe('stalled');
  });

  it('keeps going while each attempt finds something new', async () => {
    const w = world();
    let page = 0;
    w.behaviour.plugin_cliq_get_messages = () => ({
      messages: [{ id: (page += 1) }],
    });
    w.start();
    await w.call('plugin_cliq_get_messages', { channel: 'sales' });
    w.finish('interrupted');
    w.claimRetry();
    await w.call('plugin_cliq_get_messages', { channel: 'sales' });
    w.finish('interrupted');
    w.claimRetry();
    await w.call('plugin_cliq_get_messages', { channel: 'sales' });
    w.finish('interrupted');
    expect(w.status()).toBe('open');
    expect(w.engine.hasActiveExecution(w.workItemId)).toBe(true);
  });

  it('closes an attempt that only reasons over what it has, then completes', async () => {
    const w = world();
    w.behaviour.plugin_cliq_get_messages = () => ({ messages: [{ id: 1 }] });
    w.start();
    await w.call('declare_requirements', { sources: [sales] });
    await w.call('plugin_cliq_get_messages', { channel: 'sales' });
    w.finish('interrupted');
    w.claimRetry();
    await w.call('complete_work', {});
    w.finish();
    expect(w.status()).toBe('completed');
    expect(w.engine.gaps(w.workItemId)).toEqual([]);
  });
});

describe('reports', () => {
  it('lists gaps after the written result', async () => {
    const w = world();
    w.start();
    w.behaviour.plugin_cliq_get_messages = () => {
      throw new Error('Cliq timed out');
    };
    await w.call('declare_requirements', { sources: [sales] });
    await w
      .call('plugin_cliq_get_messages', { channel: 'sales' })
      .catch(() => undefined);
    await w.call('complete_work', {});
    w.finish();
    const report = workReport(
      w.engine,
      {
        chatThread: (id: string) => id,
        requireThread: () => ({ dotId: 'dot' }),
        threads: () => [],
      } as never,
      w.workItemId,
      { outcome: 'completed' },
    );
    expect(report?.label).toMatch(/finished/);
    expect(report?.text).toMatch(
      /What may be missing\*\*\n- Today's #sales messages could not be read/,
    );
  });

  it("puts a child's gaps in the parent's next prompt", async () => {
    const parent = world();
    // A finished child that recorded a gap.
    parent.db
      .prepare(
        'INSERT INTO work_dependencies (parentWorkItemId, childWorkItemId, blocking) VALUES (?, ?, 0)',
      )
      .run(parent.workItemId, 'child-1');
    parent.db
      .prepare(
        `INSERT INTO work_items (id, actorId, title, objective, status, recurring, source, autoResume, attemptCount, createdAt, updatedAt, gapsJson)
         VALUES ('child-1', 'dot', 'Read #sales', 'x', 'completed', 0, 'delegation', 1, 1, 0, 0, ?)`,
      )
      .run(
        JSON.stringify([{ kind: 'source', text: '#sales could not be read.' }]),
      );
    parent.start();
    expect(parent.engine.continuationPrompt(parent.workItemId)).toMatch(
      /Child objectives finished with gaps\. Name them in your result:\nRead #sales: #sales could not be read\./,
    );
  });
});

describe('read retries', () => {
  const failing = (messages: string[]) => {
    let calls = 0;
    return {
      calls: () => calls,
      call: async () => {
        const message = messages[calls];
        calls += 1;
        if (message) throw new Error(message);
        return 'ok';
      },
    };
  };
  const noWait = async () => undefined;

  it('retries a timeout once', async () => {
    const read = failing(['Request timed out']);
    await expect(retryRead(read.call, noWait)).resolves.toBe('ok');
    const twice = failing(['socket hang up', 'socket hang up']);
    await expect(retryRead(twice.call, noWait)).rejects.toThrow('socket');
    expect(twice.calls()).toBe(2);
  });

  it('waits out a short rate limit once and gives up on a long one', async () => {
    const waits: number[] = [];
    const short = failing(['429 Too Many Requests, retry after 5s']);
    await expect(
      retryRead(short.call, async (ms) => {
        waits.push(ms);
      }),
    ).resolves.toBe('ok');
    expect(waits).toEqual([5000]);
    const long = failing(['Rate limit exceeded, retry after 600 seconds']);
    await expect(retryRead(long.call, noWait)).rejects.toThrow('Rate limit');
    expect(long.calls()).toBe(1);
  });

  it('does not retry a permanent failure', async () => {
    const read = failing(['Channel not found']);
    await expect(retryRead(read.call, noWait)).rejects.toThrow('not found');
    expect(read.calls()).toBe(1);
  });
});
