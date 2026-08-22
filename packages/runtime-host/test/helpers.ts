import {
  RUNTIME_PROJECTION_SCHEMA_V1,
  type RuntimeCommand,
  type RuntimeCommandReceipt,
  type RuntimeNotification,
  type RuntimeQuery,
  type RuntimeQueryResult,
  type RuntimeSessionProjection,
} from '@kite/runtime-contract';
import {
  RUNTIME_HOST_EXECUTION_ADAPTER_ID_V1,
  type RuntimeHostExecutionBridge,
  type RuntimeHostExecutionServices,
  type RuntimeHostKernelInput,
  type RuntimeHostPreparedExecution,
  runtimeCommandFromKernelInput,
} from '@kite/runtime-host';
import type { RuntimeStorage } from '@kite/runtime-host/storage';
import { defineRuntimeModuleV1, type RuntimeModuleV1 } from '@kite/runtime-spi';

export function projection(sessionId: string, revision: number): RuntimeSessionProjection {
  return {
    schema: RUNTIME_PROJECTION_SCHEMA_V1,
    sessionId,
    revision,
    workspace: `/workspace/${sessionId}`,
    lifecycle: 'open',
  };
}

export class TestExecutionBridge implements RuntimeHostExecutionBridge {
  readonly projections = new Map<string, RuntimeSessionProjection>();
  readonly calls: RuntimeCommand[] = [];
  readonly recoveries: string[] = [];
  commandImplementation?: (
    command: RuntimeCommand,
    publish: (notification: RuntimeNotification) => void,
  ) => Promise<RuntimeCommandReceipt>;
  prepareImplementation?: (
    command: RuntimeCommand,
    publish: (notification: RuntimeNotification) => void,
  ) => Promise<RuntimeHostPreparedExecution>;
  shutdownImplementation?: (sessionId: string, reason: string) => Promise<void>;
  closeImplementation?: () => Promise<void>;
  recoverImplementation?: (sessionId: string) => Promise<void>;

  recoverSession(sessionId: string): Promise<void> {
    this.recoveries.push(sessionId);
    return this.recoverImplementation?.(sessionId) ?? Promise.resolve();
  }

  async prepare(
    input: RuntimeHostKernelInput,
    publish: (notification: RuntimeNotification) => void,
  ) {
    const command = runtimeCommandFromKernelInput(input);
    this.calls.push(command);
    if (this.prepareImplementation) return this.prepareImplementation(command, publish);
    const receipt = this.commandImplementation
      ? await this.commandImplementation(command, publish)
      : ({
          status: 'rejected',
          commandId: command.commandId,
          code: 'unsupported',
        } satisfies RuntimeCommandReceipt);
    return { receipt };
  }

  shutdownSession(sessionId: string, reason: string): Promise<void> {
    return this.shutdownImplementation?.(sessionId, reason) ?? Promise.resolve();
  }

  close(): Promise<void> {
    return this.closeImplementation?.() ?? Promise.resolve();
  }

  query(query: RuntimeQuery): Promise<RuntimeQueryResult> {
    if (query.type === 'list_sessions') {
      return Promise.resolve({
        status: 'ok',
        queryType: query.type,
        sessions: [...this.projections.values()],
      });
    }
    if (query.type === 'get_session_projection') {
      const session = this.projections.get(query.sessionId);
      return Promise.resolve(
        session
          ? { status: 'ok', queryType: query.type, revision: session.revision, session }
          : { status: 'not_found', queryType: query.type, code: 'session_not_found' },
      );
    }
    return Promise.resolve({
      status: 'rejected',
      queryType: query.type,
      code: 'unsupported',
    });
  }
}

export function testStorage(onClose: () => void = () => undefined): RuntimeStorage {
  return {
    adapterId: 'test',
    stateSchemaVersion: 25,
    storeSchemaVersion: 4,
    compatibilityEpoch: 'kite-runtime-2026-08-18',
    close: onClose,
  } as unknown as RuntimeStorage;
}

export function testRuntimeModules(
  createBridge: (services: RuntimeHostExecutionServices) => RuntimeHostExecutionBridge,
  lifecycle: {
    readonly start?: () => Promise<void>;
    readonly dispose?: () => Promise<void>;
  } = {},
): readonly RuntimeModuleV1[] {
  return [
    defineRuntimeModuleV1({
      moduleId: 'test-module',
      revision: '1',
      register: (registry) => {
        registry.registerExecutionAdapter({
          adapterId: RUNTIME_HOST_EXECUTION_ADAPTER_ID_V1,
          revision: '1',
          create: ({ services }: { readonly services: RuntimeHostExecutionServices }) =>
            createBridge(services),
        });
      },
      ...(lifecycle.start ? { start: lifecycle.start } : {}),
      ...(lifecycle.dispose ? { dispose: lifecycle.dispose } : {}),
    }),
  ];
}

export function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
