/**
 * Scheduling for the model: run a task once later, on an interval, or at
 * times of day; see, change and cancel those schedules; and schedule one exact
 * action (such as a message) that the owner approves now and that runs later.
 *
 * When the owner asked for it in this conversation, a schedule takes effect at
 * once. Anywhere else, such as in a background run, it is proposed and waits
 * for the owner's approval. A scheduled action always follows the tool's own
 * permission: one that needs approval is approved now and runs at its time.
 */
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { ExecutionEngine } from './execution-engine.js';
import { decide } from './authorize.js';
import type { PluginService } from './plugins.js';
import type { PluginParameters } from './plugin-schema.js';
import {
  assertTimezone,
  initialRunAt,
  type ScheduleSpec,
} from './schedule-time.js';
import { ownerChat, snapshotFor, type WorkDeps } from './work-tools.js';
import { localTime } from './action-item-tools.js';

const MINUTE = 60_000;
const YEAR = 365 * 24 * 60 * MINUTE;
const UNITS = { minutes: 1, hours: 60, days: 1440, weeks: 10_080 } as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const isoTime = z
  .string()
  .trim()
  .max(40)
  .describe(
    'An ISO 8601 time with its UTC offset, such as 2026-11-06T13:43:00-05:00.',
  );

/** When a task runs, in the shape the model writes. */
export const whenInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('once').describe('Run once.'),
    at: isoTime.optional(),
    inMinutes: z
      .number()
      .int()
      .min(1)
      .max(525_600)
      .optional()
      .describe('Minutes from now. Give this or at.'),
  }),
  z.object({
    kind: z.literal('every').describe('Repeat on a fixed interval.'),
    every: z.number().int().min(1).max(1000),
    unit: z.enum(['minutes', 'hours', 'days', 'weeks']),
    startAt: isoTime
      .optional()
      .describe('First run. Defaults to one interval from now.'),
  }),
  z.object({
    kind: z
      .literal('calendar')
      .describe('Run at a time of day, every day or on chosen weekdays.'),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .describe('24-hour local time, such as 09:00.'),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .optional()
      .describe('0 is Sunday through 6 Saturday. Leave out for every day.'),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe("The owner's IANA timezone, such as America/Jamaica."),
    until: isoTime.optional().describe('Optional last day to run.'),
  }),
]);
type When = z.infer<typeof whenInput>;

function instant(text: string, name: string) {
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text))
    throw new Error(
      `${name} needs a UTC offset, such as 2026-11-06T13:43:00-05:00.`,
    );
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error(`${name} is not a valid time.`);
  return ms;
}

/** Turns the model's `when` into a schedule and its first run. */
export function scheduleFor(
  when: When,
  now: number,
  minIntervalMs: number,
): { spec: ScheduleSpec; nextRunAt: number } {
  if (when.kind === 'once') {
    if ((when.at == null) === (when.inMinutes == null))
      throw new Error('Give either at or inMinutes.');
    const at =
      when.at != null ? instant(when.at, 'at') : now + when.inMinutes! * MINUTE;
    if (at < now + MINUTE)
      throw new Error('That time is in the past or less than a minute away.');
    if (at > now + YEAR) throw new Error('That time is more than a year away.');
    return { spec: { kind: 'once', at }, nextRunAt: at };
  }
  if (when.kind === 'every') {
    const ms = when.every * UNITS[when.unit] * MINUTE;
    if (ms < minIntervalMs)
      throw new Error(
        `Repeat at most every ${Math.round(minIntervalMs / MINUTE)} minutes.`,
      );
    if (ms > YEAR) throw new Error('Repeat at least once a year.');
    const start =
      when.startAt != null ? instant(when.startAt, 'startAt') : now + ms;
    if (start < now + MINUTE)
      throw new Error(
        'The first run is in the past or less than a minute away.',
      );
    return { spec: { kind: 'interval', seconds: ms / 1000 }, nextRunAt: start };
  }
  try {
    assertTimezone(when.timezone);
  } catch {
    throw new Error(`${when.timezone} is not a known timezone.`);
  }
  const [hour, minute] = when.time.split(':').map(Number);
  const spec: ScheduleSpec = {
    kind: 'calendar',
    timezone: when.timezone,
    weekdays: [...new Set(when.weekdays ?? [])],
    minuteOfDay: hour * 60 + minute,
    ...(when.until != null
      ? { endAt: instant(when.until, 'until') + 24 * 60 * MINUTE }
      : {}),
  };
  const nextRunAt = initialRunAt(spec, now);
  if (nextRunAt == null) throw new Error('That schedule has no upcoming run.');
  return { spec, nextRunAt };
}

