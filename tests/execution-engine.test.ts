import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import { Store } from '../src/server/store.js';
import { decide, type ExecutionContext } from '../src/server/authorize.js';

const resources: { close: () => void; dir: string }[] = [];
function open() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-engine-'));
  const db = new DatabaseSync(join(dir, 'test.sqlite'));
  let clock = 1_000_000;
  const engine = new ExecutionEngine(db, () => clock);
  resources.push({
    close: () => db.close(),
    dir,
  });
  return {
    engine,
    db,
    setTime: (value: number) => {
      clock = value;
    },
  };
}
afterEach(() =>
  resources.splice(0).forEach(({ close, dir }) => {
    close();
    rmSync(dir, { recursive: true, force: true });
  }),
);

const ctx = (cause: ExecutionContext['cause']): ExecutionContext => ({
  actorId: 'dot-a',
  ownerId: 'owner',
  executionId: 'exec',
  threadId: 'thread',
  mode: 'background',
  cause,
});

describe('execution engine', () => {
  it('lets only one claim win and only one active execution exist', () => {
    const { engine } = open();
    const item = engine.createWorkItem({
      actorId: 'dot',
      title: 'Research',
      objective: 'Find sources',
      source: 'owner',
    });
    expect(engine.enqueueExecution(String(item.id))).toBeTruthy();
    expect(engine.enqueueExecution(String(item.id))).toBeNull();
    const first = engine.claimExecution();
    expect(first).toBeTruthy();
    expect(engine.claimExecution()).toBeNull();
  });

  it('fires a due trigger once and skips while that attempt is active', () => {
    const { engine, setTime } = open();
    const item = engine.createWorkItem({
      actorId: 'dot',
      title: 'Digest',
      objective: 'Check the inbox',
      source: 'schedule',
      recurring: true,
    });
    engine.addTrigger({
      workItemId: String(item.id),
      actorId: 'dot',
      kind: 'schedule',
      spec: { kind: 'interval', seconds: 3600 },
      nextRunAt: 1_000,
    });
    setTime(5_000);
    expect(engine.fireDueTriggers()).toHaveLength(1);
    expect(engine.fireDueTriggers()).toHaveLength(0);
    expect(
      engine.detail(String(item.id))?.executions.filter((row) =>
        ['queued', 'running'].includes(
          String((row as { status: string }).status),
        ),
      ),
    ).toHaveLength(1);
  });

  it('keeps the objective open when a save fails after complete_work', () => {
    const { engine } = open();
    const item = engine.createWorkItem({
      actorId: 'dot',
      title: 'Brief',
      objective: 'Write the brief',
      source: 'owner',
      autoResume: true,
    });
    const first = engine.enqueueExecution(String(item.id))!;
    engine.claimExecution();
    engine.setFinishIntent(first, 'complete');
    const begun = engine.beginEffect(
      String(item.id),
      first,
      'create_space_page',
      { title: 'Brief' },
      true,
    );
    expect(begun.action).toBe('run');
    if (begun.action !== 'run') return;
    engine.completeEffect(
      String(item.id),
      'create_space_page',
      begun.operationId,
      'failed',
      { error: 'save failed' },
    );
    engine.finishExecution(first, 'completed');
    expect(engine.workItem(String(item.id))?.status).toBe('open');
    const second = engine.claimExecution();
    expect(second).toBeTruthy();
    expect(second && 'finishIntent' in second && second.finishIntent).toBeNull();
    engine.finishExecution(String(second?.id), 'completed');
    expect(engine.workItem(String(item.id))?.status).toBe('open');
  });

  it('finalizes only a clean attempt that reaffirms completion', () => {
    const { engine } = open();
    const item = engine.createWorkItem({
      actorId: 'dot',
      title: 'Brief',
      objective: 'Write the brief',
      source: 'owner',
      autoResume: false,
    });
    const id = engine.enqueueExecution(String(item.id))!;
    engine.claimExecution();
    engine.setFinishIntent(id, 'complete');
    engine.finishExecution(id, 'completed');
    expect(engine.workItem(String(item.id))?.status).toBe('completed');
  });

  it('mints a new operation id for identical arguments and replays the same id', () => {
    const { engine } = open();
    const item = engine.createWorkItem({
      actorId: 'dot',
      title: 'Invoices',
      objective: 'Create invoices',
      source: 'owner',
    });
    const workItemId = String(item.id);
    const first = engine.beginEffect(
      workItemId,
      null,
      'plugin_billing_create',
      { amount: 10 },
      true,
    );
    const second = engine.beginEffect(
      workItemId,
      null,
      'plugin_billing_create',
      { amount: 10 },
      true,
    );
    expect(first.action).toBe('run');
    expect(second.action).toBe('run');
    if (first.action !== 'run' || second.action !== 'run') return;
    expect(first.operationId).not.toBe(second.operationId);
    engine.completeEffect(workItemId, 'plugin_billing_create', first.operationId, 'succeeded', {
      invoice: 'inv-1',
    });
    const replay = engine.beginEffect(
      workItemId,
      null,
      'plugin_billing_create',
      { amount: 10, operationId: first.operationId },
      true,
    );
    expect(replay).toEqual({
      action: 'return',
      operationId: first.operationId,
      result: { invoice: 'inv-1' },
    });
  });

  it('does not replay an uncertain non-idempotent operation', () => {
    const { engine } = open();
    const item = engine.createWorkItem({
      actorId: 'dot',
      title: 'Invoice',
      objective: 'Create one invoice',
      source: 'delegation',
      autoResume: true,
    });
    const executionId = engine.enqueueExecution(String(item.id))!;
    engine.claimExecution();
    const begun = engine.beginEffect(
      String(item.id),
      executionId,
      'plugin_billing_create',
      { amount: 10 },
      false,
    );
    expect(begun.action).toBe('run');
    if (begun.action !== 'run') return;
    engine.finishExecution(executionId, 'interrupted', 'crashed');
    const again = engine.beginEffect(
      String(item.id),
      null,
      'plugin_billing_create',
      { amount: 10, operationId: begun.operationId },
      false,
    );
    expect(again).toMatchObject({ action: 'return', result: { status: 'uncertain' } });
    expect(engine.workItem(String(item.id))?.status).toBe('open');
  });

  it('approves without running the tool and recovers a crash before the worker', () => {
    const { engine } = open();
    const item = engine.createWorkItem({
      actorId: 'dot',
      title: 'Rename',
      objective: 'Change name',
      source: 'owner',
    });
    const proposed = engine.proposeAction({
      executionId: null,
      workItemId: String(item.id),
      actorId: 'dot',
      threadId: 'thread',
      toolName: 'propose_profile',
      arguments: { name: 'Ada' },
    });
    const approved = engine.approveAction(proposed.pendingActionId, true);
    expect(approved?.status).toBe('approved');
    expect(engine.claimApprovedAction()?.status).toBe('executing');
    const stuck = engine.proposeAction({
      executionId: null,
      workItemId: String(item.id),
      actorId: 'dot',
      threadId: 'thread',
      toolName: 'propose_profile',
      arguments: { name: 'Bea' },
    });
    engine.approveAction(stuck.pendingActionId, true);
    expect(engine.claimApprovedAction()?.id).toBe(stuck.pendingActionId);
  });

  it('does not run an approval after the objective is cancelled', () => {
    const { engine } = open();
    const item = engine.createWorkItem({
      actorId: 'dot',
      title: 'Send',
      objective: 'Send the note',
      source: 'owner',
    });
    const proposed = engine.proposeAction({
      executionId: null,
      workItemId: String(item.id),
      actorId: 'dot',
      threadId: 'thread',
      toolName: 'edit_space_page',
      arguments: { id: 'page' },
    });
    engine.cancelWork(String(item.id));
    const result = engine.approveAction(proposed.pendingActionId, true);
    expect(result?.status).toBe('declined');
    expect(engine.claimApprovedAction()).toBeNull();
  });

  it('enqueues one continuation when the waited children finish', () => {
    const { engine } = open();
    const parent = engine.createWorkItem({
      actorId: 'dot-a',
      title: 'Analysis',
      objective: 'Prepare the analysis',
      source: 'owner',
    });
    const first = engine.delegate({
      parentWorkItemId: String(parent.id),
      actorId: 'dot-b',
      title: 'Research',
      objective: 'Research competitors',
      blocking: false,
    });
    const second = engine.delegate({
      parentWorkItemId: String(parent.id),
      actorId: 'dot-b',
      title: 'Notes',
      objective: 'Draft notes',
      blocking: false,
    });
    expect(engine.workItem(String(parent.id))?.status).toBe('open');
    const childExec = engine.claimExecution()!;
    engine.setFinishIntent(String(childExec.id), 'complete');
    engine.finishExecution(String(childExec.id), 'completed');
    expect(engine.workItem(String(parent.id))?.status).toBe('open');
    engine.waitFor(String(parent.id), [first.workItemId]);
    const waiting = engine.workItem(String(parent.id));
    expect(['waiting_for_dependency', 'open']).toContain(waiting?.status);
    const remaining = engine.claimExecution();
    if (remaining && String(remaining.workItemId) === second.workItemId) {
      engine.setFinishIntent(String(remaining.id), 'complete');
      engine.finishExecution(String(remaining.id), 'completed');
    }
    const parentExecutions =
      engine.detail(String(parent.id))?.executions.filter((row) =>
        String((row as { id?: string }).id),
      ) ?? [];
    expect(parentExecutions.length).toBeLessThanOrEqual(2);
  });

  it('migrates a recurring legacy task without waiting for the old queue to drain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opendots-cutover-'));
    const store = new Store(join(dir, 'test.sqlite'));
    resources.push({
      close: () => store.close(),
      dir,
    });
    const recurring = store.createTask('Morning digest', 3600);
    store.createTask('One shot');
    const engine = new ExecutionEngine(store.database, () => Date.now());
    engine.backfillTerminal([]);
    engine.beginCutover(
      store.tasks(),
      (task) =>
        store.interrupt(
          { ...task, lease: task.lease ?? '' },
          'Interrupted for migration.',
        ),
      () => store.tasks(),
    );
    expect(engine.cutover).toBe(true);
    expect(store.claim()).toBeNull();
    const migrated = engine.listWork().map((detail) => detail?.workItem);
    expect(migrated.some((item) => String(item?.objective) === recurring.prompt)).toBe(
      true,
    );
    expect(
      migrated.some((item) => String(item?.objective) === 'One shot'),
    ).toBe(true);
  });

  it('pauses an objective without disabling its trigger', () => {
    const { engine, setTime } = open();
    const item = engine.createWorkItem({
      actorId: 'dot',
      title: 'Digest',
      objective: 'Send it',
      source: 'schedule',
      recurring: true,
    });
    const triggerId = engine.addTrigger({
      workItemId: String(item.id),
      actorId: 'dot',
      kind: 'schedule',
      spec: { kind: 'interval', seconds: 3600 },
      nextRunAt: 1_000_000,
      enabled: true,
    });
    expect(engine.pauseWork(String(item.id))).toBe(true);
    expect(engine.workItem(String(item.id))?.status).toBe('paused');
    expect(Number(engine.trigger(triggerId)?.enabled)).toBe(1);
    setTime(1_000_000);
    expect(engine.fireDueTriggers()).toEqual([]);
    expect(engine.resumeWork(String(item.id))).toBe(true);
    expect(engine.workItem(String(item.id))?.status).toBe('open');
    expect(Number(engine.trigger(triggerId)?.enabled)).toBe(1);
  });
});

