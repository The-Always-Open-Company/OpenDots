import type { Context, Hono } from 'hono';
import { z, ZodError } from 'zod';
import { ACTION_ITEM_STATUSES, ENTITY_KINDS } from '../shared/types.js';
import {
  actionItemInput,
  actionItemPatch,
  sourceInput,
  type ActionItemService,
  type Actor,
} from './action-items.js';
import { assertTimezone } from './schedule-time.js';

const timeZone = z
  .string()
  .max(80)
  .optional()
  .refine((value) => {
    if (!value) return true;
    try {
      assertTimezone(value);
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone.');

const newItem = actionItemInput.extend({ source: sourceInput.optional() });
const createBody = z.union([
  z.object({ items: z.array(newItem).min(1).max(50), timezone: timeZone }),
  newItem.extend({ timezone: timeZone }),
]);

function failure(c: Context, error: unknown) {
  if (error instanceof ZodError)
    return c.json(
      {
        error: error.issues
          .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; '),
      },
      400,
    );
  const message = error instanceof Error ? error.message : 'Request failed.';
  return c.json({ error: message }, /not found/i.test(message) ? 404 : 400);
}

const owner = (zone?: string): Actor => ({
  id: 'owner',
  timeZone: zone || 'UTC',
});

/** Owner API for action items and the entities they are tagged with. */
export function actionItemRoutes(app: Hono, service: ActionItemService) {
  app.get('/api/action-items', async (c) => {
    try {
      const list = (name: string) =>
        (c.req.queries(name) ?? [])
          .flatMap((value) => value.split(','))
          .map((value) => value.trim())
          .filter(Boolean);
      const zone = timeZone.parse(c.req.query('timezone'));
      const statuses = list('status');
      const limit = c.req.query('limit');
      return c.json(
        await service.search(
          {
            query: c.req.query('q'),
            entities: c.req.queries('entity'),
            owner: c.req.query('owner'),
            requester: c.req.query('requester'),
            statuses: statuses.length
              ? z.array(z.enum(ACTION_ITEM_STATUSES)).parse(statuses)
              : undefined,
            labels: list('label'),
            dueBefore: c.req.query('dueBefore'),
            dueAfter: c.req.query('dueAfter'),
            limit: limit ? Number(limit) : undefined,
          },
          owner(zone),
          c.req.raw.signal,
        ),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get('/api/action-items/review', (c) => {
    try {
      const zone = timeZone.parse(c.req.query('timezone'));
      return c.json(
        service.review(owner(zone), {
          markReminded: c.req.query('markReminded') === 'true',
        }),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get('/api/action-items/:id', (c) => {
    const item = service.detail(c.req.param('id'));
    return item
      ? c.json(item)
      : c.json({ error: 'Action item not found.' }, 404);
  });
  app.post('/api/action-items', async (c) => {
    try {
      const body = createBody.parse(await c.req.json().catch(() => null));
      const items = 'items' in body ? body.items : [body];
      return c.json(
        await service.create(items, owner(body.timezone), c.req.raw.signal),
        201,
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.patch('/api/action-items/:id', async (c) => {
    try {
      const body = actionItemPatch
        .extend({ timezone: timeZone })
        .parse(await c.req.json().catch(() => null));
      return c.json(
        await service.update(
          c.req.param('id'),
          body,
          owner(body.timezone),
          c.req.raw.signal,
        ),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post('/api/action-items/:id/notes', async (c) => {
    try {
      const body = z
        .object({ note: z.string().trim().min(1).max(4000) })
        .parse(await c.req.json().catch(() => null));
      return c.json(
        await service.addNote(
          c.req.param('id'),
          body.note,
          owner(),
          c.req.raw.signal,
        ),
        201,
      );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.delete('/api/action-items/:id', async (c) =>
    (await service.delete(c.req.param('id')))
      ? c.json({ deleted: true })
      : c.json({ error: 'Action item not found.' }, 404),
  );
  app.get('/api/entities', (c) => {
    const kind = ENTITY_KINDS.find((value) => value === c.req.query('kind'));
    return c.json(service.store.entities(c.req.query('q'), kind));
  });
  app.post('/api/entities/merge', async (c) => {
    try {
      const body = z
        .object({ fromEntityId: z.string(), intoEntityId: z.string() })
        .parse(await c.req.json().catch(() => null));
      return c.json(
        await service.mergeEntities(
          body.fromEntityId,
          body.intoEntityId,
          c.req.raw.signal,
        ),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
}
