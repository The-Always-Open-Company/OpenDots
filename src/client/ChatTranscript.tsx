import { openPageLink } from './page-navigation';
import { Fragment, type ReactNode } from 'react';
import { Clock3, ListChecks, Mic, Phone, PhoneOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { AssistantMessage, Message } from '@ag-ui/core';
import { AgentTrace, buildTranscriptItems } from './agent-trace';
import type { CallReceipt } from '../shared/types';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt';
import { isVoiceNote, voiceNoteReplyIds } from '../shared/voice-note';
import { workPromptKind, workPromptLabel } from '../shared/work-marker';
import {
  callTaskMessagePrefix,
  chatTaskMessagePrefix,
} from '../shared/call-task';
// These markers only control rendering; they do not confer trust or permissions.
export function isInternalVoiceReceipt(message: Message): boolean {
  const metadata = message.metadata;
  return (
    message.role === 'user' &&
    (message.id.startsWith(voiceReceiptMessagePrefix) ||
      (!!metadata &&
        typeof metadata === 'object' &&
        'opendotsSource' in metadata &&
        metadata.opendotsSource === 'voice_receipt'))
  );
}
/** The task line of a call or chat task result, which the app wrote rather than the owner. */
function taskMarker(
  message: Message,
): { kind: 'call' | 'chat'; label: string } | null {
  if (message.role !== 'user') return null;
  const kind = message.id.startsWith(callTaskMessagePrefix)
    ? 'call'
    : message.id.startsWith(chatTaskMessagePrefix)
      ? 'chat'
      : null;
  if (!kind) return null;
  const content = typeof message.content === 'string' ? message.content : '';
  return {
    kind,
    label: content.split('\n')[0] || (kind === 'call' ? 'Call task' : 'Task'),
  };
}
function Receipt({ call }: { call: CallReceipt }) {
  return (
    <div className="call-receipt">
      <PhoneOff size={13} />
      <span>
        {call.status === 'failed'
          ? 'Call failed'
          : call.endedAt
            ? `${Math.round((call.endedAt - call.startedAt) / 1000)}s · Call ended`
            : 'Call in progress'}
      </span>
      {call.error && <small>{call.error}</small>}
    </div>
  );
}
function messageBody(message: Message) {
  const marker = workPromptKind(message);
  const task = taskMarker(message);
  if (marker)
    return (
      <div className="work-marker">
        <Clock3 size={13} />
        <span>{workPromptLabel(marker)}</span>
      </div>
    );
  if (task)
    return (
      <div className="work-marker">
        {task.kind === 'call' ? <Phone size={13} /> : <ListChecks size={13} />}
        <span>{task.label}</span>
      </div>
    );
  if (typeof message.content !== 'string' || !message.content.trim())
    return null;
  return (
    <div className={`chat-bubble ${message.role}`}>
      {isVoiceNote(message) && (
        <span className="voice-note-label">
          <Mic size={12} />
          Voice note
        </span>
      )}
      <ReactMarkdown
        components={{
          img: ({ alt }) => <span>{alt}</span>,
          a: ({ href, children }) => (
            <a
              onClick={(event) => {
                if (href?.startsWith('/#/spaces/')) {
                  event.preventDefault();
                  openPageLink(href);
                }
              }}
              href={href}
              target={href?.startsWith('/#/spaces/') ? undefined : '_blank'}
              rel="noreferrer"
            >
              {children}
            </a>
          ),
        }}
      >
        {String(message.content)}
      </ReactMarkdown>
    </div>
  );
}

export function ChatTranscript({
  messages,
  calls,
  working = false,
  renderTools,
  renderSpeech,
}: {
  messages: Message[];
  calls: CallReceipt[];
  /** The latest grouped steps show the step in progress. */
  working?: boolean;
  renderTools?: (message: AssistantMessage) => ReactNode;
  /** Shown under the written reply to each voice note. */
  renderSpeech?: (message: AssistantMessage) => ReactNode;
}) {
  const ids = new Set(messages.map((message) => message.id));
  const spoken = renderSpeech ? voiceNoteReplyIds(messages) : new Set<string>();
  const items = buildTranscriptItems(messages);
  const liveTrace = working
    ? items.findLast((item) => item.kind === 'trace')?.id
    : undefined;
  const render = renderTools ?? (() => null);
  const receipts = (anchorIds: string[]) => {
    const anchors = new Set(anchorIds);
    return calls
      .filter(
        (call) => call.anchorMessageId && anchors.has(call.anchorMessageId),
      )
      .map((call) => <Receipt key={call.id} call={call} />);
  };
  return (
    <>
      {calls
        .filter(
          (call) => !call.anchorMessageId || !ids.has(call.anchorMessageId),
        )
        .map((call) => (
          <Receipt key={call.id} call={call} />
        ))}
      {items.map((item) => {
        if (item.kind === 'trace')
          return (
            <Fragment key={item.id}>
              <AgentTrace
                steps={item.steps}
                live={item.id === liveTrace}
                renderTools={render}
              />
              {receipts(item.anchorIds)}
            </Fragment>
          );
        if (item.kind === 'cards')
          return (
            <Fragment key={item.id}>
              {render({ ...item.message, toolCalls: item.calls })}
              {receipts(item.anchorIds)}
            </Fragment>
          );
        const { message } = item;
        return (
          <Fragment key={message.id}>
            {messageBody(message)}
            {message.role === 'assistant' &&
              spoken.has(message.id) &&
              renderSpeech?.(message)}
            {receipts(item.anchorIds)}
          </Fragment>
        );
      })}
    </>
  );
}
