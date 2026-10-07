import { useCallback, useEffect, useState } from 'react';
import { Check, Pencil, Sparkles, Trash2, X } from 'lucide-react';
import type { Dot } from '../shared/types';
import { api } from './api';

interface LearnedMemory {
  id: string;
  text: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export function LearnedMemories({
  dots,
  available,
  defaultDotId,
}: {
  dots: Dot[];
  available: boolean;
  defaultDotId: string;
}) {
  const [dotId, setDotId] = useState(defaultDotId);
  const [memories, setMemories] = useState<LearnedMemory[]>();
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState('');
  const dot = dots.find((item) => item.id === dotId) ?? dots[0];
  const load = useCallback(async () => {
    if (!available || !dot) return;
    try {
      setMemories(await api<LearnedMemory[]>(`/dots/${dot.id}/memories`));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load memories.');
    }
  }, [available, dot?.id]);
  useEffect(() => {
    setMemories(undefined);
    void load();
  }, [load]);
  const act = async (path: string, method: string, body: unknown) => {
    try {
      await api(path, method, body);
      setEditing(undefined);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  };
  return (
    <section className="memory-section" aria-labelledby="learned-heading">
      <div className="memory-section-heading">
        <div>
          <h2 id="learned-heading">Learned by each Dot</h2>
          <p className="muted">
            Facts a Dot picked up in its own conversations. Only that Dot uses
            them; other Dots can ask it with ask_dot.
          </p>
        </div>
        {dots.length > 1 && (
          <label className="memory-dot-picker">
            <span className="sr-only">Dot</span>
            <select
              aria-label="Show memories learned by"
              value={dot?.id}
              onChange={(event) => setDotId(event.target.value)}
            >
              {dots.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!available ? (
        <p className="muted">
          Learned memory needs Postgres. Set DATABASE_URL on the server (see the
          setup guide), then restart.
        </p>
      ) : error ? (
        <p className="chat-error" role="alert">
          {error}
        </p>
      ) : !memories ? (
        <p className="muted">Loading…</p>
      ) : !memories.length ? (
        <p className="muted">
          {dot?.memoryAllowed
            ? `${dot.name} hasn’t learned anything yet. It learns from what you tell it in chat.`
            : `${dot?.name} has memory turned off in its settings.`}
        </p>
      ) : (
        <div className="memory-grid">
          {memories.map((memory) => (
            <article className="memory-card" key={memory.id}>
              <Sparkles size={18} />
              {editing === memory.id ? (
                <textarea
                  aria-label="Edit learned memory"
                  value={draft}
                  maxLength={2000}
                  rows={3}
                  onChange={(event) => setDraft(event.target.value)}
                />
              ) : (
                <p>{memory.text}</p>
              )}
              <div>
                <small>
                  {memory.updatedAt || memory.createdAt
                    ? new Date(
                        memory.updatedAt ?? memory.createdAt ?? '',
                      ).toLocaleDateString()
                    : ''}
                </small>
                {editing === memory.id ? (
                  <>
                    <button
                      className="icon-button"
                      aria-label="Save memory"
                      disabled={!draft.trim()}
                      onClick={() =>
                        void act(
                          `/dots/${dot!.id}/memories/${memory.id}`,
                          'PUT',
                          { text: draft },
                        )
                      }
                    >
                      <Check size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Cancel editing"
                      onClick={() => setEditing(undefined)}
                    >
                      <X size={16} />
                    </button>
                  </>
                ) : (
                  <button
                    className="icon-button"
                    aria-label="Edit learned memory"
                    onClick={() => {
                      setEditing(memory.id);
                      setDraft(memory.text);
                    }}
                  >
                    <Pencil size={15} />
                  </button>
                )}
                <button
                  className="icon-button"
                  aria-label="Delete learned memory"
                  onClick={() =>
                    void act(
                      `/dots/${dot!.id}/memories/${memory.id}`,
                      'DELETE',
                      {},
                    )
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
