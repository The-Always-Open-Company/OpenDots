import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Download,
  FilePlus2,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  DocumentAccessReason,
  DocumentDetail as Detail,
  WorkspaceState,
} from '../shared/types';
import { api, ApiError, download, upload } from './api';
import { DocumentStatusBadge } from './DocumentLibrary';
import {
  AccessFields,
  DOCUMENT_ACCEPT,
  formatSize,
  type AccessMode,
} from './DocumentUploadDialog';

const PREVIEW_CHARS = 20_000;
const REASONS: Record<DocumentAccessReason, string> = {
  all: 'shared with all Dots',
  granted: 'granted directly',
  space: 'through a Space',
};

export function DocumentDetail({
  id,
  workspace,
  onBack,
  onPage,
  onThread,
}: {
  id: string;
  workspace: WorkspaceState;
  onBack: () => void;
  onPage: (spaceId: string, pageId: string) => void;
  onThread: (threadId: string) => void;
}) {
  const [document, setDocument] = useState<Detail>();
  const [missing, setMissing] = useState(false);
  const [text, setText] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<AccessMode>('none');
  const [dotIds, setDotIds] = useState<string[]>([]);
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [pageSpace, setPageSpace] = useState(workspace.spaces[0]?.id ?? '');
  const versionInput = useRef<HTMLInputElement>(null);
  const reset = (next: Detail) => {
    setTitle(next.title);
    setMode(next.allDots ? 'all' : next.dotIds.length ? 'dots' : 'none');
    setDotIds(next.dotIds);
    setSpaceIds(next.spaceIds);
  };
  const load = useCallback(async () => {
    try {
      const next = await api<Detail>(`/documents/${id}`);
      setDocument(next);
      setError('');
      return next;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else
        setError(e instanceof Error ? e.message : 'Could not load document.');
    }
  }, [id]);
  useEffect(() => {
    void load().then((next) => next && reset(next));
  }, [load]);
  const pending =
    document?.status === 'queued' || document?.status === 'processing';
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [pending, load]);
  useEffect(() => {
    if (document?.indexedVersion == null || !workspace.setup.documents) {
      setText(undefined);
      return;
    }
    let active = true;
    void api<{ text: string }>(`/documents/${id}/text`)
      .then((result) => active && setText(result.text))
      .catch(() => active && setText(''));
    return () => {
      active = false;
    };
  }, [id, document?.indexedVersion, workspace.setup.documents]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not complete that.');
    } finally {
      setBusy(false);
    }
  };
  if (missing)
    return (
      <main className="spaces-surface library">
        <div className="library-empty">
          <h2>Document not found</h2>
          <button className="document-primary" onClick={onBack}>
            Back to documents
          </button>
        </div>
      </main>
    );
  if (!document)
    return (
      <main className="spaces-surface library">
        <div className="library-empty">
          <h2>{error || 'Loading document…'}</h2>
        </div>
      </main>
    );
  const dotName = (dotId: string) =>
    workspace.dots.find((dot) => dot.id === dotId)?.name ?? 'Removed Dot';
  const spaceName = (spaceId: string) =>
    workspace.spaces.find((space) => space.id === spaceId)?.name ?? 'Space';
  const sourceThread = workspace.conversations.find(
    (thread) => thread.id === document.sourceThreadId,
  );
  return (
    <main className="spaces-surface library" aria-label={document.title}>
      <section className="space-library document-detail">
        <button className="text-button document-back" onClick={onBack}>
          <ArrowLeft size={13} /> All documents
        </button>
        <header className="library-heading">
          <div>
            <span className="library-eyebrow">DOCUMENT</span>
            <h1>{document.title}</h1>
            <p>
              {document.fileName} · {formatSize(document.size)}
              {document.pageCount ? ` · ${document.pageCount} pages` : ''}
              {document.chunkCount ? ` · ${document.chunkCount} passages` : ''}
              {` · version ${document.version}`}
            </p>
          </div>
          <DocumentStatusBadge document={document} />
        </header>
        {document.error && (
          <p className="chat-error" role="alert">
            {document.error}
          </p>
        )}
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        {document.sourceThreadId && (
          <p className="muted">
            Attached in chat with {dotName(document.sourceDotId ?? '')}
            {sourceThread && (
              <>
                {' · '}
                <button
                  className="text-button"
                  onClick={() => onThread(sourceThread.id)}
                >
                  Open conversation
                </button>
              </>
            )}
          </p>
        )}
        <div className="document-actions">
          <button
            disabled={busy || !workspace.setup.documents}
            onClick={() =>
              void act(() =>
                download(`/documents/${id}/file`, document.fileName),
              )
            }
          >
            <Download size={15} /> Download
          </button>
          <button
            disabled={busy || !workspace.setup.documents}
            onClick={() => versionInput.current?.click()}
          >
            <Upload size={15} /> New version
          </button>
          <input
            ref={versionInput}
            type="file"
            hidden
            accept={DOCUMENT_ACCEPT}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file)
                void act(() => upload(`/documents/${id}/versions`, file));
            }}
          />
          <button
            disabled={busy || pending || !workspace.setup.documents}
            onClick={() =>
              void act(() => api(`/documents/${id}/reprocess`, 'POST', {}))
            }
          >
            <RefreshCw size={15} /> Reprocess
          </button>
          <span className="document-convert">
            <select
              aria-label="Space for the new page"
              value={pageSpace}
              onChange={(event) => setPageSpace(event.target.value)}
            >
              {workspace.spaces.map((space) => (
                <option key={space.id} value={space.id}>
                  {space.name}
                </option>
              ))}
            </select>
            <button
              disabled={busy || !text || !pageSpace}
              onClick={() =>
                void act(async () => {
                  const page = await api<{ id: string }>(
                    `/documents/${id}/convert-to-page`,
                    'POST',
                    { spaceId: pageSpace },
                  );
                  onPage(pageSpace, page.id);
                })
              }
            >
              <FilePlus2 size={15} /> Copy to page
            </button>
          </span>
          <button
            className="danger"
            disabled={busy || !workspace.setup.documents}
            onClick={() => {
              if (
                window.confirm(
                  `Delete “${document.title}”? Dots will lose access and its search index is removed.`,
                )
              )
                void act(async () => {
                  await api(`/documents/${id}`, 'DELETE', {});
                  onBack();
                });
            }}
          >
            <Trash2 size={15} /> Delete
          </button>
        </div>
        <div className="document-columns">
          <section className="document-panel" aria-labelledby="access-heading">
            <div className="document-panel-heading">
              <h2 id="access-heading">Access</h2>
              {!editing && (
                <button
                  className="text-button"
                  onClick={() => setEditing(true)}
                >
                  Change
                </button>
              )}
            </div>
            {editing ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    const next = await api<Detail>(
                      `/documents/${id}`,
                      'PATCH',
                      {
                        title: title.trim() || document.title,
                        allDots: mode === 'all',
                        dotIds: mode === 'dots' ? dotIds : [],
                        spaceIds,
                      },
                    );
                    reset(next);
                    setEditing(false);
                  });
                }}
              >
                <label className="field-label" htmlFor="document-title">
                  Title
                </label>
                <input
                  id="document-title"
                  value={title}
                  maxLength={200}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <AccessFields
                  workspace={workspace}
                  mode={mode}
                  dotIds={dotIds}
                  spaceIds={spaceIds}
                  onMode={setMode}
                  onDotIds={setDotIds}
                  onSpaceIds={setSpaceIds}
                />
                <div className="document-form-actions">
                  <button
                    type="button"
                    onClick={() => {
                      reset(document);
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="primary"
                    disabled={busy || (mode === 'dots' && !dotIds.length)}
                  >
                    Save access
                  </button>
                </div>
              </form>
            ) : (
              <>
                <p className="muted">
                  {document.allDots
                    ? 'Shared with all Dots, including new ones.'
                    : document.dotIds.length
                      ? `Granted to ${document.dotIds.map(dotName).join(', ')}.`
                      : 'Not granted to any Dot directly.'}
                  {document.spaceIds.length
                    ? ` Linked to ${document.spaceIds.map(spaceName).join(', ')}.`
                    : ''}
                </p>
                <h3>Who can read it</h3>
                {document.readers.length ? (
                  <ul className="document-readers">
                    {document.readers.map((reader) => (
                      <li key={reader.dotId}>
                        <strong>{dotName(reader.dotId)}</strong>
                        <small>
                          {reader.reasons
                            .map((reason) =>
                              reason === 'space'
                                ? `through ${reader.viaSpaceIds.map(spaceName).join(', ')}`
                                : REASONS[reason],
                            )
                            .join('; ')}
                        </small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No Dot can read this document yet.</p>
                )}
                {document.indexedVersion === null && (
                  <p className="muted">
                    Dots can search it once processing finishes.
                  </p>
                )}
              </>
            )}
          </section>
          <section
            className="document-panel document-preview"
            aria-labelledby="preview-heading"
          >
            <h2 id="preview-heading">Converted text</h2>
            {text === undefined ? (
              <p className="muted">
                {pending
                  ? 'Converting… this can take a few minutes for large files.'
                  : 'No converted text yet.'}
              </p>
            ) : text ? (
              <>
                <pre>{text.slice(0, PREVIEW_CHARS)}</pre>
                {text.length > PREVIEW_CHARS && (
                  <p className="muted">
                    Preview shows the first {PREVIEW_CHARS.toLocaleString()}{' '}
                    characters. Dots can read the rest.
                  </p>
                )}
              </>
            ) : (
              <p className="muted">No text was extracted.</p>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
