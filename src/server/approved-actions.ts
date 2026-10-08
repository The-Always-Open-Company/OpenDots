import type { ExecutionEngine } from './execution-engine.js';
import type { MemoryProvider } from './memory.js';
import type { PluginService } from './plugins.js';
import { assertWake, parseSchedule } from './schedule-time.js';
import type { Store } from './store.js';
import type { WorkspaceStore } from './workspace.js';
import { snapshotFor } from './work-tools.js';
import type { ExecutionContext } from './authorize.js';

const MASCOTS = ['blue', 'mint', 'orange', 'purple'];

type ActionRow = Record<string, unknown>;

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Approved action failed.';
}

export async function applyApprovedAction(
  deps: {
    engine: ExecutionEngine;
    workspace: WorkspaceStore;
    store: Store;
    plugins: PluginService;
    memory?: MemoryProvider;
  },
  action: ActionRow,
) {
  const id = String(action.id);
  const toolName = String(action.toolName);
  const args = JSON.parse(String(action.argumentsJson)) as Record<string, unknown>;
  const dot = deps.workspace.dot(String(action.actorId));
  if (!dot) {
    deps.engine.completeApprovedAction(id, 'declined', {
      error: 'Dot not found.',
    });
    return;
  }
  const workItemId = action.workItemId ? String(action.workItemId) : undefined;
  const ctx: ExecutionContext = {
    actorId: dot.id,
    ownerId: deps.workspace.ownerId,
    workItemId,
    executionId: action.executionId ? String(action.executionId) : '',
    threadId: String(action.threadId),
    mode: 'background',
    cause: 'approved_action',
  };
  try {
    deps.engine.gate(
      ctx,
      toolName,
      args,
      snapshotFor(deps, dot, false, workItemId),
    );
  } catch (error) {
    deps.engine.completeApprovedAction(id, 'declined', { error: message(error) });
    return;
  }
  const operationId = String(action.operationId ?? '');
  const idempotent =
    toolName === 'arm_trigger' ||
    toolName === 'apply_profile' ||
    toolName === 'create_space_page' ||
    toolName === 'edit_space_page' ||
    toolName === 'remember' ||
    toolName === 'update_note' ||
    deps.plugins.idempotent(toolName);
  const finish = (status: 'executed' | 'uncertain' | 'declined', result: unknown) => {
    const schedule =
      toolName === 'arm_trigger' ||
      toolName === 'apply_profile' ||
      toolName === 'update_schedule' ||
      toolName === 'cancel_schedule';
    deps.engine.completeApprovedAction(id, status, result, {
      continue: !schedule,
    });
  };
  try {
    const result = await run(deps, dot.id, toolName, args, operationId, workItemId, ctx.executionId || null, idempotent);
    finish('executed', result);
  } catch (error) {
    finish('uncertain', { error: message(error) });
  }
}

async function run(
  deps: {
    engine: ExecutionEngine;
    workspace: WorkspaceStore;
    plugins: PluginService;
    memory?: MemoryProvider;
  },
  actorId: string,
  toolName: string,
  args: Record<string, unknown>,
  operationId: string,
  workItemId: string | undefined,
  executionId: string | null,
  idempotent: boolean,
) {
  const perform = async () => {
    if (toolName === 'arm_trigger') return arm(deps.engine, actorId, args, operationId);
    if (toolName === 'update_schedule') return updateSchedule(deps, actorId, args);
    if (toolName === 'cancel_schedule') return cancelSchedule(deps, actorId, args);
    if (toolName === 'apply_profile') return applyProfile(deps.workspace, actorId, args);
    if (toolName === 'create_space_page')
      return createPage(deps.workspace, actorId, args, operationId);
    if (toolName === 'edit_space_page')
      return editPage(deps.workspace, actorId, args);
    if (toolName === 'remember' && deps.memory)
      return deps.memory.add(
        { userId: deps.workspace.ownerId, dotId: actorId },
        [{ role: 'user', content: String(args.fact ?? '') }],
        { infer: false, threadId: String(args.threadId ?? '') },
      );
    if (toolName === 'update_note' && deps.memory) {
      const updated = await deps.memory.update(
        { userId: deps.workspace.ownerId, dotId: actorId },
        String(args.id),
        String(args.text ?? ''),
      );
      if (!updated) throw new Error('Note not found.');
      return { updated: true };
    }
    if (toolName === 'forget' && deps.memory) {
      const deleted = await deps.memory.delete(
        { userId: deps.workspace.ownerId, dotId: actorId },
        String(args.id),
      );
      if (!deleted) throw new Error('Note not found.');
      return { deleted: true };
    }
    const plugin = toolName.match(/^plugin_([a-z][a-z0-9-]*)_(.+)$/);
    if (plugin)
      return deps.plugins.call(actorId, plugin[1], plugin[2], args);
    throw new Error(`No worker is registered for ${toolName}.`);
  };
  if (!workItemId) return perform();
  const begun = deps.engine.beginEffect(
    workItemId,
    executionId,
    toolName,
    { ...args, operationId },
    idempotent,
    true,
  );
  if (begun.action === 'return') return begun.result;
  try {
    const result = await perform();
    deps.engine.completeEffect(
      workItemId,
      toolName,
      begun.operationId,
      'succeeded',
      result,
    );
    return result;
  } catch (error) {
    deps.engine.completeEffect(
      workItemId,
      toolName,
      begun.operationId,
      idempotent ? 'failed' : 'uncertain',
      { error: message(error) },
    );
    throw error;
  }
}

