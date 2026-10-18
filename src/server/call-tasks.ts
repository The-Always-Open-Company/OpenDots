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
  PREDICATE_THRESHOLD,
  routedModel,
  taskPrompt,
  type CallReport,
  type Routing,
  type TaskBrief,
  type TaskInput,
  type TaskPlanner,
} from './task-brief.js';
import type { CallTaskStatus } from './workspace.js';

export interface CallTask {
  /** The persisted record's ID. */
  id: string;
  childThreadId: string;
  /** Shown to the voice model as `Task <number>`; a revision keeps its number. */
  number: number;
  revision: number;
  delegationId: string;
  label: string;
  status: CallTaskStatus;
  input: TaskInput;
  brief?: TaskBrief;
  routing?: Routing | null;
  model?: string;
  /** A related open task that must finish first. */
  waitFor?: CallTask;
  /** The task this one replaced, if it is a correction. */
  replaces?: CallTask;
  acknowledgedAt: number;
  finishedAt?: number;
  report?: CallReport;
  controller: AbortController;
  /** Why the task was stopped, when it was. */
  stopReason?: string;
  settled: Promise<void>;
  settle(): void;
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

const superseded = (task: CallTask) => task.status === 'superseded';
const isOpen = (task: CallTask) =>
  task.status === 'planning' ||
  task.status === 'waiting' ||
  task.status === 'running';

export class CallTaskScheduler {
  private tasks: CallTask[] = [];
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
        | 'fastModel'
        | 'routerMinConfidence'
        | 'voiceTaskConcurrency'
        | 'voiceTaskAfterCallMs'
      >;
      /** Model for tasks that are not routed to `fastModel`. */
      reasoningModel?: string;
      /** The last few main-thread messages, for briefs. */
      chat: () => string;
    },
  ) {}
  get delivery() {
    return this.options.delivery;
  }
  open() {
    return this.tasks.filter(isOpen);
  }
  /** Labels of tasks still working, for the call receipt. */
  running() {
    return this.open().map((task) => task.label);
  }
  /** Settles once every task submitted so far has finished or stopped. */
  settled() {
    return Promise.all(this.tasks.map((task) => task.settled)).then(() => {});
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
    const label = fallbackBrief(input).label;
    const record = this.options.runner.create(delegationId, label);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const task: CallTask = {
      ...record,
      number: ++this.numbers,
      revision: 1,
      delegationId,
      label,
      status: 'planning',
      input,
      acknowledgedAt,
      controller: new AbortController(),
      settled,
      settle,
    };
    this.tasks.push(task);
    void this.plan(task);
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
    for (const task of this.open()) this.stop(task, reason);
  }
  private stop(task: CallTask, reason: string) {
    task.stopReason = reason;
    if (task.status === 'running') task.controller.abort(new Error(reason));
    else this.finish(task, failedReport(reason), 'stopped');
  }
  private async plan(task: CallTask) {
    const { planner } = this.options;
    const signal = task.controller.signal;
    const routing = planner.route(task.input, signal).catch(() => null);
    const brief = planner.brief(task.input, signal).catch(() => null);
    // Corrections take effect before the brief is written.
    void routing.then((answers) => this.relate(task, answers));
    const [answers, written] = await Promise.all([routing, brief]);
    if (task.status !== 'planning') return;
    task.routing = answers;
    task.brief = written ?? fallbackBrief(task.input);
    task.label = task.brief.label;
    if (
      written?.clarify &&
      (answers?.needsClarification ?? 0) > PREDICATE_THRESHOLD
    ) {
      this.options.delivery.clarify(task, written.clarify);
      task.status = 'clarify';
      this.save(task);
      task.settle();
      return;
    }
    task.status = 'waiting';
    this.save(task);
    this.pump();
  }
  private relate(task: CallTask, answers: Routing | null) {
    if (task.status !== 'planning' || !answers?.relatesTo) return;
    const related = this.tasks.find(
      (other) => other !== task && key(other) === answers.relatesTo,
    );
    if (!related || !isOpen(related)) return;
    if (answers.isCorrection > PREDICATE_THRESHOLD) {
      task.number = related.number;
      task.revision = related.revision + 1;
      task.replaces = related;
      task.waitFor = related.waitFor;
      related.status = 'superseded';
      related.controller.abort(new Error('Superseded by a correction.'));
      this.save(related);
      related.settle();
    } else task.waitFor = related;
  }
  private save(task: CallTask) {
    try {
      this.options.runner.save(task);
    } catch (error) {
      console.error(
        'A call task status could not be saved:',
        error instanceof Error ? error.name : 'Error',
      );
    }
  }
  private pump() {
    const limit =
      this.options.config.voiceTaskConcurrency ??
      DEFAULT_VOICE_TASK_CONCURRENCY;
    for (const task of this.tasks) {
      if (
        this.tasks.filter((other) => other.status === 'running').length >= limit
      )
        return;
      if (task.status !== 'waiting') continue;
      if (task.waitFor && isOpen(task.waitFor)) continue;
      void this.start(task);
    }
  }
  private async start(task: CallTask) {
    const { config, reasoningModel } = this.options;
    task.status = 'running';
    task.model = routedModel(task.routing?.complexity, config, reasoningModel);
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
  private async attempt(task: CallTask): Promise<CallReport | null> {
    const fast =
      !!this.options.config.fastModel &&
      task.model === this.options.config.fastModel;
    try {
      return await this.options.runner.run(
        task,
        taskPrompt(task.brief!, fast),
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
  private finish(task: CallTask, report: CallReport, status?: CallTaskStatus) {
    task.report = report;
    task.finishedAt = Date.now();
    task.status = status ?? (report.status === 'failed' ? 'failed' : 'done');
    this.save(task);
    try {
      this.options.runner.record(task, report);
    } catch (error) {
      console.error(
        'A call task result could not be added to the conversation:',
        error instanceof Error ? error.name : 'Error',
      );
    }
    this.options.delivery.deliver(task, report);
    task.settle();
    this.pump();
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