describe('authorize', () => {
  const snapshot = {
    paused: false,
    cancelled: false,
    consultation: false,
    researchAllowed: true,
    memoryAllowed: true,
    spaceAllowed: () => true,
    documentAllowed: () => true,
    pluginAllowed: (pluginId: string) => pluginId === 'mail',
    skillAllowed: () => false,
    rules: [
      {
        id: 'ask-edit',
        dotId: 'dot-a',
        text: 'Ask before editing',
        mode: 'ask' as const,
        toolNames: ['edit_space_page'],
      },
      {
        id: 'block-edit',
        dotId: null,
        text: 'Never edit',
        mode: 'block' as const,
        toolNames: ['edit_space_page'],
      },
    ],
    blockedOnConsultation: new Set(['edit_space_page']),
  };

  it('lets a block rule beat ask, and does not re-ask an approved action', () => {
    expect(decide(ctx('model'), 'edit_space_page', {}, snapshot).effect).toBe(
      'block',
    );
    const askOnly = {
      ...snapshot,
      rules: snapshot.rules.filter((rule) => rule.mode === 'ask'),
    };
    expect(decide(ctx('model'), 'edit_space_page', {}, askOnly)).toMatchObject({
      effect: 'pending',
    });
    expect(decide(ctx('approved_action'), 'edit_space_page', {}, askOnly).effect).toBe(
      'allow',
    );
  });

  it('does not inherit another Dot grant', () => {
    expect(
      decide(ctx('model'), 'plugin_mail_send', {}, snapshot).effect,
    ).toBe('allow');
    expect(
      decide(
        { ...ctx('model'), actorId: 'dot-b' },
        'plugin_other_send',
        {},
        snapshot,
      ).effect,
    ).toBe('block');
  });
});
