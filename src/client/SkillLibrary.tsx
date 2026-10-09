import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Plus, Trash2, Upload, WandSparkles } from 'lucide-react';
import type { Dot, Skill } from '../shared/types';
import { api, ApiError } from './api';
import { Mascot } from './Mascot';

const TEMPLATE = `---
name: weekly-brief
description: Use when I ask for a weekly status brief.
---
Start with a three-line summary.
Then list wins, risks, and next steps as short bullets.
`;

export function skillNameOf(markdown: string) {
  return /^name:\s*(.+)$/m.exec(markdown)?.[1]?.trim();
}

export function SkillLibrary({ dots }: { dots: Dot[] }) {
  const [skills, setSkills] = useState<Skill[]>();
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ name?: string; markdown: string }>();
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try {
      setSkills(await api<Skill[]>('/skills'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load skills.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the skill.');
      return false;
    }
  };
  /** Creates a skill, or replaces one with the same name after confirming. */
  const create = async (markdown: string) => {
    try {
      await api('/skills', 'POST', { markdown });
    } catch (e) {
      const name = skillNameOf(markdown);
      if (
        !(e instanceof ApiError && e.status === 409 && name) ||
        !window.confirm(`Replace the existing ${name} skill?`)
      )
        throw e;
      await api(`/skills/${name}`, 'PUT', { markdown });
    }
  };
  const save = async () => {
    if (!editing) return;
    setSaving(true);
    const saved = await run(() =>
      editing.name
        ? api(`/skills/${editing.name}`, 'PUT', { markdown: editing.markdown })
        : create(editing.markdown),
    );
    setSaving(false);
    if (saved) setEditing(undefined);
  };
  const uploadFiles = async (files: File[]) => {
    for (const file of files)
      await run(async () => {
        if (file.size > 20_000)
          throw new Error(`${file.name} is larger than 20,000 bytes.`);
        await create(await file.text());
      });
  };
  const toggle = (skill: Skill, dot: Dot, enabled: boolean) =>
    void run(() =>
      enabled
        ? api(`/dots/${dot.id}/skills`, 'POST', { name: skill.name })
        : api(`/dots/${dot.id}/skills/${skill.name}`, 'DELETE', {}),
    );
  return (
    <main className="main-content">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h1>Skills</h1>
          <p>
            Instructions a Dot loads when a request fits, or when you mention it
            as @name. Choose which Dots may use each one. Scripts in a skill are
            never run.
          </p>
        </div>
        <div className="skill-heading-actions">
          <input
            ref={fileInput}
            type="file"
            accept=".md,text/markdown"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              void uploadFiles(files);
            }}
          />
          <button onClick={() => fileInput.current?.click()}>
            <Upload size={15} />
            Upload SKILL.md
          </button>
          <button
            className="primary"
            onClick={() => setEditing({ markdown: TEMPLATE })}
          >
            <Plus size={15} />
            New skill
          </button>
        </div>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <section className="skill-editor" aria-label="Skill editor">
          <h2>{editing.name ? `Edit ${editing.name}` : 'New skill'}</h2>
          <p className="muted">
            Start with frontmatter: a lowercase <code>name</code> using letters,
            numbers, and hyphens, and a one-line <code>description</code> of
            when to use it. The body after the second <code>---</code> is what
            the Dot reads.
          </p>
          <textarea
            aria-label="SKILL.md"
            value={editing.markdown}
            rows={16}
            maxLength={20_000}
            spellCheck={false}
            onChange={(event) =>
              setEditing({ ...editing, markdown: event.target.value })
            }
          />
          <div className="skill-editor-actions">
            <button onClick={() => setEditing(undefined)}>Cancel</button>
            <button
              className="primary"
              disabled={saving || !editing.markdown.trim()}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save skill'}
            </button>
          </div>
        </section>
      )}
      {!skills ? (
        !error && <p className="muted">Loading…</p>
      ) : !skills.length ? (
        <div className="large-empty">
          <WandSparkles size={32} />
          <h2>Teach your Dots a way of working.</h2>
          <p>
            Upload a SKILL.md or write a new skill, then turn it on for the Dots
            that should use it.
          </p>
        </div>
      ) : (
        <div className="skill-list">
          {skills.map((skill) => (
            <article className="skill-card" key={skill.name}>
              <div className="skill-card-heading">
                <div>
                  <h2>@{skill.name}</h2>
                  <p>{skill.description}</p>
                </div>
                <div className="skill-card-actions">
                  <button
                    className="icon-button"
                    aria-label={`Edit ${skill.name}`}
                    onClick={() =>
                      void api<Skill & { markdown: string }>(
                        `/skills/${skill.name}`,
                      )
                        .then((full) =>
                          setEditing({
                            name: skill.name,
                            markdown: full.markdown,
                          }),
                        )
                        .catch((e) => setError(e.message))
                    }
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Delete ${skill.name}`}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete the ${skill.name} skill? Dots that use it lose it.`,
                        )
                      )
                        void run(() =>
                          api(`/skills/${skill.name}`, 'DELETE', {}),
                        );
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              {skill.scripts.length > 0 && (
                <p className="muted skill-scripts">
                  Lists {skill.scripts.length} script
                  {skill.scripts.length === 1 ? '' : 's'}; they are never run.
                </p>
              )}
              <fieldset className="skill-dots">
                <legend>Dots that can use it</legend>
                {dots.map((dot) => {
                  const enabled = skill.dotIds.includes(dot.id);
                  return (
                    <label
                      key={dot.id}
                      className={`skill-dot ${enabled ? 'on' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(event) =>
                          toggle(skill, dot, event.target.checked)
                        }
                      />
                      <Mascot
                        identity={dot.id}
                        character={dot.mascot}
                        name={dot.name}
                        small
                        decorative
                      />
                      <span>{dot.name}</span>
                    </label>
                  );
                })}
              </fieldset>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
