import type { PendingAction, Plugin } from '../shared/types';

export type PluginName = Pick<Plugin, 'id' | 'name'>;

export interface ActionField {
  label: string;
  value: string;
  technical: boolean;
}

const titles: Record<string, string> = {
  arm_trigger: 'Start a schedule',
  apply_profile: 'Update this Pod’s profile',
};

// Plugin tools nest their inputs by request part; the owner cares about what is inside.
const wrappers = new Set([
  'body',
  'path_variables',
  'query_params',
  'params',
  'arguments',
  'input',
]);
const acronyms = new Set(['id', 'ids', 'url', 'api', 'cc', 'bcc', 'html']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FIELDS = 12;
// Schedule cards: plain labels for what the owner decides, the rest tucked away.
const LABELS: Record<string, string> = {
  allowTools: 'May use without asking',
  runs: 'Runs',
  nextRunAt: 'First run',
};
const TECHNICAL = new Set(['spec', 'kind', 'anchor', 'dotCanManage']);
const SCHEDULE_TOOLS = new Set(['arm_trigger', 'update_schedule']);
const MAX_VALUE = 600;

function words(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
}

export function readableName(name: string) {
  return words(name)
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (acronyms.has(lower)) return lower.toUpperCase();
      return index ? lower : lower[0].toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

export function actionTitle(toolName: string, plugins: PluginName[] = []) {
  const plugin = /^plugin_([a-z][a-z0-9-]*)_(.+)$/.exec(toolName);
  if (!plugin) return { title: titles[toolName] ?? readableName(toolName) };
  const pluginName =
    plugins.find((entry) => entry.id === plugin[1])?.name ??
    readableName(plugin[1]);
  const parts = plugin[2].split('_');
  // MCP servers often prefix tools with a product, as in ZohoCliq_send_message.
  const product =
    parts.length > 1 && /[A-Z]/.test(parts[0])
      ? words(parts.shift()!).join(' ')
      : undefined;
  const source =
    product && !product.toLowerCase().startsWith(pluginName.toLowerCase())
      ? `${pluginName} · ${product}`
      : (product ?? pluginName);
  return { title: readableName(parts.join('_')), source };
}

function technicalKey(key: string) {
  return /(^|_)id$/i.test(key) || /[a-z]Id$/.test(key);
}

function display(value: unknown, key: string) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number' && /At$/.test(key) && value > 1e11)
    return new Date(value).toLocaleString();
  const text = String(value);
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}

export function actionFields(
  argumentsJson: string,
  toolName = '',
): ActionField[] {
  const schedule = SCHEDULE_TOOLS.has(toolName);
  let args: unknown;
  try {
    args = JSON.parse(argumentsJson);
  } catch {
    return [
      { label: 'Details', value: display(argumentsJson, ''), technical: false },
    ];
  }
  const fields: ActionField[] = [];
  const visit = (
    value: unknown,
    labels: string[],
    key: string,
    technical: boolean,
  ) => {
    if (value === null || value === undefined || value === '') return;
    const label = labels.join(' · ') || 'Details';
    if (Array.isArray(value)) {
      if (schedule && key === 'allowTools')
        fields.push({
          label,
          value: value
            .map((item) => {
              const { title, source } = actionTitle(String(item));
              return source ? `${title} (${source})` : title;
            })
            .join(', '),
          technical,
        });
      else if (value.every((item) => item === null || typeof item !== 'object'))
        fields.push({
          label,
          value: value.map((item) => display(item, key)).join(', '),
          technical,
        });
      else
        value.forEach((item, index) =>
          visit(
            item,
            [...labels.slice(0, -1), `${labels.at(-1) ?? 'Item'} ${index + 1}`],
            key,
            technical,
          ),
        );
      return;
    }
    if (typeof value === 'object') {
      for (const [child, inner] of Object.entries(value))
        visit(
          inner,
          wrappers.has(child)
            ? labels
            : [...labels, (schedule && LABELS[child]) || readableName(child)],
          child,
          technical ||
            technicalKey(child) ||
            (schedule && TECHNICAL.has(child)),
        );
      return;
    }
    fields.push({
      label,
      value: display(value, key),
      technical: technical || uuid.test(String(value)),
    });
  };
  visit(args, [], '', false);
  return fields;
}

function FieldList({ fields }: { fields: ActionField[] }) {
  return (
    <dl className="action-fields">
      {fields.map((field, index) => (
        <div key={`${field.label}-${index}`}>
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** How a request ended, in a few words, once it was answered. */
export function actionOutcome(action: PendingAction, now = Date.now()) {
  let result: { error?: unknown; reason?: unknown } = {};
  try {
    result = action.resultJson ? JSON.parse(action.resultJson) : {};
  } catch {
    // An unreadable outcome still shows its status.
  }
  const why = String(result.error ?? result.reason ?? '').slice(0, 200);
  switch (action.status) {
    case 'pending':
      return null;
    case 'approved':
      return action.notBefore != null && action.notBefore > now
        ? `Approved · runs at ${new Date(action.notBefore).toLocaleString()}`
        : 'Approved · running';
    case 'executing':
      return 'Approved · running';
    case 'executed':
      return 'Approved · done';
    case 'failed':
      return `Approved · failed${why ? `: ${why}` : ''}`;
    case 'uncertain':
      return 'Approved · outcome unknown, check before trying again';
    case 'declined':
      return why && why !== 'Declined by the owner.'
        ? `Not run: ${why}`
        : 'Declined';
    default:
      return action.status;
  }
}

export function PendingActionCard({
  action,
  plugins,
  busy,
  onApprove,
  onDecline,
}: {
  action: PendingAction;
  plugins?: PluginName[];
  busy?: boolean;
  onApprove?: (id: string) => void;
  onDecline?: (id: string) => void;
}) {
  const { title, source } = actionTitle(action.toolName, plugins);
  const fields = actionFields(action.argumentsJson, action.toolName);
  const main = fields.filter((field) => !field.technical);
  const technical = fields.filter((field) => field.technical);
  const outcome = actionOutcome(action);
  const waiting = action.status === 'pending';
  return (
    <article
      className={`task-detail-card pending-action-card${waiting ? '' : ' answered'}`}
      data-action-id={action.id}
    >
      <small>
        {waiting ? 'Waiting for you' : 'Approval request'}
        {source ? ` · ${source}` : ''}
      </small>
      <h2>{title}</h2>
      {waiting && action.notBefore != null && (
        <p className="muted">
          Runs at {new Date(action.notBefore).toLocaleString()} once approved.
        </p>
      )}
      {!!main.length && <FieldList fields={main.slice(0, MAX_FIELDS)} />}
      {main.length > MAX_FIELDS && (
        <p className="muted">
          {main.length - MAX_FIELDS} more detail
          {main.length - MAX_FIELDS === 1 ? '' : 's'} not shown.
        </p>
      )}
      {!!technical.length && (
        <details>
          <summary>Technical details</summary>
          <FieldList fields={technical} />
        </details>
      )}
      {waiting ? (
        <div className="task-controls">
          <button
            type="button"
            disabled={busy}
            onClick={() => onApprove?.(action.id)}
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecline?.(action.id)}
          >
            Decline
          </button>
        </div>
      ) : (
        <p
          className={`action-outcome ${action.status === 'declined' ? 'declined' : action.status === 'failed' || action.status === 'uncertain' ? 'problem' : 'approved'}`}
        >
          {outcome}
        </p>
      )}
    </article>
  );
}
