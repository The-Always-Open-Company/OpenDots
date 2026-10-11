import type { PluginAuthMode, PluginKind } from './types.js';

const googleScope = (name: string) => `https://www.googleapis.com/auth/${name}`;

export const GOOGLE_CALENDAR_SCOPES = {
  read: [googleScope('calendar.readonly')],
  write: [
    googleScope('calendar.events'),
    googleScope('calendar.calendarlist.readonly'),
  ],
};

export interface PluginPreset {
  id: 'linear' | 'zoho' | 'google-calendar';
  name: string;
  /** Native integrations are implemented by OpenDots; MCP ones are hosted by the provider. */
  group: 'native' | 'mcp';
  kind: PluginKind;
  summary: string;
  authMode: PluginAuthMode;
  /** Suggested plugin id. */
  defaultId: string;
  urls?: { label: string; url: string }[];
  scopeSets?: { label: string; scopes: string[] }[];
  setup: string[];
  docsUrl: string;
}

export const PLUGIN_PRESETS: PluginPreset[] = [
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    group: 'native',
    kind: 'google-calendar',
    summary:
      'Read and schedule events. OpenDots limits which calendars and attendees a Dot may use.',
    authMode: 'oauth',
    defaultId: 'google-calendar',
    scopeSets: [
      { label: 'Read only', scopes: GOOGLE_CALENDAR_SCOPES.read },
      { label: 'Read and write events', scopes: GOOGLE_CALENDAR_SCOPES.write },
    ],
    setup: [
      'In Google Cloud, enable the Google Calendar API for a project.',
      'Configure the OAuth consent screen and add the scopes you choose below.',
      'Create an OAuth client of type Web application.',
      'Add the redirect URI shown below to the client, then paste its id and secret here.',
      'Save, then Connect to sign in with the Google account the Dots should use.',
    ],
    docsUrl:
      'https://developers.google.com/workspace/calendar/api/quickstart/js',
  },
  {
    id: 'linear',
    name: 'Linear',
    group: 'mcp',
    kind: 'mcp',
    summary:
      "Find, create and update issues, projects and comments through Linear's MCP server.",
    authMode: 'stored',
    defaultId: 'linear',
    urls: [
      { label: 'Read and write', url: 'https://mcp.linear.app/mcp' },
      { label: 'Read only', url: 'https://mcp.linear.app/mcp/readonly' },
    ],
    setup: [
      'In Linear, open Settings, then Security & access, and create a dedicated API key.',
      'Give the key only the permissions and teams the Dots need. A Read key keeps them read-only.',
      'Choose the read-only endpoint for Dots that should never change anything.',
      'Paste the key here. To give some Dots write access, add a second Linear plugin with its own key.',
    ],
    docsUrl: 'https://linear.app/docs/mcp',
  },
  {
    id: 'zoho',
    name: 'Zoho',
    group: 'mcp',
    kind: 'mcp',
    summary:
      'Use the Zoho tools you pick in Zoho MCP, such as CRM, Mail or Desk.',
    authMode: 'secret_url',
    defaultId: 'zoho',
    setup: [
      'Sign in at mcp.zoho.com, or the domain for your region (.eu, .in, .com.au or .jp).',
      'Create an MCP server and add only the tools the Dots should have.',
      'Under Connection, choose Authorization via Connection and authorize it, so Dots can work without a browser.',
      'Copy the server URL from Connect and paste it here. It contains an API key, so OpenDots stores it encrypted.',
      'If the URL leaks, use Regenerate API Key in Zoho and paste the new one.',
    ],
    docsUrl:
      'https://help.zoho.com/portal/en/kb/mcp/getting-started/articles/zoho-mcp-help-documentation',
  },
];

export function presetFor(id: string | null | undefined) {
  return PLUGIN_PRESETS.find((preset) => preset.id === id);
}
