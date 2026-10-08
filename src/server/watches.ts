import { createHash, timingSafeEqual } from 'node:crypto';
import { decide, type ExecutionContext } from './authorize.js';
import type { ExecutionEngine } from './execution-engine.js';
import type { WorkspaceStore } from './workspace.js';
import type { Store } from './store.js';

export function hookSecretHash(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

export function secretsMatch(expectedHash: string, provided: string) {
  const actual = hookSecretHash(provided);
  const left = Buffer.from(expectedHash);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function dedupKey(idempotencyKey: string | undefined, raw: string) {
  const header = idempotencyKey?.trim();
  if (header) return header.slice(0, 200);
  try {
    const body = JSON.parse(raw) as { id?: unknown };
    if (typeof body?.id === 'string' && body.id.trim())
      return body.id.trim().slice(0, 200);
  } catch {
    // Fall through to a hash of the raw body.
  }
  return createHash('sha256').update(raw).digest('hex');
}

export function deliverInternal(
  engine: ExecutionEngine,
  workspace: WorkspaceStore,
  event: 'page.updated' | 'document.ready',
  payload: Record<string, unknown>,
) {
  for (const trigger of engine.triggersOf('watch')) {
    const spec = JSON.parse(String(trigger.specJson)) as {
      watchKind?: string;
      event?: string;
      spaceId?: string;
    };
    if (spec.watchKind !== 'internal' || spec.event !== event) continue;
    if (spec.spaceId && payload.spaceId && spec.spaceId !== payload.spaceId)
      continue;
    const actor = String(trigger.actorId);
    if (!workspace.dot(actor)) continue;
    const spaceId =
      typeof payload.spaceId === 'string' ? payload.spaceId : spec.spaceId;
    const documentId =
      typeof payload.documentId === 'string'
        ? payload.documentId
        : typeof payload.id === 'string'
          ? payload.id
          : '';
    const toolName = event === 'document.ready' ? 'document_watch' : 'watch_delivery';
    const args =
      event === 'document.ready' ? { id: documentId } : { spaceId: spaceId ?? '' };
    if (event === 'page.updated' && !spaceId) continue;
    if (event === 'document.ready' && !documentId) continue;
    const decision = decide(
      context(actor, String(trigger.workItemId), 'internal_event'),
      toolName,
      args,
      snapshot(engine, workspace, actor, String(trigger.workItemId)),
    );
    if (decision.effect === 'block') continue;
    const key = `${event}:${String(payload.id)}:${String(payload.revision ?? payload.updatedAt ?? '')}`;
    engine.acceptWebhook(String(trigger.id), key, JSON.stringify(payload));
  }
}

export function watchDecision(
  engine: ExecutionEngine,
  store: Store,
  workspace: WorkspaceStore,
  event: { watchId: string; payload: string },
  pluginAllowed: (
    dotId: string,
    pluginId: string,
    toolName: string,
  ) => boolean = () => false,
): 'enqueue' | 'later' | 'drop' {
  if (store.settings().paused) return 'later';
  const trigger = engine.trigger(event.watchId);
  if (!trigger || !Number(trigger.enabled)) return 'drop';
  const actor = String(trigger.actorId);
  if (!workspace.dot(actor)) return 'drop';
  const spec = JSON.parse(String(trigger.specJson)) as {
    watchKind?: string;
    event?: string;
    spaceId?: string;
    pluginId?: string;
    toolName?: string;
  };
  let body: { spaceId?: string; documentId?: string; id?: string } = {};
  try {
    body = JSON.parse(event.payload) as typeof body;
  } catch {
    if (spec.watchKind === 'internal') return 'drop';
  }
  if (spec.watchKind === 'poll') {
    if (
      !spec.pluginId ||
      !spec.toolName ||
      !pluginAllowed(actor, spec.pluginId, spec.toolName)
    )
      return 'later';
  }
  const toolName =
    spec.watchKind === 'poll' && spec.pluginId && spec.toolName
      ? `plugin_${spec.pluginId}_${spec.toolName}`
      : spec.event === 'document.ready'
        ? 'document_watch'
        : 'watch_delivery';
  const args: Record<string, unknown> = {};
  if (spec.watchKind === 'internal' && spec.event === 'page.updated') {
    const spaceId = spec.spaceId ?? body.spaceId;
    if (!spaceId) return 'drop';
    args.spaceId = spaceId;
  }
  if (spec.watchKind === 'internal' && spec.event === 'document.ready') {
    const documentId = body.documentId ?? body.id;
    if (!documentId) return 'drop';
    args.id = documentId;
  }
  const cause =
    spec.watchKind === 'internal'
      ? 'internal_event'
      : spec.watchKind === 'poll'
        ? 'trigger'
        : 'webhook';
  const decision = decide(
    context(actor, String(trigger.workItemId), cause),
    toolName,
    args,
    snapshot(engine, workspace, actor, String(trigger.workItemId)),
  );
  if (decision.effect === 'block') {
    engine.event('auth_denied', {
      workItemId: String(trigger.workItemId),
      triggerId: String(trigger.id),
      actorId: actor,
      payload: { toolName, reason: decision.reason, cause },
    });
    return decision.reason === 'Agents are paused.' ? 'later' : 'drop';
  }
  return 'enqueue';
}

function context(
  actorId: string,
  workItemId: string,
  cause: ExecutionContext['cause'],
): ExecutionContext {
  return {
    actorId,
    ownerId: 'owner',
    workItemId,
    executionId: '',
    threadId: '',
    mode: 'background',
    cause,
  };
}

function snapshot(
  engine: ExecutionEngine,
  workspace: WorkspaceStore,
  actorId: string,
  workItemId: string,
) {
  const item = engine.workItem(workItemId);
  return {
    paused: false,
    cancelled: item?.status === 'cancelled',
    consultation: false,
    researchAllowed: true,
    memoryAllowed: true,
    spaceAllowed: (spaceId: string) => workspace.canAccessSpace(actorId, spaceId),
    documentAllowed: (id: string) => workspace.documents.canRead(actorId, id),
    pluginAllowed: () => true,
    skillAllowed: () => true,
    rules: engine.rules(),
    blockedOnConsultation: new Set<string>(),
  };
}
