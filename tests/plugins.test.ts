import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { decide, type ExecutionContext } from '../src/server/authorize.js';
import { approvalDenied } from '../src/server/approved-actions.js';
import { ExecutionEngine } from '../src/server/execution-engine.js';
import type { PluginRow, RemoteTool } from '../src/server/plugin-adapters.js';
import { googleCalendarAdapter } from '../src/server/plugin-adapters/google-calendar.js';
import { PluginOAuth } from '../src/server/plugin-oauth.js';
import {
  decryptSecret,
  encryptSecret,
  secretStorageAvailable,
} from '../src/server/plugin-secrets.js';
import { PluginService } from '../src/server/plugins.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { snapshotFor } from '../src/server/work-tools.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { GOOGLE_CALENDAR_SCOPES } from '../src/shared/plugin-presets.js';

const network = vi.hoisted(() => ({
  handler: null as
    null | ((url: string, init: RequestInit) => Response | Promise<Response>),
}));
vi.mock('../src/server/plugin-network.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/server/plugin-network.js')>();
  return {
    ...actual,
    pluginFetch: async (url: string, init: RequestInit = {}) => {
      if (!network.handler) throw new Error('No network in tests.');
      return network.handler(url, init);
    },
  };
});

const KEY = Buffer.alloc(32, 7).toString('base64');
const cleanup: { close: () => void; dir: string }[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  network.handler = null;
  cleanup.splice(0).forEach(({ close, dir }) => {
    close();
    rmSync(dir, { recursive: true, force: true });
  });
});

function world(
  adapters: ConstructorParameters<typeof PluginService>[1] = {},
  oauth?: PluginOAuth,
) {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-plugins-'));
  const store = new Store(join(dir, 'open.sqlite'));
  const workspace = new WorkspaceStore(join(dir, 'open.sqlite'), 'owner');
  const engine = new ExecutionEngine(store.database);
  const plugins = new PluginService(store.database, adapters, { oauth });
  cleanup.push({
    close: () => {
      store.close();
      workspace.close();
    },
    dir,
  });
  const dot = workspace.dots()[0];
  const snapshot = () => ({
    ...snapshotFor({ store, workspace, plugins, engine }, dot, false),
    rules: engine.rules(),
  });
  return { dir, store, workspace, engine, plugins, dot, snapshot };
}

const ctx = (
  actorId: string,
  cause: ExecutionContext['cause'] = 'model',
): ExecutionContext => ({
  actorId,
  ownerId: 'owner',
  executionId: '',
  threadId: 't',
  mode: cause === 'model' ? 'interactive' : 'background',
  cause,
});

