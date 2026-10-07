import { z } from 'zod';
import {
  chunksToMarkdown,
  type DocumentLibrary,
  type StoredChunk,
} from './document-library.js';
import type { DocumentClaim, Documents } from './documents.js';

const task = z.object({
  task_id: z.string(),
  task_status: z.string(),
  error_message: z.string().nullish(),
});
const result = z.object({
  chunks: z.array(
    z.object({
      chunk_index: z.number().optional(),
      text: z.string(),
      raw_text: z.string().nullish(),
      headings: z.array(z.string()).nullish(),
      page_numbers: z.array(z.number()).nullish(),
    }),
  ),
});

export interface IngestorOptions {
  tickMs?: number;
  pollMs?: number;
  /** Total time one document may take, including queueing in docling-serve. */
  timeoutMs?: number;
  /** How often a running job extends its lease. */
  renewMs?: number;
}

/**
 * Converts queued documents with docling-serve, one at a time. A lease keeps
 * a restarted server, a new version or a delete from being overwritten.
 */
export class DocumentIngestor {
  private timer?: ReturnType<typeof setInterval>;
  private active?: { claim: DocumentClaim; controller: AbortController };
  private options: Required<IngestorOptions>;
  constructor(
    private documents: Documents,
    private library: DocumentLibrary,
    private doclingUrl: string,
    options: IngestorOptions = {},
  ) {
    this.options = {
      tickMs: 2_000,
      pollMs: 2_000,
      timeoutMs: 30 * 60_000,
      renewMs: 60_000,
      ...options,
    };
  }
  start() {
    if (this.timer) return;
    void this.library
      .sweep()
      .catch(() =>
        console.error('Document cleanup failed; it will retry on restart.'),
      );
    this.timer = setInterval(() => void this.tick(), this.options.tickMs);
    void this.tick();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.active) {
      this.active.controller.abort(new Error('Server stopping.'));
      this.documents.release(this.active.claim);
    }
  }
  /** Starts the next job now instead of waiting for the next tick. */
  wake() {
    if (this.timer) void this.tick();
  }
  async tick() {
    if (this.active) return;
    let claim: DocumentClaim | null;
    try {
      claim = this.documents.claim();
    } catch {
      console.error('Document queue check failed; will retry.');
      return;
    }
    if (!claim) return;
    const controller = new AbortController();
    this.active = { claim, controller };
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Processing took longer than ${Math.round(this.options.timeoutMs / 60_000)} minutes.`,
          ),
        ),
      this.options.timeoutMs,
    );
    const current = claim;
    const renew = setInterval(() => {
      if (!this.documents.renew(current))
        controller.abort(new Error('Document changed while processing.'));
    }, this.options.renewMs);
    try {
      const { chunks, markdown } = await this.convert(
        current,
        controller.signal,
      );
      await this.library.saveConversion(
        current,
        chunks,
        markdown,
        controller.signal,
      );
    } catch (error) {
      if (this.timer || !controller.signal.aborted)
        this.documents.fail(
          current,
          error instanceof Error
            ? error.message
            : 'Document processing failed.',
        );
    } finally {
      clearTimeout(timeout);
      clearInterval(renew);
      this.active = undefined;
    }
    if (this.timer) void this.tick();
  }
  private async convert(claim: DocumentClaim, signal: AbortSignal) {
    const base = this.doclingUrl.replace(/\/$/, '');
    const bytes = await this.library.readClaimed(claim);
    // docling-serve has no plain-text reader; Markdown is a superset.
    const name =
      claim.extension === 'txt' ? 'document.md' : `document.${claim.extension}`;
    const form = new FormData();
    form.append(
      'files',
      new Blob([new Uint8Array(bytes)], { type: claim.mimeType }),
      name,
    );
    // The chunk endpoint cannot return Markdown; the readable copy is rebuilt from raw chunks.
    form.append('include_converted_doc', 'false');
    form.append('chunking_include_raw_text', 'true');
    form.append('chunking_use_markdown_tables', 'true');
    form.append('target_type', 'inbody');
    form.append('convert_image_export_mode', 'placeholder');
    form.append('convert_include_images', 'false');
    const submit = await fetch(`${base}/v1/chunk/hybrid/file/async`, {
      method: 'POST',
      body: form,
      signal,
    }).catch(() => {
      signal.throwIfAborted();
      throw new Error('Could not reach docling-serve. Check DOCLING_URL.');
    });
    if (!submit.ok)
      throw new Error(
        `docling-serve rejected the document (HTTP ${submit.status}).`,
      );
    let status = task.parse(await submit.json());
    while (
      !['success', 'failure', 'partial_success'].includes(status.task_status)
    ) {
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs));
      signal.throwIfAborted();
      const poll = await fetch(
        `${base}/v1/status/poll/${encodeURIComponent(status.task_id)}`,
        { signal },
      );
      if (!poll.ok)
        throw new Error(
          `docling-serve status check failed (HTTP ${poll.status}).`,
        );
      status = task.parse(await poll.json());
    }
    if (status.task_status === 'failure')
      throw new Error(
        `docling-serve could not convert this file${status.error_message ? `: ${status.error_message.slice(0, 300)}` : '.'}`,
      );
    const response = await fetch(
      `${base}/v1/result/${encodeURIComponent(status.task_id)}`,
      { signal },
    );
    if (!response.ok)
      throw new Error(
        `docling-serve result fetch failed (HTTP ${response.status}).`,
      );
    const data = result.parse(await response.json());
    const chunks: StoredChunk[] = data.chunks
      .filter((chunk) => chunk.text.trim())
      .map((chunk, ordinal) => {
        const pages = chunk.page_numbers ?? [];
        return {
          ordinal,
          text: chunk.text,
          raw: chunk.raw_text ?? undefined,
          headings: chunk.headings ?? [],
          pageFrom: pages.length ? Math.min(...pages) : null,
          pageTo: pages.length ? Math.max(...pages) : null,
        };
      });
    if (!chunks.length)
      throw new Error(
        'No readable text was found in this file. If every file fails this way, check the docling-serve logs.',
      );
    const markdown = chunksToMarkdown(chunks);
    return { chunks, markdown };
  }
}