function arm(
  engine: ExecutionEngine,
  actorId: string,
  args: Record<string, unknown>,
  operationId: string,
) {
  const existing = engine.triggerByOperation(operationId);
  if (existing) return { triggerId: existing.id };
  const spec = parseSchedule(args.spec);
  const nextRunAt = Number(args.nextRunAt);
  if (!Number.isFinite(nextRunAt)) throw new Error('Schedule time is invalid.');
  if (args.kind === 'wake') assertWake(engine.policy(actorId), nextRunAt, Date.now());
  const workItemId = String(args.workItemId);
  const triggerId = engine.addTrigger({
    workItemId,
    actorId,
    kind: args.kind === 'wake' ? 'wake' : 'schedule',
    spec: { ...spec, operationId },
    anchor: args.anchor === 'after_success' ? 'after_success' : 'clock',
    nextRunAt,
    enabled: true,
    dotCanManage: args.dotCanManage !== false,
  });
  if (args.kind === 'wake')
    engine.event('wake_set', {
      workItemId,
      actorId,
      triggerId,
      payload: { nextRunAt },
    });
  return { triggerId };
}

function updateSchedule(
  deps: { engine: ExecutionEngine },
  actorId: string,
  args: Record<string, unknown>,
) {
  const trigger = deps.engine.trigger(String(args.triggerId));
  if (!trigger || !Number(trigger.dotCanManage) || String(trigger.actorId) !== actorId)
    throw new Error('This schedule is managed by the owner.');
  const spec = parseSchedule(args.spec);
  deps.engine.updateTrigger(String(trigger.id), {
    spec,
    nextRunAt: Number(args.nextRunAt),
  });
  return { triggerId: trigger.id, updated: true };
}

function cancelSchedule(
  deps: { engine: ExecutionEngine },
  actorId: string,
  args: Record<string, unknown>,
) {
  const trigger = deps.engine.trigger(String(args.triggerId));
  if (!trigger || !Number(trigger.dotCanManage) || String(trigger.actorId) !== actorId)
    throw new Error('This schedule is managed by the owner.');
  deps.engine.updateTrigger(String(trigger.id), { enabled: false });
  return { triggerId: trigger.id, enabled: false };
}

function applyProfile(
  workspace: WorkspaceStore,
  actorId: string,
  args: Record<string, unknown>,
) {
  const dot = workspace.dot(actorId);
  if (!dot) throw new Error('Dot not found.');
  const name = String(args.name ?? '').trim();
  if (name.length < 1 || name.length > 40)
    throw new Error('Name must be 1 to 40 characters.');
  const mascot = args.mascot == null ? null : String(args.mascot);
  if (mascot !== null && !MASCOTS.includes(mascot))
    throw new Error('Choose a blue, mint, orange, or purple mascot.');
  const updated = workspace.updateDot(dot.id, {
    ...dot,
    name,
    mascot,
  });
  return { name: updated.name, mascot: updated.mascot };
}

function createPage(
  workspace: WorkspaceStore,
  actorId: string,
  args: Record<string, unknown>,
  operationId: string,
) {
  const dot = workspace.dot(actorId);
  if (!dot) throw new Error('Dot not found.');
  const spaceId = typeof args.spaceId === 'string' ? args.spaceId : dot.spaceId;
  if (!workspace.canAccessSpace(actorId, spaceId))
    throw new Error('Space access has been revoked or was not granted.');
  return workspace.pages.create(
    spaceId,
    {
      title: String(args.title ?? ''),
      content: typeof args.content === 'string' ? args.content : '',
      parentId: typeof args.parentId === 'string' ? args.parentId : null,
    },
    null,
    operationId,
  );
}

function editPage(
  workspace: WorkspaceStore,
  actorId: string,
  args: Record<string, unknown>,
) {
  const dot = workspace.dot(actorId);
  if (!dot) throw new Error('Dot not found.');
  const spaceId = typeof args.spaceId === 'string' ? args.spaceId : dot.spaceId;
  if (!workspace.canAccessSpace(actorId, spaceId))
    throw new Error('Space access has been revoked or was not granted.');
  return workspace.pages.update(spaceId, String(args.id), {
    title: typeof args.title === 'string' ? args.title : undefined,
    content: typeof args.content === 'string' ? args.content : undefined,
    parentId:
      args.parentId === undefined
        ? undefined
        : args.parentId === null
          ? null
          : String(args.parentId),
    expectedRevision: Number(args.expectedRevision),
  });
}
