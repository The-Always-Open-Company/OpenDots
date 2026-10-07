import { randomUUID } from 'node:crypto';
import { PageError } from './pages.js';
import type { WorkspaceStore } from './workspace.js';
export class PageService {
  constructor(
    private workspace: WorkspaceStore,
    private requireReady: () => void = () => {},
  ) {}
  async conversation(spaceId: string, pageId: string, dotId: string) {
    const page = this.workspace.pages.get(spaceId, pageId);
    const dot = this.workspace.dot(dotId);
    if (!dot || !this.workspace.canAccessSpace(dotId, spaceId))
      throw new PageError(
        'Choose a specialist in this Space with access enabled.',
        400,
      );
    const current = this.workspace.pages.thread(pageId, dotId);
    if (current?.ready)
      return this.workspace.requireThread(current.threadId, dotId);
    this.requireReady();
    if (!this.workspace.pages.reserveThread(pageId, dotId, randomUUID()))
      throw new PageError(
        'This page conversation is being created. Retry shortly.',
        409,
      );
    const threadId = this.workspace.pages.thread(pageId, dotId)!.threadId;
    try {
      const thread =
        this.workspace.conversations().find((t) => t.id === threadId) ??
        this.workspace.bindThread(threadId, dotId, page.title);
      this.workspace.pages.finishThread(pageId, dotId);
      return thread;
    } catch (error) {
      this.workspace.pages.releaseThread(pageId, dotId);
      throw error;
    }
  }
  async saveConversation(
    threadId: string,
    title: string,
    parentId: string | null,
  ) {
    const thread = this.workspace.requireThread(threadId);
    const dot = this.workspace.dot(thread.dotId)!;
    const chunks: string[] = [];
    for (const message of this.workspace.threads.messages(threadId)) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      let text = '';
      if (typeof message.content === 'string') text = message.content;
      else if (Array.isArray(message.content)) {
        text = message.content
          .flatMap((part) =>
            part &&
            typeof part === 'object' &&
            'text' in part &&
            typeof part.text === 'string'
              ? [part.text]
              : [],
          )
          .join('\n');
      }
      if (text.trim())
        chunks.push(`## ${message.role === 'user' ? 'You' : 'Dot'}\n\n${text}`);
    }
    const content = chunks.join('\n\n');
    if (!content)
      throw new PageError('This conversation has no persisted text to save.');
    if (content.length > 100000)
      throw new PageError(
        'This conversation exceeds the 100,000 character page limit. Save a shorter conversation.',
      );
    const destination =
      this.workspace.pages.forThread(threadId)?.spaceId ?? dot.spaceId;
    if (!this.workspace.canAccessSpace(dot.id, destination))
      throw new PageError('Space access has been revoked.', 400);
    return this.workspace.pages.create(
      destination,
      { title, content, parentId },
      threadId,
    );
  }
}
