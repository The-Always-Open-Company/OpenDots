import type { Hono } from 'hono';
import { z } from 'zod';
import { HandoffError, type HandoffService } from './handoffs.js';

const handoffInput = z
  .object({
    dotId: z.string().min(1),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('document'), documentId: z.string().min(1) }),
      z.object({
        kind: z.literal('page'),
        spaceId: z.string().min(1),
        pageId: z.string().min(1),
      }),
    ]),
    note: z.string().max(1000).optional(),
  })
  .strict();

export function handoffRoutes(app: Hono, handoffs: HandoffService) {
  app.post('/api/handoffs', async (c) => {
    const parsed = handoffInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Choose a Dot and a document or page to send.' },
        400,
      );
    try {
      return c.json(handoffs.create(parsed.data), 201);
    } catch (error) {
      if (error instanceof HandoffError)
        return c.json({ error: error.message }, error.status);
      throw error;
    }
  });
}
