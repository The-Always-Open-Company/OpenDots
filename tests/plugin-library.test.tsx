import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import {
  draftBody,
  draftFor,
  PluginCard,
  PresetPicker,
  slugOf,
} from '../src/client/PluginLibrary';
import { presetFor } from '../src/shared/plugin-presets';
import type { Dot, Plugin } from '../src/shared/types';

const dot: Dot = {
  id: 'd1',
  spaceId: 's1',
  spaceIds: ['s1'],
  name: 'Ada',
  instructions: '',
  researchAllowed: false,
  memoryAllowed: false,
  consultable: false,
  mascot: null,
  replyMode: 'text',
  createdAt: 0,
};

const plugin = (overrides: Partial<Plugin> = {}): Plugin => ({
  id: 'linear',
  name: 'Linear',
  kind: 'mcp',
  preset: 'linear',
  url: 'https://mcp.linear.app/mcp',
  authMode: 'stored',
  tokenEnv: '',
  secretConfigured: true,
  accountLabel: null,
  config: {},
  oauth: null,
  status: 'connected',
  error: null,
  skipped: [],
  createdAt: 1,
  checkedAt: null,
  tools: [
    {
      name: 'list_issues',
      description: 'List issues',
      access: 'read',
      accessOverridden: false,
      parameters: [{ name: 'team', type: 'string', required: false }],
    },
    {
      name: 'create_issue',
      description: 'Create an issue',
      access: 'write',
      accessOverridden: false,
      parameters: [{ name: 'team', type: 'string', required: false }],
    },
  ],
  grants: [
    {
      dotId: 'd1',
      toolName: 'create_issue',
      mode: 'ask',
      constraints: { team: ['ENG'] },
    },
  ],
  activity: [],
  ...overrides,
});

const card = (value: Plugin) =>
  renderToStaticMarkup(
    <PluginCard
      plugin={value}
      dots={[dot]}
      run={async () => true}
      onEdit={() => undefined}
    />,
  );

describe('PluginLibrary', () => {
  it('groups tools by class and shows each Dot’s mode and limits', () => {
    const html = card(plugin());
    expect(html).toContain('<h3>Read</h3>');
    expect(html).toContain('<h3>Write</h3>');
    expect(html).toMatch(
      /aria-label="Ada access to list_issues"[^>]*>[\s\S]*?<option value="off" selected="">Off<\/option>/,
    );
    expect(html).toMatch(
      /aria-label="Ada access to create_issue"[^>]*>[\s\S]*?<option value="ask" selected="">Ask first<\/option>/,
    );
    expect(html).toContain('aria-label="Limits for Ada on create_issue"');
    expect(html).not.toContain('aria-label="Limits for Ada on list_issues"');
    expect(html).toContain('Allow read tools');
    expect(html).not.toContain('>Connect</button>');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('2 tools');
    expect(html).toMatch(
      /class="plugin-fold"[^>]*hidden|hidden=""[^>]*class="plugin-fold"/,
    );
  });

  it('offers Connect for an unconnected OAuth plugin and review for a changed schema', () => {
    const calendar = card(
      plugin({
        id: 'gcal',
        name: 'Google Calendar',
        kind: 'google-calendar',
        authMode: 'oauth',
        secretConfigured: false,
        tools: [],
        grants: [],
      }),
    );
    expect(calendar).toContain('Not connected');
    expect(calendar).toContain('>Connect</button>');
    expect(calendar).not.toContain('aria-label="Test Google Calendar"');
    const stale = card(
      plugin({ status: 'stale', error: 'Schema changed. Accept it.' }),
    );
    expect(stale).toContain('Review and accept');
  });

  it('lists native integrations apart from MCP servers', () => {
    const html = renderToStaticMarkup(
      <PresetPicker onPick={() => undefined} onCancel={() => undefined} />,
    );
    expect(html).toContain('Google Calendar');
    expect(html).toContain('Linear');
    expect(html).toContain('Zoho');
    expect(html).toContain('Custom MCP server');
    expect(html.indexOf('Google Calendar')).toBeLessThan(
      html.indexOf('Linear'),
    );
  });

  it('builds request bodies that never resend a blank secret', () => {
    expect(slugOf('My Linear!')).toBe('my-linear');
    const linear = draftFor(presetFor('linear') ?? null);
    expect(draftBody(linear)).not.toHaveProperty('token');
    expect(draftBody({ ...linear, token: ' lin_api ' })).toMatchObject({
      url: 'https://mcp.linear.app/mcp',
      authMode: 'stored',
      token: 'lin_api',
    });
    const zoho = draftFor(presetFor('zoho') ?? null);
    const zohoBody = draftBody({
      ...zoho,
      token: 'https://mcp.zoho.com/x?key=1',
    });
    expect(zohoBody).not.toHaveProperty('url');
    expect(zohoBody).toMatchObject({ authMode: 'secret_url' });
    const calendar = draftFor(presetFor('google-calendar') ?? null);
    expect(
      draftBody({ ...calendar, clientId: 'c', attendeeDomains: 'acme.com' }),
    ).toMatchObject({
      kind: 'google-calendar',
      oauth: { clientId: 'c' },
      config: { calendars: ['primary'], attendeeDomains: ['acme.com'] },
    });
    expect(draftBody(calendar)).toMatchObject({
      oauth: expect.not.objectContaining({ clientSecret: expect.anything() }),
    });
  });
});
