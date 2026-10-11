import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCheck, X } from 'lucide-react';
import type { AppNotification, Dot } from '../shared/types';
import { api } from './api';
import { Mascot } from './Mascot';
import { timeAgo } from './notification-feed';

const TOAST_MS = 8000;

function NotificationMascot({
  item,
  dots,
}: {
  item: AppNotification;
  dots: Dot[];
}) {
  const dot = dots.find((candidate) => candidate.id === item.dotId);
  return (
    <Mascot
      small
      decorative
      identity={dot?.id ?? item.dotId ?? undefined}
      character={dot?.mascot}
    />
  );
}

/** Bottom-right toasts. Each hides itself after a few seconds but stays unread. */
export function NotificationToasts({
  toasts,
  dots,
  onOpen,
  onDismiss,
  onExpire,
}: {
  toasts: AppNotification[];
  dots: Dot[];
  onOpen: (item: AppNotification) => void;
  onDismiss: (item: AppNotification) => void;
  onExpire: (item: AppNotification) => void;
}) {
  const expire = useRef(onExpire);
  expire.current = onExpire;
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const live = timers.current;
    for (const item of toasts)
      if (!live.has(item.id))
        live.set(
          item.id,
          setTimeout(() => {
            live.delete(item.id);
            expire.current(item);
          }, TOAST_MS),
        );
    for (const [id, timer] of live)
      if (!toasts.some((item) => item.id === id)) {
        clearTimeout(timer);
        live.delete(id);
      }
  }, [toasts]);
  useEffect(() => {
    const live = timers.current;
    return () => live.forEach((timer) => clearTimeout(timer));
  }, []);
  if (!toasts.length) return null;
  return (
    <div className="notification-toasts" role="status" aria-live="polite">
      {toasts.map((item) => (
        <article
          key={item.id}
          className={`notification-toast ${item.kind}`}
          aria-label={item.title}
        >
          <NotificationMascot item={item} dots={dots} />
          <div>
            <strong>{item.title}</strong>
            {item.body && <p>{item.body}</p>}
            <button className="notification-link" onClick={() => onOpen(item)}>
              Open
            </button>
          </div>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(item)}
          >
            <X size={14} />
          </button>
        </article>
      ))}
    </div>
  );
}

/** Recent notifications, read and unread, opened from the rail bell. */
export function NotificationPanel({
  dots,
  unreadCount,
  onOpen,
  onReadAll,
  onClose,
}: {
  dots: Dot[];
  unreadCount: number;
  onOpen: (item: AppNotification) => void;
  onReadAll: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [items, setItems] = useState<AppNotification[]>();
  const [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  const load = useCallback(async () => {
    try {
      setItems(await api<AppNotification[]>('/notifications?limit=30'));
      setError('');
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not load notifications.',
      );
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, unreadCount]);
  useEffect(() => {
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') onClose();
        return;
      }
      const target = event.target as Node;
      if (
        !panel.current?.contains(target) &&
        !(target as Element).closest?.('.rail-notifications')
      )
        onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [onClose]);
  return (
    <section
      ref={panel}
      className="notification-panel"
      aria-label="Notifications"
    >
      <header>
        <h2>Notifications</h2>
        <button
          className="notification-link"
          disabled={!unreadCount}
          onClick={() => void onReadAll().then(load)}
        >
          <CheckCheck size={14} /> Mark all read
        </button>
      </header>
      {error && <p className="chat-error">{error}</p>}
      {items && !items.length && (
        <p className="muted notification-empty">
          Nothing yet. Your Dots will let you know here when they finish work,
          need your approval, or reply.
        </p>
      )}
      <ul>
        {items?.map((item) => (
          <li key={item.id}>
            <button
              className={`notification-item ${item.readAt ? '' : 'unread'}`}
              onClick={() => onOpen(item)}
            >
              <NotificationMascot item={item} dots={dots} />
              <span>
                <strong>{item.title}</strong>
                {item.body && <small>{item.body}</small>}
                <time dateTime={new Date(item.createdAt).toISOString()}>
                  {timeAgo(item.createdAt)}
                </time>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
