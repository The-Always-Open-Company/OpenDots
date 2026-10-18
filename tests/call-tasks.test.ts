import { afterEach, expect, it, vi } from 'vitest';
import {
  ResultDelivery,
  type CallTask,
  type DeliveryTiming,
} from '../src/server/call-tasks.js';
import type { CallReport } from '../src/server/task-brief.js';
import type { VoiceResultDelivery } from '../src/server/platform-config.js';

const deliveries: ResultDelivery[] = [];
afterEach(() => {
  deliveries.splice(0).forEach((delivery) => delivery.detach());
  vi.restoreAllMocks();
});

function setup(
  mode: VoiceResultDelivery,
  timing: Partial<DeliveryTiming> = {},
) {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  let now = 10_000;
  const sent: { type: string; id: string | null; content: string }[] = [];
  const notify = vi.fn();
  const delivery = new ResultDelivery({
    mode,
    sink: {
      append: (type, id, content) => (sent.push({ type, id, content }), true),
    },
    notify,
    now: () => now,
    timing: {
      quietMs: 1000,
      batchMs: 1500,
      longSpeechMs: 8000,
      speechWaitMs: 6000,
      idleUpgradeMs: 4000,
      ackGraceMs: 500,
      tickMs: 60_000,
      ...timing,
    },
  });
  deliveries.push(delivery);
  let numbers = 0;
  const task = (label: string, acknowledgedAt = now): CallTask => ({
    id: label,
    childThreadId: `child-${label}`,
    number: ++numbers,
    revision: 1,
    delegationId: `item_${numbers}`,
    label,
    status: 'done',
    input: { words: label, transcript: '', chat: '', openTasks: [] },
    acknowledgedAt,
    finishedAt: now,
    controller: new AbortController(),
    settled: Promise.resolve(),
    settle() {},
  });
  return {
    delivery,
    sent,
    notify,
    task,
    advance(ms: number) {
      now += ms;
      delivery.tick();
    },
    get now() {
      return now;
    },
  };
}
const report = (patch: Partial<CallReport> = {}): CallReport => ({
  status: 'done',
  facts: 'The answer.',
  spoken: 'Here is the answer.',
  details: 'The answer, in detail.',
  ...patch,
});
const types = (sent: { type: string }[]) => sent.map((item) => item.type);

it('speaks to a waiting owner, but only into a pause', () => {
  const f = setup('sequential');
  const waiting = f.task('Weather');
  f.delivery.heard('dot', 'Let me check. ');
  f.delivery.deliver(waiting, report());
  f.delivery.tick();
  expect(f.sent).toHaveLength(0);
  f.advance(1000);
  expect(f.sent).toEqual([
    expect.objectContaining({ type: 'commentary', id: 'item_1' }),
  ]);
  expect(f.sent[0].content).toMatch(
    /^\[Task 1: Weather\] Status: done\. Facts: The answer\..*Tell the owner now, in a sentence or two: Here is the answer\./,
  );
});

it('passes results quietly when the owner moved on, or when the Dot asks for quiet', () => {
  const f = setup('sequential');
  const moved = f.task('Weather');
  f.advance(600);
  f.delivery.heard('owner', 'Anyway, lunch.');
  f.delivery.deliver(moved, report());
  f.delivery.deliver(f.task('Filed note', 0), report({ delivery: 'quiet' }));
  expect(types(f.sent)).toEqual(['thinking', 'thinking']);
  expect(f.sent[0].content).toContain('do not announce them');
});

it('speaks failures and owner questions even after the conversation moved on, except in quiet mode', () => {
  for (const mode of ['sequential', 'quiet'] as const) {
    const f = setup(mode);
    const failed = f.task('Booking');
    const question = f.task('Renewal');
    f.advance(600);
    f.delivery.heard('owner', 'Something else.');
    f.delivery.deliver(failed, report({ status: 'failed' }));
    f.delivery.deliver(
      question,
      report({ status: 'needs_owner', needsOwner: 'Send it?' }),
    );
    f.advance(5000);
    expect(types(f.sent)).toEqual(
      mode === 'quiet' ? ['thinking', 'thinking'] : ['commentary'],
    );
    if (mode === 'sequential') {
      f.advance(100);
      f.delivery.heard('dot', 'The booking failed.');
      f.advance(1000);
      expect(types(f.sent)).toEqual(['commentary', 'commentary']);
      expect(f.sent[1].content).toContain('Owner needs to: Send it?');
    }
  }
});

