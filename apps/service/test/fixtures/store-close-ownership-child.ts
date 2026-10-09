import type { AgentRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { createPermissionManagement } from '../../src/permission-management';
import { assembleProcessService } from '../../src/process-service';

// The parent owns this exact child; an explicit exit retires retained unconfirmed owners.
process.once('SIGTERM', () => process.exit(143));
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk: string) => {
  input += chunk;
  if (input === 'exit\n') process.exit(0);
  else if (!'exit\n'.startsWith(input)) process.exit(2);
});
process.stdin.once('end', () => process.exit(0));
const NativeWorker = globalThis.Worker;
class FailedCloseWorker extends NativeWorker {
  constructor(...args: ConstructorParameters<typeof NativeWorker>) {
    super(new URL('./sqlite-close-failed-worker.ts', import.meta.url).href, args[1]);
  }
}
globalThis.Worker = FailedCloseWorker;
const profile = selectProfile({ dataRoot: process.argv[2]!, profile: 'test' });
const body = '原完整模型结果🙂'.repeat(2048);
const model = createFixedModel([
  [
    { type: 'text_delta', text: body },
    { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
  ],
]);
let runtime: AgentRuntime | undefined;
let service: Awaited<ReturnType<typeof assembleProcessService>> | undefined;
let client: ReturnType<typeof createClient> | undefined;
let failedClose = false;
try {
  service = await assembleProcessService(
    {
      profile: {
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        profileAccessKey: profile.profileAccessKey,
      },
      instanceId: 'close-original',
      buildId: 'fixed',
      token: 'a'.repeat(64),
    },
    {
      configure() {
        return {
          model,
          modelId: 'fixed',
          permissions: {
            async authorize() {
              return { allowed: true, revision: 'fixed' };
            },
          },
          permissionManagement(owner) {
            runtime = owner;
            return createPermissionManagement({ runtime: owner, profile, writable: false });
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
    rootUri: `file://${profile.dataRoot}`,
    name: 'original',
  });
  await client.createSession({
    expectedStoreId: storeId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'original',
  });
  await client.startRun('s', {
    expectedStoreId: storeId,
    commandId: 'work',
    kind: 'run.start',
    content: 'original',
  });
  const deadline = Date.now() + 2500;
  for (;;) {
    const view = await client.getView('s');
    if (view.runs.length && view.runs.every((row) => !row.isActive)) break;
    if (Date.now() >= deadline) throw Error('original task deadline');
    await Bun.sleep(5);
  }
  if (!runtime) throw Error('original runtime missing');
  const view = await client.getView('s');
  const modelExecution = view.executions.find((row) => row.kind === 'model');
  if (!modelExecution) throw Error('original model execution missing');
  const modelOutput = await client.getModelOutput('s', modelExecution.id);
  const storedView = await runtime.getView('s');
  const metadata = await runtime.getMetadata();
  const command = await client.getCommand('work');
  const close = service.close();
  const sameClose = service.close() === close;
  const error = await close.catch((error: unknown) => error);
  failedClose = true;
  const lifecycle = await (
    await fetch(`${service.endpoint}/v1/lifecycle`, {
      headers: { authorization: `Bearer ${service.bootstrap.token}` },
    })
  ).json();
  console.log(
    JSON.stringify({
      pid: process.pid,
      body,
      view,
      modelOutput,
      storedView,
      metadata,
      command,
      modelCalls: model.requests.length,
      sameClose,
      error:
        error instanceof Error
          ? { message: error.message, code: 'code' in error ? error.code : null }
          : null,
      lifecycle,
    }),
  );
} catch (error) {
  if (
    error instanceof Error &&
    error.cause &&
    typeof error.cause === 'object' &&
    'originalError' in error.cause
  )
    console.error(error.cause.originalError);
  throw error;
} finally {
  globalThis.Worker = NativeWorker;
  client?.disposeNetwork();
  if (service && !failedClose)
    await service.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