/** A schedule in words, for the model and the owner. */
export function describeSchedule(spec: ScheduleSpec) {
  if (spec.kind === 'once') return `once at ${new Date(spec.at).toISOString()}`;
  if (spec.kind === 'interval') {
    const minutes = spec.seconds / 60;
    for (const [unit, size] of Object.entries(UNITS).reverse())
      if (minutes % size === 0) {
        const count = minutes / size;
        return `every ${count === 1 ? unit.slice(0, -1) : `${count} ${unit}`}`;
      }
    return `every ${spec.seconds} seconds`;
  }
  const time = `${String(Math.floor(spec.minuteOfDay / 60)).padStart(2, '0')}:${String(spec.minuteOfDay % 60).padStart(2, '0')}`;
  const days = spec.weekdays.length
    ? spec.weekdays.map((day) => WEEKDAYS[day]).join(', ')
    : 'every day';
  return `at ${time} ${spec.weekdays.length ? `on ${days}` : days} (${spec.timezone})${spec.endAt ? ` until ${new Date(spec.endAt).toISOString().slice(0, 10)}` : ''}`;
}

function nextRun(spec: ScheduleSpec, at: number | null) {
  if (at == null) return null;
  return spec.kind === 'calendar'
    ? localTime(at, spec.timezone)
    : new Date(at).toISOString();
}

const stored = (actionId: string, workItemId: string | null) => ({
  status: 'pending' as const,
  actionId,
  ...(workItemId ? { workItemId } : {}),
  note: 'This is stored for the owner to approve. Do not call it again.',
});

/** The owner may manage a schedule they asked for; the Pod only ones it may manage. */
function manageable(deps: WorkDeps, id: string) {
  const trigger = deps.engine.trigger(id);
  if (
    !trigger ||
    String(trigger.actorId) !== deps.dot.id ||
    !['schedule', 'wake'].includes(String(trigger.kind))
  )
    throw new Error('Schedule not found. Use an id from list_schedules.');
  if (!deps.ownerPresent && !Number(trigger.dotCanManage))
    throw new Error('This schedule is managed by the owner.');
  return trigger;
}

/** Cancels a schedule, and the objective it ran when nothing else runs it. */
export function cancelScheduled(engine: ExecutionEngine, triggerId: string) {
  const trigger = engine.trigger(triggerId);
  if (!trigger) return { cancelled: false };
  engine.updateTrigger(triggerId, { enabled: false });
  const workItemId = String(trigger.workItemId);
  const item = engine.workItem(workItemId);
  const others = engine
    .schedulesFor(String(trigger.actorId))
    .some((row) => String(row.workItemId) === workItemId);
  if (item && String(item.source) === 'schedule' && !others)
    engine.cancelWork(workItemId);
  return { cancelled: true, id: triggerId };
}

/** Plugin write tools this Pod may schedule. */
function schedulable(plugins: PluginService, dotId: string, name: string) {
  const tool = name.replace(/^functions\./, '');
  const definition = plugins
    .definitions(dotId)
    .find((item) => item.name === tool);
  if (!definition)
    throw new Error(
      `${tool} is not a tool this Pod can use. Schedule one of its plugin tools by its full name.`,
    );
  if (plugins.classify(tool)?.access === 'read')
    throw new Error(
      `${tool} only reads. Schedule a task with instructions for work that reads and reports.`,
    );
  return { tool, definition };
}

