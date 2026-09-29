import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../src/bootstrap';
import { createPreparedAppShellExecutor } from '../../src/sandbox/composition';

test('workspace removal deletes history while live Shell cleanup continues', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-remove-live-shell-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const sessionId = 'workspace-live-shell';
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const model = createMockModelServer();
  const storage = await createKiteSessionAppServerStorageComposition({
    databasePath: join(root, 'kite-session.sqlite'),
    hostInstanceId: 'live-shell-host',
  });
  const started = deferred();
  const exited = deferred();
  const allowCleanup = deferred();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let abortObserved = false;
  let cleanupFinished = false;
  model.setResponses([
    {
      message: {
        tool_calls: [
          {
            id: 'live-shell-call',
            name: 'shell_execute',
            args: { command: 'exec sleep 60', yield_ms: 0 },
          },
        ],
      },
      toolContinuation: 'required',
    },
    { message: { content: 'Waiting for the Shell.' } },
  ]);
  const shellExecutor = createPreparedAppShellExecutor({
    workspace,
    sandboxEnabled: false,
    resolveBackend: () => 'none',
    createNativeExecutor: () => async () => {
      throw new Error('Host executor required.');
    },
    createHostExecutor:
      () =>
      async ({ command, signal }) => {
        child = Bun.spawn(['/bin/sh', '-c', command], {
          cwd: workspace,
          stdout: 'ignore',
          stderr: 'ignore',
        });
        const stop = () => {
          abortObserved = true;
          child?.kill('SIGTERM');
        };
        if (signal?.aborted) stop();
        else signal?.addEventListener('abort', stop, { once: true });
        started.resolve();
        await child.exited;
        exited.resolve();
        await allowCleanup.promise;
        cleanupFinished = true;
        signal?.removeEventListener('abort', stop);
        return {
          ok: false,
          command,
          exitCode: 130,
          stdout: '',
          stderr: '',
          terminationReason: 'cancelled' as const,
          processCleanup: {
            confirmedExited: true,
            gracefulRequested: true,
            forced: false,
            unconfirmedDescendantCount: 0,
          },
        };
      },
  });
  const server = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: join(root, 'kite-session.sqlite'),
    storageOwner: storage,
    workspaces: [
      {
        userId: 'mixed-stop-user',
        workspace,
        config: {
          providerName: 'mixed-stop-model',
          providerType: 'openai-compatible' as const,
          apiKey: 'fixture-key',
          baseURL: model.baseURL,
          modelName: 'mock-model',
          modelKwargs: { maxOutputTokens: 64 },
          modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
          features: { resourceBudget: true },
          sandbox: { enabled: true },
        },
        shellExecutor,
        interactionMode: 'full' as const,
        sandboxBackend: 'seatbelt' as const,
        skillOptions: {
          userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
          userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
          projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
          projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
        },
        initialSkillActivations: [],
      },
    ],
  });
  const admission: RuntimeServerAdmissionPort = Object.freeze({
    authorize: async (_request: RuntimeServerAdmissionInput) => ({
      allowed: true as const,
      workspace,
    }),
  });
  const client = new RuntimeClient({
    transport: Object.freeze({
      connect: async () => {
        const pair = server.open({ admission });
        return Object.freeze({
          send: (message: RuntimeProtocolMessage) => pair.client.send(message),
          messages: () => pair.client.messages(),
          close: (reason?: string) => pair.client.close(reason),
        });
      },
    }),
    clientInfo: { name: `workspace-live-shell`, version: '1', instanceId: 'client' },
  });

  try {
    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'live-create',
      workspace,
      bootstrapSessionId: sessionId,
    });
    expect(created.status).toBe('applied');
    if (created.status !== 'applied') throw new Error('Session creation failed.');
    expect(
      await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'start_turn',
        commandId: 'live-start',
        sessionId,
        expectedRevision: created.revision,
        input: 'Start the Shell.',
      }),
    ).toMatchObject({ status: 'applied' });
    await bounded(
      (async () => {
        while (true) {
          const projection = await client.query({
            schema: RUNTIME_QUERY_SCHEMA_,
            type: 'get_session_projection',
            sessionId,
          });
          const interaction =
            projection.status === 'ok'
              ? projection.session?.interactionQueue.interactions.find(
                  (entry) => entry.kind === 'approval',
                )
              : undefined;
          if (interaction?.kind === 'approval') {
            expect(
              await client.command({
                schema: RUNTIME_COMMAND_SCHEMA_,
                type: 'respond_interaction',
                commandId: 'approve-test-shell',
                sessionId,
                expectedRevision: interaction.sessionRevision,
                interaction,
                response: { kind: 'approval', decision: 'approve_once' },
              }),
            ).toMatchObject({ status: 'applied' });
            break;
          }
          await Bun.sleep(10);
        }
      })(),
    );
    await bounded(started.promise);
    let removalFinished = false;
    const removal = server
      .removeWorkspace({
        phase: 'remove',
        workspace,
        workspaceDigest: `sha256:${createHash('sha256').update(workspace).digest('hex')}`,
        token: 'live-shell-remove',
      })
      .then((result) => {
        removalFinished = true;
        return result;
      });
    // Attach a handler immediately so a regression does not leak an unhandled rejection.
    void removal.catch(() => {});
    expect(await bounded(removal)).toEqual({ deletedSessions: 1, token: 'live-shell-remove' });
    expect(abortObserved).toBe(true);
    expect(removalFinished).toBe(true);
    expect(cleanupFinished).toBe(false);
    expect(storage.storage.sessions.loadEventsStrict(sessionId)).toHaveLength(0);
    await bounded(exited.promise);
    allowCleanup.resolve();
    await bounded(
      (async () => {
        while (!cleanupFinished) await Bun.sleep(10);
      })(),
    );
    expect(cleanupFinished).toBe(true);
    expect(child?.signalCode).toBe('SIGTERM');
    await Bun.sleep(50);
    expect(
      await server.host.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId,
      }),
    ).toMatchObject({ status: 'not_found' });
    expect(storage.storage.sessions.loadEventsStrict(sessionId)).toHaveLength(0);
  } finally {
    allowCleanup.resolve();
    child?.kill();
    if (child) await child.exited;
    await client.close();
    await server[Symbol.asyncDispose]();
    storage.disposeStorage();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(10_000).then(() => {
      throw new Error('Timed out waiting for execution cleanup.');
    }),
  ]);
}
