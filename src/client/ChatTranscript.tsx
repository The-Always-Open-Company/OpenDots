import { openPageLink } from './page-navigation';
import { Fragment, type ReactNode } from 'react';
import { Clock3, ListChecks, Mic, Phone, PhoneOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { AssistantMessage, Message } from '@ag-ui/core';
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
export function ChatTranscript({
  messages,
  calls,
  renderTools,
  renderSpeech,
}: {
  messages: Message[];
  calls: CallReceipt[];
  renderTools?: (message: AssistantMessage) => ReactNode;
  /** Shown under the written reply to each voice note. */
  renderSpeech?: (message: AssistantMessage) => ReactNode;
}) {
  const ids = new Set(messages.map((message) => message.id));
  const spoken = renderSpeech ? voiceNoteReplyIds(messages) : new Set<string>();
  return (
    <>
      {calls
        .filter(
          (call) => !call.anchorMessageId || !ids.has(call.anchorMessageId),
        )
        .map((call) => (
          <Receipt key={call.id} call={call} />
        ))}
      {messages.map((message) => {
        const marker = workPromptKind(message);
        const task = taskMarker(message);
        return (
          <Fragment key={message.id}>
            {marker ? (
              <div className="work-marker">
                <Clock3 size={13} />
                <span>{workPromptLabel(marker)}</span>
              </div>
            ) : task ? (
              <div className="work-marker">
                {task.kind === 'call' ? (
                  <Phone size={13} />
                ) : (
                  <ListChecks size={13} />
                )}
                <span>{task.label}</span>
              </div>
            ) : (
              typeof message.content === 'string' &&
              message.content.trim() && (
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
                          target={
                            href?.startsWith('/#/spaces/')
                              ? undefined
                              : '_blank'
                          }
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
              )
            )}
            {message.role === 'assistant' &&
              spoken.has(message.id) &&
              renderSpeech?.(message)}
            {message.role === 'assistant' && renderTools?.(message)}
            {calls
              .filter((call) => call.anchorMessageId === message.id)
              .map((call) => (
                <Receipt key={call.id} call={call} />
              ))}
          </Fragment>
        );
      })}
    </>
  );
}
