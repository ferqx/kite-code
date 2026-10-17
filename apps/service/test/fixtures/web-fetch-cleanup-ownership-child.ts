import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { assembleProcessService } from '../../src/process-service';

// Only this parent's explicit protocol retires the deliberately retained real Worker.
process.once('SIGTERM', () => process.exit(143));
process.stdin.setEncoding('utf8');
let exitInput = '';
process.stdin.on('data', (chunk: string) => {
  exitInput += chunk;
  if (exitInput === 'exit\n') process.exit(0);
  else if (!'exit\n'.startsWith(exitInput)) process.exit(2);
});
process.stdin.once('end', () => process.exit(0));
const NativeWorker = globalThis.Worker;
let parserOutput: { title?: string; content?: string } | undefined;
let originalThread: unknown;
let parserInputs = 0,
  terminationAttempts = 0,
  modelCalls = 0;
const failure = Object.assign(Error('fixture original extractor terminate rejected'), {
  code: 'fixture_original_terminate_failed',
});
globalThis.Worker = class extends NativeWorker {
  readonly parser: boolean;
  constructor(...args: ConstructorParameters<typeof NativeWorker>) {
    super(...args);
    this.parser = String(args[0]).includes('extractor-worker');
    if (this.parser)
      NativeWorker.prototype.addEventListener.call(this, 'message', (original: Event) => {
        const event = original as MessageEvent;
        if (event.data?.protocol === 'kite_worker_thread@1') originalThread = event.data.thread;
        else parserOutput = event.data;
      });
  }
  override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
    if (this.parser) parserInputs++;
    if (Array.isArray(transfer)) super.postMessage(message, transfer);
    else super.postMessage(message, transfer);
  }
  override terminate() {
    if (!this.parser) return super.terminate();
    terminationAttempts++;
    // This is an injected JavaScript rejection, not a native OS failure. The real
    // parser remains alive; the fixture never requests its termination here.
    throw failure;
  }
} as typeof Worker;
const profile = selectProfile({ dataRoot: process.argv[2]!, profile: 'test' });
const body = 'Original retained resource 中🙂e\u0301\r\n'.repeat(100) + 'ORIGINAL_ARTICLE_TAIL';
const page = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === '/robots.txt')
      return new Response('User-agent: *\nAllow: /');
    return new Response(
      `<html><title>Original resource</title><body><article><p>${body}</p></article></body></html>`,
      { headers: { 'content-type': 'text/html' } },
    );
  },
});
const target = `http://fixture.test:${page.port}/article`;
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    await request.json();
    const first = modelCalls++ === 0;
    const delta = first
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'original-web',
              type: 'function',
              function: { name: 'web_fetch', arguments: JSON.stringify({ url: target }) },
            },
          ],
        }
      : { content: 'unexpected next Model' };
    const chunk = (value: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: 'fixed-local', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    return new Response(
      `${chunk(delta, null)}${chunk({}, first ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  },
});
privateDirectory(profile.profilePath);
writeFileSync(
  join(profile.profilePath, 'config.jsonc'),
  JSON.stringify({
    modelId: 'local',
    models: [
      {
        id: 'local',
        provider: 'compatible',
        model: 'local',
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
      },
    ],
    tools: [{ id: 'web_fetch', definitionVersion: '1' }],
  }),
  { mode: 0o600 },
);
let runtime: AgentRuntime | undefined;
let retained = false;
let service: Awaited<ReturnType<typeof assembleProcessService>> | undefined;
let client: ReturnType<typeof createClient> | undefined;
try {
  service = await assembleProcessService(
    {
      profile: {
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        profileAccessKey: profile.profileAccessKey,
      },
      instanceId: 'web-cleanup-original',
      buildId: 'fixed',
      token: 'b'.repeat(64),
    },
    {
      configure() {
        const host = createDefaultProcessConfiguration({
          userConfigurationPath: profile.profilePath + '/config.jsonc',
          profile,
          permissionPolicy: {
            readPolicy: () => ({
              mode: 'full',
              workspaceTrust: true,
              revision: 'trusted-fixture-full',
              allowed: [
                { kind: 'model', definitionId: 'local', definitionVersion: '1' },
                { kind: 'tool', definitionId: 'web_fetch', definitionVersion: '1' },
              ],
            }),
          },
          webFetch: {
            network: {
              policy: { mode: 'allowlist', hosts: ['fixture.test'] },
              allowLoopbackForTests: true,
              resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
              admitHop: async () => ({ allowed: true, revision: 'trusted-fixture-network' }),
            },
          },
        });
        const permissionManagement = host.permissionManagement;
        if (!permissionManagement) throw Error('original permission management missing');
        return {
          ...host,
          permissionManagement(owner) {
            runtime = owner;
            return permissionManagement(owner);
          },
        };
      },
    },
  );
  client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      apiMajor: 1,
      profile: service.bootstrap.profile,
      requiredCapabilities: ['sessions', 'commands', 'history'],
    },
  });
  await client.connect();
  const storeId = service.bootstrap.storeId!;
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: pathToFileURL(profile.dataRoot).href,
    name: 'original',
  });
  await client.createSession({
    expectedStoreId: storeId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'original',
  });
  const input = 'Original user data 中🙂e\u0301\r\n原第二行';
  await client.startRun('s', {
    expectedStoreId: storeId,
    commandId: 'work',
    kind: 'run.start',
    content: input,
  });
  const deadline = Date.now() + 2500;
  for (;;) {
    const view = await client.getView('s');
    if (view.runs.length && view.runs.every((run) => !run.isActive)) break;
    if (Date.now() >= deadline) throw Error('original web fixture deadline');
    await Bun.sleep(5);
  }
  if (!runtime) throw Error('original runtime missing');
  const storedView = await runtime.getView('s');
  const tool = storedView.executions.find((execution) => execution.kind === 'tool');
  if (!tool) throw Error('original Tool missing');
  const metadata = await runtime.getMetadata();
  const command = await runtime.getCommand('work');
  const messages = await runtime.listMessages('s', { limit: 200 });
  const execution = await runtime.getExecution(tool.id);
  const closing = service.close();
  const sameClose = service.close() === closing;
  const error = await closing.then(
    () => null,
    (cause: unknown) => cause,
  );
  const runtimeError = await runtime.close().then(
    () => null,
    (cause: unknown) => cause,
  );
  retained = true;
  console.log(
    JSON.stringify({
      pid: process.pid,
      input,
      parserOutput,
      originalThread: process.platform === 'darwin' ? originalThread : null,
      parserInputs,
      terminationAttempts,
      modelCalls,
      storedView,
      metadata,
      command,
      messages,
      execution,
      sameClose,
      lifecycle: runtime.getLifecycleState(),
      runtimeError:
        runtimeError instanceof Error
          ? {
              code: 'code' in runtimeError ? runtimeError.code : null,
              message: runtimeError.message,
            }
          : null,
      error:
        error instanceof Error
          ? { code: 'code' in error ? error.code : null, message: error.message }
          : null,
    }),
  );
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  globalThis.Worker = NativeWorker;
  client?.disposeNetwork();
  if (service && !retained)
    await service.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
