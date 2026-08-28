import {
  RUNTIME_PROJECTION_SCHEMA_,
  type RuntimeCommand,
  type RuntimeCommandReceipt,
  type RuntimeNotification,
  type RuntimeQuery,
  type RuntimeQueryResult,
  type RuntimeSessionProjection,
} from '@kite-ai/runtime-contract';
import {
  RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
  type RuntimeHostCommandInspection,
  type RuntimeHostCommandInspectionContext,
  type RuntimeHostExecutionBridge,
  type RuntimeHostExecutionServices,
  type RuntimeHostPreparedExecution,
} from '@kite-ai/runtime-host';
import {
  type RuntimeHostKernelInput,
  runtimeCommandFromKernelInput,
  translateRuntimeCommandToKernelInput,
} from '@kite-ai/runtime-host/kernel-adapter';
import {
  createRuntimeStoredCommandReceipt,
  type RuntimeCommandReceiptLookupInput,
  type RuntimeSessionDeletionInput,
  type RuntimeStorage,
  type RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import { defineRuntimeModule, type RuntimeModule } from '@kite-ai/runtime-spi';

export function projection(sessionId: string, revision: number): RuntimeSessionProjection {
  return {
    schema: RUNTIME_PROJECTION_SCHEMA_,
    sessionId,
    revision,
    workspace: `/workspace/${sessionId}`,
    lifecycle: 'open',
    interactionQueue: { revision, interactions: [] },
  };
}

const testCommandReceipts = new Map<string, RuntimeStoredCommandReceipt>();

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
  ) => Promise<{
    readonly receipt: RuntimeCommandReceipt;
    readonly execution?: RuntimeHostPreparedExecution['execution'];
  }>;
  shutdownImplementation?: (sessionId: string, reason: string) => Promise<void>;
  closeImplementation?: () => Promise<void>;
  recoverImplementation?: (sessionId: string) => Promise<void>;

  constructor() {
    testCommandReceipts.clear();
  }

  async inspectCommand(
    command: RuntimeCommand,
    context: RuntimeHostCommandInspectionContext,
  ): Promise<RuntimeHostCommandInspection> {
    return {
      kind: 'accepted',
      decision: {
        targetSessionId: context.targetSessionId,
        commit: async (evidence) => {
          const prepared = await this.prepare(
            translateRuntimeCommandToKernelInput(command),
            () => {},
          );
          if (prepared.receipt.status !== 'applied') {
            throw new Error(
              'Test execution bridge legacy command did not produce an applied receipt.',
            );
          }
          testCommandReceipts.set(
            `${evidence.scopeSessionId}\u0000${evidence.commandId}`,
            createRuntimeStoredCommandReceipt(evidence, prepared.receipt.revision),
          );
          return {
            receipt: prepared.receipt,
            ...(prepared.execution ? { preparedExecution: { execution: prepared.execution } } : {}),
          };
        },
      },
    };
  }

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
    formatEpoch: 'kite-runtime-2026-08-18',
    commandReceipts: {
      lookup(input: RuntimeCommandReceiptLookupInput) {
        const receipt = testCommandReceipts.get(`${input.scopeSessionId}\u0000${input.commandId}`);
        if (!receipt) return { status: 'missing' as const };
        return {
          status: receipt.requestDigest === input.requestDigest ? 'replay' : 'digest_mismatch',
          receipt,
        };
      },
    },
    sessions: {
      deleteSession(_sessionId: string, deletion?: RuntimeSessionDeletionInput) {
        if (!deletion) return;
        testCommandReceipts.set(
          `${deletion.commandReceipt.scopeSessionId}\u0000${deletion.commandReceipt.commandId}`,
          deletion.commandReceipt,
        );
      },
    },
    close: onClose,
  } as unknown as RuntimeStorage;
}

export function testRuntimeModules(
  createBridge: (services: RuntimeHostExecutionServices) => RuntimeHostExecutionBridge,
  lifecycle: {
    readonly start?: () => Promise<void>;
    readonly dispose?: () => Promise<void>;
  } = {},
): readonly RuntimeModule[] {
  return [
    defineRuntimeModule({
      moduleId: 'test-module',
      revision: '1',
      register: (registry) => {
        registry.registerExecutionAdapter({
          adapterId: RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
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
