import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';
import type { UploadedFile } from './document-library.js';
import { DEFAULT_MAX_UPLOAD_MB } from './platform-config.js';

const PAGE_CONTENT_LIMIT = 100_000;

const patch = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    allDots: z.boolean().optional(),
    dotIds: z.array(z.string().min(1)).max(200).optional(),
    spaceIds: z.array(z.string().min(1)).max(200).optional(),
  })
  .strict();
const filter = z.object({
  q: z.string().max(200).optional(),
  spaceId: z.string().optional(),
  dotId: z.string().optional(),
  source: z.enum(['upload', 'chat']).optional(),
  status: z.enum(['queued', 'processing', 'ready', 'failed']).optional(),
});
const access = z.enum(['none', 'dots', 'all']);

class DocumentRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 413 | 503 = 400,
  ) {
    super(message);
  }
}

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter(
    (item): item is string => typeof item === 'string' && !!item,
  );

async function readUpload(
  c: Context,
  maxBytes: number,
): Promise<{
  file: UploadedFile;
  fields: Record<string, unknown>;
}> {
  const body = await c.req.parseBody({ all: true }).catch(() => {
    throw new DocumentRequestError('Send the document as multipart form data.');
  });
  const file = body.file;
  if (!(file instanceof File))
    throw new DocumentRequestError('Choose a file to upload.');
  if (file.size > maxBytes)
    throw new DocumentRequestError(
      `Files can be up to ${Math.floor(maxBytes / 1_000_000)} MB.`,
      413,
    );
  return {
    file: { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
    fields: body,
  };
}

export function documentRoutes(platform: Platform) {
  const app = new Hono();
  const workspace = platform.workspace;
  const library = () => {
    const value = platform.services.documents;
    if (!value)
      throw new DocumentRequestError(
        'The document library needs DATABASE_URL and DOCLING_URL.',
        503,
      );
    return value;
  };
  const detail = (id: string) =>
    workspace.documents.detail(id, workspace.dots());
  const maxBytes =
    platform.config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_MB * 1_000_000;

  app.get('/documents', (c) => {
    const parsed = filter.safeParse(c.req.query());
    if (!parsed.success) throw new DocumentRequestError('Invalid filter.');
    return c.json(workspace.documents.list(parsed.data));
  });
  app.post('/documents', async (c) => {
    const documents = library();
    const { file, fields } = await readUpload(c, maxBytes);
    const mode = access.safeParse(fields.access ?? 'none');
    if (!mode.success)
      throw new DocumentRequestError('Access must be none, dots or all.');
    const dotIds = mode.data === 'dots' ? strings(fields.dotIds) : [];
    const spaceIds = strings(fields.spaceIds);
    const threadId = strings(fields.threadId)[0];
    let source: { sourceThreadId?: string; sourceDotId?: string } = {};
    if (threadId) {
      // Attachments: the receiving Dot can read it, and so can the page's Space.
      const thread = workspace.requireThread(threadId);
      if (workspace.threadKind(threadId) !== 'chat')
        throw new DocumentRequestError('Attach files in a chat conversation.');
      dotIds.push(thread.dotId);
      const page = workspace.pages.forThread(threadId);
      if (page && workspace.canAccessSpace(thread.dotId, page.spaceId))
        spaceIds.push(page.spaceId);
      source = { sourceThreadId: thread.id, sourceDotId: thread.dotId };
    }
    const title = strings(fields.title)[0]?.slice(0, 200);
    const document = await documents.upload(file, {
      title,
      allDots: mode.data === 'all',
      dotIds,
      spaceIds,
      ...source,
    });
    return c.json(detail(document.id), 201);
  });
  app.get('/documents/:id', (c) => c.json(detail(c.req.param('id'))));
  app.patch('/documents/:id', async (c) => {
    const parsed = patch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new DocumentRequestError(
        'Send a title, allDots, dotIds or spaceIds to change.',
      );
    workspace.documents.update(c.req.param('id'), parsed.data);
    return c.json(detail(c.req.param('id')));
  });
  app.post('/documents/:id/versions', async (c) => {
    const documents = library();
    workspace.documents.require(c.req.param('id'));
    const { file } = await readUpload(c, maxBytes);
    await documents.addVersion(c.req.param('id'), file);
    return c.json(detail(c.req.param('id')), 201);
  });
  app.post('/documents/:id/reprocess', (c) => {
    library().reprocess(c.req.param('id'));
    return c.json(detail(c.req.param('id')));
  });
  app.delete('/documents/:id', async (c) => {
    await library().remove(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.get('/documents/:id/file', async (c) => {
    const { bytes, fileName } = await library().readOriginal(c.req.param('id'));
    return new Response(new Uint8Array(bytes), {
      headers: {
        // Never rendered inline: an uploaded HTML file must not run as this origin.
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  });
  app.get('/documents/:id/text', async (c) =>
    c.json({ text: await library().text(c.req.param('id')) }),
  );
  app.post('/documents/:id/convert-to-page', async (c) => {
    const parsed = z
      .object({ spaceId: z.string().min(1) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new DocumentRequestError('Choose a Space.');
    const document = workspace.documents.require(c.req.param('id'));
    const text = await library().text(document.id);
    if (!text)
      throw new DocumentRequestError(
        'This document has no converted text yet. Wait until it is ready.',
      );
    const note = '\n\n*Converted text was truncated to fit a page.*';
    const page = workspace.pages.create(parsed.data.spaceId, {
      title: document.title.slice(0, 160),
      content:
        text.length > PAGE_CONTENT_LIMIT
          ? text.slice(0, PAGE_CONTENT_LIMIT - note.length) + note
          : text,
    });
    return c.json(page, 201);
  });
  app.onError((error, c) => {
    if (error instanceof DocumentRequestError)
      return c.json({ error: error.message }, error.status);
    if (error instanceof SyntaxError)
      return c.json({ error: 'Invalid JSON request.' }, 400);
    const message = error instanceof Error ? error.message : '';
    if (
      /^(Document not found|Document access|Unsupported file type|The file |Conversation does not belong|Space not found|Pages require)/.test(
        message,
      )
    )
      return c.json(
        { error: message },
        /not found|does not belong/.test(message) ? 404 : 400,
      );
    console.error('Document request failed:', error.name);
    return c.json(
      {
        error:
          'The document request could not complete. Check that Postgres and docling-serve are running.',
      },
      503,
    );
  });
  return app;
}
