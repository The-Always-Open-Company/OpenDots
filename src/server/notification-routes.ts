import type { Hono } from 'hono';
import type { NotificationService } from './notifications.js';

export function notificationRoutes(
  app: Hono,
  notifications: NotificationService,
) {
  app.get('/api/notifications', (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json(
      notifications.list({
        unread: c.req.query('unread') === '1',
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    );
  });
  app.post('/api/notifications/read-all', (c) =>
    c.json({ updated: notifications.markAllRead() }),
  );
  app.post('/api/notifications/:id/read', (c) =>
    c.json({ updated: notifications.markRead(c.req.param('id')) }),
  );
}
