import { randomUUID } from 'node:crypto';
import type { Message } from '@ag-ui/core';
import { speakable } from './live-call-controller.js';
import type { PlatformConfig } from './platform-config.js';
import {
  taskModel,
  type CallReport,
  type Routing,
  type TaskBrief,
  type TaskSource,
} from './task-brief.js';
import type { CallTaskStatus, WorkspaceStore } from './workspace.js';
import type { SqliteThreadRunner } from './thread-runner.js';
import {
  callTaskMessagePrefix,
  chatTaskMessagePrefix,
} from '../shared/call-task.js';

/** A background task that runs one child turn on its own hidden thread. */
export interface QueuedTask {
  /** The persisted record's ID. */
  id: string;
  childThreadId: string;
  label: string;
  status: CallTaskStatus;
  brief?: TaskBrief;
  routing?: Routing | null;
  /** One of several tasks split from one request; its model follows the splitter's label. */
  split?: boolean;
  model?: string;
  /** Tasks that must finish first; their results are added to the prompt. */
  waitFor?: QueuedTask[];
  controller: AbortController;
  /** Why the task was stopped, when it was. */
  stopReason?: string;
  finishedAt?: number;
  report?: CallReport;
  settled: Promise<void>;
  settle(): void;
}

/** A result for the chat and the voice model when the child turn failed. */
export function failedReport(reason: string): CallReport {
  const text = `That request could not be completed: ${reason}`;
  return { status: 'failed', facts: text, spoken: text, details: text };
}

/** The final reply stands in for a `report_call_result` the Dot did not make. */
export function reportFromText(text: string): CallReport {
  const facts = speakable(text).slice(0, 1800) || 'Done.';
  return { status: 'done', facts, spoken: '', details: text.trim() || facts };
}

const superseded = (task: QueuedTask) => task.status === 'superseded';
export const isOpen = (task: QueuedTask) =>
  task.status === 'planning' ||
  task.status === 'waiting' ||
  task.status === 'running';

/** The finished results a task waited for, for its prompt. */
export function earlierResults(task: QueuedTask) {
  return (task.waitFor ?? []).flatMap((earlier) =>
    earlier.report
      ? [{ label: earlier.label, facts: earlier.report.facts.slice(0, 1500) }]
      : [],
  );
}

/**
 * The model for a task. A single task follows Decisions routing; each of
 * several split tasks follows the splitter's label. Anything but an explicit
 * `reasoning` answer uses the fast model, because a task can escalate.
 */
export function taskRoute(
  task: Pick<QueuedTask, 'split' | 'brief' | 'routing'>,
  config: Pick<PlatformConfig, 'fastModel'>,
  reasoningModel: string | undefined,
) {
  const answer = task.split
    ? task.brief?.complexity
    : task.routing?.complexity?.choice;
  return {
    model: taskModel(answer, config, reasoningModel),
    source: answer ? (task.split ? 'splitter' : 'decisions') : 'default',
    answer: answer ?? null,
  };
}

export interface TaskQueueOptions<T extends QueuedTask> {
  /** Names the queue in log lines. */
  name: TaskSource;
  config: Pick<PlatformConfig, 'fastModel'>;
  /** Model for tasks that are not routed to `fastModel`. */
  reasoningModel?: string;
  concurrency: () => number;
  /** Finished tasks are dropped from the queue instead of kept for later lookups. */
  forgetFinished?: boolean;
  prompt(task: T, canEscalate: boolean): string;
  /** Runs one child turn and returns its report. */
  run(
    task: T,
    prompt: string,
    model: string | undefined,
    signal: AbortSignal,
  ): Promise<CallReport>;
  save(task: T): void;
  /** Writes the result to the main thread. */
  record(task: T, report: CallReport): void;
  deliver?(task: T, report: CallReport): void;
}

/**
 * Runs queued tasks up to a concurrency cap. A task waits for the tasks in
 * its `waitFor`, runs once on its routed model, and runs again once on the
 * reasoning model when a fast run asks to escalate.
 */
