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

export interface PlatformConfig extends WebConfig {
  model?: string;
  apiKey?: string;
  baseUrl: string;
  /** Estimated token budget for conversation history sent to the model. */
  contextMaxTokens?: number;
  /** Model that summarizes older history; defaults to `model`. */
  summaryModel?: string;
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
    slack,
    missing,
  };
}
