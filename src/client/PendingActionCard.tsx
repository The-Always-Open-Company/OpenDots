import type { PendingAction, Plugin } from '../shared/types';

export type PluginName = Pick<Plugin, 'id' | 'name'>;

export interface ActionField {
  label: string;
  value: string;
  technical: boolean;
}

const titles: Record<string, string> = {
  arm_trigger: 'Start a schedule',
  apply_profile: 'Update this Dot’s profile',
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

export function actionFields(argumentsJson: string): ActionField[] {
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
      if (value.every((item) => item === null || typeof item !== 'object'))
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
          wrappers.has(child) ? labels : [...labels, readableName(child)],
          child,
          technical || technicalKey(child),
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
  const fields = actionFields(action.argumentsJson);
  const main = fields.filter((field) => !field.technical);
  const technical = fields.filter((field) => field.technical);
  return (
    <article className="task-detail-card pending-action-card">
      <small>Waiting for you{source ? ` · ${source}` : ''}</small>
      <h2>{title}</h2>
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
    </article>
  );
}
