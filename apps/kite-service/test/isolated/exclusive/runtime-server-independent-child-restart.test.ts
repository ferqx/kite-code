import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childThreadIdForToolAttempt } from '@kite-ai/agent-kernel';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../../tests/tui-system/harness/fixtures';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../../src/bootstrap';

test('default Store11 App Server resumes one accepted independent child after process restart', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-child-restart-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(home, 'kite-session.sqlite');
  const marker = join(home, 'accepted.marker');
  const parentSessionId = 'child-restart-parent';
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = createMockModelServer();
  const childGate = deferred();
  let parentRequests = 0;
  let childRequests = 0;
  model.setResponses(
    Array.from({ length: 8 }, () => ({
      response: async ({ messages }: { messages: readonly unknown[] }) => {
        const transcript = JSON.stringify(messages);
        if (transcript.includes('RESTART_CHILD_TASK') && !transcript.includes('RESTART_PARENT')) {
          childRequests += 1;
          await childGate.promise;
          return { message: { content: 'RESTART_CHILD_RESULT' } };
        }
        parentRequests += 1;
        if (parentRequests === 1)
          return {
            message: {
              tool_calls: [
                {
                  id: 'restart-child-task',
                  name: 'task',
                  args: {
                    name: 'Restart reviewer',
                    subagent_type: 'review',
                    task: 'RESTART_CHILD_TASK',
                    background: true,
                    result_disposition: 'required',
                  },
                },
              ],
            },
            toolContinuation: 'required' as const,
          };
        expect(transcript).toContain('<subagent_result task_id=');
        expect(transcript).toContain('RESTART_CHILD_RESULT');
        return {
          message: { content: 'RESTART_PARENT_FINISHED' },
          expectedRequest: { toolResults: [{ toolCallId: 'restart-child-task' }] },
        };
      },
    })),
  );
  const crashed = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '../runtime-server-independent-child-restart-fixture.ts'),
      home,
      workspace,
      model.baseURL,
      marker,
    ],
    { cwd: join(import.meta.dir, '../../../../..'), stdout: 'pipe', stderr: 'pipe' },
  );
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let client: RuntimeClient | undefined;
  try {
    await until(() => existsSync(marker));
    crashed.kill('SIGKILL');
    await crashed.exited;
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'child-restart-recovered-host',
      executionLeaseMs: 150,
      renewIntervalMs: 40,
    });
    const dispatch = storage.storage.sessions
      .loadEventsStrict(parentSessionId)
      .find(({ event }) => event.type === 'capability.subagent_dispatch_intent_recorded')?.event;
    if (dispatch?.type !== 'capability.subagent_dispatch_intent_recorded')
      throw new Error('Crash fixture did not persist its accepted child intent.');
    const childThreadId = childThreadIdForToolAttempt({
      parentSessionId,
      parentInvocationId: dispatch.invocationId,
      parentToolCallId: 'restart-child-task',
      attempt: dispatch.attempt,
    });
    const before = storage.readChildSessionIntent(childThreadId);
    expect(before).toMatchObject({
      parentSessionId,
      childThreadId,
      childSessionCreated: false,
      dispatchAckEventId: null,
    });
    const parentBefore = storage.loadCurrentSnapshot(parentSessionId);
    expect(
      parentBefore?.resourceBudget.status === 'active'
        ? parentBefore.resourceBudget.reservations[before!.delegatedReservationId]?.state
        : undefined,
    ).toBe('reserved');
    const admission: RuntimeServerAdmissionPort = Object.freeze({
      authorize: async (_request: RuntimeServerAdmissionInput) => ({
        allowed: true as const,
        workspace,
      }),
    });
    server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'child-restart-user',
          workspace,
          config: {
            providerName: 'child-restart-model',
            providerType: 'openai-compatible' as const,
            apiKey: 'fixture-key',
            baseURL: model.baseURL,
            modelName: 'mock-model',
            modelKwargs: { maxOutputTokens: 64 },
            modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
            features: { resourceBudget: true },
            sandbox: { enabled: false },
          },
          shellExecutor: async ({ command }: { command: string }) => ({
            ok: true as const,
            command,
            exitCode: 0,
            stdout: '',
            stderr: '',
          }),
          interactionMode: 'accept_edits' as const,
          sandboxBackend: 'none' as const,
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
    const currentServer = server;
    const transport: RuntimeClientTransport = Object.freeze({
      connect: async () => {
        const pair = currentServer.open({ admission });
        return Object.freeze({
          send: (message: RuntimeProtocolMessage) => pair.client.send(message),
          messages: () => pair.client.messages(),
          close: (reason?: string) => pair.client.close(reason),
        });
      },
    });
    client = new RuntimeClient({
      transport,
      clientInfo: { name: 'child-restart-test', version: '1', instanceId: 'client' },
    });
    await client.connect();
    await Bun.sleep(200);
    const resumed = await Promise.race([
      client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'resume_session',
        commandId: 'child-restart-resume',
        sessionId: parentSessionId,
      }),
      Bun.sleep(2_000).then(() => {
        throw new Error('Parent resume command waited for child completion.');
      }),
    ]);
    if (resumed.status !== 'applied')
      throw new Error(`Restart parent could not resume: ${JSON.stringify(resumed)}`);
    const whileChildRuns = <T>(work: Promise<T>): Promise<T> =>
      Promise.race([
        work,
        Bun.sleep(2_000).then(() => {
          throw new Error('Recovered parent query waited for the child model.');
        }),
      ]);
    const first = await whileChildRuns(
      client.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'list_background_executions',
        sessionId: parentSessionId,
      }),
    );
    expect(first.status).toBe('ok');
    await until(() => childRequests === 1).catch(() => {
      const diagnostic = JSON.stringify({
        childRequests,
        parentRequests,
        childSessionCreated: storage!.readChildSessionIntent(childThreadId)?.childSessionCreated,
        parentEventTypes: storage!.storage.sessions
          .loadEventsStrict(parentSessionId)
          .map(({ event }) => event.type),
      });
      throw new Error(`Child was not dispatched after parent resume: ${diagnostic}`);
    });
    expect(storage.readChildSessionIntent(childThreadId)?.childSessionCreated).toBe(true);
    expect(
      await whileChildRuns(
        client.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'get_session_projection',
          sessionId: parentSessionId,
        }),
      ),
    ).toMatchObject({ status: 'ok' });
    childGate.resolve();
    await until(() =>
      storage!.storage.sessions
        .loadEventsStrict(parentSessionId)
        .some(({ event }) => event.type === 'run.completed'),
    );
    const events = storage.storage.sessions
      .loadEventsStrict(parentSessionId)
      .map(({ event }) => event);
    expect(
      events.filter((event) => event.type === 'subagent.child_terminal_imported'),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'subagent.background_result_persisted'),
    ).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent.background_result_persisted',
        childTerminalStatus: 'completed',
      }),
    );
    expect(storage.loadCurrentSnapshot(childThreadId)?.childSessionOrigin?.terminal?.status).toBe(
      'completed',
    );
    expect(childRequests).toBe(1);
    expect(parentRequests).toBe(2);
    expect(events.filter((event) => event.type === 'run.completed')).toHaveLength(1);
    model.assertComplete({ allowUnconsumedResponses: true });
  } finally {
    childGate.resolve();
    if (crashed.exitCode === null) crashed.kill('SIGKILL');
    await crashed.exited;
    await client?.close();
    await server?.cancelAllSessions('Restart test cleanup.');
    await server?.[Symbol.asyncDispose]();
    storage?.disposeStorage();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error('Child restart did not cross the expected boundary.');
}
