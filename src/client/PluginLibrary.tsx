import { useCallback, useEffect, useState } from 'react';
import {
  CalendarDays,
  ChevronRight,
  ExternalLink,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import type {
  Dot,
  Plugin,
  PluginAccess,
  PluginAuthMode,
  PluginConstraints,
  PluginGrant,
  PluginGrantMode,
  PluginsResponse,
  PluginTool,
} from '../shared/types';
import {
  PLUGIN_PRESETS,
  presetFor,
  type PluginPreset,
} from '../shared/plugin-presets';
import { api } from './api';
import { Mascot } from './Mascot';

const ACCESS_LABEL: Record<PluginAccess, string> = {
  read: 'Read',
  write: 'Write',
  destructive: 'Destructive',
};
const MODE_LABEL: Record<PluginGrantMode | 'off', string> = {
  off: 'Off',
  ask: 'Ask first',
  allow: 'Allowed',
  deny: 'Off',
};
const STATUS_LABEL: Record<Plugin['status'], string> = {
  connected: 'Connected',
  unchecked: 'Not checked',
  stale: 'Schema changed',
  error: 'Needs attention',
};

export function slugOf(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^[^a-z]+/, '')
      .slice(0, 40) || ''
  );
}

const list = (text: string) =>
  text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

export interface PluginDraft {
  existing: boolean;
  preset: PluginPreset | null;
  kind: Plugin['kind'];
  id: string;
  idTouched: boolean;
  name: string;
  url: string;
  authMode: PluginAuthMode;
  token: string;
  tokenEnv: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  calendars: string;
  attendeeDomains: string;
  sendUpdates: 'none' | 'externalOnly' | 'all';
  allowDelete: boolean;
}

export function draftFor(
  preset: PluginPreset | null,
  plugin?: Plugin,
): PluginDraft {
  const config = (plugin?.config ?? {}) as {
    calendars?: string[];
    attendeeDomains?: string[];
    sendUpdates?: PluginDraft['sendUpdates'];
    allowDelete?: boolean;
  };
  return {
    existing: !!plugin,
    preset,
    kind: plugin?.kind ?? preset?.kind ?? 'mcp',
    id: plugin?.id ?? preset?.defaultId ?? '',
    idTouched: !!plugin,
    name: plugin?.name ?? preset?.name ?? '',
    url:
      plugin && plugin.authMode !== 'secret_url'
        ? plugin.url
        : (preset?.urls?.[0]?.url ?? ''),
    authMode: plugin?.authMode ?? preset?.authMode ?? 'stored',
    token: '',
    tokenEnv: plugin?.tokenEnv ?? '',
    clientId: plugin?.oauth?.clientId ?? '',
    clientSecret: '',
    scopes: plugin?.oauth?.scopes ?? preset?.scopeSets?.[0]?.scopes ?? [],
    calendars: (config.calendars ?? ['primary']).join(', '),
    attendeeDomains: (config.attendeeDomains ?? []).join(', '),
    sendUpdates: config.sendUpdates ?? 'none',
    allowDelete: config.allowDelete ?? false,
  };
}

/** The request body for POST /plugins; blank secrets keep what is stored. */
export function draftBody(draft: PluginDraft) {
  const base = {
    id: draft.id,
    name: draft.name.trim(),
    kind: draft.kind,
    preset: draft.preset?.id ?? null,
    authMode: draft.authMode,
  };
  if (draft.kind === 'google-calendar')
    return {
      ...base,
      oauth: {
        clientId: draft.clientId.trim(),
        ...(draft.clientSecret.trim()
          ? { clientSecret: draft.clientSecret.trim() }
          : {}),
        scopes: draft.scopes,
      },
      config: {
        calendars: list(draft.calendars).length
          ? list(draft.calendars)
          : ['primary'],
        attendeeDomains: list(draft.attendeeDomains),
        sendUpdates: draft.sendUpdates,
        allowDelete: draft.allowDelete,
      },
    };
  return {
    ...base,
    ...(draft.authMode === 'secret_url' ? {} : { url: draft.url.trim() }),
    ...(draft.authMode === 'env' ? { tokenEnv: draft.tokenEnv.trim() } : {}),
    ...((draft.authMode === 'stored' || draft.authMode === 'secret_url') &&
    draft.token.trim()
      ? { token: draft.token.trim() }
      : {}),
  };
}