export function scheduleTools(deps: WorkDeps): ToolDefinition[] {
  const ctx = () => deps.context();
  const chat = () => ownerChat(deps);
  const minInterval = () => deps.engine.policy(deps.dot.id).minWakeIntervalMs;
  const tools: ToolDefinition[] = [
    defineTool({
      name: 'schedule',
      description:
        'Schedule something to happen later: once at a time, every so often, or at times of day. Give instructions for a task the Pod carries out in the background each time and reports on in this chat, or an action for one exact plugin call, such as sending a set message. Use it whenever the owner asks for something later or on a schedule. When a task must make changes each time, such as sending messages, list those tools in allowTools; the owner approves them with the schedule and each run uses them without asking.',
      parameters: z.object({
        title: z.string().trim().min(1).max(160),
        when: whenInput,
        instructions: z
          .string()
          .trim()
          .min(1)
          .max(4000)
          .optional()
          .describe(
            'For a task: what each run should do, complete enough to act on without this conversation.',
          ),
        action: z
          .object({
            tool: z.string().trim().min(1).max(160),
            arguments: z.record(z.string(), z.unknown()),
          })
          .optional()
          .describe(
            'For one exact plugin call: the full tool name and its arguments, as you would call it.',
          ),
        allowTools: z
          .array(z.string().trim().min(1).max(160))
          .max(10)
          .optional()
          .describe(
            'For a task: plugin tools each run may use without asking, by full name.',
          ),
      }),
      execute: async ({ title, when, instructions, action, allowTools }) => {
        deps.check();
        if (!instructions === !action)
          throw new Error('Give either instructions or an action.');
        const timing = scheduleFor(when, Date.now(), minInterval());
        if (action) return scheduleAction(deps, title, timing, action);
        return scheduleTask(
          deps,
          title,
          timing,
          instructions!,
          allowTools ?? [],
        );
      },
    }),
    defineTool({
      name: 'list_schedules',
      description:
        "List this Pod's scheduled tasks and wakes, with when each runs next.",
      parameters: z.object({}),
      execute: async () => {
        deps.check();
        return {
          schedules: deps.engine.schedulesFor(deps.dot.id).map((row) => {
            const spec = JSON.parse(String(row.specJson)) as ScheduleSpec;
            return {
              id: row.id,
              title: row.title,
              ...((spec as { action?: unknown }).action
                ? { action: (spec as { action?: unknown }).action }
                : { instructions: String(row.objective).slice(0, 300) }),
              ...(deps.engine.allowedTools(String(row.workItemId)).length
                ? {
                    allowTools: deps.engine.allowedTools(
                      String(row.workItemId),
                    ),
                  }
                : {}),
              when:
                row.kind === 'wake'
                  ? 'a wake for a responsibility'
                  : describeSchedule(spec),
              nextRun: nextRun(
                spec,
                row.nextRunAt == null ? null : Number(row.nextRunAt),
              ),
            };
          }),
        };
      },
    }),
    defineTool({
      name: 'change_schedule',
      description:
        'Change when a scheduled task runs, or its title or instructions. Take the id from list_schedules.',
      parameters: z.object({
        id: z.string(),
        when: whenInput.optional(),
        title: z.string().trim().min(1).max(160).optional(),
        instructions: z.string().trim().min(1).max(4000).optional(),
      }),
      execute: async ({ id, when, title, instructions }) => {
        deps.check();
        const trigger = manageable(deps, id);
        const timing = when
          ? scheduleFor(when, Date.now(), minInterval())
          : undefined;
        const args = {
          triggerId: id,
          ...(timing ? { spec: timing.spec, nextRunAt: timing.nextRunAt } : {}),
          ...(title ? { title } : {}),
          ...(instructions ? { instructions } : {}),
        };
        if (!deps.ownerPresent) {
          const pending = deps.engine.proposeAction({
            executionId: ctx().executionId || null,
            workItemId: String(trigger.workItemId),
            actorId: deps.dot.id,
            threadId: chat(),
            toolName: 'update_schedule',
            arguments: args,
          });
          return stored(pending.pendingActionId, String(trigger.workItemId));
        }
        changeScheduled(deps.engine, args);
        return {
          changed: true,
          id,
          ...(timing
            ? {
                when: describeSchedule(timing.spec),
                nextRun: nextRun(timing.spec, timing.nextRunAt),
              }
            : {}),
        };
      },
    }),
    defineTool({
      name: 'cancel_schedule',
      description:
        'Stop a scheduled task so it does not run again. Take the id from list_schedules.',
      parameters: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        deps.check();
        const trigger = manageable(deps, id);
        if (!deps.ownerPresent) {
          const pending = deps.engine.proposeAction({
            executionId: ctx().executionId || null,
            workItemId: String(trigger.workItemId),
            actorId: deps.dot.id,
            threadId: chat(),
            toolName: 'cancel_schedule',
            arguments: { triggerId: id },
          });
          return stored(pending.pendingActionId, String(trigger.workItemId));
        }
        return cancelScheduled(deps.engine, id);
      },
    }),
  ];
  const hasSchedules = deps.engine.schedulesFor(deps.dot.id).length > 0;
  return tools.filter(
    (tool) =>
      hasSchedules ||
      !['change_schedule', 'cancel_schedule'].includes(tool.name),
  );
}

