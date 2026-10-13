import {
  AgentRunner,
  finalizeRunEvents,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  type LocalThreadEndpointRecord,
} from '@copilotkit/runtime/v2';
import {
  compactEvents,
  EventType,
  type AbstractAgent,
  type BaseEvent,
  type Message,
} from '@ag-ui/client';
import { Observable, ReplaySubject } from 'rxjs';
import {
  clientAdditions,
  type StoredRun,
  type ThreadHistory,
} from './thread-history.js';

interface ActiveRun {
  runId: string;
  agent: AbstractAgent;
  subject: ReplaySubject<BaseEvent>;
  stop: { requested: boolean };
}

function eventMessageId(event: BaseEvent): string | undefined {
  const id = (event as { messageId?: unknown }).messageId;
  return typeof id === 'string' ? id : undefined;
}

const terminal = (event: BaseEvent) =>
  event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR;

// Clients reject RUN_FINISHED without IDs and stop applying the replay there.
function withRunIds(
  event: BaseEvent,
  threadId: string,
  runId: string,
): BaseEvent {
  if (event.type !== EventType.RUN_FINISHED) return event;
  const ids = event as { threadId?: unknown; runId?: unknown };
  return typeof ids.threadId === 'string' && typeof ids.runId === 'string'
    ? event
    : ({ ...event, threadId, runId } as BaseEvent);
}

// Older stopped runs were saved with a duplicate, ID-less RUN_FINISHED.
function replayEvents(runs: StoredRun[]): BaseEvent[] {
  return compactEvents(
    runs.flatMap((run) => {
      const end = run.events.findIndex(terminal);
      return (end < 0 ? run.events : run.events.slice(0, end + 1)).map(
        (event) => withRunIds(event, run.threadId, run.runId),
      );
    }),
  );
}

// Durable replacement for CopilotKit's InMemoryAgentRunner: the same run,
// connect and stop semantics, persisted in the workspace database.
export class SqliteThreadRunner extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  private active = new Map<string, ActiveRun>();

  constructor(private history: ThreadHistory) {
    super();
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId, agent, input } = request;
    if (this.active.has(threadId)) throw new Error('Thread already running');
    const additions = new Set(
      clientAdditions(this.history.messages(threadId), input.messages).map(
        (message) => message.id,
      ),
    );
    const parentRunId = this.history.lastRunId(threadId);
    const stop = { requested: false };
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    const active: ActiveRun = { runId: input.runId, agent, subject, stop };
    this.active.set(threadId, active);
    const events: BaseEvent[] = [];
    const emit = (event: BaseEvent) => {
      events.push(event);
      subject.next(event);
    };
    const finish = (interruptionMessage?: string) => {
      // finalizeRunEvents appends to the array it is given; emit appends too.
      for (const event of finalizeRunEvents([...events], {
        stopRequested: stop.requested,
        ...(interruptionMessage === undefined ? {} : { interruptionMessage }),
      }))
        emit(withRunIds(event, threadId, input.runId));
      try {
        if (interruptionMessage === undefined || events.length)
          this.persist(
            threadId,
            input.runId,
            parentRunId,
            agent,
            events,
            additions,
          );
      } catch (error) {
        console.error(
          'Thread history could not be saved:',
          error instanceof Error ? error.name : 'Error',
        );
      } finally {
        if (this.active.get(threadId) === active) this.active.delete(threadId);
        subject.complete();
      }
    };
    void agent
      .runAgent(input, {
        onEvent: ({ event }) => {
          if (event.type === EventType.RUN_STARTED) {
            const started = event as BaseEvent & { input?: unknown };
            started.input ??= {
              ...input,
              messages: input.messages.filter((m) => additions.has(m.id)),
            };
          }
          emit(event);
        },
      })
      .then(
        () => finish(),
        (error: unknown) =>
          finish(error instanceof Error ? error.message : String(error)),
      );
    return subject.asObservable();
  }

  private persist(
    threadId: string,
    runId: string,
    parentRunId: string | null,
    agent: AbstractAgent,
    events: BaseEvent[],
    additions: Set<string>,
  ) {
    // Tool-call-only assistant messages are identified by parentMessageId.
    const generated = new Set(
      events
        .flatMap((event) => [
          eventMessageId(event),
          (event as { parentMessageId?: unknown }).parentMessageId,
        ])
        .filter((id): id is string => typeof id === 'string' && !!id),
    );
    const messages = (agent.messages as Message[]).filter(
      (message) => generated.has(message.id) || additions.has(message.id),
    );
    this.history.appendRun(
      {
        runId,
        threadId,
        agentId: agent.agentId ?? 'default',
        parentRunId,
        events: compactEvents(events),
        createdAt: Date.now(),
      },
      messages,
      generated,
    );
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const connection = new ReplaySubject<BaseEvent>(Infinity);
    const replayed = new Set<string>();
    for (const event of replayEvents(this.history.runs(request.threadId))) {
      connection.next(event);
      const id = eventMessageId(event);
      if (id) replayed.add(id);
    }
    const active = this.active.get(request.threadId);
    if (active)
      active.subject.subscribe({
        next: (event) => {
          const id = eventMessageId(event);
          if (!id || !replayed.has(id)) connection.next(event);
        },
        complete: () => connection.complete(),
        error: (error) => connection.error(error),
      });
    else connection.complete();
    return connection.asObservable();
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return Promise.resolve(this.active.has(request.threadId));
  }

  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const active = this.active.get(request.threadId);
    if (
      !active ||
      active.stop.requested ||
      (request.runId !== undefined && request.runId !== active.runId)
    )
      return Promise.resolve(false);
    active.stop.requested = true;
    try {
      active.agent.abortRun();
      return Promise.resolve(true);
    } catch {
      active.stop.requested = false;
      return Promise.resolve(false);
    }
  }

  listThreads(): LocalThreadEndpointRecord[] {
    return this.history.threads().map((thread) => ({
      id: thread.id,
      name: thread.name,
      agentId: thread.agentId,
      organizationId: '',
      createdById: '',
      archived: false,
      createdAt: new Date(thread.createdAt).toISOString(),
      updatedAt: new Date(thread.updatedAt).toISOString(),
    }));
  }

  getThreadMessages(threadId: string): Message[] {
    return this.history.messages(threadId);
  }

  getThreadEvents(threadId: string): BaseEvent[] {
    return replayEvents(this.history.runs(threadId));
  }

  getThreadState(threadId: string): Record<string, unknown> | null {
    const snapshot = this.getThreadEvents(threadId).findLast(
      (event) => event.type === EventType.STATE_SNAPSHOT,
    ) as (BaseEvent & { snapshot?: Record<string, unknown> }) | undefined;
    return snapshot?.snapshot ?? null;
  }

  // History is durable; the runtime's local "clear threads" route must not wipe it.
  clearThreads(): void {}
}
