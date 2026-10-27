export const workPromptPrefix = 'opendots-work:';
/** A background run's result, posted into the chat the work came from. */
export const workResultPrefix = 'opendots-work-result:';

/** The marker line of a posted background result; null for any other message. */
export function workResultLabel(message: {
  id: string;
  role: string;
  content?: unknown;
}): string | null {
  if (message.role !== 'user' || !message.id.startsWith(workResultPrefix))
    return null;
  const content = typeof message.content === 'string' ? message.content : '';
  return content.split('\n')[0] || 'Background work';
}

export type WorkPromptKind =
  'schedule' | 'wake' | 'watch' | 'approval' | 'work';

export function workPromptKind(message: {
  id: string;
  role: string;
  metadata?: unknown;
}): WorkPromptKind | null {
  if (message.role !== 'user') return null;
  const record =
    message.metadata && typeof message.metadata === 'object'
      ? (message.metadata as Record<string, unknown>)
      : undefined;
  const marked =
    record?.opendotsSource === 'work' ||
    message.id.startsWith(workPromptPrefix);
  if (!marked) return null;
  const kind = record?.triggerKind;
  if (
    kind === 'schedule' ||
    kind === 'wake' ||
    kind === 'watch' ||
    kind === 'approval'
  )
    return kind;
  return 'work';
}

export function workPromptLabel(kind: WorkPromptKind) {
  if (kind === 'schedule') return 'Schedule ran';
  if (kind === 'wake') return 'Woke up';
  if (kind === 'watch') return 'Watch fired';
  if (kind === 'approval') return 'Approved action ran';
  return 'Scheduled run';
}