const mailTools = (sendDestructive = false): RemoteTool[] => [
  {
    name: 'list',
    description: 'List mail',
    schema: { type: 'object', properties: { folder: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'send',
    description: 'Send mail',
    schema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        team: { type: 'string' },
        body: { type: 'string' },
      },
    },
    annotations: sendDestructive ? { destructiveHint: true } : {},
  },
  {
    name: 'purge',
    description: 'Delete everything',
    schema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true },
  },
];

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('plugin secrets', () => {
  it('seals and opens a secret only with the configured key', () => {
    expect(secretStorageAvailable()).toBe(false);
    expect(() => encryptSecret('x')).toThrow(/PLUGIN_SECRET_KEY/);
    vi.stubEnv('PLUGIN_SECRET_KEY', KEY);
    expect(secretStorageAvailable()).toBe(true);
    const sealed = encryptSecret('lin_api_123');
    expect(sealed).not.toContain('lin_api_123');
    expect(decryptSecret(sealed)).toBe('lin_api_123');
    vi.stubEnv('PLUGIN_SECRET_KEY', Buffer.alloc(32, 9).toString('base64'));
    expect(() => decryptSecret(sealed)).toThrow(/could not be decrypted/);
  });

  it('refuses stored and secret URL modes without a key', () => {
    const { plugins } = world();
    expect(() =>
      plugins.save({
        id: 'linear',
        name: 'Linear',
        url: 'https://mcp.linear.app/mcp',
        authMode: 'stored',
        token: 'lin_api_123',
      }),
    ).toThrow(/PLUGIN_SECRET_KEY/);
    expect(() =>
      plugins.save({
        id: 'zoho',
        name: 'Zoho',
        authMode: 'secret_url',
        token: 'https://mcp.zoho.com/x?key=abc',
      }),
    ).toThrow(/PLUGIN_SECRET_KEY/);
  });

  it('never returns a token, ciphertext or secret URL, and redacts it from errors', async () => {
    vi.stubEnv('PLUGIN_SECRET_KEY', KEY);
    const secretUrl =
      'https://zoho.example/mcp/message?key=zoho-super-secret-key-123';
    const { store, engine, plugins } = world({
      listTools: async (plugin) => {
        if (plugin.authMode === 'secret_url')
          throw new Error(
            `Could not reach ${decryptSecret(plugin.secretCipher!)}`,
          );
        return mailTools();
      },
    });
    const app = createApp({
      store,
      runner: new Runner(store, { mode: 'sample', baseUrl: '' }),
      config: { mode: 'sample', baseUrl: '' },
      engine,
      plugins,
    });
    const created = await app.request(
      '/api/plugins',
      json('POST', {
        id: 'linear',
        name: 'Linear',
        preset: 'linear',
        url: 'https://mcp.linear.app/mcp',
        authMode: 'stored',
        token: 'lin_api_secret_token',
      }),
    );
    expect(created.status).toBe(201);
    const zoho = await app.request(
      '/api/plugins',
      json('POST', {
        id: 'zoho',
        name: 'Zoho',
        authMode: 'secret_url',
        token: secretUrl,
      }),
    );
    expect(zoho.status).toBe(201);
    expect((await zoho.json()) as { url: string }).toMatchObject({
      url: 'https://zoho.example',
      secretConfigured: true,
    });
    const failed = await app.request(
      '/api/plugins/zoho/refresh',
      json('POST', {}),
    );
    expect(failed.status).toBe(400);
    const message = JSON.stringify(await failed.json());
    expect(message).toContain('[redacted]');
    expect(message).not.toContain('zoho-super-secret-key-123');
    const listing = await (await app.request('/api/plugins')).text();
    const state = await (await app.request('/api/state')).text();
    for (const text of [listing, state]) {
      expect(text).not.toContain('lin_api_secret_token');
      expect(text).not.toContain('zoho-super-secret-key-123');
      expect(text).not.toContain('v1:');
      expect(text).not.toContain('secretCipher');
    }
    expect(JSON.parse(listing)).toMatchObject({ secretStorage: true });
    // A blank token on edit keeps the stored one.
    plugins.save({ id: 'linear', name: 'Linear renamed', authMode: 'stored' });
    expect(decryptSecret(plugins.get('linear')!.secretCipher!)).toBe(
      'lin_api_secret_token',
    );
  });
});

