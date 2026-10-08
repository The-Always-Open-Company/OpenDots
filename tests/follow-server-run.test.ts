import { expect, it } from 'vitest';
import { decideFollow } from '../src/client/follow-server-run';

const base = {
  threadId: 'thread',
  seenThreadId: 'thread' as string | null,
  seenRunId: 'run-1' as string | null,
  activityRunning: false,
  latestRunId: 'run-1' as string | null,
  pendingLocal: false,
};

it('remembers the run already on screen and follows a later server run', () => {
  expect(decideFollow({ ...base, seenThreadId: null })).toEqual({
    action: 'seed',
    runId: 'run-1',
  });
  expect(
    decideFollow({ ...base, seenThreadId: null, activityRunning: true }),
  ).toEqual({ action: 'follow' });
  expect(decideFollow(base)).toEqual({ action: 'wait' });
  expect(decideFollow({ ...base, latestRunId: 'run-2' })).toEqual({
    action: 'follow',
  });
  expect(decideFollow({ ...base, activityRunning: true })).toEqual({
    action: 'follow',
  });
  expect(
    decideFollow({ ...base, pendingLocal: true, latestRunId: 'run-2' }),
  ).toEqual({ action: 'adopt', runId: 'run-2' });
});
