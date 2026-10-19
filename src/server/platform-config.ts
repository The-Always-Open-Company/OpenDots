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

/** Unset or `on` loads rarely used tools on demand; `off` sends every tool. */
export function lazyToolsFromEnv(value: string | undefined): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw || raw === 'on') return true;
  if (raw === 'off') return false;
  throw new Error('LAZY_TOOLS must be on or off.');
}

/** Unset means on: one message with several requests becomes several tasks. */
export function taskSplitFromEnv(value: string | undefined): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw || raw === 'on') return true;
  if (raw === 'off') return false;
  throw new Error('TASK_SPLIT must be on or off.');
}

export type ModelApi = 'chat-completions' | 'responses';

/** Unset means chat completions, which every OpenAI-compatible endpoint speaks. */
export function modelApiFromEnv(value: string | undefined): ModelApi {
  const raw = value?.trim().toLowerCase();
  if (!raw || raw === 'chat-completions') return 'chat-completions';
  if (raw === 'responses') return 'responses';
  throw new Error('OPENAI_API must be chat-completions or responses.');
}

export type VoiceProvider = 'live' | 'realtime';
export const DEFAULT_LIVE_VOICE_MODEL = 'gpt-live-1';

/** Unset means GPT-Live; `realtime` keeps the older Realtime API calls. */
export function voiceProviderFromEnv(value: string | undefined): VoiceProvider {
  const raw = value?.trim().toLowerCase();
  if (!raw || raw === 'live') return 'live';
  if (raw === 'realtime') return 'realtime';
  throw new Error('VOICE_PROVIDER must be live or realtime.');
}

export const DEFAULT_VOICE_TASK_LIMIT = 20;

/** Delegated Dot turns per call. Unset means 20; `off` or `0` means no limit. */
export function voiceTaskLimitFromEnv(value: string | undefined): number {
  const raw = value?.trim().toLowerCase();
  if (!raw) return DEFAULT_VOICE_TASK_LIMIT;
  if (raw === 'off' || raw === '0') return Infinity;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error(
      'VOICE_TASK_LIMIT must be off, or an integer from 1 to 100.',
    );
  return limit;
}

export const DEFAULT_DECISIONS_MODEL = 'gpt-6-luna';
export const DEFAULT_FAST_MODEL = 'gpt-6-luna';

/** Unset means the default model; `off` leaves the setting unset. */
function modelOrOff(value: string | undefined, fallback: string) {
  const raw = value?.trim();
  if (!raw) return fallback;
  return raw.toLowerCase() === 'off' ? undefined : raw;
}

/** Unset means `gpt-6-luna`; `off` turns routing and correction detection off. */
export function decisionsModelFromEnv(
  value: string | undefined,
): string | undefined {
  return modelOrOff(value, DEFAULT_DECISIONS_MODEL);
}

/** Unset means `gpt-6-luna`; `off` keeps every turn on the reasoning model. */
export function fastModelFromEnv(
  value: string | undefined,
): string | undefined {
  return modelOrOff(value, DEFAULT_FAST_MODEL);
}

export const DEFAULT_ROUTER_MIN_CONFIDENCE = 0.8;

export function routerMinConfidenceFromEnv(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_ROUTER_MIN_CONFIDENCE;
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw new Error('ROUTER_MIN_CONFIDENCE must be a number from 0 to 1.');
  return confidence;
}

export const DEFAULT_VOICE_TASK_CONCURRENCY = 3;

export function voiceTaskConcurrencyFromEnv(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_VOICE_TASK_CONCURRENCY;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw new Error('VOICE_TASK_CONCURRENCY must be an integer from 1 to 10.');
  return limit;
}

export type VoiceResultDelivery = 'sequential' | 'batch' | 'quiet';

/** Unset means `sequential`: one spoken result at a time, paced by speech. */
export function voiceResultDeliveryFromEnv(
  value: string | undefined,
): VoiceResultDelivery {
  const raw = value?.trim().toLowerCase();
  if (!raw || raw === 'sequential') return 'sequential';
  if (raw === 'batch' || raw === 'quiet') return raw;
  throw new Error('VOICE_RESULT_DELIVERY must be sequential, batch or quiet.');
}

export const DEFAULT_VOICE_QUIET_MS = 1000;
export const DEFAULT_VOICE_TASK_AFTER_CALL_MS = 10 * 60_000;

/** A whole number of milliseconds from `min` to `max`, or `fallback` when unset. */
export function millisecondsFromEnv(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value?.trim()) return fallback;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < min || ms > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return ms;
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
  /** API the conversation model is called through; defaults to chat completions. */
  modelApi?: ModelApi;
  /** Estimated token budget for conversation history sent to the model. */
  contextMaxTokens?: number;
  /** Model turns allowed per reply; unset means no limit. */
  maxAgentTurns?: number;
  /** Send rarely used tools only after the model discovers them; unset means on. */
  lazyTools?: boolean;
  /** Log estimated prompt and tool tokens for each run. */
  logContextSize?: boolean;
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
  /** Model for simple turns and voice task briefs; unset in config keeps every turn on `model`. */
  fastModel?: string;
  /** Decisions API model for routing and correction detection; unset in config turns them off. */
  decisionsModel?: string;
  /** Lowest `simple` confidence that sends a main chat turn to `fastModel`; defaults to 0.8. */
  routerMinConfidence?: number;
  /** Split a message with several requests into separate tasks; unset in config means on. */
  taskSplit?: boolean;
  documentsDir?: string;
  maxUploadBytes?: number;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  voiceKey?: string;
  /** Speech API for calls; unset means `live`. */
  voiceProvider?: VoiceProvider;
  /** Model that speaks and listens during a call. */
  voiceModel?: string;
  voiceName: string;
  /** Model for Dot turns delegated from a call; defaults to `model`. */
  voiceTaskModel?: string;
  /** Delegated Dot turns per call; defaults to 20, `Infinity` for no limit. */
  voiceTaskLimit?: number;
  /** Call tasks that run at once; defaults to 3. */
  voiceTaskConcurrency?: number;
  /** How finished call tasks reach the call; defaults to `sequential`. */
  voiceResultDelivery?: VoiceResultDelivery;
  /** Silence on the line before a result is sent; defaults to 1000. */
  voiceQuietMs?: number;
  /** How long call tasks may keep running after hangup; defaults to 10 minutes. */
  voiceTaskAfterCallMs?: number;
  /** Model that transcribes voice notes; defaults to `gpt-4o-mini-transcribe`. */
  voiceTranscribeModel?: string;
  /** Model that speaks replies to voice notes; defaults to `gpt-4o-mini-tts`. */
  voiceSpeechModel?: string;
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
    voiceNotes: !!(config.voiceKey && !missing.length),
    memory: !!(config.databaseUrl && !missing.length),
    documents: !!(config.databaseUrl && config.doclingUrl && !missing.length),
    actionItems: !!(config.databaseUrl && config.apiKey && !missing.length),
    slack,
    missing,
  };
}
