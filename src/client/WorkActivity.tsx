import { useState } from 'react';
import type { PendingAction, WorkView } from '../shared/types';

export function WorkActivity({
  work,
  actions,
  busy,
  onOpen,
  onAction,
  onApprove,
  onDecline,
  onDisableTrigger,
  onCreate,
}: {
  work: WorkView[];
  actions: PendingAction[];
  busy: boolean;
  onOpen: (id: string) => void;
  onAction: (id: string, action: 'pause' | 'resume' | 'cancel') => void;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
  onDisableTrigger: (id: string) => void;
  onCreate: (title: string, objective: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const pending = actions.filter((action) => action.status === 'pending');
  return (
    <section className="work-activity">
      <form
        className="task-detail-card"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate(title, objective).then(() => {
            setTitle('');
            setObjective('');
          });
        }}
      >
        <h2>New objective</h2>
        <input
          aria-label="Objective title"
          value={title}
          maxLength={160}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
        <textarea
          aria-label="Objective"
          value={objective}
          maxLength={4000}
          onChange={(event) => setObjective(event.target.value)}
          required
        />
        <button className="primary" disabled={busy}>
          Queue objective
        </button>
      </form>
      {!!pending.length && (
        <div className="task-list">
          {pending.map((action) => (
            <article className="task-detail-card" key={action.id}>
              <h2>{action.toolName}</h2>
              <p className="muted">{action.argumentsJson.slice(0, 400)}</p>
              <div className="task-controls">
                <button disabled={busy} onClick={() => onApprove(action.id)}>
                  Approve
                </button>
                <button disabled={busy} onClick={() => onDecline(action.id)}>
                  Decline
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="task-list">
        {work.map((item) => (
          <article className="task-detail-card" key={String(item.workItem.id)}>
            <button className="text-button" onClick={() => onOpen(String(item.workItem.id))}>
              <strong>{String(item.workItem.title)}</strong>
            </button>
            <p className="muted">
              {String(item.workItem.status)} · {String(item.workItem.source)}
            </p>
            <div className="task-controls">
              {item.workItem.status === 'open' ? (
                <button
                  disabled={busy}
                  onClick={() => onAction(String(item.workItem.id), 'pause')}
                >
                  Pause objective
                </button>
              ) : item.workItem.status === 'paused' ? (
                <button
                  disabled={busy}
                  onClick={() => onAction(String(item.workItem.id), 'resume')}
                >
                  Resume objective
                </button>
              ) : null}
              {item.workItem.status !== 'cancelled' && (
                <button
                  disabled={busy}
                  onClick={() => onAction(String(item.workItem.id), 'cancel')}
                >
                  Cancel objective
                </button>
              )}
              {item.triggers
                ?.filter((trigger) => trigger.enabled)
                .map((trigger) => (
                  <button
                    key={String(trigger.id)}
                    disabled={busy}
                    onClick={() => onDisableTrigger(String(trigger.id))}
                  >
                    Disable {String(trigger.kind)}
                  </button>
                ))}
              {item.children
                ?.filter((child) => child.status !== 'cancelled')
                .map((child) => (
                  <button
                    key={String(child.id)}
                    disabled={busy}
                    onClick={() => onAction(String(child.id), 'cancel')}
                  >
                    Stop {String(child.title)}
                  </button>
                ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function WorkDetail({
  detail,
  busy,
  onReplay,
}: {
  detail: WorkView;
  busy?: boolean;
  onReplay?: (id: string) => void;
}) {
  return (
    <section className="task-detail-card">
      <h2>{String(detail.workItem.title)}</h2>
      <p>{String(detail.workItem.objective)}</p>
      <h3>Attempts</h3>
      {detail.executions.map((execution) => (
        <p className="muted" key={String(execution.id)}>
          Attempt {execution.attempt}: {execution.status}
          {execution.error ? ` — ${execution.error}` : ''}
        </p>
      ))}
      <h3>Events</h3>
      {detail.events.slice(0, 12).map((event) => (
        <p className="muted" key={event.id}>
          {event.type}: {event.payloadJson.slice(0, 180)}
        </p>
      ))}
      {!!detail.triggers?.length && (
        <>
          <h3>Schedules</h3>
          {detail.triggers.map((trigger) => (
            <p className="muted" key={String(trigger.id)}>
              {String(trigger.kind)} · {trigger.enabled ? 'enabled' : 'off'}
              {trigger.nextRunAt
                ? ` · next ${new Date(trigger.nextRunAt).toLocaleString()}`
                : ''}
            </p>
          ))}
        </>
      )}
      {!!detail.children.length && (
        <>
          <h3>Children</h3>
          {detail.children.map((child) => (
            <p className="muted" key={String(child.id)}>
              {String(child.title)} · {String(child.status)}
              {child.blocking ? ' · blocking' : ''}
            </p>
          ))}
        </>
      )}
      {!!detail.invocations?.length && (
        <>
          <h3>Tool results</h3>
          {detail.invocations.map((invocation) => {
            const attempt = detail.executions.find(
              (execution) => execution.id === invocation.executionId,
            )?.attempt;
            return (
              <p className="muted" key={invocation.id}>
                {invocation.toolName} · {invocation.status}
                {attempt ? ` · attempt ${attempt}` : ''}
                {invocation.resultJson
                  ? ` · ${invocation.resultJson.slice(0, 120)}`
                  : ''}
              </p>
            );
          })}
        </>
      )}
      {!!detail.inbound?.some((event) => event.status === 'dead') && (
        <>
          <h3>Dead events</h3>
          {detail.inbound
            .filter((event) => event.status === 'dead')
            .map((event) => (
              <p className="muted" key={event.id}>
                {event.payload.slice(0, 180)}{' '}
                <button
                  disabled={busy}
                  onClick={() => onReplay?.(event.id)}
                >
                  Replay
                </button>
              </p>
            ))}
        </>
      )}
      {!!detail.actions.length && (
        <>
          <h3>Actions</h3>
          {detail.actions.map((action) => (
            <p className="muted" key={action.id}>
              {action.toolName} · {action.status}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
