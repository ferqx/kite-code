import { deepStrictEqual, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { startDevelopmentWeb } from '@kite-ai/service/development-web';
import { launchPairedService } from '@kite-ai/service/paired';
import { type AssetManifest, validateTrustedAssets } from '@kite-ai/web';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';

// Independent actual browser qualifier. Only facts/hold/release/stop are accepted on stdin.
// hold delays one real metadata GET response; it never changes its payload or executes a mutation.
const root = realpathSync(mkdtempSync('/private/tmp/kite-web-file-checkpoints-'));
const workspace = join(root, 'workspace');
mkdirSync(workspace);
const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
const original = Buffer.from(`\uFEFF${'原完整字节 😀 α\r\n'.repeat(10000)}`);
writeFileSync(join(workspace, 'original.txt'), original);
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const requests: unknown[] = [];
const steps = new Map<string, number>();
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages: { role: string; content: string }[] };
    requests.push(body);
    const key = body.messages
      .filter((m) => m.role === 'user')
      .at(-1)!
      .content.includes('SECOND')
      ? 'second'
      : 'first';
    const step = steps.get(key) ?? 0;
    steps.set(key, step + 1);
    let call: { name: string; input: unknown } | null = null;
    if (step === 0) call = { name: 'files.read', input: { path: 'original.txt', limit: 10000 } };
    if (step === 1) {
      const result = JSON.parse(body.messages.filter((m) => m.role === 'tool').at(-1)!.content) as {
        baseline: unknown;
      };
      call = {
        name: 'files.write',
        input: {
          path: 'original.txt',
          base: result.baseline,
          content: `${key} modified UTF8 😀\r\n`,
        },
      };
    }
    if (step === 2)
      call = {
        name: 'files.write',
        input: { path: `${key}-created.txt`, base: null, content: `${key} created\r\n` },
      };
    const frame = (delta: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: `actual-${requests.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(
      frame(
        call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${requests.length}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.input) },
                },
              ],
            }
          : { content: `${key} completed` },
        null,
      ) +
        frame({}, call ? 'tool_calls' : 'stop') +
        'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  },
});
writeFileSync(
  join(profile.profilePath, 'config.jsonc'),
  JSON.stringify({
    modelId: 'fixed',
    models: [
      { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
    ],
    tools: [
      { id: 'files.read', definitionVersion: '3' },
      { id: 'files.write', definitionVersion: '2' },
    ],
  }),
);
const built = await buildTerminalBundle({
  destination: join(root, 'candidate'),
  repositoryRoot: realpathSync(join(import.meta.dir, '../../..')),
  bunExecutable: process.execPath,
});
const child = await launchPairedService({
  entrypoint: built.artifact.entrypoint,
  executable: built.artifact.executable,
  runtimeProtection: built.artifact.runtimeProtection,
  profile,
  instanceId: 'actual-browser-files',
  buildId: built.buildId,
  apiMajor: 1,
  requiredCapabilities: ['extension_queries', 'extensions_actions', 'interactions'],
});
const client = child.client,
  storeId = child.bootstrap.storeId!;
async function until<T>(read: () => Promise<T>, match: (value: T) => boolean) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (match(value)) return value;
    if (Date.now() > deadline) throw Error('owned_browser_fixture_deadline');
    await Bun.sleep(5);
  }
}
let gateway: ReturnType<typeof startDevelopmentWeb> | undefined;
let proxy: ReturnType<typeof Bun.serve> | undefined;
const reader = await openSqliteStore({
  dataRoot: profile.dataRoot,
  profile: profile.profile,
  mode: 'readonly',
});
let release: (() => void) | undefined;
let held = false;
let stopped!: () => void;
const stop = new Promise<void>((resolve) => {
  stopped = resolve;
});
const reads: { path: string; method: string; aborted: boolean; delayed: boolean }[] = [];
try {
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: pathToFileURL(workspace).href,
    name: 'Owned checkpoint Workspace',
  });
  for (const [sessionId, title] of [
    ['s', 'Actual Files checkpoints'],
    ['other', 'Separate empty Session'],
  ] as const)
    await client.createSession({
      expectedStoreId: storeId,
      commandId: `create-${sessionId}`,
      sessionId,
      workspaceId: 'w',
      title,
    });
  const mode = await client.getPermissionMode('s', { storeId });
  await client.setPermissionMode('s', {
    expectedStoreId: storeId,
    commandId: 'mode',
    mode: 'full',
    ifRevision: mode.revision,
    makeDefault: false,
    ifDefaultRevision: mode.defaultRevision,
  });
  const trust = await client.getWorkspaceTrust('w', { storeId });
  await client.setWorkspaceTrust('w', {
    expectedStoreId: storeId,
    commandId: 'trust',
    trusted: true,
    canonicalIdentity: trust.canonicalIdentity,
    externalReadScopeDigest: trust.externalReadScopeDigest,
    ifRevision: trust.revision,
  });
  for (const [commandId, content] of [
    ['first', 'FIRST actual Files read/write/create'],
    ['second', 'SECOND actual Files read/write/create'],
  ] as const) {
    await client.startRun('s', { expectedStoreId: storeId, commandId, kind: 'run.start', content });
    const command = await until(
      () => client.getCommand(commandId),
      (c) => c.status === 'applied',
    );
    const run = await until(
      () => client.getRun((command.receipt as { runId: string }).runId),
      (r) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(r.status),
    );
    if (run.status !== 'completed')
      throw Error(`actual_run_${run.status}:${JSON.stringify(await client.getView('s'))}`);
  }
  if (requests.length !== 8) throw Error('actual_provider_count');
  const points = await client.queryExtension('s', 'builtin.files', 'files.checkpoints', {});
  const directory = points[0]!.payload as unknown as {
    items: { checkpoint: { id: string; boundary: { runId: string } } }[];
  };
  if (directory.items.length !== 2) throw Error('actual_two_points_missing');
  const first = await client.getCommand('first');
  const pointId = directory.items.find(
    (i) => i.checkpoint.boundary.runId === (first.receipt as { runId: string }).runId,
  )!.checkpoint.id;
  await client.invokeExtension('s', {
    expectedStoreId: storeId,
    commandId: 'restore-original',
    kind: 'extension.invoke',
    extensionId: 'builtin.files',
    actionId: 'files.checkpoint.restore',
    definitionVersion: '1',
    input: { checkpointId: pointId, restoreId: 'explicit-first' },
  });
  const cards = await until(
    () => client.listInteractions('s', { storeId, state: 'pending', limit: 100 }),
    (v) => v.interactions.some((c) => c.definitionId === 'builtin.files/files.checkpoint.restore'),
  );
  const card = cards.interactions.find(
    (c) => c.definitionId === 'builtin.files/files.checkpoint.restore',
  )!;
  if (card.kind !== 'approval' || card.runId !== null)
    throw Error('independent_restore_approval_missing');
  await client.answerInteraction('s', card.id, {
    expectedStoreId: storeId,
    commandId: 'approve-restore',
    expectedRevision: card.revision,
    answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
  });
  const restored = await until(
    () => client.getExecution(card.executionId!),
    (v) => ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(v.status),
  );
  if (
    restored.status !== 'succeeded' ||
    hash(readFileSync(join(workspace, 'original.txt'))) !== hash(original) ||
    existsSync(join(workspace, 'first-created.txt')) ||
    existsSync(join(workspace, 'second-created.txt'))
  )
    throw Error(`actual_restore_failed:${JSON.stringify(restored)}`);
  // Assets are the current public builder's compiled source-independent Web output.
  const assetManifest = JSON.parse(
    readFileSync(join(built.root, 'web/manifest.json'), 'utf8'),
  ) as AssetManifest;
  const assets = new Map(
    assetManifest.map((entry) => [
      entry.path,
      {
        content: readFileSync(join(built.root, 'web', entry.path.slice(1)), 'utf8'),
        mediaType: entry.mediaType,
      },
    ]),
  );
  await validateTrustedAssets(assets, assetManifest);
  gateway = startDevelopmentWeb({ admittedClient: client, assets });
  proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'GET') return new Response('readonly_fixture', { status: 405 });
      const checkpointRead = url.pathname.includes('/file-checkpoints');
      const event = {
        path: url.pathname,
        method: request.method,
        aborted: false,
        delayed: checkpointRead && held,
      };
      if (checkpointRead) {
        reads.push(event);
        request.signal.addEventListener('abort', () => {
          event.aborted = true;
        });
      }
      const headers = new Headers(request.headers);
      headers.delete('host');
      if (headers.has('origin')) headers.set('origin', gateway!.endpoint);
      const actual = await fetch(`${gateway!.endpoint}${url.pathname}${url.search}`, { headers });
      if (event.delayed) {
        held = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return actual;
    },
  });
  async function facts() {
    const view = await reader.getView('s');
    return {
      root,
      storeId,
      workspaceId: 'w',
      sessionId: 's',
      pointId,
      restoreId: 'explicit-first',
      providerCalls: requests.length,
      cursor: (await reader.getMetadata()).lastChangeCursor,
      messages: view.messages.length,
      runs: view.runs.length,
      executions: view.executions.length,
      writeEffects: view.executions.filter(
        (e) => e.definitionId === 'files.write' && e.status === 'succeeded',
      ).length,
      files: ['original.txt', 'first-created.txt', 'second-created.txt'].map((path) => ({
        path,
        exists: existsSync(join(workspace, path)),
        hash: existsSync(join(workspace, path)) ? hash(readFileSync(join(workspace, path))) : null,
      })),
      directory: points[0]!.payload,
      status: (
        await client.queryExtension('s', 'builtin.files', 'files.checkpoint.restore-status', {
          checkpointId: pointId,
          restoreId: 'explicit-first',
        })
      )[0]!.payload,
      reads,
    };
  }
  const before = await facts();
  console.log(
    JSON.stringify({
      ready: true,
      endpoint: proxy.url.href,
      fixturePid: process.pid,
      childPid: child.pid,
      buildId: built.buildId,
      facts: before,
    }),
  );
  process.once('SIGINT', stopped);
  process.once('SIGTERM', stopped);
  let buffer = '';
  let commands = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'),
        command = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      commands = commands.then(async () => {
        if (command === 'facts') console.log(JSON.stringify({ facts: await facts() }));
        else if (command === 'hold') {
          held = true;
          console.log('{"hold":true}');
        } else if (command === 'release') {
          release?.();
          release = undefined;
          console.log('{"released":true}');
        } else if (command === 'stop') stopped();
        else console.log('{"invalidCommand":true}');
      });
    }
  });
  await stop;
  await commands;
  const after = await facts();
  for (const key of [
    'storeId',
    'workspaceId',
    'sessionId',
    'pointId',
    'providerCalls',
    'cursor',
    'messages',
    'runs',
    'executions',
    'writeEffects',
    'files',
    'status',
  ] as const)
    deepStrictEqual(after[key], before[key], `readonly_drift:${key}`);
  strictEqual(
    reads.every((read) => read.method === 'GET'),
    true,
  );
  console.log(JSON.stringify({ qualifiedReadonly: true, before, after }));
} finally {
  release?.();
  process.stdin.pause();
  proxy?.stop(true);
  await gateway?.close();
  await reader.close();
  await child.close();
  provider.stop(true);
  console.log(JSON.stringify({ closed: true, root }));
}
