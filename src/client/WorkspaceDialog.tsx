import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Dot, Memory, State, WorkspaceState } from '../shared/types';
export type Dialog =
  | { type: 'space' }
  | { type: 'dot'; dot?: Dot; spaceId: string }
  | { type: 'settings' }
  | { type: 'memory'; memory?: Memory }
  | { type: 'schedule'; threadId: string };
export function WorkspaceDialog({
  dialog,
  state,
  workspace,
  onClose,
  mutate,
}: {
  dialog: Dialog;
  state: State;
  workspace: WorkspaceState;
  onClose: () => void;
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
  const [name, setName] = useState(
    dialog.type === 'dot' ? (dialog.dot?.name ?? '') : '',
  );
  const [text, setText] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.instructions ?? '')
      : dialog.type === 'memory'
        ? (dialog.memory?.text ?? '')
        : '',
  );
  const [research, setResearch] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.researchAllowed ?? true)
      : state.settings.researchAllowed,
  );
  const [memory, setMemory] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.memoryAllowed ?? true)
      : state.settings.memoryAllowed,
  );
  const [consultable, setConsultable] = useState(
    dialog.type === 'dot' ? (dialog.dot?.consultable ?? true) : true,
  );
  const [spaceIds, setSpaceIds] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceIds ?? [dialog.spaceId]) : [],
  );
  const [defaultSpace, setDefaultSpace] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceId ?? dialog.spaceId) : '',
  );
  const [interval, setInterval] = useState('86400');
  const [mascot, setMascot] = useState(
    dialog.type === 'dot' ? (dialog.dot?.mascot ?? '') : '',
  );
  const [useClock, setUseClock] = useState(false);
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [timeOfDay, setTimeOfDay] = useState('09:00');
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    container.current
      ?.querySelector<HTMLElement>('input,textarea,select')
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = [
          ...(container.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input,textarea,select,a[href]',
          ) ?? []),
        ];
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  const title =
    dialog.type === 'space'
      ? 'A space for something.'
      : dialog.type === 'dot'
        ? dialog.dot
          ? 'Make this Dot yours.'
          : 'Meet your next specialist.'
        : dialog.type === 'settings'
          ? 'Your workspace, your rules.'
          : dialog.type === 'memory'
            ? 'Something to remember.'
            : 'Let your Dot keep time.';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={container}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">OPENDOTS TEMPLATE</span>
        <h2 id="dialog-title">{title}</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            let path = '',
              method = 'POST',
              body: unknown;
            if (dialog.type === 'space') {
              path = '/spaces';
              body = { name, description: text };
            }
            if (dialog.type === 'dot') {
              path = dialog.dot ? `/dots/${dialog.dot.id}` : '/dots';
              method = dialog.dot ? 'PUT' : 'POST';
              body = {
                spaceId: defaultSpace,
                spaceIds,
                name,
                instructions: text,
                researchAllowed: research,
                memoryAllowed: memory,
                consultable,
                mascot: mascot || null,
              };
            }
            if (dialog.type === 'settings') {
              path = '/settings';
              method = 'PATCH';
              body = { researchAllowed: research, memoryAllowed: memory };
            }
            if (dialog.type === 'memory') {
              path = dialog.memory
                ? `/memories/${dialog.memory.id}`
                : '/memories';
              method = dialog.memory ? 'PUT' : 'POST';
              body = { text };
            }
            if (dialog.type === 'schedule') {
              path = '/tasks';
              const [hour, minute] = timeOfDay.split(':').map(Number);
              body = useClock
                ? {
                    prompt: text,
                    threadId: dialog.threadId,
                    schedule: {
                      kind: 'calendar',
                      timezone,
                      weekdays,
                      minuteOfDay: hour * 60 + minute,
                    },
                  }
                : {
                    prompt: text,
                    threadId: dialog.threadId,
                    intervalSeconds: Number(interval),
                  };
            }
            if (await mutate(path, method, body)) onClose();
            else
              setError('Could not save. Review the workspace error and retry.');
            setBusy(false);
          }}
        >
          {(dialog.type === 'space' || dialog.type === 'dot') && (
            <>
              <label className="field-label" htmlFor="entity-name">
                Name
              </label>
              <input
                id="entity-name"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                required
              />
              {dialog.type === 'dot' && (
                <>
                  <label className="field-label" htmlFor="dot-mascot">
                    Mascot
                  </label>
                  <select
                    id="dot-mascot"
                    value={mascot}
                    onChange={(event) => setMascot(event.target.value)}
                  >
                    <option value="">Color from this Dot’s id</option>
                    <option value="blue">Blue</option>
                    <option value="mint">Mint</option>
                    <option value="orange">Orange</option>
                    <option value="purple">Purple</option>
                  </select>
                </>
              )}
            </>
          )}
          {dialog.type !== 'settings' && (
            <>
              <label className="field-label" htmlFor="entity-text">
                {dialog.type === 'dot'
                  ? 'Role instructions'
                  : dialog.type === 'space'
                    ? 'What belongs here?'
                    : dialog.type === 'memory'
                      ? 'Preference or context'
                      : 'Task to revisit'}
              </label>
              <textarea
                id="entity-text"
                rows={4}
                maxLength={dialog.type === 'schedule' ? 4000 : 2000}
                required={dialog.type !== 'space'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  dialog.type === 'dot'
                    ? 'You are a thoughtful research partner. Compare evidence and be clear about uncertainty.'
                    : ''
                }
              />
            </>
          )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>Space access</legend>
              <p className="muted">
                Choose where this Dot can read and edit pages.
              </p>
              {workspace.spaces.map((space) => (
                <label className="permission-row" key={space.id}>
                  <input
                    type="checkbox"
                    checked={spaceIds.includes(space.id)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...spaceIds, space.id]
                        : spaceIds.filter((id) => id !== space.id);
                      setSpaceIds(next);
                      if (!next.includes(defaultSpace))
                        setDefaultSpace(next[0] ?? '');
                    }}
                  />
                  <span>{space.name}</span>
                </label>
              ))}
              <label className="field-label" htmlFor="default-space">
                Default destination for saved pages
              </label>
              <select
                id="default-space"
                value={defaultSpace}
                required
                onChange={(event) => setDefaultSpace(event.target.value)}
              >
                <option value="" disabled>
                  Choose a Space
                </option>
                {workspace.spaces
                  .filter((space) => spaceIds.includes(space.id))
                  .map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
              </select>
            </fieldset>
          )}
          {(dialog.type === 'dot' || dialog.type === 'settings') && (
            <>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={research}
                  onChange={(e) => setResearch(e.target.checked)}
                />
                <span>
                  <strong>Public-page research</strong>
                  <small>
                    Allow the server-side read-only browser tool. Global
                    settings always take precedence.
                  </small>
                </span>
              </label>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={memory}
                  onChange={(e) => setMemory(e.target.checked)}
                />
                <span>
                  <strong>Use and learn memories</strong>
                  <small>
                    Include About me and learned preferences in new turns, and
                    learn how you like to communicate and work. Changing
                    permission stops active work.
                  </small>
                </span>
              </label>
              {dialog.type === 'dot' && (
                <label className="permission-row">
                  <input
                    type="checkbox"
                    checked={consultable}
                    onChange={(e) => setConsultable(e.target.checked)}
                  />
                  <span>
                    <strong>Other Dots can consult this Dot</strong>
                    <small>
                      Lets other Dots ask it questions. It answers from its own
                      memories, documents, and Spaces, but can’t edit pages
                      while consulted.
                    </small>
                  </span>
                </label>
              )}
            </>
          )}
          {dialog.type === 'schedule' && (
            <>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={useClock}
                  onChange={(event) => setUseClock(event.target.checked)}
                />
                <span>Run at a time of day</span>
              </label>
              {useClock ? (
                <>
                  <label className="field-label" htmlFor="schedule-time">
                    Time
                  </label>
                  <input
                    id="schedule-time"
                    type="time"
                    value={timeOfDay}
                    onChange={(event) => setTimeOfDay(event.target.value)}
                    required
                  />
                  <label className="field-label" htmlFor="schedule-zone">
                    Timezone
                  </label>
                  <input
                    id="schedule-zone"
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    required
                  />
                  <fieldset className="space-access-fields">
                    <legend>Weekdays</legend>
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(
                      (label, day) => (
                        <label className="permission-row" key={label}>
                          <input
                            type="checkbox"
                            checked={weekdays.includes(day)}
                            onChange={(event) =>
                              setWeekdays(
                                event.target.checked
                                  ? [...weekdays, day]
                                  : weekdays.filter((value) => value !== day),
                              )
                            }
                          />
                          <span>{label}</span>
                        </label>
                      ),
                    )}
                  </fieldset>
                </>
              ) : (
                <>
                  <label className="field-label" htmlFor="schedule-interval">
                    Repeat after each successful run
                  </label>
                  <select
                    id="schedule-interval"
                    value={interval}
                    onChange={(e) => setInterval(e.target.value)}
                  >
                    <option value="60">Every minute (testing)</option>
                    <option value="3600">Every hour</option>
                    <option value="86400">Every day</option>
                    <option value="604800">Every week</option>
                  </select>
                </>
              )}
              <p className="muted">
                Runs on the server in this same conversation, even with the tab
                closed. Pausing an objective is separate from disabling its
                schedule.
              </p>
            </>
          )}
          {dialog.type === 'settings' && (
            <div className="config-note">
              <strong>Service setup</strong>
              <p>
                {workspace.setup.missing.length
                  ? `Add ${workspace.setup.missing.join(', ')} to the server environment, then restart.`
                  : 'Text configuration is present. A successful conversation confirms connectivity.'}
              </p>
              <p>
                Slack: {workspace.setup.slack.replaceAll('_', ' ')}. Voice:{' '}
                {workspace.setup.voice
                  ? 'configuration present'
                  : 'needs VOICE_API_KEY and VOICE_MODEL'}
                .
              </p>
              <p>
                Conversations are stored in this server&apos;s database. No
                usage telemetry is sent.
              </p>
            </div>
          )}
          {dialog.type === 'memory' && (
            <p className="muted">
              Every Dot with memory enabled sees this. Avoid secrets; memories
              go to your model provider with each turn.
            </p>
          )}
          {error && (
            <p className="chat-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary full" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
      </section>
    </div>
  );
}
