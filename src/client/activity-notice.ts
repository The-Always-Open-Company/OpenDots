import type { WorkView } from '../shared/types';
import { workPromptLabel, type WorkPromptKind } from '../shared/work-marker';

export interface FinishedAttempt {
  id: string;
  status: string;
  title: string;
  threadId: string | null;
  source: string;
  kinds: string[];
}

const noticed = new Set(['completed', 'failed', 'interrupted']);

export function finishedAttempts(work: WorkView[]): FinishedAttempt[] {
  return work.flatMap((item) =>
    item.executions
      .filter((execution) => noticed.has(execution.status))
      .map((execution) => ({
        id: execution.id,
        status: execution.status,
        title: String(item.workItem.title),
        threadId: item.workItem.workThreadId ?? null,
        source: String(item.workItem.source),
        kinds: item.triggers.map((trigger) => trigger.kind),
      })),
  );
}

export function takeNewFinishes(seen: Set<string> | null, work: WorkView[]) {
  const finished = finishedAttempts(work);
  if (!seen)
    return { seen: new Set(finished.map((item) => item.id)), fresh: [] };
  const fresh = finished.filter((item) => !seen.has(item.id));
  const next = new Set(seen);
  for (const item of fresh) next.add(item.id);
  return { seen: next, fresh };
}

export function attemptHeadline(attempt: FinishedAttempt) {
  const kind: WorkPromptKind = attempt.kinds.includes('schedule')
    ? 'schedule'
    : attempt.source === 'schedule'
      ? 'schedule'
      : attempt.kinds.includes('wake') || attempt.source === 'responsibility'
        ? 'wake'
        : attempt.kinds.includes('watch')
          ? 'watch'
          : 'work';
  return {
    title: workPromptLabel(kind),
    body:
      attempt.status === 'completed'
        ? attempt.title
        : `${attempt.title} · ${attempt.status}`,
  };
}

export function requestActivityNotifications() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') return;
  void Notification.requestPermission().catch(() => undefined);
}

export function notifyFinishedAttempt(input: {
  title: string;
  body: string;
  tag: string;
  visibleHere: boolean;
}) {
  if (input.visibleHere) return;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(input.title, { body: input.body, tag: input.tag });
  } catch {
    // Notification can throw outside a secure context. The badge still updates.
  }
}
