import WebSocket from 'ws';
import { liveSessions } from './voice-live.js';

export interface LiveSocket {
  send(data: string): void;
  close(): void;
}
export interface LiveSocketHandlers {
  open(): void;
  message(text: string): void;
  close(): void;
  error(error: Error): void;
}
export type LiveSocketFactory = (
  url: string,
  headers: Record<string, string>,
  handlers: LiveSocketHandlers,
) => LiveSocket;

export const wsSocket: LiveSocketFactory = (url, headers, handlers) => {
  const socket = new WebSocket(url, { headers, maxPayload: 1024 * 1024 });
  socket.on('open', handlers.open);
  socket.on('message', (data) => handlers.message(data.toString()));
  socket.on('close', handlers.close);
  socket.on('error', handlers.error);
  return socket;
};

export interface Utterance {
  /** The owner's words for this delegation (untrusted speech). */
  words: string;
  /** The recent call transcript (untrusted). */
  transcript: string;
}
export interface LiveCallHooks {
  /** A delegation's words are ready; `acknowledgedAt` is when the call was told it started. */
  delegate(
    delegationId: string,
    utterance: Utterance,
    acknowledgedAt: number,
  ): void;
  /** Transcript activity, for pacing result delivery. */
  heard?(speaker: 'owner' | 'dot', text: string): void;
  /** The session finished, or its control connection dropped, without our close. */
  closed(): void;
}

/** Speech that starts this soon after `offset_ms` still belongs to the request. */
const OFFSET_GRACE_MS = 1500;

/** GPT-Live counts 500 tokens per append; this keeps each piece comfortably under it. */
const APPEND_CHARS = 1800;
/** Longer answers stay in the chat; the call speaks the start of them. */
const SPOKEN_CHARS = APPEND_CHARS * 2;

/** Strips Markdown that reads badly aloud; GPT-Live paraphrases the rest. */
export function speakable(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, ' (code in the chat) ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function appendPieces(text: string) {
  const spoken = speakable(text);
  const clipped =
    spoken.length > SPOKEN_CHARS
      ? `${spoken.slice(0, SPOKEN_CHARS)}… The full answer is in the chat.`
      : spoken;
  const pieces: string[] = [];
  let rest = clipped;
  while (rest.length > APPEND_CHARS) {
    const window = rest.slice(0, APPEND_CHARS);
    const cut = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('\n'),
      window.lastIndexOf('? '),
      window.lastIndexOf('! '),
    );
    const end = cut > APPEND_CHARS / 2 ? cut + 1 : APPEND_CHARS;
    pieces.push(rest.slice(0, end).trim());
    rest = rest.slice(end);
  }
  if (rest.trim()) pieces.push(rest.trim());
  return pieces;
}

/**
 * Owns one GPT-Live session's server connection: transcript, delegations and
 * close. It only needs the session ID, so phone calls accepted over SIP can
 * attach the same way as browser calls.
 */
