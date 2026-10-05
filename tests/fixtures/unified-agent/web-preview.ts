import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Extension } from '@kite-ai/agent/extensions';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { readSessionLogs } from '@kite-ai/agent/storage';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { startDevelopmentWeb } from '@kite-ai/service/development-web';
import { validateTrustedAssets } from '@kite-ai/web';
import { assetManifest, getTrustedAssets } from '@kite-ai/web/assets';

// Explicit, harmless live browser fixture. Only "append", "facts" and "stop" are accepted on stdin.
// Build @kite-ai/web first. No existing profile, paid Provider or arbitrary HTTP mutation port.
const root = mkdtempSync(join(tmpdir(), 'kite-web-preview-'));
const workspace = join(root, 'workspace');
mkdirSync(workspace);
const profile = { dataRoot: join(root, 'data'), profile: 'browser-qa' };
const store = await openSqliteStore(profile);
const storeId = (await store.getMetadata()).storeId;
const artifacts = createArtifactStore({ profile, store });
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const markdown = [
  '# Complete Markdown fixture',
  'Paragraph with **bold**, *emphasis* and `inline code`.',
  '> A quoted observation.',
  '- First list item',
  '- Second list item',
  '| Field | Value |\n| --- | --- |\n| scope | original Session |',
  '![Image alt remains text](https://external.invalid/image.png)',
  '[External link](https://example.com) and [file link](./private-file.ts)',
  '<script>window.fixtureScriptExecuted = true</script>',
  '```typescript',
  ...Array.from({ length: 100 }, (_, index) => `const line${index} = "完整正文 ${index}";`),
  '```',
  'END OF COMPLETE MARKDOWN',
].join('\n\n');
const model = createFixedModel(
  [markdown, 'Second original response.', 'Other Session response.', 'New appended response.'].map(
    (text): ModelEvent[] => [{ type: 'text_delta', text }, finish],
  ),
);
const extension: Extension = {
  id: 'fixture.browser-qa',
  version: '1',
  apiMajor: 1,
  jobs: [
    {
      id: 'fixture.browser-output',
      version: '1',
      description: 'Harmless fixed output for browser inspection',
      inputSchema: { type: 'object', additionalProperties: false },
      async start() {
        return { reference: { id: 'fixture-output' } };
      },
      async *observe() {
        yield { type: 'output', stream: 'stdout', content: 'stdout α\n' };
        yield { type: 'output', stream: 'stderr', content: 'stderr β\n' };
        yield { type: 'progress', value: { percentage: 100 } };
        yield {
          type: 'terminal',
          supervision: 'ended',
          result: { outcome: 'succeeded', content: 'Harmless output finished.' },
        };
      },
      async cancel() {
        return { status: 'already_finished' };
      },
      async dispose() {},
    },
  ],
  actions: [
    {
      id: 'output',
      version: '1',
      description: 'Launch one ordinary fixture Job',
      inputSchema: { type: 'object', additionalProperties: false },
      async prepare(input) {
        return input;
      },
      async execute(_input, context) {
        const operation = await context.operations.ensure({
          key: 'original-output',
          request: {
            kind: 'job',
            definitionId: 'fixture.browser-output',
            definitionVersion: '1',
            input: {},
          },
        });
        await context.operations.wait(operation, { signal: context.signal, timeoutMs: 5000 });
        return { outcome: 'succeeded', content: 'Output created.' };
      },
    },
  ],
};
const runtime = createRuntime({
  store,
  artifacts,
  model,
  modelId: 'fixed',
  extensions: [extension],
  permissions: {
    async authorize() {
      return { allowed: true, revision: 'harmless-fixture-1' };
    },
  },
});
const serviceProfile = { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'fixture' };
const service = await startService({
  runtime,
  profile: serviceProfile,
  buildId: 'actual-web-qa',
  instanceId: crypto.randomUUID(),
  subjectId: 'fixture-owner',
  sessionLogs: (query, observer) => readSessionLogs(store, query, observer),
});
const client = createClient({
  endpoint: service.endpoint,
  token: service.bootstrap.token,
  bootstrap: service.bootstrap,
  expected: {
    profile: serviceProfile,
    apiMajor: 1,
    instanceId: service.bootstrap.instanceId,
    buildId: 'actual-web-qa',
    requiredCapabilities: ['sessions', 'commands', 'history', 'context'],
  },
});
let web: ReturnType<typeof startDevelopmentWeb> | undefined;
let stop!: () => void;
const stopped = new Promise<void>((resolve) => {
  stop = resolve;
});
let commands = Promise.resolve();
let appended = false;
try {
  await client.connect();
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'qa-workspace',
    name: 'Harmless browser fixture',
    rootUri: pathToFileURL(workspace).href,
  });
  for (const [sessionId, title] of [
    ['qa-markdown', 'Complete Markdown'],
    ['qa-other', 'Other Session'],
  ])
    await client.createSession({
      expectedStoreId: storeId,
      commandId: `create-${sessionId}`,
      sessionId: sessionId!,
      workspaceId: 'qa-workspace',
      title: title!,
    });
  async function run(sessionId: string, commandId: string, content: string) {
    await client.startRun(sessionId, {
      expectedStoreId: storeId,
      commandId,
      kind: 'run.start',
      content,
    });
    await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    const run = (await client.getView(sessionId)).runs.find(
      (item) => item.originCommandId === commandId,
    );
    if (run?.status !== 'completed') throw new Error('browser_fixture_run_failed');
  }
  await run('qa-markdown', 'qa-first', 'Show the full original Markdown response.');
  await run('qa-markdown', 'qa-second', 'Preserve the original reading position.');
  await run('qa-other', 'qa-other-work', 'A separate original Session.');
  await client.invokeExtension('qa-markdown', {
    expectedStoreId: storeId,
    commandId: 'qa-output',
    kind: 'extension.invoke',
    extensionId: extension.id,
    actionId: 'output',
    definitionVersion: '1',
    input: {},
  });
  await runtime.waitForCommand('qa-output', { timeoutMs: 5000 });
  const assets = getTrustedAssets();
  await validateTrustedAssets(assets, assetManifest);
  web = startDevelopmentWeb({ admittedClient: client, assets });
  const output = (await client.getView('qa-markdown')).executions.find(
    (item) => item.definitionId === 'fixture.browser-output',
  );
  process.stdout.write(
    `${JSON.stringify({ endpoint: web.endpoint, pageIdentity: web.pageIdentity, modelCalls: model.requests.length, outputId: output?.id })}\n`,
  );
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const command = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (command === 'stop') stop();
      else if (command === 'facts') {
        commands = commands.then(async () => {
          const view = await client.getView('qa-markdown');
          process.stdout.write(
            `${JSON.stringify({ facts: true, modelCalls: model.requests.length, messages: view.messages.length, runs: view.runs.length, executions: view.executions.length, cursor: view.snapshotCursor })}\n`,
          );
        });
      } else if (command === 'append' && !appended) {
        appended = true;
        commands = commands.then(async () => {
          await run('qa-markdown', 'qa-appended', 'One later original message.');
          process.stdout.write(
            `${JSON.stringify({ appended: true, modelCalls: model.requests.length })}\n`,
          );
        });
        void commands.catch(() => {
          process.exitCode = 1;
          stop();
        });
      }
    }
  });
  await stopped;
  await commands;
  process.stdout.write(`${JSON.stringify({ finalModelCalls: model.requests.length })}\n`);
} finally {
  process.stdin.pause();
  await web?.close();
  client.disposeNetwork();
  await service.close();
  rmSync(root, { recursive: true, force: true });
}
