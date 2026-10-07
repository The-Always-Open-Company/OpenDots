import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpRight,
  FileText,
  LayoutGrid,
  List,
  Search,
  Upload,
} from 'lucide-react';
import type {
  DocumentStatus,
  DocumentSummary,
  WorkspaceState,
} from '../shared/types';
import { api } from './api';
import { DocumentUploadDialog, formatSize } from './DocumentUploadDialog';

const STATUS: Record<DocumentStatus, [string, string]> = {
  queued: ['running', 'Queued'],
  processing: ['running', 'Processing'],
  ready: ['completed', 'Ready'],
  failed: ['failed', 'Failed'],
};

export function DocumentStatusBadge({
  document,
}: {
  document: Pick<DocumentSummary, 'status' | 'indexedVersion' | 'version'>;
}) {
  const [className, label] = STATUS[document.status];
  const updating =
    document.status !== 'ready' && document.indexedVersion !== null;
  return (
    <span className={`status ${className}`}>
      <span />
      {updating && document.status !== 'failed'
        ? `Updating to v${document.version}`
        : label}
    </span>
  );
}

/** Polls the document list, faster while anything is still converting. */
export function useDocuments(query: string) {
  const [documents, setDocuments] = useState<DocumentSummary[]>();
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setDocuments(await api<DocumentSummary[]>(`/documents${query}`));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load documents.');
    }
  }, [query]);
  const pending = documents?.some((document) =>
    ['queued', 'processing'].includes(document.status),
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), pending ? 3000 : 10000);
    return () => clearInterval(timer);
  }, [load, pending]);
  return { documents, error, reload: load };
}

export function DocumentLibrary({
  workspace,
  onOpen,
}: {
  workspace: WorkspaceState;
  onOpen: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [dotId, setDotId] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [uploading, setUploading] = useState<File[]>();
  const [dragging, setDragging] = useState(false);
  const params = new URLSearchParams(
    Object.entries({ q: q.trim(), dotId, spaceId, source, status }).filter(
      ([, value]) => value,
    ),
  ).toString();
  const { documents, error, reload } = useDocuments(params ? `?${params}` : '');
  const available = workspace.setup.documents;
  return (
    <main
      className="spaces-surface library"
      aria-label="Documents"
      onDragOver={(event) => {
        if (!available || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        if (!available) return;
        event.preventDefault();
        setDragging(false);
        const files = [...event.dataTransfer.files];
        if (files.length) setUploading(files);
      }}
    >
      <section className="space-library">
        <header className="library-heading">
          <div>
            <span className="library-eyebrow">LIBRARY</span>
            <h1>Documents</h1>
            <p>
              Files your Dots can search and cite. Share each one with every
              Dot, specific Dots, or the Dots in linked Spaces.
            </p>
          </div>
          <button
            className="document-primary"
            disabled={!available}
            onClick={() => setUploading([])}
          >
            <Upload size={16} /> Upload
          </button>
        </header>
        {!available && (
          <p className="document-setup-note">
            Uploads need Postgres and docling-serve. Set DATABASE_URL and
            DOCLING_URL on the server (see the setup guide), then restart.
          </p>
        )}
        <div className="library-tools">
          <label className="library-search">
            <Search size={17} />
            <input
              aria-label="Search documents"
              placeholder="Search by title or file name"
              value={q}
              onChange={(event) => setQ(event.target.value)}
            />
          </label>
          <div
            className="library-view-toggle"
            role="group"
            aria-label="Library view"
          >
            <button
              aria-label="Grid view"
              aria-pressed={layout === 'grid'}
              onClick={() => setLayout('grid')}
            >
              <LayoutGrid size={17} />
            </button>
            <button
              aria-label="List view"
              aria-pressed={layout === 'list'}
              onClick={() => setLayout('list')}
            >
              <List size={18} />
            </button>
          </div>
        </div>
        <div className="document-filters">
          <select
            aria-label="Filter by Dot"
            value={dotId}
            onChange={(event) => setDotId(event.target.value)}
          >
            <option value="">Any Dot</option>
            {workspace.dots.map((dot) => (
              <option key={dot.id} value={dot.id}>
                Readable by {dot.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by Space"
            value={spaceId}
            onChange={(event) => setSpaceId(event.target.value)}
          >
            <option value="">Any Space</option>
            {workspace.spaces.map((space) => (
              <option key={space.id} value={space.id}>
                In {space.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="">Any source</option>
            <option value="upload">Uploaded here</option>
            <option value="chat">Attached in chat</option>
          </select>
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">Any status</option>
            <option value="ready">Ready</option>
            <option value="processing">Processing</option>
            <option value="queued">Queued</option>
            <option value="failed">Failed</option>
          </select>
        </div>
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <div className="library-section-label">
          <h2>{params ? 'Matching documents' : 'All documents'}</h2>
          {documents && (
            <span>
              {documents.length}{' '}
              {documents.length === 1 ? 'document' : 'documents'}
            </span>
          )}
        </div>
        {documents?.length ? (
          <div className={`library-pages ${layout}`}>
            {documents.map((document) => (
              <DocumentCard
                key={document.id}
                document={document}
                workspace={workspace}
                onOpen={() => onOpen(document.id)}
              />
            ))}
          </div>
        ) : documents ? (
          <div className={`library-empty ${dragging ? 'dragging' : ''}`}>
            <FileText size={30} strokeWidth={1.3} />
            <h2>{params ? 'No matching documents' : 'No documents yet'}</h2>
            <p>
              {params
                ? 'Try a different search or filter.'
                : available
                  ? 'Drop files here or upload PDFs, Office files, Markdown, text, CSV or images.'
                  : 'Finish setup to start uploading.'}
            </p>
          </div>
        ) : (
          <p className="muted">Loading…</p>
        )}
        {dragging && (
          <div className="document-drop-overlay" aria-hidden>
            Drop to upload
          </div>
        )}
      </section>
      {uploading && (
        <DocumentUploadDialog
          workspace={workspace}
          initialFiles={uploading}
          onClose={() => setUploading(undefined)}
          onUploaded={() => void reload()}
        />
      )}
    </main>
  );
}

export function DocumentCard({
  document,
  workspace,
  onOpen,
}: {
  document: DocumentSummary;
  workspace: WorkspaceState;
  onOpen: () => void;
}) {
  const spaces = workspace.spaces.filter((space) =>
    document.spaceIds.includes(space.id),
  );
  const access = document.allDots
    ? 'All Dots'
    : document.dotIds.length
      ? workspace.dots
          .filter((dot) => document.dotIds.includes(dot.id))
          .map((dot) => dot.name)
          .join(', ')
      : spaces.length
        ? 'Space members'
        : 'No Dots';
  return (
    <button className="library-page-card" onClick={onOpen}>
      <span className="library-page-icon">
        <FileText size={20} strokeWidth={1.5} />
      </span>
      <div className="library-card-body">
        <h3>{document.title}</h3>
        <p>
          {document.fileName} · {formatSize(document.size)}
          {document.pageCount ? ` · ${document.pageCount} pages` : ''}
        </p>
        <div className="library-page-meta">
          <DocumentStatusBadge document={document} />
          <span title="Who can read it">{access}</span>
          {spaces.length > 0 && (
            <span className="document-card-spaces">
              {spaces.map((space) => space.name).join(', ')}
            </span>
          )}
        </div>
      </div>
      <ArrowUpRight className="library-card-arrow" size={15} />
    </button>
  );
}
