export interface FollowSnapshot {
  threadId: string;
  seenThreadId: string | null;
  seenRunId: string | null;
  activityRunning: boolean;
  latestRunId: string | null;
  pendingLocal: boolean;
}

export type FollowDecision =
  | { action: 'seed'; runId: string | null }
  | { action: 'wait' }
  | { action: 'adopt'; runId: string | null }
  | { action: 'follow' };

/**
 * An open chat already loaded its history. A later server run has to be
 * pulled in on purpose: replaying the whole thread onto messages that are
 * already on screen would append their text a second time.
 */
export function decideFollow(input: FollowSnapshot): FollowDecision {
  if (input.pendingLocal) return { action: 'adopt', runId: input.latestRunId };
  if (input.seenThreadId !== input.threadId)
    return input.activityRunning
      ? { action: 'follow' }
      : { action: 'seed', runId: input.latestRunId };
  if (!input.activityRunning && input.latestRunId === input.seenRunId)
    return { action: 'wait' };
  return { action: 'follow' };
}
