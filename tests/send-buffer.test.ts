import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSendBuffer, sendTimingFrom } from '../src/client/send-buffer';

const timing = { delayMs: 5000, nudgeMs: 20000, graceMs: 10000 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(onFlush: () => boolean | void = () => undefined) {
  const flush = vi.fn(onFlush);
  const buffer = createSendBuffer({ timing, onFlush: flush });
  return { buffer, flush };
}

it('converts settings seconds to milliseconds', () => {
  expect(
    sendTimingFrom({
      sendDelaySeconds: 5,
      typingNudgeSeconds: 20,
      typingNudgeGraceSeconds: 10,
    }),
  ).toEqual(timing);
});

it('delivers held messages once after the send delay', () => {
  const { buffer, flush } = setup();
  buffer.hold();
  expect(buffer.holding).toBe(true);
  vi.advanceTimersByTime(4999);
  expect(flush).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(flush).toHaveBeenCalledTimes(1);
  expect(buffer.holding).toBe(false);
  vi.advanceTimersByTime(60000);
  expect(flush).toHaveBeenCalledTimes(1);
});

it('restarts the delay on each send', () => {
  const { buffer, flush } = setup();
  buffer.hold();
  vi.advanceTimersByTime(4000);
  buffer.hold();
  vi.advanceTimersByTime(4000);
  expect(flush).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(flush).toHaveBeenCalledTimes(1);
});

it('pauses while the composer has text and restarts when it is cleared', () => {
  const { buffer, flush } = setup();
  buffer.hold();
  vi.advanceTimersByTime(3000);
  buffer.draftChanged('and one more');
  vi.advanceTimersByTime(10000);
  expect(flush).not.toHaveBeenCalled();
  buffer.draftChanged('   ');
  vi.advanceTimersByTime(4999);
  expect(flush).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(flush).toHaveBeenCalledTimes(1);
});

it('nudges after unsent text lingers, then delivers after the grace period', () => {
  const { buffer, flush } = setup();
  buffer.hold();
  buffer.draftChanged('half a thought');
  vi.advanceTimersByTime(19999);
  expect(buffer.nudging).toBe(false);
  vi.advanceTimersByTime(1);
  expect(buffer.nudging).toBe(true);
  expect(flush).not.toHaveBeenCalled();
  buffer.draftChanged('half a thought, longer');
  vi.advanceTimersByTime(9999);
  expect(flush).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(flush).toHaveBeenCalledTimes(1);
  expect(buffer.nudging).toBe(false);
  expect(buffer.holding).toBe(false);
});

it('dismisses the nudge and restarts the delay when the user sends again', () => {
  const { buffer, flush } = setup();
  buffer.hold();
  buffer.draftChanged('more');
  vi.advanceTimersByTime(20000);
  expect(buffer.nudging).toBe(true);
  buffer.hold();
  buffer.draftChanged('');
  expect(buffer.nudging).toBe(false);
  vi.advanceTimersByTime(4999);
  expect(flush).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(flush).toHaveBeenCalledTimes(1);
});

it('dismisses the nudge when the composer is cleared', () => {
  const { buffer, flush } = setup();
  buffer.hold();
  buffer.draftChanged('more');
  vi.advanceTimersByTime(20000);
  buffer.draftChanged('');
  expect(buffer.nudging).toBe(false);
  vi.advanceTimersByTime(5000);
  expect(flush).toHaveBeenCalledTimes(1);
});

it('does not nudge when nothing is held', () => {
  const { buffer, flush } = setup();
  buffer.draftChanged('just typing');
  vi.advanceTimersByTime(60000);
  expect(buffer.nudging).toBe(false);
  expect(flush).not.toHaveBeenCalled();
});

it('delivers immediately when the delay is zero', () => {
  const flush = vi.fn();
  const buffer = createSendBuffer({
    timing: { ...timing, delayMs: 0 },
    onFlush: flush,
  });
  buffer.hold();
  expect(flush).toHaveBeenCalledTimes(1);
  expect(buffer.holding).toBe(false);
});

it('keeps holding when delivery is refused until flushed again', () => {
  let allow = false;
  const { buffer, flush } = setup(() => allow);
  buffer.hold();
  vi.advanceTimersByTime(5000);
  expect(flush).toHaveBeenCalledTimes(1);
  expect(buffer.holding).toBe(true);
  allow = true;
  buffer.flushNow();
  expect(flush).toHaveBeenCalledTimes(2);
  expect(buffer.holding).toBe(false);
});

it('cancels pending timers on dispose', () => {
  const { buffer, flush } = setup();
  buffer.hold();
  buffer.dispose();
  vi.advanceTimersByTime(60000);
  expect(flush).not.toHaveBeenCalled();
});
