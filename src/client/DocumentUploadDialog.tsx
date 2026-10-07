import { useEffect, useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import type { DocumentDetail, WorkspaceState } from '../shared/types';
import { upload } from './api';

export const DOCUMENT_ACCEPT =
  '.pdf,.docx,.pptx,.xlsx,.html,.htm,.md,.txt,.csv,.png,.jpg,.jpeg';

export type AccessMode = 'none' | 'dots' | 'all';

/** Who can read a document: nobody directly, chosen Dots, or every Dot. */
export function AccessFields({
  workspace,
  mode,
  dotIds,
  spaceIds,
  onMode,
  onDotIds,
  onSpaceIds,
}: {
  workspace: WorkspaceState;
  mode: AccessMode;
  dotIds: string[];
  spaceIds: string[];
  onMode: (mode: AccessMode) => void;
  onDotIds: (ids: string[]) => void;
  onSpaceIds: (ids: string[]) => void;
}) {
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((item) => item !== id);
  return (
    <>
      <fieldset className="space-access-fields">
        <legend>Which Dots can read it?</legend>
        {(
          [
            ['none', 'No Dots', 'Only through linked Spaces, if any.'],
            ['dots', 'Specific Dots', 'Choose below.'],
            ['all', 'All Dots', 'Includes Dots you create later.'],
          ] as const
        ).map(([value, label, hint]) => (
          <label className="permission-row" key={value}>
            <input
              type="radio"
              name="document-access"
              checked={mode === value}
              onChange={() => onMode(value)}
            />
            <span>
              <strong>{label}</strong>
              <small>{hint}</small>
            </span>
          </label>
        ))}
        {mode === 'dots' &&
          workspace.dots.map((dot) => (
            <label className="permission-row nested" key={dot.id}>
              <input
                type="checkbox"
                checked={dotIds.includes(dot.id)}
                onChange={(event) =>
                  onDotIds(toggle(dotIds, dot.id, event.target.checked))
                }
              />
              <span>{dot.name}</span>
            </label>
          ))}
      </fieldset>
      <fieldset className="space-access-fields">
        <legend>Spaces</legend>
        <p className="muted">
          Dots that work in a linked Space can read it too.
        </p>
        {workspace.spaces.map((space) => (
          <label className="permission-row" key={space.id}>
            <input
              type="checkbox"
              checked={spaceIds.includes(space.id)}
              onChange={(event) =>
                onSpaceIds(toggle(spaceIds, space.id, event.target.checked))
              }
            />
            <span>{space.name}</span>
          </label>
        ))}
      </fieldset>
    </>
  );
}

export function DocumentUploadDialog({
  workspace,
  initialFiles = [],
  spaceId,
  onClose,
  onUploaded,
}: {
  workspace: WorkspaceState;
  initialFiles?: File[];
  spaceId?: string;
  onClose: () => void;
  onUploaded: (documents: DocumentDetail[]) => void;
}) {
  const [files, setFiles] = useState<File[]>(initialFiles);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<AccessMode>(spaceId ? 'none' : 'all');
  const [dotIds, setDotIds] = useState<string[]>([]);
  const [spaceIds, setSpaceIds] = useState<string[]>(spaceId ? [spaceId] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    container.current?.querySelector<HTMLElement>('input,button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  const submit = async () => {
    setBusy(true);
    setError('');
    const done: DocumentDetail[] = [];
    try {
      for (const file of files)
        done.push(
          await upload<DocumentDetail>('/documents', file, {
            access: mode,
            dotIds: mode === 'dots' ? dotIds : undefined,
            spaceIds,
            title: files.length === 1 ? title.trim() || undefined : undefined,
          }),
        );
      onUploaded(done);
      onClose();
    } catch (e) {
      const failed = files[done.length]?.name ?? 'file';
      setError(
        `${failed}: ${e instanceof Error ? e.message : 'Upload failed.'}`,
      );
      if (done.length) {
        setFiles(files.slice(done.length));
        onUploaded(done);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-title"
        ref={container}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">DOCUMENTS</span>
        <h2 id="upload-title">Add to the library.</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="field-label" htmlFor="upload-files">
            Files
          </label>
          <input
            id="upload-files"
            type="file"
            multiple
            accept={DOCUMENT_ACCEPT}
            onChange={(event) => setFiles([...(event.target.files ?? [])])}
          />
          {!!files.length && (
            <ul className="upload-file-list">
              {files.map((file) => (
                <li key={`${file.name}-${file.size}`}>
                  {file.name}
                  <small>{formatSize(file.size)}</small>
                </li>
              ))}
            </ul>
          )}
          {files.length === 1 && (
            <>
              <label className="field-label" htmlFor="upload-title-field">
                Title (optional)
              </label>
              <input
                id="upload-title-field"
                value={title}
                maxLength={200}
                placeholder={files[0].name.replace(/\.[^.]+$/, '')}
                onChange={(event) => setTitle(event.target.value)}
              />
            </>
          )}
          <AccessFields
            workspace={workspace}
            mode={mode}
            dotIds={dotIds}
            spaceIds={spaceIds}
            onMode={setMode}
            onDotIds={setDotIds}
            onSpaceIds={setSpaceIds}
          />
          {error && (
            <p className="chat-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="primary full"
            disabled={
              busy || !files.length || (mode === 'dots' && !dotIds.length)
            }
          >
            <Upload size={15} />
            {busy
              ? 'Uploading…'
              : `Upload ${files.length > 1 ? `${files.length} files` : 'file'}`}
          </button>
        </form>
      </section>
    </div>
  );
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
