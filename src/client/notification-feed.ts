import type { AppNotification } from '../shared/types';

/** The conversation the owner is looking at right now, if any. */
export function watchedThread(input: {
  view: string;
  selectedThread?: string;
  pageVisible: boolean;
}) {
  return input.view === 'chat' && input.pageVisible
    ? input.selectedThread
    : undefined;
}

/**
 * Splits unread notifications into ones to mark read silently (their
 * conversation is open) and new ones to show. The first call only seeds
 * `seen`, so a reload does not replay old toasts.
 */
export function takeNewNotifications(
  seen: Set<string> | null,
  unread: AppNotification[],
  watching?: string,
) {
  const silent = unread.filter(
    (item) => !!watching && item.threadId === watching,
  );
  if (!seen)
    return {
      seen: new Set(unread.map((item) => item.id)),
      fresh: [] as AppNotification[],
      silent,
    };
  const next = new Set(seen);
  const fresh: AppNotification[] = [];
  for (const item of [...unread].reverse()) {
    if (next.has(item.id)) continue;
    next.add(item.id);
    if (!silent.includes(item)) fresh.push(item);
  }
  return { seen: next, fresh, silent };
}

/** Shows a system notification while the tab is hidden; clicking it returns here. */
export function systemNotify(item: AppNotification, onClick: () => void) {
  if (document.visibilityState === 'visible') return;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    const shown = new Notification(item.title, {
      body: item.body,
      tag: item.id,
    });
    shown.onclick = () => {
      window.focus();
      onClick();
      shown.close();
    };
  } catch {
    // Notification can throw outside a secure context. The toast still shows.
  }
}

export function timeAgo(at: number, now = Date.now()) {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}