/** Applies a schedule change: timing, title and instructions. */
export function changeScheduled(
  engine: ExecutionEngine,
  args: {
    triggerId: string;
    spec?: ScheduleSpec;
    nextRunAt?: number;
    title?: string;
    instructions?: string;
  },
) {
  const trigger = engine.trigger(args.triggerId);
  if (!trigger) throw new Error('Schedule not found.');
  if (args.spec)
    engine.updateTrigger(args.triggerId, {
      spec: args.spec,
      nextRunAt: args.nextRunAt,
      enabled: true,
    });
  if (args.title || args.instructions) {
    const item = engine.workItem(String(trigger.workItemId));
    if (item)
      engine.reviseWork(
        String(item.id),
        args.title ?? String(item.title),
        args.instructions ?? String(item.objective),
      );
  }
  return { changed: true, id: args.triggerId };
}

type Timing = { spec: ScheduleSpec; nextRunAt: number };

/** Validates one plugin call the Pod may make, and returns its clean name. */
function checkedCall(
  deps: WorkDeps,
  action: { tool: string; arguments: Record<string, unknown> },
) {
  const { tool, definition } = schedulable(
    deps.plugins,
    deps.dot.id,
    action.tool,
  );
  const checked = (definition.parameters as unknown as PluginParameters)[
    '~standard'
  ].validate(action.arguments);
  if ('issues' in checked)
    throw new Error(
      `The arguments do not fit ${tool}: ${checked.issues
        .slice(0, 3)
        .map(
          (issue) =>
            `${issue.path?.join('.') || 'arguments'}: ${issue.message}`,
        )
        .join('; ')}`,
    );
  return tool;
}

