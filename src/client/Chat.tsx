import { PageReviewCard } from './PageReviewCard';
import { pageReviewSchema, pageReviewTool } from '../shared/page-review';
import { contextualMessage, type PageContext } from './page-context';
import { api, upload } from './api';
import type { Page } from '../server/pages';
import { useEffect, useRef, useState } from 'react';
import {
  CopilotChatToolCallsView,
  useRenderTool,
  useHumanInTheLoop,
  useAgent,
  useCopilotKit,
} from '@copilotkit/react-core/v2';
import {
  FilePlus,
  ArrowUp,
  Clock3,
  Link2,
  Paperclip,
  Phone,
  PhoneOff,
  Square,
  X,
} from 'lucide-react';
import {
  ComputerToolCard,
  type ComputerToolRenderProps,
} from './ComputerToolCard';
import { ChatTranscript, isInternalVoiceReceipt } from './ChatTranscript';
import type {
  CallReceipt,
  Conversation,
  DocumentSummary,
  Dot,
  PendingAction,
} from '../shared/types';
import { Mascot } from './Mascot';
import { useVoice } from './useVoice';
import { CallView } from './CallView';
import {
  attachedDocuments,
  shouldSubmitComposerOnKeyDown,
} from './chat-composer';
import { DOCUMENT_ACCEPT } from './DocumentUploadDialog';

interface Attachment {
  key: string;
  name: string;
  document?: DocumentSummary;
  error?: string;
}

