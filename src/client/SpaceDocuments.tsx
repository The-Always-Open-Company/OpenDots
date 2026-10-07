import { useState } from 'react';
import { Link2, Unlink, Upload } from 'lucide-react';
import type { DocumentSummary, Space, WorkspaceState } from '../shared/types';
import { api } from './api';
import { DocumentCard, useDocuments } from './DocumentLibrary';
import { DocumentUploadDialog } from './DocumentUploadDialog';

export function SpaceDocuments({
  space,
  workspace,
  onOpen,
}: {
  space: Space;
  workspace: WorkspaceState;
  onOpen: (id: string) => void;
}) {
  const { documents, error, reload } = useDocuments(
    `?spaceId=${encodeURIComponent(space.id)}`,
  );
  const [uploading, setUploading] = useState(false);
  const [linking, setLinking] = useState<DocumentSummary[]>();
  const [choice, setChoice] = useState('');
  const [actionError, setActionError] = useState('');
  const setLinks = async (document: DocumentSummary, linked: boolean) => {
    setActionError('');
    try {
      await api(`/documents/${document.id}`, 'PATCH', {
        spaceIds: linked
          ? [...document.spaceIds, space.id]
          : document.spaceIds.filter((id) => id !== space.id),
      });
      setLinking(undefined);
      setChoice('');
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not update.');
    }
  };
  const startLinking = async () => {
    try {
      const all = await api<DocumentSummary[]>('/documents');
      const options = all.filter(
        (document) => !document.spaceIds.includes(space.id),
      );
      setLinking(options);
      setChoice(options[0]?.id ?? '');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not load.');
    }
  };
  return (
    <section
      className="space-documents"
      aria-labelledby={`space-documents-${space.id}`}
    >
      <div className="library-section-label">
        <h2 id={`space-documents-${space.id}`}>Documents</h2>
        {documents && <span>{documents.length}</span>}
        <span className="space-documents-actions">
          <button className="text-button" onClick={() => void startLinking()}>
            <Link2 size={13} /> Link existing
          </button>
          <button
            className="text-button"
            disabled={!workspace.setup.documents}
            onClick={() => setUploading(true)}
          >
            <Upload size={13} /> Upload
          </button>
        </span>
      </div>
      <p className="muted">
        Every Dot working in {space.name} can search these.
      </p>
      {(error || actionError) && (
        <p className="chat-error" role="alert">
          {actionError || error}
        </p>
      )}
      {linking && (
        <form
          className="space-documents-link"
          onSubmit={(event) => {
            event.preventDefault();
            const document = linking.find((item) => item.id === choice);
            if (document) void setLinks(document, true);
          }}
        >
          {linking.length ? (
            <>
              <select
                aria-label="Document to link"
                value={choice}
                onChange={(event) => setChoice(event.target.value)}
              >
                {linking.map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.title}
                  </option>
                ))}
              </select>
              <button className="primary" disabled={!choice}>
                Link to {space.name}
              </button>
            </>
          ) : (
            <span className="muted">Every document is already linked.</span>
          )}
          <button type="button" onClick={() => setLinking(undefined)}>
            Cancel
          </button>
        </form>
      )}
      {documents?.length ? (
        <div className="library-pages list">
          {documents.map((document) => (
            <div className="space-document-row" key={document.id}>
              <DocumentCard
                document={document}
                workspace={workspace}
                onOpen={() => onOpen(document.id)}
              />
              <button
                className="icon-button"
                aria-label={`Unlink ${document.title} from ${space.name}`}
                title="Unlink from this Space"
                onClick={() => void setLinks(document, false)}
              >
                <Unlink size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {uploading && (
        <DocumentUploadDialog
          workspace={workspace}
          spaceId={space.id}
          onClose={() => setUploading(false)}
          onUploaded={() => void reload()}
        />
      )}
    </section>
  );
}
