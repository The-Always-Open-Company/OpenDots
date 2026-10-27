import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppNotification, NotificationKind } from '../shared/types.js';
import type { ExecutionEngine } from './execution-engine.js';
import type { WorkspaceStore } from './workspace.js';

/** Somewhere a notification is delivered besides the app, such as Telegram, email or Slack. */
export interface NotificationChannel {
  name: string;
  send(notification: AppNotification): Promise<void>;
}

export interface NotificationInput {
  kind: NotificationKind;
  dotId?: string | null;
  title: string;
  body?: string;
  threadId?: string | null;
  workItemId?: string | null;
}

const BODY_CHARS = 400;

function excerpt(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > BODY_CHARS
    ? `${flat.slice(0, BODY_CHARS - 1).trimEnd()}…`
    : flat;
}

function row(value: Record<string, unknown>): AppNotification {
  return {
    id: String(value.id),
    kind: String(value.kind) as NotificationKind,
    dotId: value.dotId == null ? null : String(value.dotId),
    title: String(value.title),
    body: String(value.body),
    threadId: value.threadId == null ? null : String(value.threadId),
    workItemId: value.workItemId == null ? null : String(value.workItemId),
    createdAt: Number(value.createdAt),
    readAt: value.readAt == null ? null : Number(value.readAt),
  };
}

export class NotificationService {
  readonly channels: NotificationChannel[] = [];
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS notifications(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, dotId TEXT, title TEXT NOT NULL,
      body TEXT NOT NULL, threadId TEXT, workItemId TEXT,
      createdAt INTEGER NOT NULL, readAt INTEGER);
      CREATE INDEX IF NOT EXISTS notifications_unread ON notifications(readAt, createdAt);`);
  }
  publish(input: NotificationInput) {
    const notification: AppNotification = {
      id: randomUUID(),
      kind: input.kind,
      dotId: input.dotId ?? null,
      title: input.title.slice(0, 200),
      body: excerpt(input.body ?? ''),
      threadId: input.threadId ?? null,
      workItemId: input.workItemId ?? null,
      createdAt: this.now(),
      readAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO notifications (id, kind, dotId, title, body, threadId, workItemId, createdAt, readAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(
        notification.id,
        notification.kind,
        notification.dotId,
        notification.title,
        notification.body,
        notification.threadId,
        notification.workItemId,
        notification.createdAt,
      );
    for (const channel of this.channels)
      void channel
        .send(notification)
        .catch(() =>
          console.error(`Notification channel ${channel.name} failed.`),
        );
    return notification;
  }
  list(options: { unread?: boolean; limit?: number } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    return this.db
      .prepare(
        `SELECT * FROM notifications ${options.unread ? 'WHERE readAt IS NULL' : ''} ORDER BY createdAt DESC, rowid DESC LIMIT ?`,
      )
      .all(limit)
      .map((value) => row(value as Record<string, unknown>));
  }
  markRead(id: string) {
    return (
      this.db
        .prepare(
          'UPDATE notifications SET readAt=? WHERE id=? AND readAt IS NULL',
        )
        .run(this.now(), id).changes === 1
    );
  }
  markAllRead() {
    return Number(
      this.db
        .prepare('UPDATE notifications SET readAt=? WHERE readAt IS NULL')
        .run(this.now()).changes,
    );
  }
}

export function lastAssistantText(
  workspace: Pick<WorkspaceStore, 'threads'>,
  threadId: string,
) {
  const messages = workspace.threads.messages(threadId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role: string; content?: unknown };
    if (message.role === 'assistant' && typeof message.content === 'string')
      if (message.content.trim()) return message.content;
  }
  return '';
}

/** Stops the owner asked for; they need no report. Server stops are retried instead. */
export const OWNER_STOPS = /^Run stopped/;

/** Notifies the owner when background work finishes, fails, or needs approval. */
export function notifyWork(
  engine: ExecutionEngine,
  workspace: WorkspaceStore,
  notifications: NotificationService,
) {
  const dotName = (id: string | null | undefined) =>
    (id && workspace.dot(id)?.name) || 'Your Pod';
  const handle = (
    type: string,
    fields: {
      workItemId?: string | null;
      actorId?: string | null;
      payload?: unknown;
    },
  ) => {
    const payload = (fields.payload ?? {}) as Record<string, unknown>;
    const item = fields.workItemId ? engine.workItem(fields.workItemId) : null;
    if (!item) return;
    const title = String(item.title);
    // Work runs in a hidden thread; the owner opens the chat it came from.
    const threadId = item.originThreadId ? String(item.originThreadId) : null;
    const workThread = item.workThreadId ? String(item.workThreadId) : null;
    const name = dotName(fields.actorId ?? String(item.actorId));
    if (type === 'action_proposed') {
      const action = engine.action(String(payload.actionId));
      notifications.publish({
        kind: 'approval_needed',
        dotId: String(item.actorId),
        title: `${name} needs your approval`,
        body: `${String(payload.toolName ?? 'An action').replace(/_/g, ' ')} for "${title}"`,
        threadId: action?.threadId ? String(action.threadId) : threadId,
        workItemId: String(item.id),
      });
      return;
    }
    if (type !== 'finished') return;
    const outcome = String(payload.outcome);
    const error = typeof payload.error === 'string' ? payload.error : '';
    const status = String(item.status);
    if (status === 'waiting_for_approval' || status === 'cancelled') return;
    if (outcome === 'failed' || outcome === 'interrupted') {
      if (OWNER_STOPS.test(error)) return;
      const retrying = engine
        .detail(String(item.id))
        ?.executions.some(
          (execution) =>
            (execution as { status?: unknown }).status === 'queued',
        );
      if (retrying) return;
      notifications.publish({
        kind: 'work_failed',
        dotId: String(item.actorId),
        title: `${name} could not finish "${title}"`,
        body: error || 'The run stopped before it finished.',
        threadId,
        workItemId: String(item.id),
      });
      return;
    }
    if (outcome !== 'completed') return;
    notifications.publish({
      kind: status === 'failed' ? 'work_failed' : 'work_finished',
      dotId: String(item.actorId),
      title:
        status === 'completed'
          ? `${name} finished "${title}"`
          : status === 'failed'
            ? `${name} could not finish "${title}"`
            : `${name} has an update on "${title}"`,
      body: workThread ? lastAssistantText(workspace, workThread) : '',
      threadId,
      workItemId: String(item.id),
    });
  };
  engine.listen((type, fields) => {
    if (type !== 'finished' && type !== 'action_proposed') return;
    // Events fire inside the engine's transaction; read the settled state after it.
    queueMicrotask(() => {
      try {
        handle(type, fields);
      } catch {
        console.error('Could not record a notification.');
      }
    });
  });
}
