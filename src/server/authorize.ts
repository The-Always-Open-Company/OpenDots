export type AuthCause =
  | 'model'
  | 'approved_action'
  | 'trigger'
  | 'continuation'
  | 'internal_event'
  | 'webhook';

export interface ExecutionContext {
  actorId: string;
  ownerId: string;
  workItemId?: string;
  executionId: string;
  threadId: string;
  mode: 'interactive' | 'background';
  parentWorkItemId?: string;
  cause: AuthCause;
}

export interface RuleRow {
  id: string;
  dotId: string | null;
  text: string;
  mode: 'allow' | 'ask' | 'block';
  toolNames: string[];
}

export interface AuthSnapshot {
  paused: boolean;
  cancelled: boolean;
  consultation: boolean;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  /** Actor may use this Space. */
  spaceAllowed: (spaceId: string) => boolean;
  documentAllowed: (id: string) => boolean;
  pluginAllowed: (pluginId: string, toolName: string) => boolean;
  /** For a granted plugin tool: whether its grant asks first, and why these arguments break its limits. */
  pluginPolicy?: (
    pluginId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => { ask: boolean; violation: string | null };
  skillAllowed: (name: string) => boolean;
  rules: RuleRow[];
  blockedOnConsultation: ReadonlySet<string>;
  /** A hidden task thread, where an approval card would never be seen. */
  taskThread?: boolean;
}

/** Why a task thread cannot ask for approval, and what the Dot should do instead. */
export const TASK_APPROVAL_BLOCKED =
  "This action needs the owner's approval, which cannot be given in a background task. Do not retry it here. Prepare everything else, then call report_call_result with status needs_owner and say exactly what you would do, so the owner can confirm it in the chat.";

export type Decision =
  | { effect: 'allow' }
  | { effect: 'block'; reason: string }
  | { effect: 'pending'; ruleId: string };

const RESEARCH_TOOLS = new Set(['search_web', 'read_public_page']);
const MEMORY_TOOLS = new Set([
  'remember',
  'search_memories',
  'list_notes',
  'update_note',
  'forget',
]);

/** Mutating tools a consulted Dot must not see or call. */
export const CONSULTATION_BLOCKED_TOOLS = new Set([
  'create_space_page',
  'edit_space_page',
  'remember',
  'update_note',
  'forget',
  'start_delegation',
  'start_objective',
  'complete_work',
  'fail_work',
  'propose_schedule',
  'update_schedule',
  'cancel_schedule',
  'propose_profile',
  'upsert_responsibility',
  'close_responsibility',
  'wait_for',
  'continue_work',
  'stop_work',
  'record_reconciliation',
  'arm_trigger',
  'apply_profile',
  'create_action_items',
  'update_action_item',
  'add_action_item_note',
  'review_action_items',
  'merge_entities',
]);

export function consultationBlocked(toolName: string) {
  return (
    CONSULTATION_BLOCKED_TOOLS.has(toolName) ||
    toolName.startsWith('plugin_') ||
    toolName.startsWith('computer_')
  );
}

/** `plugin_<pluginId>_<toolName>`. Plugin ids do not contain underscores. */
export function pluginToolName(toolName: string) {
  const match = /^plugin_([a-z][a-z0-9-]*)_(.+)$/.exec(toolName);
  if (!match) return null;
  return { pluginId: match[1], toolName: match[2] };
}

function matching(rules: RuleRow[], actorId: string, toolName: string) {
  const named = rules.filter(
    (rule) =>
      rule.toolNames.includes(toolName) &&
      (rule.dotId == null || rule.dotId === actorId),
  );
  const rank = (mode: RuleRow['mode'], workspace: boolean) =>
    (mode === 'block' ? 0 : mode === 'ask' ? 2 : 4) + (workspace ? 0 : 1);
  return named.sort(
    (a, b) => rank(a.mode, a.dotId == null) - rank(b.mode, b.dotId == null),
  )[0];
}

/** Policy for one privileged operation. `ask` applies only to model-initiated calls. */
export function decide(
  ctx: ExecutionContext,
  toolName: string,
  args: Record<string, unknown>,
  snapshot: AuthSnapshot,
): Decision {
  if (snapshot.cancelled)
    return { effect: 'block', reason: 'This objective was cancelled.' };
  if (snapshot.paused && (ctx.mode === 'background' || ctx.cause !== 'model'))
    return { effect: 'block', reason: 'Agents are paused.' };
  if (ctx.cause === 'model' && snapshot.paused)
    return { effect: 'block', reason: 'Agents are paused.' };
  if (
    snapshot.consultation &&
    (consultationBlocked(toolName) ||
      snapshot.blockedOnConsultation.has(toolName))
  )
    return {
      effect: 'block',
      reason: 'A consulted Pod cannot change anything.',
    };
  if (RESEARCH_TOOLS.has(toolName) && !snapshot.researchAllowed)
    return { effect: 'block', reason: 'Research permission is disabled.' };
  if (MEMORY_TOOLS.has(toolName) && !snapshot.memoryAllowed)
    return { effect: 'block', reason: 'Memory permission is disabled.' };
  const spaceId = typeof args.spaceId === 'string' ? args.spaceId : undefined;
  if (spaceId && !snapshot.spaceAllowed(spaceId))
    return {
      effect: 'block',
      reason: 'Space access has been revoked or was not granted.',
    };
  const documentId =
    typeof args.documentId === 'string'
      ? args.documentId
      : typeof args.id === 'string' && toolName.includes('document')
        ? args.id
        : undefined;
  if (
    documentId &&
    toolName.includes('document') &&
    !snapshot.documentAllowed(documentId)
  )
    return {
      effect: 'block',
      reason: 'Document access has been revoked or was not granted.',
    };
  const plugin = pluginToolName(toolName);
  if (plugin && !snapshot.pluginAllowed(plugin.pluginId, plugin.toolName))
    return { effect: 'block', reason: 'Plugin tool is not granted.' };
  const policy = plugin
    ? snapshot.pluginPolicy?.(plugin.pluginId, plugin.toolName, args)
    : undefined;
  if (policy?.violation) return { effect: 'block', reason: policy.violation };
  if (toolName === 'load_skill') {
    const name = typeof args.name === 'string' ? args.name : '';
    if (!snapshot.skillAllowed(name))
      return { effect: 'block', reason: 'Skill is not enabled for this Pod.' };
  }
  const rule = matching(snapshot.rules, ctx.actorId, toolName);
  if (rule?.mode === 'block')
    return { effect: 'block', reason: 'Rule blocked this action.' };
  const pending: Decision | null =
    rule?.mode === 'ask' && ctx.cause === 'model'
      ? { effect: 'pending', ruleId: rule.id }
      : // Unlike rules, an Ask first grant also holds background work and polls.
        plugin && policy?.ask && ctx.cause !== 'approved_action'
        ? {
            effect: 'pending',
            ruleId: `grant:${plugin.pluginId}/${plugin.toolName}`,
          }
        : null;
  if (pending && snapshot.taskThread)
    return { effect: 'block', reason: TASK_APPROVAL_BLOCKED };
  return pending ?? { effect: 'allow' };
}
