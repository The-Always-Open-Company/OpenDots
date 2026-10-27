import { randomUUID } from 'node:crypto';
import type { Message } from '@ag-ui/core';
import { workResultPrefix } from '../shared/work-marker.js';
import { CONVERSATION_LEDGER, type ExecutionEngine } from './execution-engine.js';
import { lastAssistantText, OWNER_STOPS } from './notifications.js';
import type { SqliteThreadRunner } from './thread-runner.js';
import type { WorkspaceStore } from './workspace.js';

export interface WorkReport {
  chatId: string;
  dotId: string;
  workItemId: string;
  label: string;
  text: string;
}

const RECURRING_SOURCES = new Set(['schedule', 'responsibility', 'watch']);

function noun(source: string, recurring: boolean) {
  if (source === 'responsibility') return 'Responsibility';
  if (source === 'watch') return 'Watch';
  return recurring || source === 'schedule' ? 'Schedule' : 'Objective';
}

/**
 * What to post into the origin chat after an attempt finishes, or null.
 * Recurring work reports every run; one-off work reports once nothing more
 * is queued, so retries and continuations stay quiet.
 */
export function workReport(
  engine: ExecutionEngine,
  workspace: Pick<WorkspaceStore, 'chatThread' | 'requireThread' | 'threads'>,
  workItemId: string,
  payload: { outcome?: unknown; error?: unknown },
): WorkReport | null {
  const item = engine.workItem(workItemId);
  if (!item || item.source === CONVERSATION_LEDGER.source) return null;
  const chatId = item.originThreadId ? String(item.originThreadId) : '';
  if (!chatId || workspace.chatThread(chatId) !== chatId) return null;
  const status = String(item.status);
  if (
    ['cancelled', 'waiting_for_approval', 'waiting_for_dependency'].includes(
      status,
    )
  )
    return null;
  const outcome = String(payload.outcome);
  const error = typeof payload.error === 'string' ? payload.error : '';
  if (outcome === 'cancelled' || OWNER_STOPS.test(error)) return null;
  if (engine.hasActiveExecution(workItemId)) return null;
  if (engine.reportsToParent(workItemId)) return null;
  const source = String(item.source);
  const recurring =
    Number(item.recurring) === 1 || RECURRING_SOURCES.has(source);
  const kind = noun(source, recurring);
  const title = String(item.title);
  const workThread = item.workThreadId ? String(item.workThreadId) : '';
  const completed = outcome === 'completed';
  const label =
    status === 'completed'
      ? `${kind} finished: ${title}`
      : status === 'failed'
        ? `${kind} could not finish: ${title}`
        : !completed
          ? `${kind} needs attention: ${title}`
          : recurring
            ? `${kind} ran: ${title}`
            : `${kind} update: ${title}`;
  const answer =
    completed && workThread ? lastAssistantText(workspace, workThread) : '';
  const text =
    answer ||
    (completed
      ? 'The run finished without a written result.'
      : `The run stopped before it finished: ${error || 'no reason was recorded.'}`);
  return {
    chatId,
    dotId: workspace.requireThread(chatId).dotId,
    workItemId,
    label,
    text,
  };
}

/** Posts each background result into the chat it came from, even while that chat is busy. */
export function reportWork(
  engine: ExecutionEngine,
  workspace: Pick<WorkspaceStore, 'chatThread' | 'requireThread' | 'threads'>,
  runner: Pick<SqliteThreadRunner, 'appendExchange'>,
) {
  engine.listen((type, fields) => {
    if (type !== 'finished' || !fields.workItemId) return;
    const workItemId = fields.workItemId;
    const payload = (fields.payload ?? {}) as Record<string, unknown>;
    // Events fire inside the engine's transaction; read the settled state after it.
    queueMicrotask(() => {
      try {
        const report = workReport(engine, workspace, workItemId, payload);
        if (report) postWorkReport(runner, report);
      } catch {
        console.error('Could not post a background result to its chat.');
      }
    });
  });
}

export function postWorkReport(
  runner: Pick<SqliteThreadRunner, 'appendExchange'>,
  report: WorkReport,
) {
  const marker = {
    id: `${workResultPrefix}${randomUUID()}`,
    role: 'user',
    content: `${report.label}\n\nPosted by the app from background work, not written by the owner.`,
    metadata: { opendotsSource: 'work_result', workItemId: report.workItemId },
  } as Message;
  runner.appendExchange(report.chatId, report.dotId, marker, report.text);
}