/** Runs instructions on a schedule; approved tools are used without asking. */
function scheduleTask(
  deps: WorkDeps,
  title: string,
  { spec, nextRunAt }: Timing,
  instructions: string,
  allowTools: string[],
) {
  const allowed = [
    ...new Set(
      allowTools.map(
        (name) => schedulable(deps.plugins, deps.dot.id, name).tool,
      ),
    ),
  ];
  const chat = ownerChat(deps);
  const item = deps.engine.createWorkItem({
    actorId: deps.dot.id,
    title,
    objective: instructions,
    source: 'schedule',
    recurring: spec.kind !== 'once',
    autoResume: false,
    originThreadId: chat,
  });
  const workItemId = String(item.id);
  // Standing permission to make changes always goes to the owner to approve.
  if (allowed.length || !deps.ownerPresent)
    return propose(deps, workItemId, {
      title,
      runs: describeSchedule(spec),
      instructions,
      ...(allowed.length ? { allowTools: allowed } : {}),
      workItemId,
      kind: 'schedule',
      spec,
      anchor: 'clock',
      nextRunAt,
      dotCanManage: true,
    });
  const id = deps.engine.addTrigger({
    workItemId,
    actorId: deps.dot.id,
    kind: 'schedule',
    spec,
    anchor: 'clock',
    nextRunAt,
    enabled: true,
    dotCanManage: true,
  });
  return {
    scheduled: true,
    id,
    workItemId,
    when: describeSchedule(spec),
    nextRun: nextRun(spec, nextRunAt),
  };
}

/**
 * One exact plugin call, once or repeating. A call that needs approval is
 * approved now: once, it waits for its time; repeating, the owner approves the
 * schedule and each run makes the call without asking again.
 */
function scheduleAction(
  deps: WorkDeps,
  title: string,
  { spec, nextRunAt }: Timing,
  input: { tool: string; arguments: Record<string, unknown> },
) {
  const tool = checkedCall(deps, input);
  const args = input.arguments;
  const context = deps.context();
  const snapshot = snapshotFor(deps, deps.dot, false, context.workItemId);
  const runsAt = new Date(nextRunAt).toISOString();
  if (spec.kind === 'once') {
    const held = deps.engine.gate(context, tool, args, snapshot, {
      notBefore: nextRunAt,
    });
    if (held)
      return {
        status: 'pending',
        actionId: held.pendingActionId,
        runsAt,
        note: 'The owner approves this now; it then runs at runsAt without asking again. Do not call it again.',
      };
    // Allowed without approval: it is stored approved and waits for its time.
    const action = deps.engine.proposeAction({
      executionId: context.executionId || null,
      workItemId: context.workItemId ?? null,
      actorId: deps.dot.id,
      threadId: context.threadId,
      toolName: tool,
      arguments: args,
      notBefore: nextRunAt,
    });
    deps.engine.approveAction(action.pendingActionId, true);
    return { scheduled: true, actionId: action.pendingActionId, runsAt };
  }
  const item = deps.engine.createWorkItem({
    actorId: deps.dot.id,
    title,
    objective: `Run ${tool} with ${JSON.stringify(args).slice(0, 3000)}`,
    source: 'schedule',
    recurring: true,
    autoResume: false,
    originThreadId: ownerChat(deps),
  });
  const workItemId = String(item.id);
  const free =
    deps.ownerPresent &&
    decide(context, tool, args, {
      ...snapshot,
      cancelled: false,
      rules: deps.engine.rules(),
    }).effect === 'allow';
  if (!free)
    return propose(deps, workItemId, {
      title,
      runs: describeSchedule(spec),
      action: { tool, arguments: args },
      workItemId,
      kind: 'schedule',
      spec,
      anchor: 'clock',
      nextRunAt,
      dotCanManage: true,
    });
  const id = deps.engine.addTrigger({
    workItemId,
    actorId: deps.dot.id,
    kind: 'schedule',
    spec: { ...spec, action: { tool, arguments: args } },
    anchor: 'clock',
    nextRunAt,
    enabled: true,
    dotCanManage: true,
  });
  return {
    scheduled: true,
    id,
    workItemId,
    when: describeSchedule(spec),
    nextRun: nextRun(spec, nextRunAt),
  };
}

/** A schedule the owner approves first; the card shows what it runs. */
function propose(
  deps: WorkDeps,
  workItemId: string,
  args: Record<string, unknown>,
) {
  const pending = deps.engine.proposeAction({
    executionId: deps.context().executionId || null,
    workItemId,
    actorId: deps.dot.id,
    threadId: ownerChat(deps),
    toolName: 'arm_trigger',
    arguments: args,
  });
  return stored(pending.pendingActionId, workItemId);
}
