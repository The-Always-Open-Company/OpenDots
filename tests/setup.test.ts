import { expect, it } from 'vitest';
import {
  contextMaxTokensFromEnv,
  DEFAULT_CONTEXT_MAX_TOKENS,
  setupStatus,
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
it('parses the context budget and rejects unusable values', () => {
  expect(contextMaxTokensFromEnv(undefined)).toBe(DEFAULT_CONTEXT_MAX_TOKENS);
  expect(contextMaxTokensFromEnv(' ')).toBe(DEFAULT_CONTEXT_MAX_TOKENS);
  expect(contextMaxTokensFromEnv('64000')).toBe(64000);
  for (const bad of ['abc', '100', '1.5', '-5000'])
    expect(() => contextMaxTokensFromEnv(bad)).toThrow(/CONTEXT_MAX_TOKENS/);
});
