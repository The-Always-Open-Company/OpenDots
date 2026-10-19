import { appendPieces, speakable } from './live-call-controller.js';
import {
  DEFAULT_VOICE_QUIET_MS,
  DEFAULT_VOICE_TASK_AFTER_CALL_MS,
  DEFAULT_VOICE_TASK_CONCURRENCY,
  type PlatformConfig,
  type VoiceResultDelivery,
} from './platform-config.js';
import {
  fallbackBrief,
  joinBriefs,
  PREDICATE_THRESHOLD,
  taskPrompt,
  type CallReport,
  type Routing,
  type TaskBrief,
  type TaskInput,
  type TaskPlanner,
} from './task-brief.js';
import {
  earlierResults,
  isOpen,
  TaskQueue,
  taskState,
  type QueuedTask,
} from './task-queue.js';

export { failedReport, reportFromText } from './task-queue.js';

export interface CallTask extends QueuedTask {
  /** Shown to the voice model as `Task <number>`; a revision keeps its number. */
  number: number;
  revision: number;
  /** Shared by every task split from one delegation. */
  delegationId: string;
  input: TaskInput;
  /** Related open tasks that must finish first. */
  waitFor?: CallTask[];
  /** The task this one replaced, if it is a correction. */
  replaces?: CallTask;
  acknowledgedAt: number;
}

/** What the scheduler needs from storage and the Dot runtime. */
export interface CallTaskRunner {
  /** Creates the task's record and its hidden child thread. */
  create(
    delegationId: string,
    label: string,
  ): { id: string; childThreadId: string };
  save(task: CallTask): void;
  /** Runs one child turn and returns its report. */
  run(
    task: CallTask,
    prompt: string,
    model: string | undefined,
    signal: AbortSignal,
  ): Promise<CallReport>;
  /** Appends the compact exchange to the main thread. */
  record(task: CallTask, report: CallReport): void;
  /** Tells the owner about a result they did not hear on the call. */
  notify(task: CallTask, report: CallReport): void;
}

const superseded = (task: CallTask) => task.status === 'superseded';

/**
 * Plans the tasks a live call delegates: routing, corrections, clarification
 * and splitting one delegation into several tasks. Running them is the
 * `TaskQueue`'s job; results go to the call, or to the chat after it ends.
 */
