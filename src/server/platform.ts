import { ComputerService } from './computer-service.js';
import { PageService } from './page-service.js';
import { randomUUID } from 'node:crypto';
import {
  CopilotRuntime,
  createCopilotHonoHandler,
  type CopilotHonoApp,
} from '@copilotkit/runtime/v2';
export { slackIdentity } from './slack-channel.js';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { DotAgent, type DotServices } from './dot-agent.js';
import { runThreadTurn } from './headless.js';
import { setupStatus, type PlatformConfig } from './platform-config.js';
import { validateRuntimeScope } from './runtime-scope.js';
import { SqliteThreadRunner } from './thread-runner.js';
import type { MemoryProvider } from './memory.js';
import type { DocumentLibrary } from './document-library.js';
import type { DocumentRetriever } from './document-retrieval.js';
import type { ExecutionEngine } from './execution-engine.js';
import type { PluginService } from './plugins.js';

export const CONSULTATION_TIME_LIMIT_MS = 45_000;

export interface PlatformServices {
  memory?: MemoryProvider;
  documents?: DocumentLibrary;
  retriever?: DocumentRetriever;
  engine?: ExecutionEngine;
  plugins?: PluginService;
  skillsDir?: string;
}

export class Platform {
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly runner: SqliteThreadRunner;
  readonly handler: CopilotHonoApp;
  consultationLimitMs = CONSULTATION_TIME_LIMIT_MS;
  constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
    readonly services: PlatformServices = {},
  ) {
    this.computers = new ComputerService(
      workspace,
      config,
      () => store.settings().paused,
    );
    this.pages = new PageService(workspace, () => this.requireReady());
    this.runner = new SqliteThreadRunner(workspace.threads);
    const runtime = new CopilotRuntime({
      runner: this.runner,
      agents: async () =>
        Object.fromEntries(
          workspace.dots().map((dot) => [dot.id, this.agent(dot.id)]),
        ),
    });
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
  }
  setup() {
    // Slack ran on CopilotKit Intelligence Channels; a self-hosted adapter is not wired yet.
    return setupStatus(
      this.config,
      this.config.slackChannel ? 'unavailable' : 'not_configured',
    );
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(`Setup required: ${missing.join(', ')}.`);
  }
  async start() {}
  async stop() {}
  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found.');
    return this.workspace.bindThread(randomUUID(), dotId, title);
  }
  async history(threadId: string): Promise<string> {
    this.requireReady();
    this.workspace.requireThread(threadId);
    return this.workspace.threads
      .messages(threadId)
      .filter((message) => ['user', 'assistant'].includes(message.role))
      .slice(-12)
      .map(
        (message) =>
          `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`,
      )
      .join('\n')
      .slice(-12000);
  }
  async handle(request: Request): Promise<Response> {
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      body = await request
        .clone()
        .json()
        .catch(() => null);
    try {
      validateRuntimeScope(request, this.workspace, body);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Conversation scope denied.',
        },
        { status: 403 },
      );
    }
    return this.handler.fetch(request);
  }
  private agent(dotId: string) {
    const services: DotServices = {
      ...this.services,
      consult: (from, to, question, signal) =>
        this.consult(from, to, question, signal),
    };
    return new DotAgent(
      this.store,
      this.workspace,
      this.config,
      dotId,
      false,
      services,
    );
  }
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    const thread = this.workspace.requireThread(threadId);
    const agent = this.agent(thread.dotId);
    if (
      typeof metadata?.workItemId === 'string' &&
      typeof metadata.executionId === 'string'
    )
      agent.workContext = {
        workItemId: metadata.workItemId,
        executionId: metadata.executionId,
      };
    return runThreadTurn(
      this.runner,
      agent,
      threadId,
      prompt,
      signal,
      metadata,
    );
  }
  /** One Dot asks another; the answer comes from the asked Dot's own access. */
  async consult(
    fromDotId: string,
    toDotId: string,
    question: string,
    signal: AbortSignal,
  ): Promise<string> {
    const from = this.workspace.dot(fromDotId);
    const to = this.workspace.dot(toDotId);
    if (!from || !to || to.id === from.id || !to.consultable)
      throw new Error(
        'That Dot is not available to consult. Use an ID from the consultable Dots list.',
      );
    const threadId = this.workspace.consultationThread(from.id, to.id);
    const limit = AbortSignal.timeout(this.consultationLimitMs);
    try {
      return await this.turn(
        threadId,
        `${from.name} asks (untrusted question from another Dot):\n\n${question}`,
        AbortSignal.any([signal, limit]),
        { opendotsSource: 'consultation', fromDotId: from.id },
      );
    } catch (error) {
      if (limit.aborted)
        throw new Error(
          `${to.name} did not answer within ${Math.round(this.consultationLimitMs / 1000)} seconds.`,
          { cause: error },
        );
      throw error;
    }
  }
  /** Consultation threads, newest first, with their recent messages for review. */
  consultations() {
    return this.workspace.consultations().map((item) => ({
      ...item,
      messages: this.workspace.threads
        .messages(item.threadId)
        .filter((message) => ['user', 'assistant'].includes(message.role))
        .slice(-20)
        .map((message) => ({
          id: message.id,
          role: message.role,
          content:
            typeof message.content === 'string'
              ? message.content.slice(0, 4000)
              : '',
        })),
    }));
  }
}