export function PluginLibrary({ dots }: { dots: Dot[] }) {
  const [data, setData] = useState<PluginsResponse>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<PluginDraft>();
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api<PluginsResponse>('/plugins'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load plugins.');
    }
  }, []);
  useEffect(() => {
    const query = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const connected = query.get('oauth');
    const failed = query.get('oauth_error');
    if (connected) setNotice(`Connected ${connected}.`);
    if (failed) setError(failed);
    if (connected || failed)
      history.replaceState(
        null,
        '',
        `${location.pathname}${location.search}#/plugins`,
      );
    void load();
  }, [load]);
  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError('');
    setNotice('');
    try {
      await action();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
      return false;
    } finally {
      await load();
    }
  };
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const body = draftBody(draft);
    const saved = await run(async () => {
      await api('/plugins', 'POST', body);
      if (draft.kind === 'mcp')
        await api(`/plugins/${draft.id}/refresh`, 'POST', {});
    }, 'Could not save the plugin.');
    setSaving(false);
    if (saved) {
      setDraft(undefined);
      if (draft.kind === 'google-calendar')
        setNotice(`Saved ${draft.name}. Connect it to sign in with Google.`);
    }
  };
  const secretStorage = data?.secretStorage ?? false;
  return (
    <main className="main-content plugin-library">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h1>Plugins</h1>
          <p>
            Connect external systems, then decide what each Pod may do with
            them. Read tools can run on their own; writes ask you first unless
            you allow them. Limits pin the values a Pod may use.
          </p>
        </div>
        <div className="skill-heading-actions">
          <button
            className="primary"
            onClick={() => {
              setDraft(undefined);
              setPicking(!picking);
            }}
          >
            <Plus size={15} />
            Add plugin
          </button>
        </div>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {data && !secretStorage && (
        <p className="muted plugin-hint">
          Set <code>PLUGIN_SECRET_KEY</code> on the server to paste tokens here
          and to connect Google Calendar. Until then, plugins can read a token
          from an environment variable.
        </p>
      )}
      {picking && (
        <PresetPicker
          onPick={(preset) => {
            setPicking(false);
            setDraft(draftFor(preset));
          }}
          onCancel={() => setPicking(false)}
        />
      )}
      {draft && (
        <PluginForm
          draft={draft}
          secretStorage={secretStorage}
          saving={saving}
          onChange={setDraft}
          onCancel={() => setDraft(undefined)}
          onSave={() => void save()}
        />
      )}
      {!data ? (
        !error && <p className="muted">Loading…</p>
      ) : !data.plugins.length ? (
        !draft &&
        !picking && (
          <div className="large-empty">
            <Plug size={32} />
            <h2>Give your Pods access to your tools.</h2>
            <p>
              Add Google Calendar, Linear, Zoho or any MCP server, then choose
              what each Pod may do with it.
            </p>
          </div>
        )
      ) : (
        <div className="skill-list">
          {data.plugins.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              dots={dots}
              run={run}
              onEdit={() => {
                setPicking(false);
                setDraft(draftFor(presetFor(plugin.preset) ?? null, plugin));
              }}
            />
          ))}
        </div>
      )}
    </main>
  );
}