export class CallTaskScheduler {
  private queue: TaskQueue<CallTask>;
  private numbers = 0;
  private detached = false;
  private afterCall?: ReturnType<typeof setTimeout>;
  constructor(
    private options: {
      planner: TaskPlanner;
      runner: CallTaskRunner;
      delivery: ResultDelivery;
      config: Pick<
        PlatformConfig,
        'fastModel' | 'voiceTaskConcurrency' | 'voiceTaskAfterCallMs'
      >;
      /** Model for tasks that are not routed to `fastModel`. */
      reasoningModel?: string;
      /** The last few main-thread messages, for briefs. */
      chat: () => string;
    },
  ) {
    const { runner, delivery, config } = options;
    this.queue = new TaskQueue<CallTask>({
      name: 'call',
      config,
      reasoningModel: options.reasoningModel,
      concurrency: () =>
        config.voiceTaskConcurrency ?? DEFAULT_VOICE_TASK_CONCURRENCY,
      prompt: (task, canEscalate) =>
        taskPrompt(task.brief!, canEscalate, {
          source: 'call',
          earlier: earlierResults(task),
        }),
      run: (task, prompt, model, signal) =>
        runner.run(task, prompt, model, signal),
      save: (task) => runner.save(task),
      record: (task, report) => runner.record(task, report),
      deliver: (task, report) => delivery.deliver(task, report),
    });
  }
  get delivery() {
    return this.options.delivery;
  }
  open() {
    return this.queue.open();
  }
  /** Labels of tasks still working, for the call receipt. */
  running() {
    return this.open().map((task) => task.label);
  }
  /** Settles once every task submitted so far has finished or stopped. */
  settled() {
    return this.queue.settled();
  }
  /** Starts planning a delegated request; returns the task right away. */
  submit(
    delegationId: string,
    utterance: { words: string; transcript: string },
    acknowledgedAt = Date.now(),
  ): CallTask {
    const input: TaskInput = {
      ...utterance,
      chat: this.options.chat(),
      openTasks: this.open().map((task) => ({
        id: key(task),
        label: task.label,
      })),
    };
    const task = this.create(
      delegationId,
      fallbackBrief(input).label,
      input,
      acknowledgedAt,
    );
    void this.plan(task);
    return task;
  }
  private create(
    delegationId: string,
    label: string,
    input: TaskInput,
    acknowledgedAt: number,
  ): CallTask {
    const task: CallTask = {
      ...taskState(this.options.runner.create(delegationId, label)),
      number: ++this.numbers,
      revision: 1,
      delegationId,
      label,
      status: 'planning',
      input,
      acknowledgedAt,
    };
    this.queue.add(task);
    return task;
  }
  /** The call ended: results go to the chat, and tasks get a time limit. */
  detach() {
    if (this.detached) return;
    this.detached = true;
    this.options.delivery.detach();
    if (!this.open().length) return;
    this.afterCall = setTimeout(
      () =>
        this.stopAll(
          'It was still running when the after-call time limit was reached.',
        ),
      this.options.config.voiceTaskAfterCallMs ??
        DEFAULT_VOICE_TASK_AFTER_CALL_MS,
    );
    this.afterCall.unref?.();
    void this.settled().then(() => clearTimeout(this.afterCall));
  }
  stopAll(reason: string) {
    this.queue.stopAll(reason);
  }
  private async plan(task: CallTask) {
    const { planner } = this.options;
    const signal = task.controller.signal;
    const routing = planner.route(task.input, signal).catch(() => null);
    const split = planner.split(task.input, signal).catch(() => null);
    // Corrections take effect before the briefs are written.
    void routing.then((answers) => this.relate(task, answers));
    const [answers, written] = await Promise.all([routing, split]);
    if (task.status !== 'planning') return;
    task.routing = answers;
    let briefs: TaskBrief[] = written?.tasks.length
      ? written.tasks
      : [fallbackBrief(task.input)];
    // A follow-up or correction changes one open task, so it stays one task.
    if (briefs.length > 1 && (answers?.relatesTo || task.replaces))
      briefs = [joinBriefs(briefs)];
    task.brief = briefs[0];
    task.label = task.brief.label;
    if (
      written?.clarify &&
      (answers?.needsClarification ?? 0) > PREDICATE_THRESHOLD
    ) {
      this.options.delivery.clarify(task, written.clarify);
      task.status = 'clarify';
      this.queue.save(task);
      task.settle();
      return;
    }
    const group = [
      task,
      ...briefs.slice(1).map((brief) => {
        const sibling = this.create(
          task.delegationId,
          brief.label,
          task.input,
          task.acknowledgedAt,
        );
        sibling.brief = brief;
        sibling.routing = answers;
        return sibling;
      }),
    ];
    if (group.length > 1)
      for (const member of group) {
        member.split = true;
        const after = (member.brief?.after ?? []).map((index) => group[index]);
        if (after.length)
          member.waitFor = [...(member.waitFor ?? []), ...after];
      }
    for (const member of group) this.queue.enqueue(member);
  }
  private relate(task: CallTask, answers: Routing | null) {
    if (task.status !== 'planning' || !answers?.relatesTo) return;
    const related = this.queue
      .all()
      .find((other) => other !== task && key(other) === answers.relatesTo);
    if (!related || !isOpen(related)) return;
    if (answers.isCorrection > PREDICATE_THRESHOLD) {
      task.number = related.number;
      task.revision = related.revision + 1;
      task.replaces = related;
      task.waitFor = related.waitFor;
      related.status = 'superseded';
      related.controller.abort(new Error('Superseded by a correction.'));
      this.queue.save(related);
      related.settle();
    } else task.waitFor = [related];
  }
}

