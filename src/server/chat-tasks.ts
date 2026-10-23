import type { Platform } from './platform.js';
import type { CompleteJson } from './model-json.js';
import {
  briefWriter,
  MAX_SPLIT_TASKS,
  splitRequest,
  taskPrompt,
  type CallReport,
  type TaskBrief,
  type TaskInput,
  type TaskSplit,
} from './task-brief.js';
import {
  appendTaskResult,
  earlierResults,
  runChildTurn,
  TaskQueue,
  taskState,
  type QueuedTask,
} from './task-queue.js';

/** Chat tasks running at once, across every chat. */
export const CHAT_TASK_CONCURRENCY = 3;
/** A chat task's child turn longer than this is stopped. */
export const CHAT_TASK_TIME_LIMIT_MS = 90_000;

export interface ChatTask extends QueuedTask {
  /** Its place in the message's list of tasks, from 1. */
  number: number;
  parentThreadId: string;
  dotId: string;
  waitFor?: ChatTask[];
}

/** What a chat turn needs to hand several requests to background tasks. */
export interface ChatTaskStarter {
  split(input: TaskInput, signal?: AbortSignal): Promise<TaskSplit | null>;
  start(request: {
    parentThreadId: string;
    dotId: string;
    /** The run of the message that was split. */
    runId: string;
    tasks: TaskBrief[];
  }): void;
}

/** The main turn's reply when a message is split; written without a model call. */
export function chatTaskReply(tasks: TaskBrief[]) {
  return `Working on these separately:\n${tasks.map((task, index) => `${index + 1}. ${task.label}`).join('\n')}\n\nEach result will appear here when it's ready.`;
}

/**
 * Runs the tasks a split chat message became, each in a hidden child thread.
 * Every result is posted to the chat on its own as soon as it is ready.
 */
export class ChatTaskService implements ChatTaskStarter {
  private queue: TaskQueue<ChatTask>;
  constructor(
    private platform: Pick<
      Platform,
      'workspace' | 'store' | 'config' | 'turn' | 'runner' | 'services'
    >,
    private complete: CompleteJson | undefined = briefWriter(platform.config),
  ) {
    const { config, workspace } = platform;
    this.queue = new TaskQueue<ChatTask>({
      name: 'chat',
      config,
      reasoningModel: config.model,
      concurrency: () => CHAT_TASK_CONCURRENCY,
      forgetFinished: true,
      prompt: (task, canEscalate) =>
        taskPrompt(task.brief!, canEscalate, {
          source: 'chat',
          earlier: earlierResults(task),
        }),
      run: async (task, prompt, model, signal) => {
        if (platform.store.settings().paused) throw new Error('Pod is paused.');
        return runChildTurn(
          workspace,
          () =>
            platform.turn(
              task.childThreadId,
              prompt,
              AbortSignal.any([
                signal,
                AbortSignal.timeout(CHAT_TASK_TIME_LIMIT_MS),
              ]),
              { opendotsSource: 'chat_task', callTaskId: task.id },
              { model },
            ),
          task.id,
        );
      },
      save: (task) =>
        workspace.updateCallTask(task.id, {
          label: task.label,
          task: task.brief?.task,
          status: task.status,
          model: task.model,
        }),
      record: (task, report) =>
        appendTaskResult(
          platform.runner,
          task.parentThreadId,
          task.dotId,
          {
            id: task.id,
            number: task.number,
            label: task.label,
            task: task.brief?.task ?? task.label,
            source: 'chat',
          },
          report,
        ),
      deliver: (task, report) => this.notify(task, report),
    });
  }
  split(input: TaskInput, signal?: AbortSignal) {
    return this.complete
      ? splitRequest(this.complete, input, {
          source: 'chat',
          maxTasks: MAX_SPLIT_TASKS,
          signal,
        })
      : Promise.resolve(null);
  }
  start(request: Parameters<ChatTaskStarter['start']>[0]): ChatTask[] {
    const { workspace } = this.platform;
    const tasks = request.tasks.map((brief, index): ChatTask => {
      const task: ChatTask = {
        ...taskState(
          workspace.createCallTask({
            source: 'chat',
            callId: request.runId,
            delegationId: request.runId,
            parentThreadId: request.parentThreadId,
            label: brief.label,
            task: brief.task,
          }),
        ),
        number: index + 1,
        parentThreadId: request.parentThreadId,
        dotId: request.dotId,
        label: brief.label,
        status: 'planning',
        brief,
        split: request.tasks.length > 1,
      };
      this.queue.add(task);
      return task;
    });
    for (const task of tasks) {
      const after = (task.brief?.after ?? []).map((index) => tasks[index]);
      if (after.length) task.waitFor = after;
    }
    for (const task of tasks) this.queue.enqueue(task);
    return tasks;
  }
  open() {
    return this.queue.open();
  }
  settled() {
    return this.queue.settled();
  }
  stopAll(reason: string) {
    this.queue.stopAll(reason);
  }
  private notify(task: ChatTask, report: CallReport) {
    const dot = this.platform.workspace.dot(task.dotId);
    try {
      this.platform.services.notifications?.publish({
        kind: 'reply',
        dotId: task.dotId,
        title: `${dot?.name ?? 'Pod'} finished "${task.label}"`,
        body: report.needsOwner
          ? `${report.needsOwner} ${report.spoken || report.facts}`
          : report.spoken || report.facts,
        threadId: task.parentThreadId,
      });
    } catch {
      // A failed notification must not lose the result; it is already in the chat.
    }
  }
}
