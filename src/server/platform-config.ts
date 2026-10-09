import type { WebConfig } from './parallel.js';
import type { SetupStatus } from '../shared/types.js';

export const DEFAULT_CONTEXT_MAX_TOKENS = 100_000;

export function contextMaxTokensFromEnv(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_CONTEXT_MAX_TOKENS;
  const tokens = Number(value);
  if (!Number.isInteger(tokens) || tokens < 4_000)
    throw new Error('CONTEXT_MAX_TOKENS must be an integer of at least 4000.');
  return tokens;
}

/** Unset, empty, `off`, or `0` means no limit. */
export function maxAgentTurnsFromEnv(
  value: string | undefined,
): number | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw || raw === 'off' || raw === '0') return undefined;
  const turns = Number(raw);
  if (!Number.isInteger(turns) || turns < 2 || turns > 100)
    throw new Error(
      'MAX_AGENT_TURNS must be off, or an integer from 2 to 100.',
    );
  return turns;
}

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_MAX_UPLOAD_MB = 50;

export function maxUploadBytesFromEnv(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_MAX_UPLOAD_MB * 1_000_000;
  const megabytes = Number(value);
  if (!Number.isFinite(megabytes) || megabytes < 1 || megabytes > 2_000)
    throw new Error('MAX_UPLOAD_MB must be a number from 1 to 2000.');
  return Math.round(megabytes * 1_000_000);
}

export interface PlatformConfig extends WebConfig {
  model?: string;
  apiKey?: string;
  baseUrl: string;
  /** Estimated token budget for conversation history sent to the model. */
  contextMaxTokens?: number;
  /** Model turns allowed per reply; unset means no limit. */
  maxAgentTurns?: number;
  /** Model that summarizes older history; defaults to `model`. */
  summaryModel?: string;
  /** Postgres with pgvector, for learned memories and document search. */
  databaseUrl?: string;
  doclingUrl?: string;
  /** Must produce 1536-dimension vectors; defaults to `text-embedding-3-small`. */
  embeddingModel?: string;
  /** Model that extracts learned memories; defaults to `model`. */
  memoryModel?: string;
  /** Model that writes document summaries and passage context; defaults to `model`. */
  enrichmentModel?: string;
  /** Model that plans document searches and reranks passages; defaults to `model`. */
  rerankModel?: string;
  documentsDir?: string;
  maxUploadBytes?: number;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  ownerToken?: string;
}
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  const missing = [
    !config.apiKey && 'OPENAI_API_KEY',
    !config.model && 'OPENAI_MODEL',
  ].filter((item): item is string => !!item);
  const declaredSlack = !!(
    config.slackChannel &&
    config.slackTeam &&
    config.slackUsers.length
  );
  slack = declaredSlack
    ? activationFailed && slack !== 'online'
      ? 'activation_failed'
      : slack
    : config.slackChannel || config.slackTeam || config.slackUsers.length
      ? 'setup_required'
      : 'not_configured';
  return {
    model: !!(config.apiKey && config.model),
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    memory: !!(config.databaseUrl && !missing.length),
    documents: !!(config.databaseUrl && config.doclingUrl && !missing.length),
    slack,
    missing,
  };
}