describe('plugin permissions', () => {
  async function granted() {
    let tools = mailTools();
    const calls: { name: string; args: unknown }[] = [];
    const w = world({
      listTools: async () => tools,
      callTool: async (_plugin, name, args) => {
        calls.push({ name, args });
        return { ok: true };
      },
    });
    w.plugins.save({ id: 'mail', name: 'Mail', url: 'http://127.0.0.1/mcp' });
    await w.plugins.refresh('mail');
    return { ...w, calls, setTools: (next: RemoteTool[]) => (tools = next) };
  }

  it('defaults read tools to Allowed and writes to Ask first, and holds asks for approval', async () => {
    const { plugins, dot, snapshot } = await granted();
    expect(plugins.grant(dot.id, 'mail', 'list')).toBe('allow');
    expect(plugins.grant(dot.id, 'mail', 'send')).toBe('ask');
    expect(decide(ctx(dot.id), 'plugin_mail_list', {}, snapshot())).toEqual({
      effect: 'allow',
    });
    expect(decide(ctx(dot.id), 'plugin_mail_send', {}, snapshot())).toEqual({
      effect: 'pending',
      ruleId: 'grant:mail/send',
    });
    expect(
      decide(ctx(dot.id, 'continuation'), 'plugin_mail_send', {}, snapshot())
        .effect,
    ).toBe('pending');
    expect(
      decide(ctx(dot.id, 'trigger'), 'plugin_mail_send', {}, snapshot()).effect,
    ).toBe('pending');
    expect(
      decide(ctx(dot.id, 'approved_action'), 'plugin_mail_send', {}, snapshot())
        .effect,
    ).toBe('allow');
    expect(decide(ctx(dot.id), 'plugin_mail_purge', {}, snapshot())).toEqual({
      effect: 'block',
      reason: 'Plugin tool is not granted.',
    });
    plugins.grant(dot.id, 'mail', 'list', 'deny');
    expect(decide(ctx(dot.id), 'plugin_mail_list', {}, snapshot()).effect).toBe(
      'block',
    );
    expect(plugins.definitions(dot.id).map((tool) => tool.name)).toEqual([
      'plugin_mail_send',
    ]);
    expect(plugins.definitions(dot.id)[0].description).toMatch(
      /owner approves each call/,
    );
    plugins.setAccess('mail', 'purge', 'read');
    expect(plugins.grant(dot.id, 'mail', 'purge')).toBe('allow');
  });

  it('enforces limits in decide, approved actions and calls, and fills in pinned values', async () => {
    const { plugins, dot, snapshot, calls, engine, workspace, store } =
      await granted();
    plugins.grant(dot.id, 'mail', 'send', 'allow', {
      to: ['boss@acme.com'],
      team: ['eng', 'ops'],
    });
    expect(() =>
      plugins.grant(dot.id, 'mail', 'send', 'allow', { nope: ['x'] }),
    ).toThrow(/no parameter named nope/);
    expect(
      decide(ctx(dot.id), 'plugin_mail_send', { team: 'sales' }, snapshot()),
    ).toEqual({ effect: 'block', reason: 'team must be one of "eng", "ops".' });
    expect(decide(ctx(dot.id), 'plugin_mail_send', {}, snapshot()).effect).toBe(
      'block',
    );
    expect(
      decide(
        ctx(dot.id),
        'plugin_mail_send',
        { team: 'eng', to: 'other@acme.com' },
        snapshot(),
      ).effect,
    ).toBe('block');
    expect(
      decide(ctx(dot.id), 'plugin_mail_send', { team: 'eng' }, snapshot())
        .effect,
    ).toBe('allow');
    expect(
      approvalDenied(
        { engine, workspace, store, plugins },
        {
          actorId: dot.id,
          threadId: 't',
          toolName: 'plugin_mail_send',
          argumentsJson: JSON.stringify({ team: 'sales' }),
        },
      ),
    ).toMatch(/team must be/);
    await expect(
      plugins.call(dot.id, 'mail', 'send', { team: 'sales' }),
    ).rejects.toThrow(/team must be/);
    await plugins.call(dot.id, 'mail', 'send', {
      team: 'ops',
      operationId: 'op-1',
    });
    expect(calls.at(-1)).toEqual({
      name: 'send',
      args: { team: 'ops', to: 'boss@acme.com' },
    });
    expect(plugins.definitions(dot.id)[0].description).toMatch(
      /to is always "boss@acme.com"/,
    );
    // Changing the mode alone keeps the limits.
    plugins.grant(dot.id, 'mail', 'send', 'ask');
    expect(plugins.details()[0].grants[0].constraints).toEqual({
      to: ['boss@acme.com'],
      team: ['eng', 'ops'],
    });
  });

  it('treats a relabelled tool as a schema change and keeps grants only for unchanged tools', async () => {
    const { plugins, dot, setTools } = await granted();
    plugins.grant(dot.id, 'mail', 'list');
    plugins.grant(dot.id, 'mail', 'send');
    setTools([
      ...mailTools(true),
      {
        name: 'archive',
        description: 'Archive',
        schema: {},
        annotations: {},
      },
    ]);
    expect((await plugins.refresh('mail')).stale).toBe(true);
    expect(plugins.views()[0].status).toBe('stale');
    expect(plugins.allowed(dot.id, 'mail', 'list')).toBe(false);
    await plugins.refresh('mail', true);
    expect(plugins.allowed(dot.id, 'mail', 'list')).toBe(true);
    expect(plugins.allowed(dot.id, 'mail', 'send')).toBe(false);
    expect(plugins.allowed(dot.id, 'mail', 'archive')).toBe(false);
    expect(
      plugins.details()[0].tools.find((tool) => tool.name === 'send')?.access,
    ).toBe('destructive');
  });

  it('skips tools whose names models reject', async () => {
    const { plugins, setTools } = await granted();
    setTools([
      ...mailTools(),
      { name: 'bad.name', description: 'x', schema: {} },
      { name: 'x'.repeat(60), description: 'x', schema: {} },
    ]);
    const result = await plugins.refresh('mail', true);
    expect(result.skipped.map((tool) => tool.name)).toEqual([
      'bad.name',
      'x'.repeat(60),
    ]);
    expect(plugins.details()[0].tools.map((tool) => tool.name)).toEqual([
      'list',
      'purge',
      'send',
    ]);
    expect(plugins.views()[0].skipped).toHaveLength(2);
  });

  it('deletes grants and stops poll watches when a plugin is removed', async () => {
    const { plugins, dot, engine } = await granted();
    plugins.grant(dot.id, 'mail', 'list');
    const item = engine.createWorkItem({
      actorId: dot.id,
      title: 'Watch mail',
      objective: 'Watch',
      source: 'watch',
      autoResume: true,
    });
    const trigger = engine.addTrigger({
      workItemId: String(item.id),
      actorId: dot.id,
      kind: 'watch',
      spec: { watchKind: 'poll', pluginId: 'mail', toolName: 'list' },
      enabled: true,
      nextRunAt: Date.now(),
    });
    expect(plugins.remove('mail')).toBe(true);
    expect(plugins.remove('mail')).toBe(false);
    expect(plugins.allowed(dot.id, 'mail', 'list')).toBe(false);
    expect(Number(engine.trigger(String(trigger))?.enabled)).toBe(0);
  });
});