export function Chat({
  thread,
  dot,
  initialPrompt,
  onConsumed,
  voiceReady,
  documentsReady = false,
  calls,
  paused,
  onSaved,
  onSchedule,
  onComputer,
  actions = [],
  onApprove,
  onDecline,
}: {
  thread: Conversation;
  dot: Dot;
  initialPrompt?: string;
  onConsumed: () => void;
  voiceReady: boolean;
  documentsReady?: boolean;
  calls: CallReceipt[];
  paused: boolean;
  onSaved: () => void;
  onSchedule: () => void;
  onComputer?: () => void;
  actions?: PendingAction[];
  onApprove?: (id: string) => void;
  onDecline?: (id: string) => void;
}) {
  const { agent, isReady } = useAgent({
    agentId: `chat-${thread.id}`,
    runtimeAgentId: dot.id,
    threadId: thread.id,
  });
  const { copilotkit } = useCopilotKit();
  const [pageContext, setPageContext] = useState<PageContext | null>();
  const [contextError, setContextError] = useState('');
  const [contextAttempt, setContextAttempt] = useState(0);
  const contextReady = pageContext !== undefined;
  useEffect(() => {
    let active = true;
    setPageContext(undefined);
    setContextError('');
    void api<PageContext | null>(
      `/conversations/${thread.id}/page-context`,
      'GET',
      undefined,
      AbortSignal.timeout(10000),
    )
      .then((page) => {
        if (active) setPageContext(page);
      })
      .catch(() => {
        if (active)
          setContextError(
            'Conversation context could not load. Retry before sending your message.',
          );
      });
    return () => {
      active = false;
    };
  }, [thread.id, contextAttempt]);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachmentsReady = attachments.every(
    (item) => item.document?.indexedVersion != null,
  );
  const waiting = attachments.some(
    (item) =>
      !item.error &&
      (!item.document ||
        ['queued', 'processing'].includes(item.document.status)),
  );
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      for (const item of attachments)
        if (item.document && item.document.indexedVersion == null)
          void api<DocumentSummary>(`/documents/${item.document.id}`)
            .then((document) =>
              setAttachments((current) =>
                current.map((entry) =>
                  entry.key === item.key
                    ? {
                        ...entry,
                        document,
                        error:
                          document.status === 'failed'
                            ? (document.error ?? 'Processing failed.')
                            : undefined,
                      }
                    : entry,
                ),
              ),
            )
            .catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [waiting, attachments]);
  const attach = (files: File[]) => {
    for (const file of files) {
      const key = crypto.randomUUID();
      setAttachments((current) => [...current, { key, name: file.name }]);
      void upload<DocumentSummary>('/documents', file, { threadId: thread.id })
        .then((document) =>
          setAttachments((current) =>
            current.map((entry) =>
              entry.key === key
                ? {
                    ...entry,
                    document,
                    error:
                      document.status === 'failed'
                        ? (document.error ?? 'Processing failed.')
                        : undefined,
                  }
                : entry,
            ),
          ),
        )
        .catch((e) =>
          setAttachments((current) =>
            current.map((entry) =>
              entry.key === key
                ? {
                    ...entry,
                    error: e instanceof Error ? e.message : 'Upload failed.',
                  }
                : entry,
            ),
          ),
        );
    }
  };
  const [source, setSource] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const voice = useVoice(thread.id, onSaved, agent.messages.at(-1)?.id);
  const sent = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: ({ error }) => setError(error.message),
    });
    const events = agent.subscribe({
      onRunErrorEvent: ({ event }) => setError(event.message),
    });
    return () => {
      subscription.unsubscribe();
      events.unsubscribe();
    };
  }, [agent, copilotkit]);
  useEffect(() => {
    if (!isReady) return;
    let active = true;
    void copilotkit
      .connectAgent({ agent })
      .then(() => {
        if (active) setLoaded(true);
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error ? e.message : 'Conversation could not connect.',
          );
      });
    return () => {
      active = false;
    };
  }, [agent, copilotkit, isReady]);
  const send = async (text: string) => {
    const documents = attachments.flatMap((item) =>
      item.document ? [item.document] : [],
    );
    if (
      (!text.trim() && !documents.length) ||
      !attachmentsReady ||
      running ||
      !loaded ||
      !contextReady ||
      paused
    )
      return;
    setError('');
    setRunning(true);
    agent.addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: contextualMessage(
        attachedDocuments(
          text.trim() ? text : 'Please look at the attached document.',
          documents,
        ),
        pageContext,
      ),
    });
    setDraft('');
    setAttachments([]);
    setSource('');
    setSourceOpen(false);
    try {
      const result = await copilotkit.runAgent({ agent });
      if (!result.newMessages.some((message) => message.role === 'assistant'))
        throw new Error(
          'The current turn returned no response. Check the runtime connection and retry.',
        );
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'The turn failed. Your conversation remains saved.',
      );
    } finally {
      setRunning(false);
    }
  };
  useEffect(() => {
    if (loaded && contextReady && !paused && initialPrompt && !sent.current) {
      sent.current = true;
      onConsumed();
      void send(initialPrompt);
    }
  }, [loaded, contextReady, paused, initialPrompt]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [agent.messages.length, running]);
  useEffect(() => {
    if (paused && voice.status !== 'idle') void voice.end();
  }, [paused]);
  useHumanInTheLoop(
    {
      name: pageReviewTool.name,
      description: pageReviewTool.description,
      parameters: pageReviewSchema,
      render: (props) => (
        <PageReviewCard {...props} threadId={thread.id} onSaved={onSaved} />
      ),
    },
    [thread.id, onSaved],
  );
  const computerCalls = agent.messages.flatMap((message) =>
    message.role === 'assistant' ? (message.toolCalls ?? []) : [],
  );
  const latestBrowserCall = computerCalls.findLast((call) =>
    [
      'navigate',
      'snapshot',
      'read',
      'screenshot',
      'click',
      'type',
      'key',
      'scroll',
    ].some((action) => call.function.name === `computer_${action}`),
  );
  useRenderTool(
    {
      name: '*',
      render: (props: ComputerToolRenderProps) =>
        props.name.startsWith('computer_') ? (
          <ComputerToolCard
            {...props}
            dotId={dot.id}
            dotName={dot.name}
            running={running}
            showScreen={props.toolCallId === latestBrowserCall?.id}
            onExpand={onComputer}
          />
        ) : null,
    },
    [dot.id, dot.name, running, latestBrowserCall?.id, onComputer],
  );
  const visible = agent.messages.filter(
    (message) =>
      !isInternalVoiceReceipt(message) &&
      ['user', 'assistant'].includes(message.role) &&
      ((typeof message.content === 'string' && message.content.trim()) ||
        (message.role === 'assistant' &&
          message.toolCalls?.some(
            (call) =>
              call.function.name.startsWith('computer_') ||
              call.function.name === pageReviewTool.name,
          ))),
  );
  return (
    <div className="live-chat">
      <header className="chat-persona">
        <Mascot
          identity={dot.id}
          character={dot.mascot}
          name={dot.name}
          small
          state={running ? 'working' : paused ? 'paused' : 'idle'}
        />
        <div>
          <strong>{dot.name}</strong>
          <span>
            {paused
              ? 'Paused'
              : running
                ? 'Thinking…'
                : loaded && contextReady
                  ? 'Here with you'
                  : 'Connecting to your conversation…'}
          </span>
        </div>
        <div className="chat-persona-actions">
          <button
            className="icon-button"
            aria-label="Save conversation as page"
            disabled={running}
            onClick={async () => {
              const title = window.prompt('Page title', thread.title);
              if (!title) return;
              try {
                const page = await api<Page>(
                  `/conversations/${thread.id}/page`,
                  'POST',
                  { title },
                );
                location.hash = `/spaces/${page.spaceId}/pages/${page.id}`;
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : 'Could not save conversation.',
                );
              }
            }}
          >
            <FilePlus size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Schedule a task in this conversation"
            onClick={onSchedule}
          >
            <Clock3 size={18} />
          </button>
          <button
            className={`icon-button ${voice.status === 'active' ? 'on-call' : ''}`}
            aria-label={
              voice.status === 'idle' ? 'Start voice call' : 'End voice call'
            }
            title={
              voiceReady
                ? 'Talk with your Dot'
                : 'Voice setup requires VOICE_API_KEY and VOICE_MODEL'
            }
            disabled={!voiceReady || paused || !loaded || !contextReady}
            onClick={() =>
              voice.status === 'idle' ? void voice.start() : void voice.end()
            }
          >
            {voice.status === 'idle' ? (
              <Phone size={18} />
            ) : (
              <PhoneOff size={18} />
            )}
          </button>
        </div>
      </header>
      {pageContext && (
        <div className="page-chat-context">
          Working on{' '}
          <a href={`/#/spaces/${pageContext.spaceId}/pages/${pageContext.id}`}>
            {pageContext.title}
          </a>
        </div>
      )}
      <div className="chat-transcript">
        {!visible.length && (
          <div className="chat-welcome">
            <span className="eyebrow">A LITTLE SPACE TO THINK</span>
            <h1>What’s on your mind?</h1>
            <p>{dot.instructions}</p>
            <p className="muted">
              Your conversation stays with this Dot, across text and calls.
            </p>
          </div>
        )}
        <ChatTranscript
          messages={visible}
          calls={calls}
          renderTools={(message) => (
            <CopilotChatToolCallsView
              message={message}
              messages={agent.messages}
            />
          )}
        />
        {running && (
          <div className="thinking">
            <span />
            <span />
            <span />
            <span>{dot.name} is thinking</span>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {contextError && (
        <div className="chat-error" role="alert">
          {contextError}
          <button onClick={() => setContextAttempt((value) => value + 1)}>
            Retry context
          </button>
        </div>
      )}
      {(error || voice.error) && (
        <div className="chat-error" role="alert">
          {error || voice.error}
          {error && (
            <button
              onClick={() => {
                setError('');
                void copilotkit
                  .connectAgent({ agent })
                  .then(() => setLoaded(true))
                  .catch((e) => setError(e.message));
              }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
      <CallView
        key={voice.status === 'idle' ? 'idle' : 'call'}
        dot={dot}
        voice={voice}
      />
      {actions
        .filter((action) => action.status === 'pending')
        .map((action) => (
          <article className="task-detail-card" key={action.id}>
            <h2>Waiting for you · {action.toolName}</h2>
            <p className="muted">{action.argumentsJson.slice(0, 400)}</p>
            <div className="task-controls">
              <button type="button" onClick={() => onApprove?.(action.id)}>
                Approve
              </button>
              <button type="button" onClick={() => onDecline?.(action.id)}>
                Decline
              </button>
            </div>
          </article>
        ))}
      <form
        className="chat-composer"
        onDragOver={(e) => {
          if (documentsReady && e.dataTransfer.types.includes('Files'))
            e.preventDefault();
        }}
        onDrop={(e) => {
          if (!documentsReady || !e.dataTransfer.files.length) return;
          e.preventDefault();
          attach([...e.dataTransfer.files]);
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void send(`${source ? `From ${source}:\n\n` : ''}${draft}`);
        }}
      >
        {sourceOpen && (
          <div className="source-input">
            <Link2 size={15} />
            <input
              aria-label="Source page URL"
              type="url"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://example.com/page"
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Remove source"
              onClick={() => {
                setSourceOpen(false);
                setSource('');
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {!!attachments.length && (
          <ul className="attachment-chips" aria-label="Attached files">
            {attachments.map((item) => (
              <li
                key={item.key}
                className={
                  item.error
                    ? 'failed'
                    : item.document?.indexedVersion != null
                      ? 'ready'
                      : 'pending'
                }
              >
                <Paperclip size={12} />
                <span>{item.document?.title ?? item.name}</span>
                <small>
                  {item.error
                    ? item.error
                    : !item.document
                      ? 'Uploading…'
                      : item.document.indexedVersion != null
                        ? 'Ready'
                        : 'Processing…'}
                </small>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${item.document?.title ?? item.name}`}
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((entry) => entry.key !== item.key),
                    )
                  }
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="chat-compose-row">
          <button
            type="button"
            className="icon-button"
            aria-label="Add source page link"
            onClick={() => setSourceOpen(!sourceOpen)}
          >
            <Link2 size={19} />
          </button>
          {documentsReady && (
            <>
              <button
                type="button"
                className="icon-button"
                aria-label="Attach files"
                title="Attach files. They are saved to Documents and shared with this Dot."
                disabled={paused}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip size={18} />
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept={DOCUMENT_ACCEPT}
                onChange={(e) => {
                  attach([...(e.target.files ?? [])]);
                  e.target.value = '';
                }}
              />
            </>
          )}
          <textarea
            aria-label="Message your Dot"
            placeholder={`Message ${dot.name}…`}
            rows={1}
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (shouldSubmitComposerOnKeyDown(e)) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {running ? (
            <button
              type="button"
              className="send-button"
              aria-label="Stop response"
              onClick={() => copilotkit.stopAgent({ agent })}
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              className="send-button"
              aria-label="Send message"
              disabled={
                (!draft.trim() && !attachments.length) ||
                !attachmentsReady ||
                !loaded ||
                !contextReady ||
                paused
              }
              title={
                attachmentsReady
                  ? undefined
                  : 'Wait for attachments to finish processing, or remove them.'
              }
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
        <div className="chat-compose-note">
          {voiceReady
            ? 'Text and voice, one conversation.'
            : 'Text is ready. Voice needs separate server configuration.'}
        </div>
      </form>
    </div>
  );
}
