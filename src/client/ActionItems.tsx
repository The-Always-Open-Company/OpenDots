import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ListChecks, Search, Trash2, X } from 'lucide-react';
import {
  ACTION_ITEM_PRIORITIES,
  ACTION_ITEM_STATUSES,
  ENTITY_KINDS,
  type ActionItem,
  type ActionItemEvent,
  type ActionItemStatus,
  type Entity,
  type WorkspaceState,
} from '../shared/types';
import { api } from './api';
import {
  dateInputValue,
  dueText,
  dueTone,
  groupActionItems,
  assigneeText,
  ownershipOf,
  ROLE_LABELS,
} from './action-item-groups';

export const browserTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

interface SearchResult {
  items: ActionItem[];
  total: number;
  unresolved?: { name: string; suggestions: Entity[] }[];
  note?: string;
}
type Detail = ActionItem & { events: ActionItemEvent[] };
interface Review {
  overdue: ActionItem[];
  dueSoon: ActionItem[];
}

export interface ActionItemFilters {
  query: string;
  assignee: '' | 'me' | 'owed' | 'others';
  status: '' | ActionItemStatus;
  showCompleted: boolean;
  entities: string[];
  label: string;
  dueAfter: string;
  dueBefore: string;
}

export const EMPTY_FILTERS: ActionItemFilters = {
  query: '',
  assignee: '',
  status: '',
  showCompleted: false,
  entities: [],
  label: '',
  dueAfter: '',
  dueBefore: '',
};

const LIST_LIMIT = 200;
const STATUS_LABELS: Record<ActionItemStatus, string> = {
  open: 'Open',
  waiting: 'Waiting',
  done: 'Done',
  dropped: 'Dropped',
};
const KIND_LABELS = {
  organization: 'Organizations',
  person: 'People',
  project: 'Projects',
  topic: 'Topics',
} as const;

/** Query string for GET /action-items; no status means open and waiting. */
export function actionItemQuery(filters: ActionItemFilters, timeZone: string) {
  const params = new URLSearchParams();
  if (filters.query.trim()) params.set('q', filters.query.trim());
  for (const name of filters.entities) params.append('entity', name);
  if (filters.assignee) params.set('assignee', filters.assignee);
  const statuses = filters.status
    ? [filters.status]
    : filters.showCompleted
      ? [...ACTION_ITEM_STATUSES]
      : [];
  if (statuses.length) params.set('status', statuses.join(','));
  if (filters.label) params.set('label', filters.label);
  if (filters.dueAfter) params.set('dueAfter', filters.dueAfter);
  if (filters.dueBefore) params.set('dueBefore', filters.dueBefore);
  params.set('limit', String(LIST_LIMIT));
  params.set('timezone', timeZone);
  return params.toString();
}

/** Loads the list; refreshes every 30 seconds unless it is a text search. */
function useActionItems(query: string, enabled: boolean, poll: boolean) {
  const [result, setResult] = useState<SearchResult>();
  const [error, setError] = useState('');
  const latest = useRef(0);
  const load = useCallback(async () => {
    if (!enabled) return;
    const request = ++latest.current;
    try {
      const next = await api<SearchResult>(`/action-items?${query}`);
      if (request !== latest.current) return;
      setResult(next);
      setError('');
    } catch (e) {
      if (request !== latest.current) return;
      setError(e instanceof Error ? e.message : 'Could not load action items.');
    }
  }, [query, enabled]);
  useEffect(() => {
    void load();
    if (!poll) return;
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load, poll]);
  return { result, error, reload: load };
}