/** The ID a task is known by in Decisions questions. */
function key(task: CallTask) {
  return `task_${task.number}`;
}

export interface DeliverySink {
  /** Sends one append to the live session; false once it is closed. */
  append(
    type: 'thinking' | 'commentary',
    delegationId: string | null,
    content: string,
  ): boolean;
}

export interface DeliveryTiming {
  /** Silence before a spoken result is sent. */
  quietMs: number;
  /** How long spoken results wait to be combined in `batch` mode. */
  batchMs: number;
  /** After this much continuous owner speech, waiting results send their facts quietly. */
  longSpeechMs: number;
  /** In `sequential` mode, the longest wait for the voice model to speak a result. */
  speechWaitMs: number;
  /** Idle line time after which an unmentioned quiet result gets a short spoken note. */
  idleUpgradeMs: number;
  /** Owner speech this soon after a task's acknowledgement still counts as the request. */
  ackGraceMs: number;
  tickMs: number;
}

const defaultTiming: DeliveryTiming = {
  quietMs: DEFAULT_VOICE_QUIET_MS,
  batchMs: 1500,
  longSpeechMs: 8000,
  speechWaitMs: 6000,
  idleUpgradeMs: 4000,
  ackGraceMs: 1500,
  tickMs: 100,
};

/** Owner phrases that ask how a pending request is going. */
const ASKED_FOR_RESULT =
  /\b(any (news|update|luck)|is it (done|ready|finished)|are you done|did you (find|finish|get)|what did you find|have you (found|finished)|how('s| is) (it|that) going|still (working|checking))\b/i;

interface Pending {
  task: CallTask;
  report: CallReport;
  factsSent: boolean;
  queuedAt: number;
  /** An idle-line upgrade of a quiet result: only its short note is spoken. */
  upgrade?: boolean;
}
interface Untold {
  task: CallTask;
  report: CallReport;
  sentAt: number;
  words: string[];
  /** What the voice model has said since the result was sent. */
  said: string;
}

/** Labeled plain text for one result, facts first. */
export function resultNote(
  task: CallTask,
  report: CallReport,
  channel: 'thinking' | 'commentary',
) {
  const status =
    report.status === 'needs_owner' ? 'needs the owner' : report.status;
  return [
    `${taskLabel(task)} Status: ${status}.`,
    `Facts: ${speakable(report.facts)}`,
    task.replaces ? 'Replaces: the earlier revision of this task.' : '',
    `Owner needs to: ${report.needsOwner ?? 'nothing'}.`,
    channel === 'commentary'
      ? `Tell the owner now, in a sentence or two${report.spoken ? `: ${speakable(report.spoken)}` : '.'}`
      : 'Background facts: use them when relevant; do not announce them.',
  ]
    .filter(Boolean)
    .join(' ');
}

function taskLabel(task: CallTask) {
  return `[Task ${task.number}${task.revision > 1 ? `, revision ${task.revision}` : ''}: ${task.label}]`;
}

/**
 * Sends finished results to the live call without derailing it: quietly as
 * thinking by default, spoken as commentary only when the owner is waiting,
 * the task failed or the owner must decide something, and only into a pause.
 * After the call ends, results go to the chat with a notification instead.
 */
export class ResultDelivery {
  private timing: DeliveryTiming;
  private queue: Pending[] = [];
  private untold: Untold[] = [];
  private detached = false;
  private timer?: ReturnType<typeof setInterval>;
  private lastOwnerAt = 0;
  private lastDotAt = 0;
  private ownerSince?: number;
  private ownerWords = '';
  private lastSpokenAt?: number;
  private openTasks: () => number = () => 0;
  readonly metrics = {
    sent: 0,
    spoken: 0,
    sentWhileBusy: 0,
    ownerAsked: 0,
    upgraded: 0,
    toChat: 0,
    delaysMs: [] as number[],
  };
  constructor(
    private options: {
      mode: VoiceResultDelivery;
      sink: DeliverySink;
      notify: (task: CallTask, report: CallReport) => void;
      timing?: Partial<DeliveryTiming>;
      now?: () => number;
    },
  ) {
    this.timing = { ...defaultTiming, ...options.timing };
  }
  /** Counts open tasks for the owner-asked metric. */
  track(openTasks: () => number) {
    this.openTasks = openTasks;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private busy(now = this.now()) {
    return (
      now - Math.max(this.lastOwnerAt, this.lastDotAt) < this.timing.quietMs
    );
  }
  /** Transcript activity from either side of the call. */
  heard(speaker: 'owner' | 'dot', text: string) {
    const now = this.now();
    if (speaker === 'owner') {
      if (!this.busy(now) || this.ownerSince === undefined)
        this.ownerSince = now;
      this.lastOwnerAt = now;
      this.ownerWords += text;
    } else {
      this.lastDotAt = now;
      this.ownerSince = undefined;
      for (const item of this.untold)
        item.said = `${item.said}${text.toLowerCase()}`.slice(-4000);
    }
    if (this.queue.length || this.untold.length || this.ownerWords)
      this.schedule();
  }
  /** A request too unclear to act on: its question goes to the voice model. */
  clarify(task: CallTask, question: string) {
    if (this.detached) return;
    this.send(
      'thinking',
      task.delegationId,
      `${taskLabel(task)} The request is unclear; nothing was started. Ask the owner: ${question}`,
    );
  }
  deliver(task: CallTask, report: CallReport) {
    if (superseded(task)) return;
    if (this.detached) {
      this.toChat(task, report);
      return;
    }
    const waiting =
      this.lastOwnerAt <= task.acknowledgedAt + this.timing.ackGraceMs;
    const spoken =
      this.options.mode !== 'quiet' &&
      (report.status !== 'done' || (waiting && report.delivery !== 'quiet'));
    if (!spoken) {
      this.send(
        'thinking',
        task.delegationId,
        resultNote(task, report, 'thinking'),
        task,
      );
      if (this.options.mode !== 'quiet')
        this.untold.push({
          task,
          report,
          sentAt: this.now(),
          words: significantWords(task.label),
          said: '',
        });
    } else
      this.queue.push({ task, report, factsSent: false, queuedAt: this.now() });
    this.schedule();
  }
  /** The call ended: spoken results still waiting go to the chat instead. */
  detach() {
    if (this.detached) return;
    this.detached = true;
    for (const item of this.queue.splice(0))
      if (!item.upgrade) this.toChat(item.task, item.report);
    this.untold = [];
    this.stopTimer();
    console.info(`Call result delivery: ${JSON.stringify(this.summary())}`);
  }
  summary() {
    const delays = this.metrics.delaysMs;
    return {
      mode: this.options.mode,
      ...this.metrics,
      delaysMs: undefined,
      medianDelayMs: delays.length
        ? [...delays].sort((a, b) => a - b)[Math.floor(delays.length / 2)]
        : null,
      maxDelayMs: delays.length ? Math.max(...delays) : null,
    };
  }
  /** Runs one delivery step; the timer calls it, and tests can too. */
  tick() {
    if (this.detached) return;
    const now = this.now();
    if (!this.busy(now) && this.ownerWords) {
      if (
        ASKED_FOR_RESULT.test(this.ownerWords) &&
        (this.openTasks() || this.untold.length || this.queue.length)
      )
        this.metrics.ownerAsked += 1;
      this.ownerWords = '';
    }
    this.markTold();
    if (this.busy(now)) {
      if (
        this.ownerSince !== undefined &&
        this.lastOwnerAt > this.lastDotAt &&
        now - this.ownerSince >= this.timing.longSpeechMs
      )
        for (const item of this.queue)
          if (!item.factsSent && !item.upgrade) {
            item.factsSent = true;
            this.send(
              'thinking',
              item.task.delegationId,
              resultNote(item.task, item.report, 'thinking'),
              item.task,
            );
          }
    } else {
      this.upgradeUntold(now);
      this.speak(now);
    }
    if (!this.queue.length && !this.untold.length && !this.ownerWords)
      this.stopTimer();
  }
  private speak(now: number) {
    if (!this.queue.length) return;
    if (this.lastSpokenAt !== undefined) {
      const spokeSince = this.lastDotAt > this.lastSpokenAt;
      if (!spokeSince && now - this.lastSpokenAt < this.timing.speechWaitMs)
        return;
    }
    if (this.options.mode === 'batch') {
      if (now - this.queue[0].queuedAt < this.timing.batchMs) return;
      const items = this.queue.splice(0);
      for (const item of items)
        if (!item.factsSent && !item.upgrade)
          this.send(
            'thinking',
            item.task.delegationId,
            resultNote(item.task, item.report, 'thinking'),
            item.task,
          );
      const combined =
        items.length === 1
          ? spokenNote(items[0])
          : `Several results are ready. Tell the owner about each in a sentence or two, in this order: ${items
              .map(
                (item) =>
                  `${taskLabel(item.task)} ${speakable(item.report.spoken || item.report.facts).slice(0, 400)}`,
              )
              .join(' ')}`;
      this.send('commentary', items[0].task.delegationId, combined);
      this.lastSpokenAt = now;
      return;
    }
    const item = this.queue.shift()!;
    this.send(
      'commentary',
      item.task.delegationId,
      spokenNote(item),
      item.factsSent ? undefined : item.task,
    );
    this.lastSpokenAt = now;
  }
  private markTold() {
    this.untold = this.untold.filter(
      (item) => !item.words.some((word) => item.said.includes(word)),
    );
  }
  private upgradeUntold(now: number) {
    const idle = now - Math.max(this.lastOwnerAt, this.lastDotAt);
    for (const item of [...this.untold])
      if (
        idle >= this.timing.idleUpgradeMs &&
        now - item.sentAt >= this.timing.idleUpgradeMs
      ) {
        this.untold.splice(this.untold.indexOf(item), 1);
        this.metrics.upgraded += 1;
        this.queue.push({
          task: item.task,
          report: item.report,
          factsSent: true,
          queuedAt: now - this.timing.batchMs,
          upgrade: true,
        });
      }
  }
  private send(
    type: 'thinking' | 'commentary',
    delegationId: string | null,
    content: string,
    task?: CallTask,
  ) {
    const now = this.now();
    if (this.busy(now)) this.metrics.sentWhileBusy += 1;
    let sent = false;
    for (const piece of appendPieces(content))
      sent = this.options.sink.append(type, delegationId, piece) || sent;
    if (!sent) return;
    this.metrics.sent += 1;
    if (type === 'commentary') this.metrics.spoken += 1;
    if (task?.finishedAt !== undefined)
      this.metrics.delaysMs.push(now - task.finishedAt);
  }
  private toChat(task: CallTask, report: CallReport) {
    this.metrics.toChat += 1;
    try {
      this.options.notify(task, report);
    } catch {
      // A failed notification must not lose the result; it is already in the chat.
    }
  }
  private schedule() {
    if (this.timer || this.detached) return;
    this.timer = setInterval(() => this.tick(), this.timing.tickMs);
    this.timer.unref?.();
    queueMicrotask(() => this.tick());
  }
  private stopTimer() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

function spokenNote(item: Pending) {
  if (!item.upgrade) return resultNote(item.task, item.report, 'commentary');
  return `${taskLabel(item.task)} This result has not come up yet. Mention it briefly at a natural point: ${speakable(item.report.spoken || item.report.facts).slice(0, 400)}`;
}

function significantWords(label: string) {
  return label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
}