export class LiveCallController {
  private socket?: LiveSocket;
  private lines: { speaker: 'You' | 'Pod'; text: string }[] = [];
  /** Owner speech with session timestamps; `taken` segments belong to earlier delegations. */
  private segments: { text: string; startMs?: number }[] = [];
  private taken = 0;
  private delegations = new Set<string>();
  private delegated = 0;
  private sequence = 0;
  private finished = false;
  private confirmed = false;
  private closing?: Promise<boolean>;
  private settleClose?: (confirmed: boolean) => void;
  /** The `session.closed` reason, or `control_lost` if the socket dropped first. */
  reason?: string;
  constructor(
    private options: {
      sessionId: string;
      apiKey: string;
      hooks: LiveCallHooks;
      socket?: LiveSocketFactory;
      /** Transcript deltas can trail the delegation event slightly. */
      settleMs?: number;
      closeTimeoutMs?: number;
    },
  ) {}
  attach(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let open = false;
      const fail = (message: string) => {
        if (open) return;
        open = true;
        this.dispose();
        reject(new Error(message));
      };
      const timer = setTimeout(
        () => fail('Voice provider control connection timed out.'),
        10_000,
      );
      timer.unref?.();
      signal.addEventListener(
        'abort',
        () => fail('Call connection was cancelled or timed out.'),
        { once: true },
      );
      this.socket = (this.options.socket ?? wsSocket)(
        `${liveSessions.replace(/^https:/, 'wss:')}/${this.options.sessionId}/attach`,
        { Authorization: `Bearer ${this.options.apiKey}` },
        {
          open: () => {
            clearTimeout(timer);
            if (open) return;
            open = true;
            resolve();
          },
          message: (text) => this.receive(text),
          close: () => {
            clearTimeout(timer);
            if (!open) fail('Voice provider control connection closed.');
            else this.finish('control_lost');
          },
          error: () => {
            clearTimeout(timer);
            fail('Voice provider control connection failed.');
          },
        },
      );
    });
  }
  transcript() {
    return this.lines
      .map((line) => `${line.speaker}: ${line.text.trim()}`)
      .join('\n')
      .slice(-20000);
  }
  /** Asks GPT-Live to finish; resolves true once `session.closed` confirms it. */
  close(): Promise<boolean> {
    if (this.finished) return Promise.resolve(this.confirmed);
    if (this.closing) return this.closing;
    this.closing = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.dispose();
        resolve(false);
      }, this.options.closeTimeoutMs ?? 15_000);
      timer.unref?.();
      this.settleClose = (confirmed) => {
        clearTimeout(timer);
        resolve(confirmed);
      };
    });
    if (!this.send({ type: 'session.close' })) {
      this.dispose();
      this.settleClose?.(false);
    }
    return this.closing;
  }
  /** Drops the connection without waiting for the session to finish. */
  dispose() {
    this.finished = true;
    this.settleClose?.(this.confirmed);
    try {
      this.socket?.close();
    } catch {
      // The socket is already closed.
    }
  }
  private finish(reason: string) {
    if (this.finished) return;
    this.reason = reason;
    this.confirmed = reason !== 'control_lost';
    const requested = !!this.closing;
    this.dispose();
    if (!requested) this.options.hooks.closed();
  }
  /** Sends backend content to the voice model; false once the session is closing. */
  append(
    type: 'thinking' | 'commentary',
    delegationId: string | null,
    content: string,
  ) {
    if (this.finished || this.closing) return false;
    return this.send({
      type: `session.${type}.append`,
      delegation_id: delegationId,
      content,
    });
  }
  private send(event: Record<string, unknown>) {
    if (!this.socket) return false;
    try {
      this.socket.send(
        JSON.stringify({ event_id: `opendots_${++this.sequence}`, ...event }),
      );
      return true;
    } catch {
      return false;
    }
  }
  private add(speaker: 'You' | 'Pod', delta: string) {
    const last = this.lines.at(-1);
    if (last?.speaker === speaker) last.text += delta;
    else this.lines.push({ speaker, text: delta });
    if (this.lines.length > 400) this.lines.splice(0, 100);
  }
  private receive(text: string) {
    let event: {
      type?: unknown;
      delta?: unknown;
      start_ms?: unknown;
      offset_ms?: unknown;
      reason?: unknown;
      delegation?: { id?: unknown; target?: unknown; offset_ms?: unknown };
    };
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof event.delta === 'string') {
      if (event.type === 'session.input_transcript.delta') {
        this.add('You', event.delta);
        this.segments.push({
          text: event.delta,
          startMs:
            typeof event.start_ms === 'number' ? event.start_ms : undefined,
        });
        if (this.segments.length > 2000) {
          const drop = Math.min(this.taken, 500);
          this.segments.splice(0, drop);
          this.taken -= drop;
        }
        this.options.hooks.heard?.('owner', event.delta);
      }
      if (event.type === 'session.output_transcript.delta') {
        this.add('Pod', event.delta);
        this.options.hooks.heard?.('dot', event.delta);
      }
    }
    if (
      event.type === 'session.delegation.created' &&
      typeof event.delegation?.id === 'string' &&
      (event.delegation.target ?? 'client') === 'client'
    ) {
      const offset = event.delegation.offset_ms ?? event.offset_ms;
      void this.delegate(
        event.delegation.id,
        typeof offset === 'number' ? offset : undefined,
      );
    }
    if (event.type === 'session.closed')
      this.finish(typeof event.reason === 'string' ? event.reason : 'closed');
  }
  /**
   * The owner's words for one delegation: speech not claimed by an earlier
   * delegation, up to shortly after `offset_ms` when the transcript has
   * timestamps. Later speech is left for the next request.
   */
  private utterance(offsetMs?: number) {
    const pending = this.segments.slice(this.taken);
    let count = pending.length;
    if (offsetMs !== undefined) {
      const after = pending.findIndex(
        (segment) =>
          segment.startMs !== undefined &&
          segment.startMs > offsetMs + OFFSET_GRACE_MS,
      );
      if (after >= 0) count = after;
    }
    this.taken += count;
    return pending
      .slice(0, count)
      .map((segment) => segment.text)
      .join('')
      .trim();
  }
  private async delegate(delegationId: string, offsetMs?: number) {
    if (this.delegations.has(delegationId) || this.finished) return;
    this.delegations.add(delegationId);
    const acknowledgedAt = Date.now();
    this.send({
      type: 'session.thinking.append',
      delegation_id: delegationId,
      content: 'The backend is working on this request. No result yet.',
    });
    // Transcript deltas can trail the delegation event slightly.
    await new Promise((resolve) =>
      setTimeout(resolve, this.options.settleMs ?? 600),
    );
    if (this.finished || this.closing) return;
    const words = this.utterance(offsetMs);
    if (!words && this.delegated) {
      this.append(
        'thinking',
        delegationId,
        'The owner has not said anything new since the previous request, so the tasks already started cover this one.',
      );
      return;
    }
    this.delegated += 1;
    this.options.hooks.delegate(
      delegationId,
      { words, transcript: this.transcript().slice(-6000) },
      acknowledgedAt,
    );
  }
}
