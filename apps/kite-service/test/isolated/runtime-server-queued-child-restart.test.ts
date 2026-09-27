import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeClient,
  RuntimeClientError,
  type RuntimeClientTransport,
} from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
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

test('full child capacity rejects a fourth request before SIGKILL without replaying attempted children', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-queued-child-restart-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(home, 'kite-session.sqlite');
  const marker = join(home, 'queued.marker');
  const parentSessionId = 'queued-child-restart-parent';
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = createMockModelServer();
  const gates = { A: deferred(), B: deferred(), C: deferred() };
  const childRequests = { A: 0, B: 0, C: 0, D: 0 };
  let parentRequests = 0;
  model.setResponses(
    Array.from({ length: 16 }, () => ({
      response: async ({ messages }: { messages: readonly unknown[] }) => {
        const transcript = JSON.stringify(messages);
        for (const label of ['A', 'B', 'C', 'D'] as const) {
          if (
            transcript.includes(`QUEUED_RESTART_CHILD_${label}`) &&
            !transcript.includes('QUEUED_RESTART_PARENT')
          ) {
            childRequests[label] += 1;
            if (label !== 'D') await gates[label].promise;
            return { message: { content: `QUEUED_RESTART_RESULT_${label}` } };
          }
        }
        parentRequests += 1;
        if (parentRequests === 1)
          return {
            message: {
              tool_calls: (['A', 'B', 'C', 'D'] as const).map((label) => ({
                id: `queued-restart-${label}`,
                name: 'task',
                args: {
                  name: `Queued ${label}`,
                  subagent_type: 'review',
                  task: `QUEUED_RESTART_CHILD_${label}`,
                  background: true,
                  result_disposition: 'required',
                },
              })),
            },
            toolContinuation: 'required' as const,
          };
        return {
          message: { content: 'Provisional final while required children remain.' },
          expectedRequest: {
            toolResults: (['A', 'B', 'C', 'D'] as const).map((label) => ({
              toolCallId: `queued-restart-${label}`,
            })),
          },
        };
      },
    })),
  );
  const crashed = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'runtime-server-queued-child-restart-fixture.ts'),
      home,
      workspace,
      model.baseURL,
      marker,
    ],
    { cwd: join(import.meta.dir, '../../../..'), stdout: 'pipe', stderr: 'pipe' },
  );
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let client: RuntimeClient | undefined;
  try {
    await until(() => existsSync(marker));
    const ids = JSON.parse(readFileSync(marker, 'utf8')) as { a: string; b: string; c: string };
    crashed.kill('SIGKILL');
    await crashed.exited;
    expect(childRequests).toEqual({ A: 1, B: 1, C: 1, D: 0 });
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'queued-child-recovered-host',
      executionLeaseMs: 150,
      renewIntervalMs: 40,
    });
    const parentBefore = storage.loadCurrentSnapshot(parentSessionId);
    expect(parentBefore?.resourceBudget.status).toBe('active');
    expect(storage.readChildSessionIntent(ids.c)?.childThreadId).toBe(ids.c);
    expect(storage.readSessionLineage(ids.c)).toEqual({ parentSessionId });
    expect(
      storage.storage.sessions
        .loadEventsStrict(parentSessionId)
        .find(
          ({ event }) => event.type === 'tool.finished' && event.toolCallId === 'queued-restart-D',
        )?.event,
    ).toMatchObject({
      result: {
        ok: false,
        stderr: expect.stringContaining('concurrency limit (3)'),
      },
    });
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
          userId: 'queued-child-user',
          workspace,
          config: {
            providerName: 'queued-child-model',
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
      clientInfo: { name: 'queued-child-restart-test', version: '1', instanceId: 'client' },
    });
    await client.connect();
    await Bun.sleep(200);
    let resumeFailedClosed = false;
    try {
      const resumed = await Promise.race([
        client.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'resume_session',
          commandId: 'queued-child-restart-resume',
          sessionId: parentSessionId,
        }),
        Bun.sleep(2_000).then(() => {
          throw new Error('Queued parent resume waited for child Provider completion.');
        }),
      ]);
      expect(['applied', 'conflict', 'unavailable']).toContain(resumed.status);
    } catch (error) {
      if (!(error instanceof RuntimeClientError)) throw error;
      expect(error.code).toBe('protocol_error');
      expect(error.protocol?.data).toMatchObject({ code: 'internal_error' });
      resumeFailedClosed = true;
    }
    await until(() =>
      storage!.storage.sessions
        .loadEventsStrict(parentSessionId)
        .some(({ event }) => event.type === 'resource_budget.unknown'),
    );
    await Bun.sleep(500);
    expect(storage.readChildSessionIntent(ids.c)?.childThreadId).toBe(ids.c);
    expect(childRequests).toEqual({ A: 1, B: 1, C: 1, D: 0 });
    for (const id of [ids.a, ids.b, ids.c])
      expect(
        storage.storage.sessions
          .loadEventsStrict(id)
          .filter(({ event }) => event.type === 'model.requested'),
      ).toHaveLength(1);
    expect(
      storage.storage.sessions
        .loadEventsStrict(parentSessionId)
        .filter(({ event }) => event.type === 'run.completed'),
    ).toHaveLength(0);
    const childSessions = storage.listChildSessions(parentSessionId, 10).entries;
    expect(childSessions.map((item) => item.sessionId)).toEqual(
      expect.arrayContaining([ids.a, ids.b, ids.c]),
    );
    expect(new Set(childSessions.map((item) => item.sessionId)).size).toBe(3);
    if (resumeFailedClosed)
      expect(storage.loadCurrentSnapshot(ids.c)?.childSessionOrigin?.terminal).toBeUndefined();
    expect(storage.readChildSessionIntent(ids.c)?.failureReceiptDigest).toBeNull();
    gates.A.resolve();
    gates.B.resolve();
    gates.C.resolve();
    await client.close();
    client = undefined;
    try {
      await server[Symbol.asyncDispose]();
    } catch (error) {
      expect(disposalMessage(error)).toContain('Independent child Session cleanup is unconfirmed.');
    }
    server = undefined;
    const afterShutdown = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'queued-child-after-shutdown-reader',
    });
    try {
      expect(afterShutdown.readChildSessionIntent(ids.c)?.failureReceiptDigest).toBeNull();
    } finally {
      afterShutdown.disposeStorage();
    }
  } finally {
    gates.A.resolve();
    gates.B.resolve();
    gates.C.resolve();
    if (crashed.exitCode === null) crashed.kill('SIGKILL');
    await crashed.exited;
    await client?.close();
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
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error('Queued child crash fixture did not reach its marker.');
}

function disposalMessage(error: unknown): string {
  return error instanceof AggregateError
    ? `${error.message} ${error.errors.map(disposalMessage).join(' ')}`
    : String(error);
}
