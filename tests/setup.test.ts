import { expect, it } from 'vitest';
import {
  contextMaxTokensFromEnv,
  DEFAULT_CONTEXT_MAX_TOKENS,
  DEFAULT_DECISIONS_MODEL,
  DEFAULT_FAST_MODEL,
  decisionsModelFromEnv,
  fastModelFromEnv,
  maxAgentTurnsFromEnv,
  setupStatus,
  voiceProviderFromEnv,
  voiceTaskLimitFromEnv,
  type PlatformConfig,
} from '../src/server/platform-config.js';
const config: PlatformConfig = {
  apiKey: 'fixture',
  model: 'fixture',
  baseUrl: 'https://example.com',
  voiceName: 'marin',
  slackUsers: [],
};
it('never claims Slack online without a complete channel declaration', () => {
  expect(setupStatus(config, 'online').slack).toBe('not_configured');
  expect(
    setupStatus({ ...config, slackChannel: 'support' }, 'online').slack,
  ).toBe('setup_required');
  expect(
    setupStatus(
      {
        ...config,
        slackChannel: 'support',
        slackTeam: 'team',
        slackUsers: ['owner'],
      },
      'online',
    ).slack,
  ).toBe('online');
});
it('needs only model setup and disables voice when it is absent', () => {
  expect(setupStatus(config)).toMatchObject({ missing: [], model: true });
  expect(
    setupStatus({
      ...config,
      apiKey: '',
      voiceKey: 'fixture',
      voiceModel: 'fixture',
    }),
  ).toMatchObject({
    missing: ['OPENAI_API_KEY'],
    model: false,
    voice: false,
  });
  expect(setupStatus({ ...config, model: undefined }).missing).toEqual([
    'OPENAI_MODEL',
  ]);
});
it('reports activation failure until the channel recovers online', () => {
  const declared = {
    ...config,
    slackChannel: 'support',
    slackTeam: 'team',
    slackUsers: ['owner'],
  };
  expect(setupStatus(declared, 'offline', true).slack).toBe(
    'activation_failed',
  );
  expect(setupStatus(declared, 'online', true).slack).toBe('online');
});
it('defaults routing and simple turns to gpt-6-luna', () => {
  for (const unset of [undefined, '', ' ']) {
    expect(decisionsModelFromEnv(unset)).toBe(DEFAULT_DECISIONS_MODEL);
    expect(fastModelFromEnv(unset)).toBe(DEFAULT_FAST_MODEL);
  }
  expect(decisionsModelFromEnv('off')).toBeUndefined();
  expect(fastModelFromEnv('OFF')).toBeUndefined();
  expect(decisionsModelFromEnv('gpt-6-luna')).toBe('gpt-6-luna');
  expect(fastModelFromEnv('gpt-5.4-mini')).toBe('gpt-5.4-mini');
});
it('parses the context budget and rejects unusable values', () => {
  expect(contextMaxTokensFromEnv(undefined)).toBe(DEFAULT_CONTEXT_MAX_TOKENS);
  expect(contextMaxTokensFromEnv(' ')).toBe(DEFAULT_CONTEXT_MAX_TOKENS);
  expect(contextMaxTokensFromEnv('64000')).toBe(64000);
  for (const bad of ['abc', '100', '1.5', '-5000'])
    expect(() => contextMaxTokensFromEnv(bad)).toThrow(/CONTEXT_MAX_TOKENS/);
});
it('leaves the turn limit off unless a usable limit is set', () => {
  for (const off of [undefined, '', ' ', 'off', 'OFF', '0'])
    expect(maxAgentTurnsFromEnv(off)).toBeUndefined();
  expect(maxAgentTurnsFromEnv('8')).toBe(8);
  for (const bad of ['1', '101', '2.5', 'many', '-3'])
    expect(() => maxAgentTurnsFromEnv(bad)).toThrow(/MAX_AGENT_TURNS/);
});
it('defaults calls to GPT-Live and keeps the Realtime API selectable', () => {
  for (const unset of [undefined, '', ' ', 'live', 'LIVE'])
    expect(voiceProviderFromEnv(unset)).toBe('live');
  expect(voiceProviderFromEnv('realtime')).toBe('realtime');
  expect(() => voiceProviderFromEnv('sip')).toThrow(/VOICE_PROVIDER/);
});
it('allows 20 delegated turns per call unless configured otherwise', () => {
  for (const unset of [undefined, '', ' '])
    expect(voiceTaskLimitFromEnv(unset)).toBe(20);
  for (const off of ['off', 'OFF', '0'])
    expect(voiceTaskLimitFromEnv(off)).toBe(Infinity);
  expect(voiceTaskLimitFromEnv('40')).toBe(40);
  for (const bad of ['101', '2.5', 'many', '-3'])
    expect(() => voiceTaskLimitFromEnv(bad)).toThrow(/VOICE_TASK_LIMIT/);
});
