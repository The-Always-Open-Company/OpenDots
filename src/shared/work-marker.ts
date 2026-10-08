export const workPromptPrefix = 'opendots-work:';

export type WorkPromptKind = 'schedule' | 'wake' | 'watch' | 'work';

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
  if (kind === 'schedule' || kind === 'wake' || kind === 'watch') return kind;
  return 'work';
}

export function workPromptLabel(kind: WorkPromptKind) {
  if (kind === 'schedule') return 'Schedule ran';
  if (kind === 'wake') return 'Woke up';
  if (kind === 'watch') return 'Watch fired';
  return 'Scheduled run';
}
