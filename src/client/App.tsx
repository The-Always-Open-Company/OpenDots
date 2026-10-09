import { openPageLink } from './page-navigation';
import { SpaceNav } from './SpaceNav';
import { SpaceWorkspace } from './SpaceWorkspace';
import { useCallback, useEffect, useState, useRef } from 'react';
import { CopilotKitProvider } from '@copilotkit/react-core/v2';
import {
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Clock3,
  Folder,
  Library,
  Menu,
  MessageCircle,
  Monitor,
  MoreHorizontal,
  Pause,
  PanelLeft,
  Play,
  Plus,
  Search,
  Settings2,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';
import type {
  Conversation,
  Detail,
  WorkView,
  Dot,
  Result,
  State,
  WorkspaceState,
} from '../shared/types';
import { api, ApiError, authHeaders, setToken } from './api';
import {
  applyCaptureResult,
  applyRefreshResult,
  dismissNotice,
  visibleNotice,
  type Notices,
} from './poll-notice';
import { Mascot } from './Mascot';
import { Chat } from './Chat';
import { ThreadList } from './ThreadList';
import { ResultPane } from './ResultPane';
import { TaskRow } from './TaskPresentation';
import { TaskActions } from './TaskActions';
import { WorkActivity, WorkDetail } from './WorkActivity';
import { WorkspaceDialog, type Dialog } from './WorkspaceDialog';
import { LearnedMemories } from './LearnedMemories';
import { SkillLibrary } from './SkillLibrary';
import { DocumentLibrary } from './DocumentLibrary';
import { DocumentDetail } from './DocumentDetail';
import {
  notifyFinishedAttempt,
  requestActivityNotifications,
  takeNewFinishes,
  attemptHeadline,
} from './activity-notice';

function describeFailure(error: unknown, fallback: string) {
  return {
    ok: false as const,
    status: error instanceof ApiError ? error.status : undefined,
    message: error instanceof Error ? error.message : fallback,
  };
}

export function App() {
  const [state, setState] = useState<State>();
  const [workspace, setWorkspace] = useState<WorkspaceState>();
  const [selectedDot, setSelectedDot] = useState('');
  const [selectedThread, setSelectedThread] = useState<string>();
  const [view, rawSetView] = useState<
    'chat' | 'tasks' | 'memories' | 'space' | 'documents' | 'skills'
  >('chat');
  const dirtyPage = useRef(false);
  const [spaceId, setSpaceId] = useState('');
  const [pageId, setPageId] = useState<string>();
  const [documentId, setDocumentId] = useState<string>();
  const setDirtyPage = useCallback((value: boolean) => {
    dirtyPage.current = value;
  }, []);
  const setView = (next: typeof view) => {
    if (dirtyPage.current && !window.confirm('Leave your unsaved page draft?'))
      return;
    dirtyPage.current = false;
    if (next !== 'space' && next !== 'documents')
      history.replaceState(null, '', location.pathname + location.search);
    rawSetView(next);
  };
  useEffect(() => {
    let acceptedHash = location.hash;
    const navigate = () => {
      const match = location.hash.match(
        /^#\/spaces\/([^/]+)(?:\/pages\/([^/]+))?$/,
      );
      const documents = location.hash.match(/^#\/documents(?:\/([^/]+))?$/);
      if (!match && !documents) return;
      if (dirtyPage.current && location.hash === acceptedHash) return;
      if (
        dirtyPage.current &&
        !window.confirm('Leave your unsaved page draft?')
      ) {
        history.replaceState(null, '', acceptedHash || location.pathname);
        return;
      }
      acceptedHash = location.hash;
      dirtyPage.current = false;
      if (match) {
        setSpaceId(match[1]);
        setPageId(match[2]);
        rawSetView('space');
      } else {
        setDocumentId(documents![1]);
        rawSetView('documents');
      }
      setMobile(false);
    };
    navigate();
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  const openPage = (space: string, page?: string) => {
    openPageLink(`#/spaces/${space}${page ? `/pages/${page}` : ''}`);
  };

  const [notices, setNotices] = useState<Notices>({
    refresh: '',
    capture: '',
    action: '',
  });
  const error = visibleNotice(notices);
  const setError = (action: string) =>
    setNotices((current) =>
      current.action === action ? current : { ...current, action },
    );
  const [auth, setAuth] = useState('');
  const [needsAuth, setNeedsAuth] = useState(false);
  const [dialog, setDialog] = useState<Dialog>();
  const [mobile, setMobile] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [pane, setPane] = useState(false);
  const [capture, setCapture] = useState<Result>();
  const [prompt, setPrompt] = useState('');
  const [pendingPrompt, setPendingPrompt] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [taskDetail, setTaskDetail] = useState<Detail>();
  const [workDetail, setWorkDetail] = useState<WorkView>();
  const [minutes, setMinutes] = useState('');
  const refresh = useCallback(async () => {
    try {
      const [s, w] = await Promise.all([
        api<State>('/state'),
        api<WorkspaceState>('/workspace'),
      ]);
      setState(s);
      setWorkspace(w);
      setNeedsAuth(false);
      setSelectedDot((previous) => previous || w.dots[0]?.id || '');
      setNotices((current) => applyRefreshResult(current, { ok: true }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedsAuth(true);
      setNotices((current) =>
        applyRefreshResult(
          current,
          describeFailure(e, 'Could not connect to the server.'),
        ),
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  const seenExecutions = useRef<Set<string> | null>(null);
  const [unseenRuns, setUnseenRuns] = useState(0);
  useEffect(() => {
    const ask = () => requestActivityNotifications();
    window.addEventListener('pointerdown', ask, { once: true });
    return () => window.removeEventListener('pointerdown', ask);
  }, []);
  useEffect(() => {
    if (!state) return;
    const result = takeNewFinishes(seenExecutions.current, state.work ?? []);
    seenExecutions.current = result.seen;
    if (!result.fresh.length) return;
    if (view !== 'tasks') setUnseenRuns((count) => count + result.fresh.length);
    const pageVisible = document.visibilityState === 'visible';
    for (const attempt of result.fresh) {
      const headline = attemptHeadline(attempt);
      notifyFinishedAttempt({
        ...headline,
        tag: attempt.id,
        visibleHere:
          pageVisible &&
          (view === 'tasks' ||
            (view === 'chat' && selectedThread === attempt.threadId)),
      });
    }
  }, [state, view, selectedThread]);
  useEffect(() => {
    if (view === 'tasks') setUnseenRuns(0);
  }, [view]);
  useEffect(() => {
    setCapture(undefined);
    if (!selectedThread) return;
    let active = true;
    const load = () =>
      void api<Result | null>(`/conversations/${selectedThread}/capture`)
        .then((result) => {
          if (!active) return;
          setCapture(result ?? undefined);
          setNotices((current) => applyCaptureResult(current, { ok: true }));
        })
        .catch((e) => {
          if (!active) return;
          setNotices((current) =>
            applyCaptureResult(
              current,
              describeFailure(e, 'Could not connect to the server.'),
            ),
          );
        });
    load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selectedThread]);
  const mutate = async (path: string, method: string, body?: unknown) => {
    setError('');
    try {
      await api(path, method, body);
      await refresh();
      if (taskDetail)
        setTaskDetail(await api<Detail>(`/tasks/${taskDetail.task.id}`));
      if (workDetail)
        setWorkDetail(
          await api<WorkView>(`/work/${workDetail.workItem.id}`).catch(
            () => undefined,
          ),
        );
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      return false;
    }
  };
  const dot =
    workspace?.dots.find((item) => item.id === selectedDot) ??
    workspace?.dots[0];
  const thread = workspace?.conversations.find(
    (item) => item.id === selectedThread && item.dotId === dot?.id,
  );
  const configured = !!workspace && workspace.setup.missing.length === 0;
  const chooseDot = (next: Dot) => {
    setSelectedDot(next.id);
    setSelectedThread(
      workspace?.conversations.find((item) => item.dotId === next.id)?.id,
    );
    setView('chat');
    setMobile(false);
    setPendingPrompt(undefined);
  };
  const newConversation = async (text?: string) => {
    if (!dot || !configured || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<Conversation>('/conversations', 'POST', {
        dotId: dot.id,
        title: text?.slice(0, 80) || 'A new thought',
      });
      await refresh();
      setSelectedThread(next.id);
      setPendingPrompt(text);
      setPrompt('');
      setView('chat');
      setMobile(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not create the conversation.',
      );
    } finally {
      setBusy(false);
    }
  };
  const deleteConversation = async (id: string) => {
    const conversation = workspace?.conversations.find(
      (item) => item.id === id,
    );
    const title = conversation?.title ?? 'this chat';
    if (
      !window.confirm(
        `Delete “${title}”? The messages are removed. Saved pages, memories, and schedules stay.`,
      )
    )
      return;
    if (!(await mutate(`/conversations/${id}`, 'DELETE'))) return;
    if (selectedThread === id)
      setSelectedThread(
        workspace?.conversations.find(
          (item) => item.id !== id && item.dotId === conversation?.dotId,
        )?.id,
      );
  };
  if (needsAuth)
    return (
      <main className="unlock">
        <Mascot />
        <h1>Your own little corner.</h1>
        <p>
          Enter the owner access token configured on this template’s server.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setToken(auth);
            try {
              await api('/state');
              setError('');
              await refresh();
            } catch (err) {
              setError(
                err instanceof Error
                  ? err.message
                  : 'Access token was not accepted.',
              );
            }
          }}
        >
          <input
            type="password"
            aria-label="Owner access token"
            autoComplete="current-password"
            value={auth}
            onChange={(e) => setAuth(e.target.value)}
            required
          />
          <button className="primary">Unlock OpenDots</button>
        </form>
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <p className="muted">The token stays in this tab’s session storage.</p>
      </main>
    );
  if (!state || !workspace || !dot)
    return (
      <main className="unlock">
        <Mascot state="working" />
        <h1>Finding your dots…</h1>
        {error && (
          <>
            <p className="chat-error">{error}</p>
            <button onClick={() => void refresh()}>Retry</button>
          </>
        )}
      </main>
    );
  const activityCount =
    unseenRuns +
      (state.actions ?? []).filter((action) => action.status === 'pending')
        .length || state.tasks.length + (state.work?.length ?? 0);
  const railView = (next: typeof view) => {
    setView(next);
    setMobile(false);
  };
  const content = (
    <div
      className={`app template-app ${navCollapsed ? 'nav-collapsed' : ''} ${mobile ? 'mobile-nav-open' : ''}`}
    >
      <nav className="icon-rail" aria-label="Workspace navigation">
        <button
          className="rail-brand"
          aria-label="OpenDots home"
          title="Home"
          onClick={() => {
            railView('chat');
            setSelectedThread(undefined);
          }}
        >
          o<span>·</span>
        </button>
        <button
          aria-label={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => setNavCollapsed(!navCollapsed)}
        >
          <PanelLeft size={18} />
        </button>
        <button
          aria-label="New chat"
          title="New chat"
          disabled={!configured}
          onClick={() => void newConversation()}
        >
          <Plus size={19} />
        </button>
        <button
          className={view === 'space' ? 'active' : ''}
          aria-label="Open Spaces"
          title="Spaces"
          onClick={() => {
            if (workspace.spaces[0]) openPage(workspace.spaces[0].id);
          }}
        >
          <Folder size={18} />
        </button>
        <button
          className={view === 'documents' ? 'active' : ''}
          aria-label="Open documents"
          aria-current={view === 'documents' ? 'page' : undefined}
          title="Documents"
          onClick={() => openPageLink('#/documents')}
        >
          <Library size={18} />
        </button>
        <button
          className={view === 'tasks' ? 'active' : ''}
          aria-label={`Open scheduled and activity${activityCount ? `, ${activityCount}` : ''}`}
          aria-current={view === 'tasks' ? 'page' : undefined}
          title="Scheduled & activity"
          onClick={() => {
            requestActivityNotifications();
            railView('tasks');
          }}
        >
          <Clock3 size={18} />
          {activityCount > 0 && (
            <small
              className={`rail-badge ${unseenRuns ? 'nav-attention' : ''}`}
            >
              {activityCount > 99 ? '99+' : activityCount}
            </small>
          )}
        </button>
        <button
          className={view === 'memories' ? 'active' : ''}
          aria-label="Open memories"
          aria-current={view === 'memories' ? 'page' : undefined}
          title="Memories"
          onClick={() => railView('memories')}
        >
          <BookOpen size={18} />
        </button>
        <button
          className={view === 'skills' ? 'active' : ''}
          aria-label="Open skills"
          aria-current={view === 'skills' ? 'page' : undefined}
          title="Skills"
          onClick={() => railView('skills')}
        >
          <WandSparkles size={18} />
        </button>
        <button
          className="rail-settings"
          aria-label="Open settings and setup"
          title="Settings & setup"
          onClick={() => {
            setDialog({ type: 'settings' });
            setMobile(false);
          }}
        >
          <Settings2 size={18} />
        </button>
      </nav>
      <button
        className="mobile-menu icon-button"
        aria-label="Open navigation"
        aria-expanded={mobile}
        aria-controls="workspace-sidebar"
        onClick={() => setMobile(true)}
      >
        <Menu size={21} />
      </button>
      {mobile && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        id="workspace-sidebar"
        className={`sidebar ${mobile ? 'open' : ''}`}
      >
        <button
          className="wordmark"
          onClick={() => {
            setView('chat');
            setSelectedThread(undefined);
          }}
        >
          <span className="dotted-logo">
            <i />
            <i />
            <i />
            <i />
          </span>
          OpenDots<span className="wordmark-dot">•</span>
        </button>
        <button
          className="new-chat nav-item"
          disabled={!configured}
          onClick={() => void newConversation()}
        >
          <Plus size={17} />
          <span>New chat</span>
        </button>
        <div className="spaces-heading nav-label">
          DOTS
          <button
            className="icon-button"
            aria-label="Create Dot"
            onClick={() =>
              setDialog({ type: 'dot', spaceId: workspace.spaces[0].id })
            }
          >
            <Plus size={14} />
          </button>
        </div>
        <nav className="dots-nav" aria-label="Dots">
          {workspace.dots.map((item) => (
            <div className="dot-nav-row" key={item.id}>
              <button
                className={`dot-nav ${dot.id === item.id && view === 'chat' ? 'active' : ''}`}
                aria-current={
                  dot.id === item.id && view === 'chat' ? 'page' : undefined
                }
                onClick={() => chooseDot(item)}
              >
                <Mascot
                  identity={item.id}
                  character={item.mascot}
                  name={item.name}
                  small
                  decorative
                />
                <span>{item.name}</span>
              </button>
              <button
                className="icon-button dot-settings"
                aria-label={`Edit ${item.name} settings`}
                onClick={() =>
                  setDialog({ type: 'dot', dot: item, spaceId: item.spaceId })
                }
              >
                <MoreHorizontal size={15} />
              </button>
            </div>
          ))}
        </nav>
        <div className="spaces-heading nav-label">
          SPACES
          <button
            className="icon-button"
            aria-label="Create Space"
            onClick={() => setDialog({ type: 'space' })}
          >
            <Plus size={14} />
          </button>
        </div>
        <nav className="spaces-nav" aria-label="Spaces">
          {workspace.spaces.map((space) => (
            <SpaceNav
              key={space.id}
              space={space}
              active={view === 'space' && spaceId === space.id}
              pageId={pageId}
              onOpen={(id) => openPage(space.id, id)}
            />
          ))}
        </nav>
        {configured ? (
          <ThreadList
            dotId={dot.id}
            dots={workspace.dots}
            local={workspace.conversations}
            selected={view === 'chat' ? selectedThread : undefined}
            onSelect={(id) => {
              const conversation = workspace.conversations.find(
                (item) => item.id === id,
              );
              if (conversation) setSelectedDot(conversation.dotId);
              setSelectedThread(id);
              setView('chat');
              setMobile(false);
            }}
            onNew={() => void newConversation()}
            onDelete={(id) => void deleteConversation(id)}
          />
        ) : (
          <div className="sidebar-empty">
            Set up text chat to begin a persistent conversation.
          </div>
        )}
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="desktop-nav-toggle document-icon"
            aria-label={navCollapsed ? 'Show navigation' : 'Hide navigation'}
            onClick={() => setNavCollapsed(!navCollapsed)}
          >
            <PanelLeft size={18} />
          </button>
          <div className="breadcrumbs">
            <span>
              {view === 'space'
                ? workspace.spaces.find((space) => space.id === spaceId)?.name
                : view === 'documents'
                  ? 'Library'
                  : 'Dots'}
            </span>
            <span>/</span>
            <strong>
              {view === 'chat'
                ? dot.name
                : view === 'tasks'
                  ? 'Activity'
                  : view === 'space'
                    ? 'Pages'
                    : view === 'documents'
                      ? 'Documents'
                      : view === 'skills'
                        ? 'Skills'
                        : 'Memories'}
            </strong>
          </div>
          <div className="top-actions">
            <span className="mode-badge">
              {configured ? 'SELF-HOSTED' : 'SETUP REQUIRED'}
            </span>
            <button
              className="pause-button"
              aria-label={
                state.settings.paused ? 'Resume all Dots' : 'Pause all Dots'
              }
              onClick={() =>
                void mutate('/settings', 'PATCH', {
                  paused: !state.settings.paused,
                })
              }
            >
              {state.settings.paused ? <Play size={14} /> : <Pause size={14} />}
              <span>{state.settings.paused ? 'Resume' : 'Pause'}</span>
            </button>
            <button
              className="icon-button"
              aria-label={pane ? 'Hide computer' : 'Show computer'}
              aria-expanded={pane}
              onClick={() => setPane(!pane)}
            >
              <Monitor size={18} />
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setNotices((current) => dismissNotice(current))}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {state.settings.paused && (
          <div className="notice">
            All Dots are paused. Active compute stops and scheduled tasks wait.
          </div>
        )}
        {view === 'space' ? (
          <SpaceWorkspace
            key={spaceId}
            space={
              workspace.spaces.find((s) => s.id === spaceId) ??
              workspace.spaces[0]
            }
            pageId={pageId}
            workspace={workspace}
            paused={state.settings.paused}
            onPage={(id) => openPage(spaceId, id)}
            onSettings={() => setDialog({ type: 'settings' })}
            onCreateDot={() => setDialog({ type: 'dot', spaceId })}
            onDirty={setDirtyPage}
            onRefresh={refresh}
            onSchedule={(threadId) => setDialog({ type: 'schedule', threadId })}
            onThread={(id) => {
              const target = workspace.conversations.find((t) => t.id === id);
              if (target) {
                setView('chat');
                setSelectedDot(target.dotId);
                setSelectedThread(id);
              }
            }}
          />
        ) : view === 'skills' ? (
          <SkillLibrary dots={workspace.dots} />
        ) : view === 'documents' ? (
          documentId ? (
            <DocumentDetail
              key={documentId}
              id={documentId}
              workspace={workspace}
              onBack={() => openPageLink('#/documents')}
              onPage={openPage}
              onThread={(id) => {
                const target = workspace.conversations.find((t) => t.id === id);
                if (target) {
                  setView('chat');
                  setSelectedDot(target.dotId);
                  setSelectedThread(id);
                }
              }}
            />
          ) : (
            <DocumentLibrary
              workspace={workspace}
              onOpen={(id) => openPageLink(`#/documents/${id}`)}
            />
          )
        ) : view === 'chat' ? (
          <div className={`chat-workspace ${pane ? 'split' : ''}`}>
            <div className="chat-column">
              {thread && configured ? (
                <Chat
                  key={thread.id}
                  thread={thread}
                  dot={dot}
                  initialPrompt={pendingPrompt}
                  onConsumed={() => setPendingPrompt(undefined)}
                  voiceReady={workspace.setup.voice}
                  documentsReady={workspace.setup.documents}
                  calls={workspace.calls.filter(
                    (call) => call.threadId === thread.id,
                  )}
                  paused={state.settings.paused}
                  onSaved={refresh}
                  onComputer={() => setPane(true)}
                  onSchedule={() =>
                    setDialog({ type: 'schedule', threadId: thread.id })
                  }
                  actions={(state.actions ?? []).filter(
                    (action) =>
                      action.status === 'pending' &&
                      action.threadId === thread.id,
                  )}
                  onApprove={(id) => {
                    requestActivityNotifications();
                    void mutate(`/actions/${id}/approve`, 'POST', {});
                  }}
                  onDecline={(id) =>
                    void mutate(`/actions/${id}/decline`, 'POST', {})
                  }
                />
              ) : (
                <div className="new-conversation">
                  <div className="empty-chat-persona">
                    <Mascot
                      identity={dot.id}
                      character={dot.mascot}
                      name={dot.name}
                      state={state.settings.paused ? 'paused' : 'idle'}
                    />
                    <h2>{dot.name}</h2>
                    <p>{dot.instructions}</p>
                    <button
                      className="text-button"
                      onClick={() =>
                        setDialog({ type: 'dot', dot, spaceId: dot.spaceId })
                      }
                    >
                      Edit specialist <MoreHorizontal size={14} />
                    </button>
                  </div>
                  {!configured && (
                    <div className="setup-card">
                      <span className="setup-icon">
                        <Settings2 size={20} />
                      </span>
                      <div>
                        <strong>Connect your Dot</strong>
                        <p>
                          Connect your model and conversation service in
                          Settings to start chatting. Your Spaces and Dot
                          preferences are ready to use.
                        </p>
                        <a
                          href="https://github.com/CopilotKit/OpenDots/blob/main/docs/SETUP.md"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open the setup guide <ArrowUpRight size={12} />
                        </a>
                      </div>
                    </div>
                  )}
                  <form
                    className="composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void newConversation(prompt);
                    }}
                  >
                    <textarea
                      aria-label="Start a conversation"
                      placeholder={
                        configured
                          ? `Message ${dot.name}…`
                          : 'Your first conversation starts after setup.'
                      }
                      value={prompt}
                      maxLength={4000}
                      onChange={(e) => setPrompt(e.target.value)}
                      disabled={!configured}
                    />
                    <div className="composer-bottom">
                      <span>
                        <MessageCircle size={14} />
                        Text and calls, one continuing conversation
                      </span>
                      <button
                        className="send-button"
                        aria-label="Start conversation"
                        disabled={!configured || busy || !prompt.trim()}
                      >
                        <ArrowUp size={19} />
                      </button>
                    </div>
                  </form>
                  <div className="starter-suggestions">
                    {[
                      'Help me think this through',
                      'Research a public page',
                      'Make a plan I can follow',
                    ].map((text) => (
                      <button
                        key={text}
                        disabled={!configured}
                        onClick={() => setPrompt(text)}
                      >
                        {text}
                        <ArrowUpRight size={12} />
                      </button>
                    ))}
                  </div>
                  <div className="connection-note">
                    <span
                      className={`online-dot ${workspace.setup.slack === 'online' ? '' : 'off'}`}
                    />
                    Slack · {workspace.setup.slack.replaceAll('_', ' ')}
                    <button
                      className="text-button"
                      onClick={() => setDialog({ type: 'settings' })}
                    >
                      Setup details
                    </button>
                  </div>
                </div>
              )}
            </div>
            {pane && (
              <ResultPane
                key={dot.id}
                dots={workspace.dots}
                defaultDotId={dot.id}
                latest={capture}
                dotState="idle"
                onClose={() => setPane(false)}
              />
            )}
          </div>
        ) : (
          <main className="main-content">
            <div className="page-heading">
              <div>
                <span className="eyebrow">YOUR WORKSPACE</span>
                <h1>
                  {view === 'memories'
                    ? 'Memories'
                    : 'A little follow-through.'}
                </h1>
                <p>
                  {view === 'memories'
                    ? 'What you share with every Dot, and the preferences each Dot has learned about you.'
                    : 'Scheduled turns run on the server in their original conversation.'}
                </p>
              </div>
              {view === 'memories' && (
                <button
                  className="primary"
                  onClick={() => setDialog({ type: 'memory' })}
                >
                  <Plus size={15} />
                  Add to About me
                </button>
              )}
            </div>
            {view === 'memories' ? (
              <>
                <div className="memory-section-heading">
                  <div>
                    <h2>About me, shared with every Dot</h2>
                    <p className="muted">
                      Preferences and context you write yourself.
                    </p>
                  </div>
                </div>
                <div className="memory-grid">
                  {state.memories.map((memory) => (
                    <article className="memory-card" key={memory.id}>
                      <BookOpen size={18} />
                      <p>{memory.text}</p>
                      <div>
                        <small>
                          {state.settings.memoryAllowed
                            ? 'Available to permitted Dots'
                            : 'Memory use disabled'}
                        </small>
                        <button
                          className="icon-button"
                          aria-label="Edit memory"
                          onClick={() => setDialog({ type: 'memory', memory })}
                        >
                          <MoreHorizontal size={17} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label="Delete memory"
                          onClick={() =>
                            void mutate(`/memories/${memory.id}`, 'DELETE', {})
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
                {!state.memories.length && (
                  <p className="muted">
                    Add a preference like “Keep my research briefs short.” You
                    can change or remove it anytime.
                  </p>
                )}
                <LearnedMemories
                  dots={workspace.dots}
                  available={workspace.setup.memory}
                  defaultDotId={dot.id}
                />
              </>
            ) : (
              <>
                {dot && (
                  <WorkActivity
                    work={(state.work ?? []).filter((item) =>
                      String(item.workItem.title)
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )}
                    actions={state.actions ?? []}
                    busy={busy}
                    onOpen={(id) =>
                      void api<WorkView>(`/work/${id}`)
                        .then(setWorkDetail)
                        .catch((e) => setError(e.message))
                    }
                    onAction={(id, action) =>
                      void mutate(`/work/${id}/actions`, 'POST', { action })
                    }
                    onApprove={(id) => {
                      requestActivityNotifications();
                      void mutate(`/actions/${id}/approve`, 'POST', {});
                    }}
                    onDecline={(id) =>
                      void mutate(`/actions/${id}/decline`, 'POST', {})
                    }
                    onDisableTrigger={(id) =>
                      void mutate(`/triggers/${id}/disable`, 'POST', {})
                    }
                    onCreate={async (title, objective) => {
                      await mutate('/work', 'POST', {
                        dotId: dot.id,
                        title,
                        objective,
                      });
                    }}
                  />
                )}
                <label className="search-box">
                  <Search size={16} />
                  <input
                    aria-label="Search tasks"
                    placeholder="Find a task…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <div className="task-list">
                  {state.tasks
                    .filter((task) =>
                      task.prompt.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        onClick={() => {
                          setMinutes(String((task.intervalSeconds ?? 0) / 60));
                          void api<Detail>(`/tasks/${task.id}`)
                            .then(setTaskDetail)
                            .catch((e) => setError(e.message));
                        }}
                      />
                    ))}
                </div>
                {!state.tasks.length && !(state.work ?? []).length && (
                  <div className="large-empty">
                    <Clock3 size={32} />
                    <h2>Let a thought come back around.</h2>
                    <p>
                      Open a conversation and use the clock button to schedule a
                      server-side task.
                    </p>
                  </div>
                )}
                {taskDetail && (
                  <section className="task-detail-card">
                    <h2>{taskDetail.task.prompt}</h2>
                    <TaskActions
                      task={taskDetail.task}
                      busy={busy}
                      settings={state.settings}
                      onAction={(action) =>
                        void mutate(
                          `/tasks/${taskDetail.task.id}/actions`,
                          'POST',
                          { action },
                        )
                      }
                      onSchedule={async () => {
                        const value = Number(minutes);
                        if (!Number.isFinite(value) || value < 0) {
                          setError('Enter a valid number of minutes.');
                          return;
                        }
                        await mutate(
                          `/tasks/${taskDetail.task.id}/schedule`,
                          'PUT',
                          {
                            intervalSeconds: value
                              ? Math.round(value * 60)
                              : null,
                          },
                        );
                      }}
                    />
                    <label className="field-label" htmlFor="legacy-minutes">
                      Repeat interval in minutes
                    </label>
                    <input
                      id="legacy-minutes"
                      type="number"
                      min={0}
                      value={minutes}
                      onChange={(event) => setMinutes(event.target.value)}
                    />
                    {taskDetail.task.error && (
                      <p className="chat-error">{taskDetail.task.error}</p>
                    )}
                    {taskDetail.events.slice(-6).map((event) => (
                      <p className="muted" key={event.id}>
                        {event.text}
                      </p>
                    ))}
                    <small>{taskDetail.runs.length} saved runs</small>
                  </section>
                )}
                {workDetail && (
                  <WorkDetail
                    detail={workDetail}
                    busy={busy}
                    onReplay={(id) =>
                      void mutate(`/inbound/${id}/replay`, 'POST', {})
                    }
                  />
                )}
              </>
            )}
          </main>
        )}
        {pane && view !== 'chat' && (
          <div className="computer-overlay">
            <ResultPane
              key={view === 'space' ? spaceId : dot.id}
              dots={workspace.dots}
              defaultDotId={
                view === 'space'
                  ? (workspace.dots.find((candidate) =>
                      candidate.spaceIds.includes(spaceId),
                    )?.id ?? dot.id)
                  : dot.id
              }
              dotState="idle"
              onClose={() => setPane(false)}
            />
          </div>
        )}
      </div>
      {dialog && (
        <WorkspaceDialog
          dialog={dialog}
          state={state}
          workspace={workspace}
          onClose={() => setDialog(undefined)}
          mutate={mutate}
        />
      )}
    </div>
  );
  return configured ? (
    <CopilotKitProvider runtimeUrl="/api/copilotkit" headers={authHeaders()}>
      {content}
    </CopilotKitProvider>
  ) : (
    content
  );
}
