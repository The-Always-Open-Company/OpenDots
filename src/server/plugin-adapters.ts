import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PluginAuthMode, PluginKind } from '../shared/types.js';
import { googleCalendarAdapter } from './plugin-adapters/google-calendar.js';
import {
  assertPublicUrl,
  CALL_TIMEOUT_MS,
  pluginFetch,
} from './plugin-network.js';

export interface PluginRow {
  id: string;
  name: string;
  /** For `secret_url` plugins this is only the origin; the full URL is sealed. */
  url: string;
  tokenEnv: string;
  schemaHash: string;
  error: string | null;
  kind: PluginKind;
  preset: string | null;
  configJson: string;
  authMode: PluginAuthMode;
  secretCipher: string | null;
  oauthJson: string | null;
  accountLabel: string | null;
  skippedJson: string;
  createdAt: number | null;
  checkedAt: number | null;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface RemoteTool {
  name: string;
  description: string;
  schema: unknown;
  annotations?: ToolAnnotations;
}

/** Resolved credentials for one call. Never stored or returned to the client. */
export interface PluginAuth {
  token: string;
  url: string;
  scopes: string[];
}

export interface PluginAdapter {
  kind: PluginKind;
  /** Returns the settings to store, or throws with a message for the owner. */
  validateConfig(config: unknown): Record<string, unknown>;
  listTools(plugin: PluginRow, auth: PluginAuth): Promise<RemoteTool[]>;
  callTool(
    plugin: PluginRow,
    auth: PluginAuth,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  /** Why the adapter's own policy refuses these arguments, if it does. */
  checkArgs?(
    plugin: PluginRow,
    name: string,
    args: Record<string, unknown>,
  ): string | null;
  /** A label for the connected account, such as an email address. */
  accountLabel?(plugin: PluginRow, auth: PluginAuth): Promise<string | null>;
}

async function connect(auth: PluginAuth) {
  const url = await assertPublicUrl(auth.url);
  const client = new Client({ name: 'opendots', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: auth.token
      ? { headers: { Authorization: `Bearer ${auth.token}` } }
      : undefined,
    fetch: (input, init) => pluginFetch(String(input), init),
  });
  await client.connect(transport);
  return client;
}

export const mcpAdapter: PluginAdapter = {
  kind: 'mcp',
  validateConfig: () => ({}),
  async listTools(_plugin, auth) {
    const client = await connect(auth);
    try {
      const tools: RemoteTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const listed = await client.listTools(cursor ? { cursor } : undefined);
        for (const tool of listed.tools)
          tools.push({
            name: tool.name,
            description: tool.description ?? tool.name,
            schema: tool.inputSchema ?? {},
            annotations: {
              ...(typeof tool.annotations?.readOnlyHint === 'boolean'
                ? { readOnlyHint: tool.annotations.readOnlyHint }
                : {}),
              ...(typeof tool.annotations?.destructiveHint === 'boolean'
                ? { destructiveHint: tool.annotations.destructiveHint }
                : {}),
            },
          });
        cursor = listed.nextCursor;
        if (!cursor) break;
      }
      return tools;
    } finally {
      await client.close().catch(() => {});
    }
  },
  async callTool(_plugin, auth, name, args) {
    const client = await connect(auth);
    try {
      return await client.callTool({ name, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      });
    } finally {
      await client.close().catch(() => {});
    }
  },
};

const registry: Record<PluginKind, PluginAdapter> = {
  mcp: mcpAdapter,
  'google-calendar': googleCalendarAdapter,
};

export function adapterFor(kind: PluginKind) {
  const adapter = registry[kind];
  if (!adapter) throw new Error(`No adapter is registered for ${kind}.`);
  return adapter;
}
