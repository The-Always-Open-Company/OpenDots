import { useEffect, useReducer, useRef, useState } from 'react';
import type { Settings } from '../shared/types';

export interface SendTiming {
  /** How long held messages wait after the last send; 0 sends immediately. */
  delayMs: number;
  /** How long the composer may hold unsent text before the nudge appears. */
  nudgeMs: number;
  /** How long after the nudge before held messages are sent anyway. */
  graceMs: number;
}

export const immediateSendTiming: SendTiming = {
  delayMs: 0,
  nudgeMs: 0,
  graceMs: 0,
};

export function sendTimingFrom(
  settings: Pick<
    Settings,
    'sendDelaySeconds' | 'typingNudgeSeconds' | 'typingNudgeGraceSeconds'
  >,
): SendTiming {
  return {
    delayMs: settings.sendDelaySeconds * 1000,
    nudgeMs: settings.typingNudgeSeconds * 1000,
    graceMs: settings.typingNudgeGraceSeconds * 1000,
  };
}

export interface SendBuffer {
  /** Messages have been sent by the user but not yet delivered to the Dot. */
  readonly holding: boolean;
  /** The "still typing?" question is showing. */
  readonly nudging: boolean;
  hold(): void;
  draftChanged(text: string): void;
  flushNow(): void;
  configure(timing: SendTiming): void;
  dispose(): void;
}

/**
 * `onFlush` may return `false` to refuse delivery (e.g. while paused); the
 * buffer then keeps holding without timers until `flushNow` is called again.
 */
export function createSendBuffer({
  timing: initial,
  onFlush,
  onChange = () => undefined,
}: {
  timing: SendTiming;
  onFlush: () => boolean | void;
  onChange?: () => void;
}): SendBuffer {
  let timing = initial;
  let holding = false;
  let nudging = false;
  let typing = false;
  let typingSince = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    if (!holding) return;
    clear();
    holding = false;
    nudging = false;
    if (onFlush() === false) holding = true;
    onChange();
  };
  const schedule = () => {
    clear();
    if (!holding) return;
    if (nudging) {
      timer = setTimeout(flush, timing.graceMs);
    } else if (typing) {
      timer = setTimeout(
        () => {
          nudging = true;
          onChange();
          schedule();
        },
        Math.max(0, typingSince + timing.nudgeMs - Date.now()),
      );
    } else {
      timer = setTimeout(flush, timing.delayMs);
    }
  };
  return {
    get holding() {
      return holding;
    },
    get nudging() {
      return nudging;
    },
    hold() {
      holding = true;
      nudging = false;
      typingSince = Date.now();
      if (timing.delayMs <= 0) return flush();
      schedule();
      onChange();
    },
    draftChanged(text) {
      const next = !!text.trim();
      if (next === typing) return;
      typing = next;
      if (typing) typingSince = Date.now();
      else nudging = false;
      schedule();
      onChange();
    },
    flushNow: flush,
    configure(next) {
      timing = next;
      if (holding && timing.delayMs <= 0) return flush();
      schedule();
    },
    dispose: clear,
  };
}

export function useSendBuffer(
  timing: SendTiming,
  onFlush: () => boolean | void,
): SendBuffer {
  const flushRef = useRef(onFlush);
  flushRef.current = onFlush;
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [buffer] = useState(() =>
    createSendBuffer({
      timing,
      onFlush: () => flushRef.current(),
      onChange: rerender,
    }),
  );
  useEffect(
    () => buffer.configure(timing),
    [buffer, timing.delayMs, timing.nudgeMs, timing.graceMs],
  );
  return buffer;
}