it('sequential waits for the voice model to speak and go quiet before the next result', () => {
  const f = setup('sequential');
  const first = f.task('First');
  const second = f.task('Second');
  f.delivery.deliver(first, report());
  f.delivery.deliver(second, report());
  f.delivery.tick();
  expect(types(f.sent)).toEqual(['commentary']);
  f.advance(2000);
  expect(f.sent).toHaveLength(1);
  f.delivery.heard('dot', 'The first result is in.');
  f.advance(500);
  expect(f.sent).toHaveLength(1);
  f.advance(500);
  expect(f.sent.map((item) => [item.type, item.id])).toEqual([
    ['commentary', 'item_1'],
    ['commentary', 'item_2'],
  ]);
});

it('sequential gives up waiting for speech after speechWaitMs', () => {
  const f = setup('sequential');
  f.delivery.deliver(f.task('First'), report());
  f.delivery.deliver(f.task('Second'), report());
  f.delivery.tick();
  f.advance(5999);
  expect(f.sent).toHaveLength(1);
  f.advance(1);
  expect(f.sent).toHaveLength(2);
});

it('batch sends each result as thinking under its own ID, then one combined commentary', () => {
  const f = setup('batch');
  f.delivery.deliver(f.task('First'), report({ spoken: 'First is done.' }));
  f.advance(500);
  f.delivery.deliver(f.task('Second'), report({ spoken: 'Second is done.' }));
  f.advance(500);
  expect(f.sent).toHaveLength(0);
  f.advance(500);
  expect(f.sent.map((item) => [item.type, item.id])).toEqual([
    ['thinking', 'item_1'],
    ['thinking', 'item_2'],
    ['commentary', 'item_1'],
  ]);
  expect(f.sent[2].content).toContain(
    '[Task 1: First] First is done. [Task 2: Second] Second is done.',
  );
});

it('quiet mode never sends commentary', () => {
  const f = setup('quiet', { idleUpgradeMs: 100 });
  f.delivery.deliver(f.task('First'), report());
  f.delivery.deliver(f.task('Second'), report({ status: 'failed' }));
  f.advance(10_000);
  f.advance(10_000);
  expect(types(f.sent)).toEqual(['thinking', 'thinking']);
});

it('sends facts quietly during long owner speech and speaks them at the next pause', () => {
  const f = setup('sequential');
  const task = f.task('Weather');
  f.delivery.heard('owner', 'So');
  f.delivery.deliver(task, report());
  for (let i = 0; i < 9; i += 1) {
    f.advance(900);
    f.delivery.heard('owner', ' and');
  }
  expect(types(f.sent)).toEqual(['thinking']);
  f.advance(1000);
  expect(types(f.sent)).toEqual(['thinking', 'commentary']);
});

it('upgrades a quiet result that never came up to a short spoken note once the line is idle', () => {
  const f = setup('sequential');
  const told = f.task('Acme renewal');
  const untold = f.task('Weather forecast');
  f.advance(600);
  f.delivery.heard('owner', 'Moving on.');
  f.delivery.deliver(told, report());
  f.delivery.deliver(untold, report({ spoken: 'It will rain.' }));
  f.delivery.heard('dot', 'By the way, the Acme renewal is in March.');
  f.advance(3000);
  expect(types(f.sent)).toEqual(['thinking', 'thinking']);
  f.advance(1000);
  expect(f.sent.map((item) => [item.type, item.id])).toEqual([
    ['thinking', 'item_1'],
    ['thinking', 'item_2'],
    ['commentary', 'item_2'],
  ]);
  expect(f.sent[2].content).toContain('has not come up yet');
  expect(f.delivery.metrics.upgraded).toBe(1);
});

it('sends results to the chat after the call, including spoken ones still waiting', () => {
  const f = setup('sequential');
  const waiting = f.task('First');
  f.delivery.heard('owner', 'Hmm');
  f.delivery.deliver(waiting, report());
  f.delivery.detach();
  const late = f.task('Late');
  f.delivery.deliver(late, report());
  expect(f.sent).toHaveLength(0);
  expect(f.notify.mock.calls.map(([task]) => task.label)).toEqual([
    'First',
    'Late',
  ]);
});

it('counts sends while speech was active, delays and owner requests for results', () => {
  const f = setup('quiet');
  f.delivery.track(() => 1);
  f.delivery.heard('owner', 'Any news on the booking?');
  f.advance(1000);
  const task = f.task('Booking');
  f.advance(250);
  f.delivery.heard('dot', 'Still');
  f.delivery.deliver(task, report());
  expect(f.delivery.summary()).toMatchObject({
    mode: 'quiet',
    sent: 1,
    spoken: 0,
    sentWhileBusy: 1,
    ownerAsked: 1,
    medianDelayMs: 250,
  });
});