export class TaskQueue<T extends QueuedTask> {
  private tasks: T[] = [];
  constructor(private options: TaskQueueOptions<T>) {}
  /** Tracks a task that is still being planned. */
  add(task: T) {
    this.tasks.push(task);
  }
  all(): readonly T[] {
    return this.tasks;
  }
  open() {
    return this.tasks.filter(isOpen);
  }
  /** Settles once every task added so far has finished or stopped. */
  settled() {
    return Promise.all(this.tasks.map((task) => task.settled)).then(() => {});
  }
  /** A planned task is ready to run once its `waitFor` tasks finish. */
  enqueue(task: T) {
    if (!this.tasks.includes(task)) this.tasks.push(task);
    task.status = 'waiting';
    this.save(task);
    this.pump();
  }
  stopAll(reason: string) {
    for (const task of this.open()) this.stop(task, reason);
  }
  stop(task: T, reason: string) {
    task.stopReason = reason;
    if (task.status === 'running') task.controller.abort(new Error(reason));
    else this.finish(task, failedReport(reason), 'stopped');
  }
  save(task: T) {
    try {
      this.options.save(task);
    } catch (error) {
      console.error(
        'A task status could not be saved:',
        error instanceof Error ? error.name : 'Error',
      );
    }
  }
  private pump() {
    const limit = this.options.concurrency();
    for (const task of this.tasks) {
      if (
        this.tasks.filter((other) => other.status === 'running').length >= limit
      )
        return;
      if (task.status !== 'waiting') continue;
      if (task.waitFor?.some(isOpen)) continue;
      void this.start(task);
    }
  }
  private async start(task: T) {
    const { config, reasoningModel } = this.options;
    task.status = 'running';
    const route = taskRoute(task, config, reasoningModel);
    task.model = route.model;
    console.info(
      `Model route for ${this.options.name} task: ${JSON.stringify(route)}`,
    );
    this.save(task);
    let report = await this.attempt(task);
    if (
      report?.escalate &&
      config.fastModel &&
      task.model === config.fastModel &&
      reasoningModel !== config.fastModel
    ) {
      task.model = reasoningModel;
      this.save(task);
      report = await this.attempt(task);
    }
    if (superseded(task)) return;
    this.finish(
      task,
      report ?? failedReport(task.stopReason ?? 'The task was stopped.'),
      task.stopReason ? 'stopped' : undefined,
    );
  }
  /** One child turn; null once the task is superseded or stopped. */
  private async attempt(task: T): Promise<CallReport | null> {
    const fast =
      !!this.options.config.fastModel &&
      task.model === this.options.config.fastModel;
    try {
      return await this.options.run(
        task,
        this.options.prompt(task, fast),
        task.model,
        task.controller.signal,
      );
    } catch (error) {
      if (task.controller.signal.aborted) return null;
      return failedReport(
        error instanceof Error ? error.message : 'unknown error',
      );
    }
  }
  private finish(task: T, report: CallReport, status?: CallTaskStatus) {
    task.report = report;
    task.finishedAt = Date.now();
    task.status = status ?? (report.status === 'failed' ? 'failed' : 'done');
    this.save(task);
    try {
      this.options.record(task, report);
    } catch (error) {
      console.error(
        'A task result could not be added to the conversation:',
        error instanceof Error ? error.name : 'Error',
      );
    }
    this.options.deliver?.(task, report);
    task.settle();
    if (this.options.forgetFinished)
      this.tasks = this.tasks.filter((other) => other !== task);
    this.pump();
  }
}

/** A new task's runtime state around its stored record. */
export function taskState(record: { id: string; childThreadId: string }) {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    ...record,
    controller: new AbortController(),
    settled,
    settle,
  };
}

/**
 * Runs a task's child turn and returns the report its `report_call_result`
 * saved, or the final reply as a report when it saved none.
 */
export async function runChildTurn(
  workspace: Pick<WorkspaceStore, 'clearCallTaskReport' | 'callTask'>,
  turn: () => Promise<string>,
  taskId: string,
): Promise<CallReport> {
  workspace.clearCallTaskReport(taskId);
  let text = '';
  let failure: unknown;
  try {
    text = await turn();
  } catch (error) {
    failure = error;
  }
  const report = workspace.callTask(taskId)?.report;
  if (report) return report;
  if (failure) throw failure;
  return reportFromText(text);
}

/** The task, then its full answer, as a compact exchange in the main thread. */
export function appendTaskResult(
  runner: Pick<SqliteThreadRunner, 'appendExchange'>,
  threadId: string,
  dotId: string,
  task: {
    id: string;
    number: number;
    revision?: number;
    label: string;
    task: string;
    source: TaskSource;
  },
  report: CallReport,
) {
  const call = task.source === 'call';
  const revision =
    task.revision && task.revision > 1 ? `, revision ${task.revision}` : '';
  const prompt = {
    id: `${call ? callTaskMessagePrefix : chatTaskMessagePrefix}${randomUUID()}`,
    role: 'user',
    content: `${call ? 'Call task' : 'Task'} ${task.number}${revision}: ${task.label}\n\n${task.task}`,
    metadata: {
      opendotsSource: call ? 'call_task' : 'chat_task',
      callTaskId: task.id,
      label: task.label,
    },
  } as Message;
  runner.appendExchange(
    threadId,
    dotId,
    prompt,
    report.needsOwner
      ? `${report.details}\n\n**Question for you:** ${report.needsOwner}`
      : report.details,
  );
}
