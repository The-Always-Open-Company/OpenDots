import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const disableUrl = new URL(
  '../src/server/disable-telemetry.ts',
  import.meta.url,
).href;
const platformUrl = new URL('../src/server/platform.ts', import.meta.url).href;
const storeUrl = new URL('../src/server/store.ts', import.meta.url).href;
const workspaceUrl = new URL('../src/server/workspace.ts', import.meta.url)
  .href;
const tsxUrl = import.meta.resolve('tsx');

// Intercept the real SDK transport before import, in a fresh process so its
// singletons observe the environment. These probes never send live telemetry.
const probe = (disable: boolean) => `
const requests = [];
globalThis.fetch = async (url) => {
  requests.push(String(url));
  return new Response('{"ok":true}', { status: 202 });
};
${disable ? `await import(${JSON.stringify(disableUrl)});` : ''}
const { Platform } = await import(${JSON.stringify(platformUrl)});
const { Store } = await import(${JSON.stringify(storeUrl)});
const { WorkspaceStore } = await import(${JSON.stringify(workspaceUrl)});
const store = new Store(':memory:');
const workspace = new WorkspaceStore(':memory:', 'fixture-owner');
try {
  const platform = new Platform(store, workspace, {
    apiKey: 'fixture', model: 'fixture',
    baseUrl: '', voiceName: 'marin', slackUsers: [],
  });
  await platform.handle(new Request('http://localhost/api/copilotkit/info'));
  const dot = workspace.dots()[0];
  workspace.bindThread('fixture-thread', dot.id, 'Fixture');
  // Reach the SDK request handler, then fail body validation before any agent run.
  const response = await platform.handle(new Request(
    'http://localhost/api/copilotkit/agent/' + dot.id + '/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'fixture-thread', messages: 'invalid' }),
    },
  ));
  if (response.status !== 400) throw new Error('Expected SDK body validation failure');
  await new Promise(resolve => setTimeout(resolve, 50));
  console.log(JSON.stringify(requests));
} finally {
  store.close();
  workspace.close();
}
`;

async function capture(disable: boolean) {
  const env = { ...process.env };
  for (const key of [
    'DO_NOT_TRACK',
    'COPILOTKIT_TELEMETRY_DISABLED',
    'COPILOTKIT_TELEMETRY_SAMPLE_RATE',
  ])
    delete env[key];
  const { stdout } = await run(
    process.execPath,
    ['--import', tsxUrl, '--input-type=module', '--eval', probe(disable)],
    { env, timeout: 30000 },
  );
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '[]') as string[];
}

it('sends no telemetry once the server entrypoint disables it', async () => {
  // Without the switch the probe sees CopilotKit's telemetry, so an empty
  // result below means the switch worked rather than that nothing was captured.
  expect(await capture(false)).not.toEqual([]);
  expect(await capture(true)).toEqual([]);
}, 60000);

it('imports the telemetry switch before anything that can load CopilotKit', async () => {
  const entry = await readFile(
    new URL('../src/server/index.ts', import.meta.url),
    'utf8',
  );
  expect(entry.match(/^import .*$/m)?.[0]).toBe(
    "import './disable-telemetry.js';",
  );
});