function calendarRow(config: Record<string, unknown> = {}): PluginRow {
  return {
    id: 'gcal',
    name: 'Calendar',
    url: 'https://www.googleapis.com/calendar/v3',
    tokenEnv: '',
    schemaHash: 'h',
    error: null,
    kind: 'google-calendar',
    preset: 'google-calendar',
    configJson: JSON.stringify(config),
    authMode: 'oauth',
    secretCipher: null,
    oauthJson: null,
    accountLabel: 'me@acme.com',
    skippedJson: '[]',
    createdAt: null,
    checkedAt: null,
  };
}

describe('google calendar', () => {
  it('lists tools for the granted scopes only', async () => {
    const auth = (scopes: string[]) => ({ token: 't', url: '', scopes });
    const read = await googleCalendarAdapter.listTools(
      calendarRow(),
      auth(GOOGLE_CALENDAR_SCOPES.read),
    );
    expect(read.map((tool) => tool.name)).toEqual([
      'list_calendars',
      'list_events',
      'get_event',
      'find_free_time',
    ]);
    const write = await googleCalendarAdapter.listTools(
      calendarRow(),
      auth(GOOGLE_CALENDAR_SCOPES.write),
    );
    expect(write.map((tool) => tool.name)).toContain('delete_event');
  });

  it('enforces the calendar allowlist, attendee domains and the delete switch', () => {
    const check = (
      name: string,
      args: Record<string, unknown>,
      config: Record<string, unknown> = {},
    ) => googleCalendarAdapter.checkArgs!(calendarRow(config), name, args);
    expect(check('list_events', {})).toBeNull();
    expect(check('list_events', { calendarId: 'me@acme.com' })).toBeNull();
    expect(check('list_events', { calendarId: 'team@group' })).toMatch(
      /not allowed/,
    );
    expect(
      check(
        'list_events',
        { calendarId: 'team@group' },
        { calendars: ['primary', 'team@group'] },
      ),
    ).toBeNull();
    expect(
      check('find_free_time', { calendarIds: ['primary', 'other@x.com'] }),
    ).toMatch(/other@x.com is not allowed/);
    expect(check('create_event', { attendees: ['bob@acme.com'] })).toBeNull();
    expect(check('create_event', { attendees: ['eve@evil.com'] })).toBe(
      'Attendees must use acme.com.',
    );
    expect(
      check(
        'update_event',
        { attendees: ['eve@evil.com'] },
        { attendeeDomains: ['evil.com'] },
      ),
    ).toBeNull();
    expect(check('delete_event', { eventId: 'e' })).toMatch(/turned off/);
    expect(
      check('delete_event', { eventId: 'e' }, { allowDelete: true }),
    ).toBeNull();
    expect(() =>
      googleCalendarAdapter.validateConfig({
        attendeeDomains: ['not a domain'],
      }),
    ).toThrow(/example.com/);
  });
});

