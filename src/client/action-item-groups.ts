import type { ActionItem, EntityRole } from '../shared/types';

export const DUE_SOON_MS = 3 * 86_400_000;
const DAY_MS = 86_400_000;

export type ActionItemGroupKey =
  | 'overdue'
  | 'dueSoon'
  | 'upcoming'
  | 'noDate'
  | 'waiting'
  | 'owed'
  | 'others'
  | 'closed';

export const GROUP_LABELS: Record<ActionItemGroupKey, string> = {
  overdue: 'Overdue',
  dueSoon: 'Due soon',
  upcoming: 'Upcoming',
  noDate: 'No due date',
  waiting: 'Waiting',
  owed: 'Owed to you',
  others: 'Between others',
  closed: 'Done and dropped',
};

const ORDER = Object.keys(GROUP_LABELS) as ActionItemGroupKey[];

const named = (item: ActionItem, role: EntityRole) =>
  item.entities.filter((entity) => entity.role === role);

/**
 * The owner is never tagged, so no assignee means the item is the owner's, and
 * no requester on someone else's item means the owner asked for it.
 */
export function ownershipOf(item: ActionItem): 'me' | 'owed' | 'others' {
  if (!named(item, 'assignee').length) return 'me';
  return named(item, 'requester').length ? 'others' : 'owed';
}

export function groupOf(item: ActionItem, now: number): ActionItemGroupKey {
  if (item.status === 'done' || item.status === 'dropped') return 'closed';
  if (item.status === 'waiting') return 'waiting';
  const ownership = ownershipOf(item);
  if (ownership !== 'me') return ownership;
  if (item.dueAt == null) return 'noDate';
  if (item.dueAt < now) return 'overdue';
  if (item.dueAt < now + DUE_SOON_MS) return 'dueSoon';
  return 'upcoming';
}

/** Non-empty sections in display order, keeping the server's order within each. */
export function groupActionItems(items: ActionItem[], now: number) {
  const groups = new Map<ActionItemGroupKey, ActionItem[]>();
  for (const item of items) {
    const key = groupOf(item, now);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return ORDER.filter((key) => groups.has(key)).map((key) => ({
    key,
    label: GROUP_LABELS[key],
    items: groups.get(key) ?? [],
  }));
}

const names = (item: ActionItem, role: EntityRole) =>
  named(item, role)
    .map((entity) => entity.name)
    .join(', ');

/** "You", "Person J owes you", or "Person J, for Person K". */
export function assigneeText(item: ActionItem) {
  const ownership = ownershipOf(item);
  if (ownership === 'me') return 'You';
  if (ownership === 'owed') return `${names(item, 'assignee')} owes you`;
  return `${names(item, 'assignee')}, for ${names(item, 'requester')}`;
}

export const ROLE_LABELS: Record<EntityRole, string> = {
  assignee: 'owes it',
  requester: 'asked for it',
  about: 'concerns',
};

const localDay = (ms: number) => {
  const date = new Date(ms);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
};
const daysBetween = (from: number, to: number) =>
  Math.round((localDay(to) - localDay(from)) / DAY_MS);
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

/** "Due tomorrow", "3 days overdue", "Due Oct 20", in the browser's timezone. */
export function dueText(dueAt: number | null, now: number) {
  if (dueAt == null) return '';
  if (dueAt < now) {
    const days = daysBetween(dueAt, now);
    return days ? `${plural(days, 'day')} overdue` : 'Overdue';
  }
  const days = daysBetween(now, dueAt);
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days < 7) return `Due in ${days} days`;
  const date = new Date(dueAt);
  return `Due ${date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date(now).getFullYear()
      ? {}
      : { year: 'numeric' }),
  })}`;
}

export function dueTone(dueAt: number | null, now: number) {
  if (dueAt == null) return '';
  if (dueAt < now) return 'overdue';
  return dueAt < now + DUE_SOON_MS ? 'soon' : '';
}

/** Local YYYY-MM-DD for a date input. */
export function dateInputValue(ms: number | null) {
  if (ms == null) return '';
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