/** Overdue and due-soon count for the rail badge. */
export function useActionItemBadge(enabled: boolean) {
  const [count, setCount] = useState(0);
  const refresh = useCallback(async () => {
    if (!enabled) return setCount(0);
    try {
      const review = await api<Review>(
        `/action-items/review?timezone=${encodeURIComponent(browserTimeZone())}`,
      );
      setCount(review.overdue.length + review.dueSoon.length);
    } catch {
      // The badge is a hint; the screen reports errors.
    }
  }, [enabled]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { count, refresh };
}

export function ActionItems({
  workspace,
  onOpenDocument,
  onOpenPage,
  onOpenThread,
  onChanged,
}: {
  workspace: WorkspaceState;
  onOpenDocument: (id: string) => void;
  onOpenPage: (spaceId: string, pageId: string) => void;
  onOpenThread: (threadId: string) => void;
  onChanged?: () => void;
}) {
  const available = workspace.setup.actionItems;
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [typed, setTyped] = useState('');
  const [selected, setSelected] = useState<string>();
  const [entities, setEntities] = useState<Entity[]>([]);
  useEffect(() => {
    const timer = setTimeout(
      () => setFilters((current) => ({ ...current, query: typed.trim() })),
      400,
    );
    return () => clearTimeout(timer);
  }, [typed]);
  const searching = !!filters.query;
  const { result, error, reload } = useActionItems(
    actionItemQuery(filters, browserTimeZone()),
    available,
    !searching,
  );
  const loadEntities = useCallback(async () => {
    if (!available) return;
    try {
      setEntities(await api<Entity[]>('/entities'));
    } catch {
      // The picker stays empty; chips on items still filter.
    }
  }, [available]);
  useEffect(() => {
    void loadEntities();
  }, [loadEntities]);
  const set = (patch: Partial<ActionItemFilters>) =>
    setFilters((current) => ({ ...current, ...patch }));
  const addEntity = (name: string) =>
    setFilters((current) =>
      current.entities.includes(name) || current.entities.length >= 5
        ? current
        : { ...current, entities: [...current.entities, name] },
    );
  const changed = () => {
    void reload();
    void loadEntities();
    onChanged?.();
  };
  const labels = [
    ...new Set([
      ...(result?.items.flatMap((item) => item.labels) ?? []),
      ...(filters.label ? [filters.label] : []),
    ]),
  ].sort();
  const filtered =
    searching ||
    filters.assignee ||
    filters.status ||
    filters.entities.length ||
    filters.label ||
    filters.dueAfter ||
    filters.dueBefore;
  return (
    <main className="spaces-surface library" aria-label="Action items">
      <section className="space-library action-items-library">
        <header className="library-heading">
          <div>
            <span className="library-eyebrow">FOLLOW-UP</span>
            <h1>Action items</h1>
            <p>
              What you have to do and what others owe you, filed by your Dots
              from meetings, documents and conversations.
            </p>
          </div>
        </header>
        {!available && (
          <p className="document-setup-note">
            Action items need Postgres and an OpenAI API key. Set DATABASE_URL
            and OPENAI_API_KEY on the server (see the setup guide), then
            restart.
          </p>
        )}
        <div className="library-tools">
          <label className="library-search">
            <Search size={17} />
            <input
              aria-label="Search action items"
              placeholder="Search by meaning, e.g. Company A security review"
              value={typed}
              disabled={!available}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
        </div>
        <div className="document-filters">
          <select
            aria-label="Filter by who owes it"
            value={filters.assignee}
            disabled={!available}
            onChange={(event) =>
              set({
                assignee: event.target.value as ActionItemFilters['assignee'],
              })
            }
          >
            <option value="">Anyone owes it</option>
            <option value="me">You owe it</option>
            <option value="owed">Others owe you</option>
            <option value="others">Between others</option>
          </select>
          <select
            aria-label="Filter by status"
            value={filters.status}
            disabled={!available}
            onChange={(event) =>
              set({ status: event.target.value as ActionItemFilters['status'] })
            }
          >
            <option value="">Open and waiting</option>
            {ACTION_ITEM_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by person, organization, project or topic"
            value=""
            disabled={!available || !entities.length}
            onChange={(event) =>
              event.target.value && addEntity(event.target.value)
            }
          >
            <option value="">Person, organization…</option>
            {ENTITY_KINDS.map((kind) => {
              const group = entities.filter((entity) => entity.kind === kind);
              return group.length ? (
                <optgroup key={kind} label={KIND_LABELS[kind]}>
                  {group.map((entity) => (
                    <option key={entity.id} value={entity.name}>
                      {entity.name}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
          <select
            aria-label="Filter by label"
            value={filters.label}
            disabled={!available}
            onChange={(event) => set({ label: event.target.value })}
          >
            <option value="">Any label</option>
            {labels.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
          <label className="action-item-date-filter">
            Due after
            <input
              type="date"
              value={filters.dueAfter}
              disabled={!available}
              onChange={(event) => set({ dueAfter: event.target.value })}
            />
          </label>
          <label className="action-item-date-filter">
            Due before
            <input
              type="date"
              value={filters.dueBefore}
              disabled={!available}
              onChange={(event) => set({ dueBefore: event.target.value })}
            />
          </label>
          {!filters.status && (
            <label className="action-item-toggle">
              <input
                type="checkbox"
                checked={filters.showCompleted}
                disabled={!available}
                onChange={(event) =>
                  set({ showCompleted: event.target.checked })
                }
              />
              Show completed
            </label>
          )}
        </div>
        {filters.entities.length > 0 && (
          <div className="action-item-active-filters">
            {filters.entities.map((name) => (
              <button
                key={name}
                className="document-tag action-item-chip"
                aria-label={`Remove filter ${name}`}
                onClick={() =>
                  set({
                    entities: filters.entities.filter(
                      (entry) => entry !== name,
                    ),
                  })
                }
              >
                {name} <X size={11} />
              </button>
            ))}
          </div>
        )}
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        {result?.note && <p className="action-item-note">{result.note}</p>}
        {result?.unresolved?.map((entry) => (
          <p className="action-item-note" key={entry.name}>
            Nothing is tagged “{entry.name}”, so it was searched as text.
            {entry.suggestions.length > 0 && (
              <>
                {' '}
                Did you mean{' '}
                {entry.suggestions.map((suggestion, index) => (
                  <span key={suggestion.id}>
                    {index > 0 && ', '}
                    <button
                      className="action-item-link"
                      onClick={() =>
                        set({
                          entities: filters.entities.map((name) =>
                            name === entry.name ? suggestion.name : name,
                          ),
                        })
                      }
                    >
                      {suggestion.name}
                    </button>
                  </span>
                ))}
                ?
              </>
            )}
          </p>
        ))}
        <div className={`action-items-columns ${selected ? 'with-panel' : ''}`}>
          <div className="action-items-list">
            {!available ? null : result ? (
              result.items.length ? (
                <>
                  {result.total > result.items.length && !searching && (
                    <p className="action-item-note">
                      Showing the first {result.items.length} of {result.total}.
                      Narrow the filters to see the rest.
                    </p>
                  )}
                  <ActionItemList
                    items={result.items}
                    now={Date.now()}
                    grouped={!searching}
                    selectedId={selected}
                    onSelect={setSelected}
                    onEntity={addEntity}
                    onLabel={(label) => set({ label })}
                  />
                </>
              ) : (
                <div className="library-empty">
                  <ListChecks size={30} strokeWidth={1.3} />
                  <h2>
                    {filtered
                      ? 'No matching action items'
                      : 'Nothing to follow up'}
                  </h2>
                  <p>
                    {filtered
                      ? 'Try a different search or filter.'
                      : 'Give a Dot meeting notes or a document and it will file the action items it finds.'}
                  </p>
                </div>
              )
            ) : (
              <p className="muted">Loading…</p>
            )}
          </div>
          {selected && (
            <ActionItemPanel
              key={selected}
              id={selected}
              workspace={workspace}
              onClose={() => setSelected(undefined)}
              onChanged={changed}
              onDeleted={() => {
                setSelected(undefined);
                changed();
              }}
              onEntity={addEntity}
              onLabel={(label) => set({ label })}
              onOpenDocument={onOpenDocument}
              onOpenPage={onOpenPage}
              onOpenThread={onOpenThread}
            />
          )}
        </div>
      </section>
    </main>
  );
}

export function ActionItemList({
  items,
  now,
  grouped,
  selectedId,
  onSelect,
  onEntity,
  onLabel,
}: {
  items: ActionItem[];
  now: number;
  grouped: boolean;
  selectedId?: string;
  onSelect: (id: string) => void;
  onEntity: (name: string) => void;
  onLabel: (label: string) => void;
}) {
  const row = (item: ActionItem) => (
    <ActionItemRow
      key={item.id}
      item={item}
      now={now}
      selected={item.id === selectedId}
      onSelect={() => onSelect(item.id)}
      onEntity={onEntity}
      onLabel={onLabel}
    />
  );
  if (!grouped)
    return (
      <section className="action-item-group">
        <div className="library-section-label">
          <h2>Best matches</h2>
          <span>{items.length}</span>
        </div>
        <ul>{items.map(row)}</ul>
      </section>
    );
  return (
    <>
      {groupActionItems(items, now).map((group) => (
        <section
          className={`action-item-group ${group.key}`}
          key={group.key}
          aria-label={group.label}
        >
          <div className="library-section-label">
            <h2>{group.label}</h2>
            <span>{group.items.length}</span>
          </div>
          <ul>{group.items.map(row)}</ul>
        </section>
      ))}
    </>
  );
}

function ActionItemRow({
  item,
  now,
  selected,
  onSelect,
  onEntity,
  onLabel,
}: {
  item: ActionItem;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onEntity: (name: string) => void;
  onLabel: (label: string) => void;
}) {
  const between = ownershipOf(item) === 'others';
  const closed = item.status === 'done' || item.status === 'dropped';
  const tags = item.entities.filter(
    (entity) =>
      entity.role !== 'assignee' && !(between && entity.role === 'requester'),
  );
  return (
    <li
      className={`action-item-row ${selected ? 'selected' : ''} ${closed ? 'closed' : ''}`}
    >
      <button
        className="action-item-open"
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
      >
        <strong>{item.statement}</strong>
        <span className="action-item-meta">
          <span>{assigneeText(item)}</span>
          {closed ? (
            <span>{STATUS_LABELS[item.status]}</span>
          ) : (
            item.dueAt != null && (
              <span className={`action-item-due ${dueTone(item.dueAt, now)}`}>
                {dueText(item.dueAt, now)}
              </span>
            )
          )}
          {(item.priority === 'high' || item.priority === 'urgent') && (
            <span className={`action-item-priority ${item.priority}`}>
              {item.priority === 'urgent' ? 'Urgent' : 'High'}
            </span>
          )}
          {item.source.title && (
            <span className="action-item-source-title">
              {item.source.title}
            </span>
          )}
        </span>
      </button>
      {(tags.length > 0 || item.labels.length > 0) && (
        <div className="document-tags action-item-tags">
          {tags.map((entity) => (
            <button
              key={`${entity.id}-${entity.role}`}
              className="document-tag action-item-chip"
              title={`Show items about ${entity.name}`}
              onClick={() => onEntity(entity.name)}
            >
              {entity.name}
            </button>
          ))}
          {item.labels.map((label) => (
            <button
              key={`label-${label}`}
              className="document-tag action-item-chip label"
              title={`Show items labelled ${label}`}
              onClick={() => onLabel(label)}
            >
              #{label}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

const SOURCE_LABELS = {
  document: 'Document',
  page: 'Page',
  conversation: 'Conversation',
  owner: 'Added by you',
} as const;

function ActionItemPanel({
  id,
  workspace,
  onClose,
  onChanged,
  onDeleted,
  onEntity,
  onLabel,
  onOpenDocument,
  onOpenPage,
  onOpenThread,
}: {
  id: string;
  workspace: WorkspaceState;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
  onEntity: (name: string) => void;
  onLabel: (label: string) => void;
  onOpenDocument: (id: string) => void;
  onOpenPage: (spaceId: string, pageId: string) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [item, setItem] = useState<Detail>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.matchMedia?.('(max-width: 1000px)').matches)
      panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  const load = useCallback(async () => {
    try {
      setItem(await api<Detail>(`/action-items/${id}`));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the item.');
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const change = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
      onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the change.');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const patch = (body: Record<string, unknown>) =>
    change(() =>
      api(`/action-items/${id}`, 'PATCH', {
        ...body,
        timezone: browserTimeZone(),
      }),
    );
  const actorName = (actor: string) =>
    actor === 'owner'
      ? 'You'
      : (workspace.dots.find((dot) => dot.id === actor)?.name ?? 'A Dot');
  const when = (ms: number) =>
    new Date(ms).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  const closed = item?.status === 'done' || item?.status === 'dropped';
  const source = item?.source;
  return (
    <aside
      ref={panel}
      className="document-panel action-item-panel"
      aria-label="Action item"
    >
      <div className="action-item-panel-heading">
        {item && (
          <span
            className={`status ${closed ? 'completed' : item.status === 'waiting' ? 'paused' : 'running'}`}
          >
            <span />
            {STATUS_LABELS[item.status]}
          </span>
        )}
        <button
          className="icon-button"
          aria-label="Close action item"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      {!item ? (
        !error && <p className="muted">Loading…</p>
      ) : (
        <>
          <h2 className="action-item-statement">{item.statement}</h2>
          <p className="action-item-context">{item.context}</p>
          {item.details && (
            <p className="action-item-details">{item.details}</p>
          )}
          <div className="action-item-actions">
            {closed ? (
              <button
                disabled={busy}
                onClick={() => void patch({ status: 'open' })}
              >
                Reopen
              </button>
            ) : (
              <>
                <button
                  className="document-primary"
                  disabled={busy}
                  onClick={() => void patch({ status: 'done' })}
                >
                  Mark done
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void patch({
                      status: item.status === 'waiting' ? 'open' : 'waiting',
                    })
                  }
                >
                  {item.status === 'waiting' ? 'Back to open' : 'Waiting'}
                </button>
                <button
                  disabled={busy}
                  onClick={() => void patch({ status: 'dropped' })}
                >
                  Drop
                </button>
              </>
            )}
          </div>
          <div className="action-item-fields">
            <label>
              Priority
              <select
                value={item.priority}
                disabled={busy}
                onChange={(event) =>
                  void patch({ priority: event.target.value })
                }
              >
                {ACTION_ITEM_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority[0].toUpperCase() + priority.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Due
              <input
                type="date"
                value={dateInputValue(item.dueAt)}
                disabled={busy}
                onChange={(event) =>
                  void patch({ due: event.target.value || null })
                }
              />
            </label>
            <label>
              Remind
              <input
                type="date"
                value={dateInputValue(item.remindAt)}
                disabled={busy}
                onChange={(event) =>
                  void patch({ remindAt: event.target.value || null })
                }
              />
            </label>
          </div>
          {item.entities.length > 0 && (
            <>
              <h3>People and topics</h3>
              <ul className="action-item-entities">
                {item.entities.map((entity) => (
                  <li key={`${entity.id}-${entity.role}`}>
                    <button
                      className="document-tag action-item-chip"
                      title={`Show items about ${entity.name}`}
                      onClick={() => onEntity(entity.name)}
                    >
                      {entity.name}
                    </button>
                    <small>
                      {entity.kind} · {ROLE_LABELS[entity.role]}
                    </small>
                  </li>
                ))}
              </ul>
            </>
          )}
          {item.labels.length > 0 && (
            <div className="document-tags action-item-tags">
              {item.labels.map((label) => (
                <button
                  key={label}
                  className="document-tag action-item-chip label"
                  onClick={() => onLabel(label)}
                >
                  #{label}
                </button>
              ))}
            </div>
          )}
          {source && (
            <>
              <h3>Source</h3>
              <div className="action-item-source">
                <div>
                  <strong>
                    {SOURCE_LABELS[source.kind]}
                    {source.title ? `: ${source.title}` : ''}
                  </strong>
                  {source.date && <small>{source.date}</small>}
                </div>
                {source.excerpt && <blockquote>{source.excerpt}</blockquote>}
                <div className="action-item-source-links">
                  {source.kind === 'document' && source.id && (
                    <button
                      className="action-item-link"
                      onClick={() => onOpenDocument(source.id!)}
                    >
                      Open document <ArrowUpRight size={12} />
                    </button>
                  )}
                  {source.kind === 'page' && source.id && source.ref && (
                    <button
                      className="action-item-link"
                      onClick={() => onOpenPage(source.ref!, source.id!)}
                    >
                      Open page <ArrowUpRight size={12} />
                    </button>
                  )}
                  {source.threadId && (
                    <button
                      className="action-item-link"
                      onClick={() => onOpenThread(source.threadId!)}
                    >
                      Open conversation <ArrowUpRight size={12} />
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
          <p className="action-item-created muted">
            Filed by {actorName(item.createdBy)} on {when(item.createdAt)}
          </p>
          <h3>Notes and history</h3>
          <form
            className="action-item-note-form"
            onSubmit={(event) => {
              event.preventDefault();
              const text = note.trim();
              if (!text) return;
              void change(() =>
                api(`/action-items/${id}/notes`, 'POST', { note: text }),
              ).then((saved) => saved && setNote(''));
            }}
          >
            <textarea
              aria-label="Add a note"
              placeholder="Add a note, e.g. Sent the draft; waiting on legal"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <button type="submit" disabled={busy || !note.trim()}>
              Add note
            </button>
          </form>
          <ol className="action-item-history">
            {[...item.events].reverse().map((event) => (
              <li key={event.id} className={event.kind}>
                <p>{event.text}</p>
                <small>
                  {actorName(event.actor)} · {when(event.createdAt)}
                </small>
              </li>
            ))}
          </ol>
          <button
            className="action-item-delete"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Delete this action item and its history?'))
                return;
              void change(() => api(`/action-items/${id}`, 'DELETE')).then(
                (deleted) => deleted && onDeleted(),
              );
            }}
          >
            <Trash2 size={14} /> Delete
          </button>
        </>
      )}
    </aside>
  );
}