describe('plugin OAuth', () => {
  function calendarWorld() {
    vi.stubEnv('PLUGIN_SECRET_KEY', KEY);
    let clock = 1_000_000;
    const oauth = new PluginOAuth({ now: () => clock });
    const w = world({}, oauth);
    w.plugins.save({
      id: 'gcal',
      name: 'Calendar',
      kind: 'google-calendar',
      preset: 'google-calendar',
      oauth: {
        clientId: 'client-1',
        clientSecret: 'client-secret-xyz',
        scopes: GOOGLE_CALENDAR_SCOPES.write,
      },
    });
    const requests: { url: string; body: string; auth: string }[] = [];
    let tokenReply: () => Response = () =>
      Response.json({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: GOOGLE_CALENDAR_SCOPES.write.join(' '),
      });
    network.handler = (url, init) => {
      const headers = new Headers(init.headers);
      requests.push({
        url,
        body: String(init.body ?? ''),
        auth: headers.get('authorization') ?? '',
      });
      if (url.startsWith('https://oauth2.googleapis.com/token'))
        return tokenReply();
      if (url.includes('/users/me/calendarList/primary'))
        return Response.json({ id: 'me@acme.com' });
      if (url.includes('/calendars/primary/events'))
        return Response.json({
          items: [{ id: 'e1', summary: 'Standup', htmlLink: 'x' }],
        });
      return new Response('{}', { status: 404 });
    };
    return {
      ...w,
      requests,
      tick: (ms: number) => (clock += ms),
      setTokenReply: (reply: () => Response) => (tokenReply = reply),
    };
  }

  it('starts with PKCE, accepts a state once, and stores the refresh token sealed', async () => {
    const { plugins, dot, requests, tick } = calendarWorld();
    const url = new URL(
      plugins.oauthStart('gcal', 'http://localhost:5173/oauth/callback'),
    );
    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    const state = url.searchParams.get('state')!;
    await expect(plugins.oauthComplete('unknown', 'code')).rejects.toThrow(
      /expired/,
    );
    expect(await plugins.oauthComplete(state, 'code-1')).toBe('gcal');
    await expect(plugins.oauthComplete(state, 'code-1')).rejects.toThrow(
      /expired/,
    );
    const exchange = new URLSearchParams(requests[0].body);
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code_verifier')).toBeTruthy();
    const view = plugins.views()[0];
    expect(view).toMatchObject({
      status: 'connected',
      secretConfigured: true,
      accountLabel: 'me@acme.com',
    });
    expect(JSON.stringify(plugins.details())).not.toContain('refresh-1');
    expect(JSON.stringify(plugins.details())).not.toContain(
      'client-secret-xyz',
    );
    expect(decryptSecret(plugins.get('gcal')!.secretCipher!)).toBe('refresh-1');
    const stale = new URL(
      plugins.oauthStart('gcal', 'http://localhost:5173/oauth/callback'),
    ).searchParams.get('state')!;
    tick(11 * 60_000);
    await expect(plugins.oauthComplete(stale, 'code-2')).rejects.toThrow(
      /expired/,
    );

    plugins.grant(dot.id, 'gcal', 'list_events', 'allow');
    const listed = await plugins.call(dot.id, 'gcal', 'list_events', {
      timeMin: '2026-10-12T00:00:00Z',
    });
    expect(listed).toMatchObject({
      events: [{ id: 'e1', summary: 'Standup' }],
    });
    expect(requests.at(-1)?.auth).toBe('Bearer access-1');
  });

  it('refreshes an expired access token and asks to reconnect once access is revoked', async () => {
    const { plugins, dot, requests, tick, setTokenReply } = calendarWorld();
    const state = new URL(
      plugins.oauthStart('gcal', 'http://localhost:5173/oauth/callback'),
    ).searchParams.get('state')!;
    await plugins.oauthComplete(state, 'code-1');
    plugins.grant(dot.id, 'gcal', 'list_events', 'allow');
    tick(3600_000);
    setTokenReply(() =>
      Response.json({ access_token: 'access-2', expires_in: 3600 }),
    );
    await plugins.call(dot.id, 'gcal', 'list_events', { timeMin: 'x' });
    expect(
      new URLSearchParams(
        requests.find((r) => r.body.includes('refresh_token'))!.body,
      ).get('refresh_token'),
    ).toBe('refresh-1');
    expect(requests.at(-1)?.auth).toBe('Bearer access-2');
    tick(3600_000);
    setTokenReply(() =>
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
    );
    await expect(
      plugins.call(dot.id, 'gcal', 'list_events', { timeMin: 'x' }),
    ).rejects.toThrow(/Reconnect/);
    expect(plugins.views()[0]).toMatchObject({
      status: 'error',
      error: 'Access was revoked. Reconnect this plugin.',
    });
  });

  it('serves the callback outside the owner-token check and redirects back to Plugins', async () => {
    const { store, engine, plugins } = calendarWorld();
    const app = createApp({
      store,
      runner: new Runner(store, { mode: 'sample', baseUrl: '' }),
      config: { mode: 'sample', baseUrl: '' },
      engine,
      plugins,
      ownerToken: 'owner-token-that-is-long-enough',
      origin: 'http://localhost:5173',
    });
    const started = await app.request('/api/plugins/gcal/oauth/start', {
      ...json('POST', {}),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner-token-that-is-long-enough',
        Origin: 'http://localhost:5173',
      },
    });
    const { url } = (await started.json()) as { url: string };
    const redirect = new URL(url).searchParams.get('redirect_uri');
    expect(redirect).toBe('http://localhost:5173/oauth/callback');
    const state = new URL(url).searchParams.get('state')!;
    const bad = await app.request('/oauth/callback?state=nope&code=x');
    expect(bad.status).toBe(302);
    expect(bad.headers.get('location')).toMatch(/^\/#\/plugins\?oauth_error=/);
    const good = await app.request(
      `/oauth/callback?state=${encodeURIComponent(state)}&code=code-1`,
    );
    expect(good.headers.get('location')).toBe('/#/plugins?oauth=gcal');
  });
});
