import { describe, expect, test } from 'bun:test';
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
import {
  RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
  type RuntimeHostExecutionBridge,
} from '@kite-ai/runtime-host';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';
import { createKiteRuntimeExecutionModule } from '../src/bootstrap';
import { KITE_RUNTIME_OPERATION_IDS_ } from '../src/bootstrap/runtime/KiteRuntimeExecutionModule';

function createBridge(handler: {
  recoverSession: RuntimeHostExecutionBridge['recoverSession'];
  inspectCommand: RuntimeHostExecutionBridge['inspectCommand'];
  query: RuntimeHostExecutionBridge['query'];
  shutdownSession: RuntimeHostExecutionBridge['shutdownSession'];
  close: RuntimeHostExecutionBridge['close'];
}): RuntimeHostExecutionBridge {
  return {
    recoverSession: handler.recoverSession,
    inspectCommand: handler.inspectCommand,
    query: handler.query,
    shutdownSession: handler.shutdownSession,
    close: handler.close,
  };
}

describe('Kite Runtime execution bridge', () => {
  test('is selected only through the exact App execution module registration', async () => {
    const bridge = createBridge({
      recoverSession: async () => undefined,
      inspectCommand: async (command) => ({
        kind: 'terminal',
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
      executionAdapterId: RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
      createBridge: (_context: { readonly marker: true }) => bridge,
    });
    const registry = createRuntimeModuleRegistry([module]);

    expect(module.manifest).toMatchObject({
      moduleId: 'kite-runtime-execution',
      providerId: 'kite-runtime-execution',
      revision: 'app-runtime-current',
      contractRevision: 'runtime-contract-current',
      operationIds: KITE_RUNTIME_OPERATION_IDS_,
    });
    expect(
      registry
        .requireExecutionAdapter<{ readonly marker: true }, RuntimeHostExecutionBridge>(
          RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
        )
        .create({ marker: true }),
    ).toBe(bridge);
    await registry.dispose();
  });

  test('forwards each inspection exactly once without publishing from the pure phase', async () => {
    let calls = 0;
    const bridge = createBridge({
      recoverSession: async () => undefined,
      inspectCommand: async (command) => {
        calls += 1;
        return {
          kind: 'terminal',
          receipt: { status: 'rejected', commandId: command.commandId, code: 'unsupported' },
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
    expect(
      await bridge.inspectCommand(
        {
          schema: RUNTIME_COMMAND_SCHEMA_,
          commandId: 'command-1',
          type: 'create_session',
          workspace: '/workspace',
        },
        { targetSessionId: 'session-1' },
      ),
    ).toEqual({
      kind: 'terminal',
      receipt: { status: 'rejected', commandId: 'command-1', code: 'unsupported' },
    });
    expect(calls).toBe(1);
  });

  test('forwards queries without receipt, history, or fallback ownership', async () => {
    const bridge = createBridge({
      recoverSession: async () => undefined,
      inspectCommand: async (command) => ({
        kind: 'terminal',
        receipt: { status: 'rejected', commandId: command.commandId, code: 'unsupported' },
      }),
      query: async (query) => ({ status: 'ok', queryType: query.type, sessions: [] }),
      shutdownSession: async () => undefined,
      close: async () => undefined,
    });
    expect(await bridge.query({ schema: RUNTIME_QUERY_SCHEMA_, type: 'list_sessions' })).toEqual({
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
      inspectCommand: async (_command, context) => ({
        kind: 'accepted',
        decision: {
          targetSessionId: context.targetSessionId,
          commit: async () => ({
            receipt: {
              status: 'applied',
              commandId: 'command-1',
              sessionId: 'session-1',
              revision: 4,
            },
            preparedExecution: { execution: prepared },
          }),
        },
      }),
      query: async (query) => ({
        status: 'rejected',
        queryType: query.type,
        code: 'unsupported',
      }),
      shutdownSession: async () => undefined,
      close: async () => undefined,
    });
    const inspected = await bridge.inspectCommand(
      {
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'command-1',
        type: 'start_turn',
        sessionId: 'session-1',
        expectedRevision: 3,
        input: 'run',
      },
      { targetSessionId: 'session-1' },
    );
    if (inspected.kind !== 'accepted') throw new Error('Expected accepted inspection.');
    const result = await inspected.decision.commit({
      scopeSessionId: 'session-1',
      commandId: 'command-1',
      requestDigest: 'a'.repeat(64),
      targetSessionId: 'session-1',
      committedAt: 1,
    });
    expect(result.preparedExecution?.execution).toBe(prepared);
    await result.preparedExecution?.execution?.run(new AbortController().signal, () => undefined);
    expect(calls).toBe(1);
  });
});
