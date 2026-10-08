export interface IntervalSpec {
  kind: 'interval';
  seconds: number;
}
export interface CalendarSpec {
  kind: 'calendar';
  timezone: string;
  /** 0 = Sunday … 6 = Saturday. Empty means every day. */
  weekdays: number[];
  minuteOfDay: number;
  endAt?: number;
}
export type ScheduleSpec = IntervalSpec | CalendarSpec;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function zonedParts(ms: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

function offsetMs(utcMs: number, timeZone: string) {
  const parts = zonedParts(utcMs, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  return asUtc - utcMs;
}

/** UTC instant for a local civil time. Returns null when that local time is skipped. */
export function utcForLocal(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timeZone: string,
) {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let utc = guess - offsetMs(guess, timeZone);
  utc = guess - offsetMs(utc, timeZone);
  const back = zonedParts(utc, timeZone);
  if (
    back.year !== year ||
    back.month !== month ||
    back.day !== day ||
    back.hour !== hour ||
    back.minute !== minute
  )
    return null;
  return utc;
}

export function nextCalendarRun(spec: CalendarSpec, after: number) {
  const start = zonedParts(after + 60_000, spec.timezone);
  for (let day = 0; day < 400; day += 1) {
    const probe = Date.UTC(start.year, start.month - 1, start.day + day);
    const civil = zonedParts(probe + 12 * 60 * 60_000, spec.timezone);
    if (spec.weekdays.length && !spec.weekdays.includes(civil.weekday))
      continue;
    const instant =
      utcForLocal(
        civil.year,
        civil.month,
        civil.day,
        spec.minuteOfDay,
        spec.timezone,
      ) ??
      utcForLocal(
        civil.year,
        civil.month,
        civil.day,
        spec.minuteOfDay + 60,
        spec.timezone,
      );
    if (instant == null || instant <= after) continue;
    if (spec.endAt != null && instant > spec.endAt) return null;
    return instant;
  }
  return null;
}

export function assertTimezone(timeZone: string) {
  new Intl.DateTimeFormat('en-US', { timeZone });
}

export function parseSchedule(input: unknown): ScheduleSpec {
  if (!input || typeof input !== 'object')
    throw new Error('Schedule is invalid.');
  const spec = input as Record<string, unknown>;
  if (spec.kind === 'interval') {
    const seconds = Number(spec.seconds);
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 31_536_000)
      throw new Error('Repeat interval must be 60 seconds to one year.');
    return { kind: 'interval', seconds };
  }
  if (spec.kind !== 'calendar') throw new Error('Schedule is invalid.');
  const timezone = String(spec.timezone ?? '');
  try {
    assertTimezone(timezone);
  } catch {
    throw new Error('Schedule timezone is invalid.');
  }
  const weekdays = Array.isArray(spec.weekdays) ? spec.weekdays.map(Number) : [];
  if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
    throw new Error('Weekdays must be 0 (Sunday) through 6 (Saturday).');
  const minuteOfDay = Number(spec.minuteOfDay);
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > 1439)
    throw new Error('Time of day must be a minute from 0 through 1439.');
  const endAt = spec.endAt == null ? undefined : Number(spec.endAt);
  if (endAt != null && !Number.isFinite(endAt))
    throw new Error('Schedule end is invalid.');
  return {
    kind: 'calendar',
    timezone,
    weekdays: [...new Set(weekdays)],
    minuteOfDay,
    ...(endAt != null ? { endAt } : {}),
  };
}

export function initialRunAt(spec: ScheduleSpec, now: number) {
  if (spec.kind === 'interval') return now + spec.seconds * 1000;
  return nextCalendarRun(spec, now);
}

export function assertWake(
  policy: { minWakeIntervalMs: number; maxWakeHorizonMs: number },
  at: number,
  now: number,
) {
  const delta = at - now;
  if (delta < policy.minWakeIntervalMs)
    throw new Error(
      `Wake must be at least ${Math.round(policy.minWakeIntervalMs / 60_000)} minutes from now.`,
    );
  if (delta > policy.maxWakeHorizonMs)
    throw new Error(
      `Wake must be within ${Math.round(policy.maxWakeHorizonMs / 86_400_000)} days.`,
    );
}

export function nextRunAt(
  spec: ScheduleSpec,
  after: number,
  anchor: 'clock' | 'after_success',
) {
  if (spec.kind === 'interval') {
    const instant = after + spec.seconds * 1000;
    return instant;
  }
  if (anchor === 'after_success') return nextCalendarRun(spec, after);
  return nextCalendarRun(spec, after);
}
