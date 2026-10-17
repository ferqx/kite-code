import { mock } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentRuntime } from '@kite-ai/agent';
import * as filesModule from '@kite-ai/agent/files';
import { selectProfile } from '@kite-ai/agent/profile';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createWorkspaceAssembly } from '../../src/assembly';
import { createPermissionManagement } from '../../src/permission-management';
import { assembleProcessService } from '../../src/process-service';

// Only the parent retires this owned process and its deliberately retained handle.
process.once('SIGTERM', () => process.exit(143));
process.stdin.setEncoding('utf8');
let exitInput = '';
process.stdin.on('data', (chunk: string) => {
  exitInput += chunk;
  if (exitInput === 'exit\n') process.exit(0);
  else if (!'exit\n'.startsWith(exitInput)) process.exit(2);
});
process.stdin.once('end', () => process.exit(0));
const realFiles = { ...filesModule };
let originalFiles: filesModule.WorkspaceFiles | undefined;
let closeAttempts = 0;
const cleanupFailure = Object.assign(Error('fixture original directory close rejected'), {
  code: 'fixture_original_directory_close_failed',
});
mock.module('@kite-ai/agent/files', () => ({
  ...realFiles,
  createWorkspaceFiles(options: Parameters<typeof realFiles.createWorkspaceFiles>[0]) {
    if (originalFiles) throw Error('unexpected second directory owner');
    const files = realFiles.createWorkspaceFiles(options);
    originalFiles = files;
    files.close = async () => {
      closeAttempts++;
      // Reject before invoking the real close, preserving the actual directory owner.
      throw cleanupFailure;
    };
    return files;
  },
}));
const profile = selectProfile({ dataRoot: process.argv[2]!, profile: 'test' });
privateDirectory(profile.profilePath);
const workspaceRoot = join(profile.dataRoot, 'workspace');
privateDirectory(workspaceRoot);
const fileBody = '原实际目录内容 中🙂e\u0301\r\n完整第二行';
writeFileSync(join(workspaceRoot, 'original.txt'), fileBody, { mode: 0o600 });
const model = createFixedModel([]);
let resolutions = 0;
let preparationError: unknown;
let runtime: AgentRuntime | undefined;
let service: Awaited<ReturnType<typeof assembleProcessService>> | undefined;
let client: ReturnType<typeof createClient> | undefined;
let retained = false;
const describeError = (error: unknown) =>
  error instanceof Error
    ? { code: 'code' in error ? error.code : null, message: error.message }
    : null;
try {
  service = await assembleProcessService(
    {
      profile: {
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        profileAccessKey: profile.profileAccessKey,
      },
      instanceId: 'preparation-original',
      buildId: 'fixed',
      token: 'c'.repeat(64),
    },
    {
      configure() {
        return {
          model,
          modelId: 'fixed',
          permissions: {
            async authorize() {
              return { allowed: true, revision: 'trusted-fixture' };
            },
          },
          async resolveRunConfiguration({ workspace }) {
            resolutions++;
            try {
              await createWorkspaceAssembly({
                workspaceRoot: fileURLToPath(workspace.rootUri),
                profile,
                toolIds: ['files.read'],
                selectedSkills: ['required-missing-skill'],
              });
              throw Error('required missing Skill unexpectedly prepared');
            } catch (error) {
              preparationError = error;
              throw error;
            }
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
  const expectedStoreId = service.bootstrap.storeId!;
  await client.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(workspaceRoot).href,
    name: 'original',
  });
  await client.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'original',
  });
  const input = 'Original preparation user data 中🙂e\u0301\r\n原第二行';
  await client.startRun('s', {
    expectedStoreId,
    commandId: 'work',
    kind: 'run.start',
    content: input,
  });
  const deadline = Date.now() + 2500;
  for (;;) {
    const command = await client.getCommand('work');
    if (command?.status === 'rejected') break;
    if (Date.now() >= deadline) throw Error('original preparation fixture deadline');
    await Bun.sleep(5);
  }
  if (!runtime || !originalFiles) throw Error('original preparation owner missing');
  const storedView = await runtime.getView('s');
  const metadata = await runtime.getMetadata();
  const command = await runtime.getCommand('work');
  const messages = await runtime.listMessages('s', { limit: 200 });
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
  const fileContent = (await originalFiles.read('original.txt')).content;
  const cause =
    preparationError instanceof Error && 'cause' in preparationError
      ? (preparationError.cause as { originalError?: unknown; cleanupError?: unknown })
      : undefined;
  retained = true;
  console.log(
    JSON.stringify({
      pid: process.pid,
      input,
      fileBody,
      fileContent,
      resolutions,
      closeAttempts,
      modelCalls: model.requests.length,
      preparationCode: describeError(preparationError)?.code ?? null,
      originalCode: describeError(cause?.originalError)?.code ?? null,
      originalCleanupCause: cause?.cleanupError === cleanupFailure,
      storedView,
      metadata,
      command,
      messages,
      executions: storedView.executions,
      sameClose,
      lifecycle: runtime.getLifecycleState(),
      runtimeError: describeError(runtimeError),
      error: describeError(error),
    }),
  );
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  client?.disposeNetwork();
  if (service && !retained)
    await service.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
