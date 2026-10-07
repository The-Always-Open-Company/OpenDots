import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';

const text = z.object({ text: z.string().trim().min(1).max(2000) }).strict();

export function memoryRoutes(platform: Platform) {
  const app = new Hono();
  const scope = (dotId: string) => ({
    userId: platform.workspace.ownerId,
    dotId,
  });
  const provider = () => platform.services.memory;
  const unavailable = {
    error: 'Learned memory needs DATABASE_URL (Postgres with pgvector).',
  };
  app.get('/dots/:id/memories', async (c) => {
    const memory = provider();
    if (!memory) return c.json(unavailable, 503);
    if (!platform.workspace.dot(c.req.param('id')))
      return c.json({ error: 'Dot not found.' }, 404);
    return c.json(await memory.list(scope(c.req.param('id'))));
  });
  app.put('/dots/:id/memories/:memoryId', async (c) => {
    const memory = provider();
    if (!memory) return c.json(unavailable, 503);
    const parsed = text.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Memory must be between 1 and 2,000 characters.' },
        400,
      );
    return (await memory.update(
      scope(c.req.param('id')),
      c.req.param('memoryId'),
      parsed.data.text,
    ))
      ? c.json({ ok: true })
      : c.json({ error: 'Memory not found for this Dot.' }, 404);
  });
  app.delete('/dots/:id/memories/:memoryId', async (c) => {
    const memory = provider();
    if (!memory) return c.json(unavailable, 503);
    return (await memory.delete(
      scope(c.req.param('id')),
      c.req.param('memoryId'),
    ))
      ? c.json({ ok: true })
      : c.json({ error: 'Memory not found for this Dot.' }, 404);
  });
  app.get('/consultations', (c) => c.json(platform.consultations()));
  return app;
}