export function PresetPicker({
  onPick,
  onCancel,
}: {
  onPick: (preset: PluginPreset | null) => void;
  onCancel: () => void;
}) {
  const native = PLUGIN_PRESETS.filter((preset) => preset.group === 'native');
  const mcp = PLUGIN_PRESETS.filter((preset) => preset.group === 'mcp');
  const option = (preset: PluginPreset | null) => (
    <button
      key={preset?.id ?? 'custom'}
      className="plugin-preset"
      onClick={() => onPick(preset)}
    >
      <strong>{preset?.name ?? 'Custom MCP server'}</strong>
      <span>
        {preset?.summary ??
          'Any remote MCP server that speaks streamable HTTP.'}
      </span>
    </button>
  );
  return (
    <section className="skill-editor" aria-label="Choose a plugin">
      <h2>Native integrations</h2>
      <p className="muted">Built into Pods, with limits it enforces itself.</p>
      <div className="plugin-presets">{native.map(option)}</div>
      <h2>MCP servers</h2>
      <p className="muted">
        Hosted by the provider. Pods pins their tools and controls access.
      </p>
      <div className="plugin-presets">
        {mcp.map(option)}
        {option(null)}
      </div>
      <div className="skill-editor-actions">
        <button onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}

function PluginForm({
  draft,
  secretStorage,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  draft: PluginDraft;
  secretStorage: boolean;
  saving: boolean;
  onChange: (draft: PluginDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = (patch: Partial<PluginDraft>) => onChange({ ...draft, ...patch });
  const preset = draft.preset;
  const needsKey =
    draft.authMode === 'stored' ||
    draft.authMode === 'secret_url' ||
    draft.authMode === 'oauth';
  const keep = draft.existing ? 'Leave blank to keep the saved one' : '';
  return (
    <section className="skill-editor plugin-form" aria-label="Plugin settings">
      <h2>
        {draft.existing
          ? `Edit ${draft.name}`
          : `Add ${preset?.name ?? 'an MCP server'}`}
      </h2>
      {preset && (
        <details className="plugin-setup" open={!draft.existing}>
          <summary>Setup steps</summary>
          <ol>
            {preset.setup.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <a href={preset.docsUrl} target="_blank" rel="noreferrer">
            Provider documentation <ExternalLink size={12} />
          </a>
        </details>
      )}
      {needsKey && !secretStorage && (
        <p className="chat-error">
          This plugin stores a credential, which needs PLUGIN_SECRET_KEY on the
          server.
        </p>
      )}
      <div className="plugin-fields">
        <label>
          Name
          <input
            value={draft.name}
            maxLength={80}
            onChange={(event) =>
              set({
                name: event.target.value,
                ...(draft.idTouched ? {} : { id: slugOf(event.target.value) }),
              })
            }
          />
        </label>
        <label>
          Id
          <input
            value={draft.id}
            disabled={draft.existing}
            maxLength={41}
            onChange={(event) =>
              set({ id: event.target.value, idTouched: true })
            }
          />
        </label>
        {draft.kind === 'mcp' && draft.authMode !== 'secret_url' && (
          <label className="wide">
            Server URL
            {preset?.urls ? (
              <select
                value={draft.url}
                onChange={(event) => set({ url: event.target.value })}
              >
                {preset.urls.map((option) => (
                  <option key={option.url} value={option.url}>
                    {option.label}: {option.url}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={draft.url}
                placeholder="https://example.com/mcp"
                onChange={(event) => set({ url: event.target.value })}
              />
            )}
          </label>
        )}
        {draft.kind === 'mcp' && draft.authMode === 'secret_url' && (
          <label className="wide">
            Server URL (contains a key, stored encrypted)
            <input
              type="password"
              autoComplete="off"
              value={draft.token}
              placeholder={keep || 'https://…'}
              onChange={(event) => set({ token: event.target.value })}
            />
          </label>
        )}
        {draft.kind === 'mcp' && draft.authMode !== 'secret_url' && (
          <label>
            Authentication
            <select
              value={draft.authMode}
              onChange={(event) =>
                set({ authMode: event.target.value as PluginAuthMode })
              }
            >
              <option value="stored" disabled={!secretStorage}>
                Paste a token
              </option>
              <option value="env">Environment variable</option>
              <option value="none">None</option>
            </select>
          </label>
        )}
        {draft.kind === 'mcp' && draft.authMode === 'stored' && (
          <label>
            Token
            <input
              type="password"
              autoComplete="off"
              value={draft.token}
              placeholder={keep}
              onChange={(event) => set({ token: event.target.value })}
            />
          </label>
        )}
        {draft.kind === 'mcp' && draft.authMode === 'env' && (
          <label>
            Variable name
            <input
              value={draft.tokenEnv}
              placeholder="LINEAR_API_KEY"
              onChange={(event) => set({ tokenEnv: event.target.value })}
            />
          </label>
        )}
        {draft.kind === 'google-calendar' && (
          <>
            <label className="wide">
              Access
              <select
                value={draft.scopes.join(' ')}
                onChange={(event) =>
                  set({ scopes: event.target.value.split(' ') })
                }
              >
                {preset?.scopeSets?.map((set_) => (
                  <option key={set_.label} value={set_.scopes.join(' ')}>
                    {set_.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              OAuth client id
              <input
                value={draft.clientId}
                onChange={(event) => set({ clientId: event.target.value })}
              />
            </label>
            <label>
              OAuth client secret
              <input
                type="password"
                autoComplete="off"
                value={draft.clientSecret}
                placeholder={keep}
                onChange={(event) => set({ clientSecret: event.target.value })}
              />
            </label>
            <p className="muted wide">
              Redirect URI to add to the client:{' '}
              <code>{`${location.origin}/oauth/callback`}</code>
            </p>
            <label>
              Calendars Pods may use
              <input
                value={draft.calendars}
                placeholder="primary"
                onChange={(event) => set({ calendars: event.target.value })}
              />
            </label>
            <label>
              Attendee domains
              <input
                value={draft.attendeeDomains}
                placeholder="Your own domain"
                onChange={(event) =>
                  set({ attendeeDomains: event.target.value })
                }
              />
            </label>
            <label>
              Email attendees about changes
              <select
                value={draft.sendUpdates}
                onChange={(event) =>
                  set({
                    sendUpdates: event.target
                      .value as PluginDraft['sendUpdates'],
                  })
                }
              >
                <option value="none">Never</option>
                <option value="externalOnly">Only outside guests</option>
                <option value="all">Everyone</option>
              </select>
            </label>
            <label className="plugin-check">
              <input
                type="checkbox"
                checked={draft.allowDelete}
                onChange={(event) => set({ allowDelete: event.target.checked })}
              />
              Allow deleting events
            </label>
          </>
        )}
      </div>
      <div className="skill-editor-actions">
        <button onClick={onCancel}>Cancel</button>
        <button
          className="primary"
          disabled={saving || !draft.name.trim() || !draft.id}
          onClick={onSave}
        >
          {saving ? 'Saving…' : draft.kind === 'mcp' ? 'Save and test' : 'Save'}
        </button>
      </div>
    </section>
  );
}

type Run = (
  action: () => Promise<unknown>,
  fallback: string,
) => Promise<boolean>;

export function PluginCard({
  plugin,
  dots,
  run,
  onEdit,
}: {
  plugin: Plugin;
  dots: Dot[];
  run: Run;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [limits, setLimits] = useState<{ dotId: string; tool: string }>();
  const native = plugin.kind !== 'mcp';
  const connected = plugin.authMode !== 'oauth' || plugin.secretConfigured;
  const grantOf = (dotId: string, tool: string) =>
    plugin.grants.find((g) => g.dotId === dotId && g.toolName === tool);
  const setMode = (dot: Dot, tool: PluginTool, mode: PluginGrantMode | 'off') =>
    void run(
      () =>
        mode === 'off'
          ? api(
              `/plugins/${plugin.id}/grants/${dot.id}/${encodeURIComponent(tool.name)}`,
              'DELETE',
              {},
            )
          : api(`/plugins/${plugin.id}/grants`, 'POST', {
              dotId: dot.id,
              toolName: tool.name,
              mode,
              constraints: grantOf(dot.id, tool.name)?.constraints ?? {},
            }),
      'Could not change access.',
    );
  const bulk = (dot: Dot, tools: PluginTool[], mode?: PluginGrantMode) =>
    tools.length &&
    void run(
      () =>
        api(`/plugins/${plugin.id}/grants`, 'POST', {
          dotId: dot.id,
          toolNames: tools.map((tool) => tool.name),
          ...(mode ? { mode } : {}),
        }),
      'Could not change access.',
    );
  const groups = (['read', 'write', 'destructive'] as PluginAccess[])
    .map((access) => ({
      access,
      tools: plugin.tools.filter((tool) => tool.access === access),
    }))
    .filter((group) => group.tools.length);
  const dotName = (id: string) => dots.find((dot) => dot.id === id)?.name ?? id;
  const foldable =
    plugin.skipped.length > 0 ||
    plugin.tools.length > 0 ||
    plugin.activity.length > 0;
  const regionId = `plugin-${plugin.id}-details`;
  const subtitle = `${plugin.accountLabel ? `${plugin.accountLabel} · ` : ''}${plugin.url}${
    plugin.checkedAt
      ? ` · checked ${new Date(plugin.checkedAt).toLocaleString()}`
      : ''
  }${
    plugin.tools.length
      ? ` · ${plugin.tools.length} ${plugin.tools.length === 1 ? 'tool' : 'tools'}`
      : ''
  }`;
  const title = (
    <>
      {native ? <CalendarDays size={14} /> : <Plug size={14} />} {plugin.name}{' '}
      <span className="plugin-badge">{native ? 'Native' : 'MCP'}</span>{' '}
      <span className={`plugin-status ${plugin.status}`}>
        {plugin.authMode === 'oauth' && !plugin.secretConfigured
          ? 'Not connected'
          : STATUS_LABEL[plugin.status]}
      </span>
    </>
  );
  return (
    <article className="skill-card plugin-card">
      <div className="skill-card-heading">
        <div className="plugin-heading">
          <h2>
            {foldable ? (
              <button
                type="button"
                className="plugin-disclosure"
                aria-expanded={open}
                aria-controls={regionId}
                onClick={() => setOpen((value) => !value)}
              >
                <ChevronRight size={14} className="chevron" aria-hidden />
                <span className="plugin-disclosure-copy">
                  <span className="plugin-title-line">{title}</span>
                  <span className="plugin-subtitle">{subtitle}</span>
                </span>
              </button>
            ) : (
              title
            )}
          </h2>
          {!foldable && <p>{subtitle}</p>}
          {plugin.authMode === 'env' && !plugin.secretConfigured && (
            <p className="chat-error">
              {plugin.tokenEnv} is not set on the server.
            </p>
          )}
        </div>
        <div className="skill-card-actions">
          {plugin.authMode === 'oauth' && (
            <button
              onClick={() =>
                void run(async () => {
                  const { url } = await api<{ url: string }>(
                    `/plugins/${plugin.id}/oauth/start`,
                    'POST',
                    {},
                  );
                  window.location.assign(url);
                }, 'Could not start sign-in.')
              }
            >
              {plugin.secretConfigured ? 'Reconnect' : 'Connect'}
            </button>
          )}
          {connected && (
            <button
              className="icon-button"
              aria-label={`Test ${plugin.name}`}
              title="Test connection and reload tools"
              onClick={() =>
                void run(
                  () => api(`/plugins/${plugin.id}/refresh`, 'POST', {}),
                  'Connection test failed.',
                )
              }
            >
              <RefreshCw size={15} />
            </button>
          )}
          <button
            className="icon-button"
            aria-label={`Edit ${plugin.name}`}
            onClick={onEdit}
          >
            <Pencil size={15} />
          </button>
          <button
            className="icon-button"
            aria-label={`Delete ${plugin.name}`}
            onClick={() => {
              if (
                window.confirm(
                  `Delete ${plugin.name}? Every Pod loses its tools, and watches that poll it stop.`,
                )
              )
                void run(
                  () => api(`/plugins/${plugin.id}`, 'DELETE', {}),
                  'Could not delete the plugin.',
                );
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      {plugin.error && (
        <div className="plugin-problem" role="alert">
          <span>{plugin.error}</span>
          {plugin.status === 'stale' && (
            <button
              onClick={() => {
                if (
                  window.confirm(
                    'Accept the new tool definitions? Pods keep access only to tools that did not change.',
                  )
                )
                  void run(
                    () => api(`/plugins/${plugin.id}/accept`, 'POST', {}),
                    'Could not accept the schema.',
                  );
              }}
            >
              Review and accept
            </button>
          )}
        </div>
      )}
      {foldable && (
        <div id={regionId} className="plugin-fold" hidden={!open}>
          {plugin.skipped.length > 0 && (
            <p className="muted plugin-hint">
              Skipped {plugin.skipped.map((tool) => tool.name).join(', ')}:{' '}
              {plugin.skipped[0].reason}
            </p>
          )}
          {plugin.tools.length > 0 && dots.length > 0 && (
            <div className="plugin-bulk">
              {dots.map((dot) => (
                <span key={dot.id} className="plugin-bulk-dot">
                  <Mascot
                    identity={dot.id}
                    character={dot.mascot}
                    name={dot.name}
                    small
                    decorative
                  />
                  {dot.name}:
                  <button
                    onClick={() =>
                      bulk(
                        dot,
                        plugin.tools.filter((tool) => tool.access === 'read'),
                        'allow',
                      )
                    }
                  >
                    Allow read tools
                  </button>
                  <button onClick={() => bulk(dot, plugin.tools)}>
                    All tools, ask before writes
                  </button>
                </span>
              ))}
            </div>
          )}
          {groups.map((group) => (
            <section key={group.access} className="plugin-tool-group">
              <h3>{ACCESS_LABEL[group.access]}</h3>
              {group.tools.map((tool) => (
                <div key={tool.name} className="plugin-tool">
                  <div className="plugin-tool-heading">
                    <div>
                      <code>{tool.name}</code>
                      <p>{tool.description.slice(0, 240)}</p>
                    </div>
                    <select
                      aria-label={`Class of ${tool.name}`}
                      value={tool.accessOverridden ? tool.access : ''}
                      onChange={(event) =>
                        void run(
                          () =>
                            api(
                              `/plugins/${plugin.id}/tools/${encodeURIComponent(tool.name)}/access`,
                              'PUT',
                              { access: event.target.value || null },
                            ),
                          'Could not change the class.',
                        )
                      }
                    >
                      <option value="">
                        From server ({ACCESS_LABEL[tool.access]})
                      </option>
                      <option value="read">Read</option>
                      <option value="write">Write</option>
                      <option value="destructive">Destructive</option>
                    </select>
                  </div>
                  <div className="plugin-tool-dots">
                    {dots.map((dot) => {
                      const grant = grantOf(dot.id, tool.name);
                      const mode =
                        !grant || grant.mode === 'deny' ? 'off' : grant.mode;
                      const limited =
                        grant && Object.keys(grant.constraints).length;
                      return (
                        <span
                          key={dot.id}
                          className={`skill-dot ${mode !== 'off' ? 'on' : ''}`}
                        >
                          <Mascot
                            identity={dot.id}
                            character={dot.mascot}
                            name={dot.name}
                            small
                            decorative
                          />
                          <span>{dot.name}</span>
                          <select
                            aria-label={`${dot.name} access to ${tool.name}`}
                            value={mode}
                            onChange={(event) =>
                              setMode(
                                dot,
                                tool,
                                event.target.value as PluginGrantMode | 'off',
                              )
                            }
                          >
                            {(['off', 'ask', 'allow'] as const).map((value) => (
                              <option key={value} value={value}>
                                {MODE_LABEL[value]}
                              </option>
                            ))}
                          </select>
                          {mode !== 'off' && tool.parameters.length > 0 && (
                            <button
                              className="icon-button"
                              aria-label={`Limits for ${dot.name} on ${tool.name}`}
                              title={limited ? 'Limits set' : 'Set limits'}
                              onClick={() =>
                                setLimits(
                                  limits?.dotId === dot.id &&
                                    limits.tool === tool.name
                                    ? undefined
                                    : { dotId: dot.id, tool: tool.name },
                                )
                              }
                            >
                              <SlidersHorizontal size={13} />
                              {limited ? <small>{limited}</small> : null}
                            </button>
                          )}
                        </span>
                      );
                    })}
                  </div>
                  {limits?.tool === tool.name &&
                    grantOf(limits.dotId, tool.name) && (
                      <ConstraintEditor
                        tool={tool}
                        grant={grantOf(limits.dotId, tool.name)!}
                        dotName={dotName(limits.dotId)}
                        onCancel={() => setLimits(undefined)}
                        onSave={(constraints) =>
                          void run(
                            () =>
                              api(`/plugins/${plugin.id}/grants`, 'POST', {
                                dotId: limits.dotId,
                                toolName: tool.name,
                                mode: grantOf(limits.dotId, tool.name)!.mode,
                                constraints,
                              }),
                            'Could not save the limits.',
                          ).then((ok) => ok && setLimits(undefined))
                        }
                      />
                    )}
                </div>
              ))}
            </section>
          ))}
          {plugin.activity.length > 0 && (
            <details className="plugin-activity">
              <summary>Recent activity</summary>
              <ul>
                {plugin.activity.map((entry) => (
                  <li key={`${entry.source}-${entry.id}`}>
                    <time>{new Date(entry.at).toLocaleString()}</time>
                    <span>{dotName(entry.dotId)}</span>
                    <code>{entry.toolName}</code>
                    <span className="muted">
                      {entry.source === 'approval'
                        ? `approval ${entry.status}`
                        : entry.status}
                    </span>
                    <code className="plugin-args">
                      {JSON.stringify(entry.arguments).slice(0, 200)}
                    </code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </article>
  );
}

function ConstraintEditor({
  tool,
  grant,
  dotName,
  onCancel,
  onSave,
}: {
  tool: PluginTool;
  grant: PluginGrant;
  dotName: string;
  onCancel: () => void;
  onSave: (constraints: PluginConstraints) => void;
}) {
  const limitable = tool.parameters.filter(
    (param) => param.type === 'string' || param.type === 'string[]',
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      limitable.map((param) => [
        param.name,
        (grant.constraints[param.name] ?? []).join(', '),
      ]),
    ),
  );
  return (
    <div className="plugin-limits">
      <p className="muted">
        Limits for {dotName}. Leave a field blank for no limit. One value pins
        it; several allow any of them.
      </p>
      {!limitable.length && (
        <p className="muted">This tool has no text parameters to limit.</p>
      )}
      {limitable.map((param) => (
        <label key={param.name}>
          <code>{param.name}</code>
          {param.description && <small>{param.description}</small>}
          {param.enum ? (
            <select
              multiple
              value={list(values[param.name] ?? '')}
              onChange={(event) =>
                setValues({
                  ...values,
                  [param.name]: [...event.target.selectedOptions]
                    .map((option) => option.value)
                    .join(', '),
                })
              }
            >
              {param.enum.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={values[param.name] ?? ''}
              placeholder="Any value"
              onChange={(event) =>
                setValues({ ...values, [param.name]: event.target.value })
              }
            />
          )}
        </label>
      ))}
      <div className="skill-editor-actions">
        <button onClick={onCancel}>Cancel</button>
        <button
          className="primary"
          onClick={() =>
            onSave(
              Object.fromEntries(
                Object.entries(values)
                  .map(([key, text]) => [key, list(text)] as const)
                  .filter(([, items]) => items.length),
              ),
            )
          }
        >
          Save limits
        </button>
      </div>
    </div>
  );
}
