import './disable-telemetry.js';
import { webSearchProvider } from './parallel.js';
import { createShutdown } from './shutdown.js';
import { reportChannelFailure, safeFailure } from './slack-channel.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import { resolveAppOrigins } from './app-origin.js';
import { WorkspaceStore } from './workspace.js';
import { Platform } from './platform.js';
import {
  contextMaxTokensFromEnv,
  DEFAULT_EMBEDDING_MODEL,
  maxUploadBytesFromEnv,
  type PlatformConfig,
} from './platform-config.js';
import { dirname, join } from 'node:path';
import { Postgres } from './postgres.js';
import { Mem0Provider } from './memory.js';
import { PgChunkIndex } from './chunk-index.js';
import { openAiEmbeddings } from './embeddings.js';
import { DocumentLibrary } from './document-library.js';
import { DocumentIngestor } from './document-ingestor.js';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4310);
const ownerToken = process.env.OWNER_TOKEN;
if (
  !['127.0.0.1', '::1', 'localhost'].includes(host) &&
  (!ownerToken || ownerToken.length < 24)
)
  throw new Error(
    'External binding requires an OWNER_TOKEN of at least 24 characters.',
  );
const database = process.env.DATABASE_PATH ?? 'data/opendots.sqlite';
// mem0 keeps a small local config file; keep it with the rest of the data.
process.env.MEM0_DIR ??= join(dirname(database), 'mem0');
const store = new Store(database);
const workspace = new WorkspaceStore(
  database,
  process.env.OWNER_ID ?? 'opendots-owner',
);
const config: PlatformConfig = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL,
  baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  contextMaxTokens: contextMaxTokensFromEnv(process.env.CONTEXT_MAX_TOKENS),
  summaryModel: process.env.SUMMARY_MODEL || undefined,
  databaseUrl: process.env.DATABASE_URL || undefined,
  doclingUrl: process.env.DOCLING_URL || undefined,
  embeddingModel: process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
  memoryModel: process.env.MEMORY_MODEL || undefined,
  documentsDir:
    process.env.DOCUMENTS_DIR || join(dirname(database), 'documents'),
  maxUploadBytes: maxUploadBytesFromEnv(process.env.MAX_UPLOAD_MB),
  webSearchProvider: webSearchProvider(process.env.WEB_SEARCH_PROVIDER),
  parallelApiKey: process.env.PARALLEL_API_KEY,
  browserUrl: process.env.BROWSER_URL,
  browserSecret: process.env.BROWSER_SECRET,
  computerSupervisorUrl: process.env.COMPUTER_SUPERVISOR_URL,
  computerSupervisorToken: process.env.COMPUTER_SUPERVISOR_TOKEN,
  computerToken: process.env.COMPUTER_TOKEN,
  computerNamespace: process.env.COMPUTER_NAMESPACE,
  voiceKey: process.env.VOICE_API_KEY,
  voiceModel: process.env.VOICE_MODEL,
  voiceName: process.env.VOICE_NAME ?? 'marin',
  slackChannel: process.env.SLACK_CHANNEL_NAME,
  slackTeam: process.env.SLACK_TEAM_ID,
  slackUsers: (process.env.SLACK_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  slackDotId: process.env.SLACK_DOT_ID || undefined,
  ownerToken,
};
const postgres = config.databaseUrl
  ? new Postgres(config.databaseUrl)
  : undefined;
const memory =
  postgres && config.apiKey && config.model
    ? new Mem0Provider(postgres, {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.memoryModel ?? config.model,
        embeddingModel: config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
      })
    : undefined;
let ingestor: DocumentIngestor | undefined;
const documents =
  postgres && config.doclingUrl && config.apiKey
    ? new DocumentLibrary(
        workspace,
        new PgChunkIndex(postgres),
        openAiEmbeddings({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
        }),
        config.documentsDir ?? join(dirname(database), 'documents'),
        () => ingestor?.wake(),
      )
    : undefined;
if (documents && config.doclingUrl)
  ingestor = new DocumentIngestor(
    workspace.documents,
    documents,
    config.doclingUrl,
  );
const platform = new Platform(store, workspace, config, { memory, documents });
const researchConfig = {
  mode: 'live' as const,
  apiKey: config.apiKey,
  model: config.model,
  baseUrl: config.baseUrl,
  webSearchProvider: config.webSearchProvider,
  parallelApiKey: config.parallelApiKey,
  browserUrl: config.browserUrl,
  browserSecret: config.browserSecret,
};
const runner = new Runner(
  store,
  researchConfig,
  async (claim, _memories, signal, progress) => {
    const threadId = workspace.taskThread(claim.id);
    if (!threadId)
      throw new Error(
        'This legacy task has no conversation. Create a new scheduled task from a conversation.',
      );
    progress('Running this task in its conversation.');
    const text = await platform.turn(threadId, claim.prompt, signal);
    return { text, sources: [], sample: false };
  },
);
if (config.slackChannel)
  console.warn(
    'Slack settings are ignored: Slack ran on CopilotKit Intelligence Channels, which OpenDots no longer uses.',
  );
const app = createApp({
  store,
  runner,
  config: researchConfig,
  ownerToken,
  origin: resolveAppOrigins(process.env.APP_ORIGIN, process.env.NODE_ENV),
  platform,
});
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  );
  await next();
});
app.get('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
app.use('/*', serveStatic({ root: './dist/client' }));
app.get('*', serveStatic({ path: './dist/client/index.html' }));
const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`OpenDots template listening on http://${host}:${info.port}`);
  runner.start();
  ingestor?.start();
  void platform.start();
});
const shutdown = createShutdown({
  stopRunner: () => runner.stop(),
  stopPlatform: async () => {
    ingestor?.stop();
    await platform.stop();
    await postgres?.close();
  },
  closeServer: () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  exit: (code) => process.exit(code),
  report: (operation, error) =>
    reportChannelFailure(operation, [safeFailure(error)]),
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
