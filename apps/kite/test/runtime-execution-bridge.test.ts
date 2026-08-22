import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_COMMAND_SCHEMA_V1,
  RUNTIME_QUERY_SCHEMA_V1,
  type RuntimeCommand,
} from '@kite/runtime-contract';
import {
  RUNTIME_HOST_EXECUTION_ADAPTER_ID_V1,
  type RuntimeHostExecutionBridge,
  type RuntimeHostPreparedExecution,
  runtimeCommandFromKernelInput,
  translateRuntimeCommandToKernelInput,
} from '@kite/runtime-host';
import { createRuntimeModuleRegistryV1 } from '@kite/runtime-spi';
import {
  createKiteRuntimeExecutionModule,
  KITE_RUNTIME_OPERATION_IDS_V1,
} from '../src/bootstrap/runtime/KiteRuntimeExecutionModule';

function createBridge(handler: {
  recoverSession: RuntimeHostExecutionBridge['recoverSession'];
  prepare: (
    command: RuntimeCommand,
    publish: Parameters<RuntimeHostExecutionBridge['prepare']>[1],
  ) => Promise<RuntimeHostPreparedExecution>;
  query: RuntimeHostExecutionBridge['query'];
  shutdownSession: RuntimeHostExecutionBridge['shutdownSession'];
  close: RuntimeHostExecutionBridge['close'];
}): RuntimeHostExecutionBridge {
  return {
    recoverSession: handler.recoverSession,
    prepare: (input, publish) => handler.prepare(runtimeCommandFromKernelInput(input), publish),
    query: handler.query,
    shutdownSession: handler.shutdownSession,
    close: handler.close,
  };
}

describe('Kite Runtime execution bridge', () => {
  test('is selected only through the exact App execution module registration', async () => {
    const bridge = createBridge({
      recoverSession: async () => undefined,
      prepare: async (command) => ({
        receipt: { status: 'rejected', commandId: command.commandId, code: 'unsupported' },
      }),
      query: async (query) => ({
        status: 'rejected',
        queryType: query.type,
        code: 'unsupported',
      }),
      shutdownSession: async () => undefined,
      close: async () => undefined,
    });
    const module = createKiteRuntimeExecutionModule({
      executionAdapterId: RUNTIME_HOST_EXECUTION_ADAPTER_ID_V1,
      createBridge: (_context: { readonly marker: true }) => bridge,
    });
    const registry = createRuntimeModuleRegistryV1([module]);

    expect(module.manifest).toMatchObject({
      moduleId: 'kite-runtime-execution',
      providerId: 'kite-runtime-execution',
      revision: 'rmv1-16',
      contractRevision: 'rmv1-03',
      operationIds: KITE_RUNTIME_OPERATION_IDS_V1,
    });
    expect(
      registry
        .requireExecutionAdapter<{ readonly marker: true }, RuntimeHostExecutionBridge>(
          RUNTIME_HOST_EXECUTION_ADAPTER_ID_V1,
        )
        .create({ marker: true }),
    ).toBe(bridge);
    await registry.dispose();
  });

  test('forwards each command exactly once to the selected handler', async () => {
    let calls = 0;
    const bridge = createBridge({
      recoverSession: async () => undefined,
      prepare: async (command, publish) => {
        calls += 1;
        publish({
          schema: 'kite.runtime-notification.v1',
          durability: 'ephemeral',
          sessionId: 'session-1',
          workId: 'work-1',
          turnId: 'turn-1',
          actorId: 'agent-1',
          attemptId: 'attempt-1',
          compositionRevision: 'rav1-state26-store5',
          streamId: 'stream-1',
          sequence: 1,
          payload: { type: 'model_delta', text: 'partial' },
        });
        return {
          receipt: {
            status: 'applied',
            commandId: command.commandId,
            sessionId: 'session-1',
            revision: 1,
          },
        };
      },
      query: async (query) => ({
        status: 'rejected',
        queryType: query.type,
        code: 'unsupported',
      }),
      shutdownSession: async () => undefined,
      close: async () => undefined,
    });
    const notifications: unknown[] = [];
    expect(
      await bridge.prepare(
        translateRuntimeCommandToKernelInput({
          schema: RUNTIME_COMMAND_SCHEMA_V1,
          commandId: 'command-1',
          type: 'create_session',
          workspace: '/workspace',
          projectHandle: {
            version: 1,
            installationId: 'install-test',
            keyId: `sha256:${'1'.repeat(64)}`,
            project: {
              projectId: 'project_test',
              revision: 1,
              workspaceDigest: `sha256:${'2'.repeat(64)}`,
            },
            canonicalWorkspaceDigest: `sha256:${'2'.repeat(64)}`,
            bootstrapIdentity: 'command-1',
            issuedAt: '2026-08-22T00:00:00.000Z',
            expiresAt: '2026-08-22T00:05:00.000Z',
            nonce: 'nonce-1',
            authenticator: `hmac-sha256:${'3'.repeat(64)}`,
          },
        }),
        (notification) => notifications.push(notification),
      ),
    ).toEqual({
      receipt: {
        status: 'applied',
        commandId: 'command-1',
        sessionId: 'session-1',
        revision: 1,
      },
    });
    expect(calls).toBe(1);
    expect(notifications).toHaveLength(1);
  });

  test('forwards queries without receipt, history, or fallback ownership', async () => {
    const bridge = createBridge({
      recoverSession: async () => undefined,
      prepare: async (command) => ({
        receipt: { status: 'rejected', commandId: command.commandId, code: 'unsupported' },
      }),
      query: async (query) => ({ status: 'ok', queryType: query.type, sessions: [] }),
      shutdownSession: async () => undefined,
      close: async () => undefined,
    });
    expect(await bridge.query({ schema: RUNTIME_QUERY_SCHEMA_V1, type: 'list_sessions' })).toEqual({
      status: 'ok',
      queryType: 'list_sessions',
      sessions: [],
    });
  });

  test('forwards Host-committed prepared execution without a local adapter', async () => {
    let calls = 0;
    const prepared = {
      sessionId: 'session-1',
      operationId: 'command-1',
      operation: 'turn' as const,
      committedRevision: 4,
      run: async (signal: AbortSignal, requestAbort: (reason: string) => void) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(requestAbort).toBeFunction();
        calls += 1;
      },
    };
    const bridge = createBridge({
      recoverSession: async () => undefined,
      prepare: async (_command) => ({
        receipt: {
          status: 'applied',
          commandId: 'command-1',
          sessionId: 'session-1',
          revision: 4,
        },
        execution: prepared,
      }),
      query: async (query) => ({
        status: 'rejected',
        queryType: query.type,
        code: 'unsupported',
      }),
      shutdownSession: async () => undefined,
      close: async () => undefined,
    });
    const result = await bridge.prepare(
      translateRuntimeCommandToKernelInput({
        schema: RUNTIME_COMMAND_SCHEMA_V1,
        commandId: 'command-1',
        type: 'start_turn',
        sessionId: 'session-1',
        expectedRevision: 3,
        input: 'run',
      }),
      () => undefined,
    );
    expect(result.execution).toBe(prepared);
    await result.execution?.run(new AbortController().signal, () => undefined);
    expect(calls).toBe(1);
  });
});
