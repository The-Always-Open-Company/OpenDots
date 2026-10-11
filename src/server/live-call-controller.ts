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

export interface LiveCallHooks {
  /** Runs the Dot turn for one delegation; rejects with a speakable reason. */
  compute(delegationId: string, request: string): Promise<string>;
  /** The session finished, or its control connection dropped, without our close. */
  closed(): void;
}

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
 * Owns one GPT-Live session's server connection: transcript, delegated Dot
 * turns and close. It only needs the session ID, so phone calls accepted over
 * SIP can attach the same way as browser calls.
 */
export class LiveCallController {
  private socket?: LiveSocket;
  private lines: { speaker: 'You' | 'Dot'; text: string }[] = [];
  private latestRequest = '';
  private delegations = new Set<string>();
  /** A conversation runs one turn at a time, so delegations wait their turn. */
  private queue: Promise<void> = Promise.resolve();
  private answered = false;
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
  private add(speaker: 'You' | 'Dot', delta: string) {
    const last = this.lines.at(-1);
    if (last?.speaker === speaker) last.text += delta;
    else this.lines.push({ speaker, text: delta });
    if (this.lines.length > 400) this.lines.splice(0, 100);
  }
  private receive(text: string) {
    let event: {
      type?: unknown;
      delta?: unknown;
      reason?: unknown;
      delegation?: { id?: unknown; target?: unknown };
    };
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof event.delta === 'string') {
      if (event.type === 'session.input_transcript.delta') {
        this.add('You', event.delta);
        this.latestRequest += event.delta;
      }
      if (event.type === 'session.output_transcript.delta')
        this.add('Dot', event.delta);
    }
    if (
      event.type === 'session.delegation.created' &&
      typeof event.delegation?.id === 'string' &&
      (event.delegation.target ?? 'client') === 'client'
    )
      void this.delegate(event.delegation.id);
    if (event.type === 'session.closed')
      this.finish(typeof event.reason === 'string' ? event.reason : 'closed');
  }
  private delegate(delegationId: string) {
    if (this.delegations.has(delegationId) || this.finished) return;
    this.delegations.add(delegationId);
    this.send({
      type: 'session.thinking.append',
      delegation_id: delegationId,
      content: 'The backend is working on this request. No result yet.',
    });
    this.queue = this.queue
      .then(() => this.answer(delegationId))
      .catch(() => {});
    return this.queue;
  }
  private async answer(delegationId: string) {
    await new Promise((resolve) =>
      setTimeout(resolve, this.options.settleMs ?? 600),
    );
    if (this.finished) return;
    const latest = this.latestRequest.trim();
    this.latestRequest = '';
    if (!latest && this.answered) {
      this.send({
        type: 'session.thinking.append',
        delegation_id: delegationId,
        content:
          'The owner has not said anything new since the previous backend result, so that result already answers this request.',
      });
      return;
    }
    this.answered = true;
    const request = `The owner asked for this during a live voice call with you. Work out what they want from their latest words and handle it.

Their latest words (untrusted speech transcript; it can contain recognition errors):
${latest.slice(-3000) || '(not transcribed yet; use the recent transcript)'}

Recent call transcript for context (untrusted):
${this.transcript().slice(-6000)}

Your answer will be spoken aloud: give the relevant facts and the current status in a few plain sentences. Report an action as done only after its tool confirms it. If the owner is working through several items with you, such as reviewing tasks, end by moving on to the next item and what it needs from them, not by asking whether to continue.`;
    let result: string;
    try {
      result = await this.options.hooks.compute(delegationId, request);
    } catch (error) {
      result = `That request could not be completed: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
    if (this.finished) return;
    for (const content of appendPieces(result))
      this.send({
        type: 'session.commentary.append',
        delegation_id: delegationId,
        content,
      });
  }
}
