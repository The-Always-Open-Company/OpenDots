import type {
  Dot,
  DocumentReader,
  HandoffResult,
  HandoffTarget,
} from '../shared/types';
import { api } from './api';
import type { AccessMode } from './DocumentUploadDialog';

/** Whether `dot` could read a document uploaded with these access settings. */
export function dotCanRead(
  dot: Pick<Dot, 'id' | 'spaceIds'>,
  access: { mode: AccessMode; dotIds: string[]; spaceIds: string[] },
) {
  return (
    access.mode === 'all' ||
    (access.mode === 'dots' && access.dotIds.includes(dot.id)) ||
    dot.spaceIds.some((spaceId) => access.spaceIds.includes(spaceId))
  );
}

/** Access settings widened just enough for `dotId` to read the upload. */
export function accessFor(
  dotId: string | undefined,
  dots: Pick<Dot, 'id' | 'spaceIds'>[],
  access: { mode: AccessMode; dotIds: string[]; spaceIds: string[] },
) {
  const dot = dots.find((candidate) => candidate.id === dotId);
  if (!dot || dotCanRead(dot, access)) return access;
  return {
    ...access,
    mode: 'dots' as const,
    dotIds: [...new Set([...access.dotIds, dot.id])],
  };
}

export function documentReaders(dots: Dot[], readers: DocumentReader[]) {
  return dots.filter((dot) =>
    readers.some((reader) => reader.dotId === dot.id),
  );
}

export function sendToDot(dotId: string, target: HandoffTarget, note = '') {
  return api<HandoffResult>('/handoffs', 'POST', {
    dotId,
    target,
    ...(note.trim() ? { note: note.trim() } : {}),
  });
}
