import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_COMMAND_SCHEMA_,
  type RuntimeCommand,
  type RuntimeCommandContext,
  type RuntimeCommandReceipt,
  type RuntimeNotification,
  type RuntimeQuery,
  type RuntimeQueryResult,
  type RuntimeSessionProjection,
} from '@kite-ai/runtime-contract';
import {
  createRuntimeHost,
  type RuntimeHostCommandInspection,
  type RuntimeHostCommandInspectionContext,
  type RuntimeHostExecutionBridge,
} from '@kite-ai/runtime-host';
import {
  createRuntimeStoredCommandReceipt,
  type RuntimeCommandCommitEvidence,
  type RuntimeCommandReceiptLookupInput,
  type RuntimeStorage,
  type RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import { testRuntimeModules, testStorage } from './helpers';

type StartCommand = Extract<RuntimeCommand, { type: 'start_turn' }>;

interface Harness {
  readonly records: Map<string, RuntimeStoredCommandReceipt>;
  readonly lookups: string[];
  readonly order: string[];
  readonly bridge: ReceiptBridge;
  readonly storage: RuntimeStorage;
}

interface ReceiptBridgeOptions {
  readonly commitGate?: Promise<void>;
  readonly commitFailure?: Error;
  readonly activationFailure?: Error;
  readonly mismatchPersistedRevision?: boolean;
  readonly terminal?: Exclude<RuntimeCommandReceipt, { readonly status: 'applied' }>;
  readonly withExecution?: boolean;
}

class ReceiptBridge implements RuntimeHostExecutionBridge {
  readonly inspections: RuntimeCommand[] = [];
  readonly commits: RuntimeCommandCommitEvidence[] = [];
  readonly recoveries: string[] = [];
  readonly inspectionContexts: RuntimeHostCommandInspectionContext[] = [];
  readonly #records: Map<string, RuntimeStoredCommandReceipt>;
  readonly #order: string[];
  readonly #options: ReceiptBridgeOptions;

  constructor(
    records: Map<string, RuntimeStoredCommandReceipt>,
    order: string[],
    options: ReceiptBridgeOptions = {},
  ) {
    this.#records = records;
    this.#order = order;
    this.#options = options;
  }

  async inspectCommand(
    command: RuntimeCommand,
    context: RuntimeHostCommandInspectionContext,
  ): Promise<RuntimeHostCommandInspection> {
    this.inspections.push(command);
    this.inspectionContexts.push(context);
    this.#order.push('inspect');
    if (this.#options.terminal) return { kind: 'terminal', receipt: this.#options.terminal };
    const targetSessionId = context.targetSessionId;
    return {
      kind: 'accepted',
      decision: {
        targetSessionId,
        commit: async (evidence) => {
          this.commits.push(evidence);
          this.#order.push('commit');
          await this.#options.commitGate;
          if (this.#options.commitFailure) throw this.#options.commitFailure;
          const revision = this.#options.mismatchPersistedRevision ? 2 : 1;
          this.#records.set(
            receiptKey(evidence),
            createRuntimeStoredCommandReceipt(evidence, revision),
          );
          const receipt = applied(command.commandId, targetSessionId, 1);
          return {
            receipt,
            activation: async (_publish) => {
              this.#order.push('activate');
              if (this.#options.activationFailure) throw this.#options.activationFailure;
            },
            ...(this.#options.withExecution
              ? {
                  preparedExecution: {
                    execution: {
                      sessionId: targetSessionId,
                      operationId: command.commandId,
                      committedRevision: 1,
                      operation: 'turn' as const,
                      run: async () => {
                        this.#order.push('schedule');
                      },
                    },
                  },
                }
              : {}),
          };
        },
      },
    };
  }

  recoverSession(
    sessionId: string,
    _publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    this.recoveries.push(sessionId);
    this.#order.push('recover');
    return Promise.resolve();
  }

  query(query: RuntimeQuery): Promise<RuntimeQueryResult> {
    if (query.type === 'list_sessions') {
      return Promise.resolve({ status: 'ok', queryType: query.type, sessions: [] });
    }
    if (query.type === 'get_session_projection') {
      return Promise.resolve({
        status: 'ok',
        queryType: query.type,
        revision: 0,
        session: projection(query.sessionId),
      });
    }
    return Promise.resolve({ status: 'rejected', queryType: query.type, code: 'unsupported' });
  }

  shutdownSession(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function harness(options: ReceiptBridgeOptions = {}): Harness {
  const records = new Map<string, RuntimeStoredCommandReceipt>();
  const lookups: string[] = [];
  const order: string[] = [];
  const bridge = new ReceiptBridge(records, order, options);
  const storage = {
    ...testStorage(),
    commandReceipts: {
      lookup(input: RuntimeCommandReceiptLookupInput) {
        lookups.push('lookup');
        order.push('lookup');
        const record = records.get(receiptKey(input));
        if (!record) return { status: 'missing' as const };
        return {
          status: record.requestDigest === input.requestDigest ? 'replay' : 'digest_mismatch',
          receipt: record,
        };
      },
    },
  } as RuntimeStorage;
  return { records, lookups, order, bridge, storage };
}

describe('Host persistent receipt command flow', () => {
  test('looks up before recovery and inspection, then commits before activation and schedule', async () => {
    const h = harness({ withExecution: true });
    const host = createRuntimeHost({
      storage: h.storage,
      modules: testRuntimeModules(() => h.bridge),
    });

    await expect(host.command(startCommand())).resolves.toEqual(
      applied('command-1', 'session-1', 1),
    );
    await host.waitForSessionIdle('session-1');
    expect(h.order).toEqual([
      'lookup',
      'lookup',
      'recover',
      'inspect',
      'commit',
      'lookup',
      'activate',
      'schedule',
    ]);
    expect(h.lookups).toEqual(['lookup', 'lookup', 'lookup']);
    expect(h.lookups.length).toBeGreaterThan(0);
    expect(h.bridge.inspections).toHaveLength(1);
    await host[Symbol.asyncDispose]();
  });

  test('replays a new Host receipt without inspecting, committing, or scheduling', async () => {
    const first = harness();
    const firstHost = createRuntimeHost({
      storage: first.storage,
      modules: testRuntimeModules(() => first.bridge),
    });
    await firstHost.command(startCommand());
    await firstHost[Symbol.asyncDispose]();

    const second = harness();
    for (const [key, value] of first.records) second.records.set(key, value);
    const secondHost = createRuntimeHost({
      storage: second.storage,
      modules: testRuntimeModules(() => second.bridge),
    });
    await expect(secondHost.command(startCommand())).resolves.toEqual({
      status: 'idempotent_replay',
      commandId: 'command-1',
      sessionId: 'session-1',
      originalRevision: 1,
    });
    expect(second.bridge.inspections).toHaveLength(0);
    expect(second.bridge.commits).toHaveLength(0);
    expect(second.order).toEqual(['lookup']);
    await secondHost[Symbol.asyncDispose]();
  });

  test('passes Host-derived content-free create and fork targets to inspection', async () => {
    const h = harness();
    const host = createRuntimeHost({
      storage: h.storage,
      modules: testRuntimeModules(() => h.bridge),
    });
    await host.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'create-1',
      type: 'create_session',
      workspace: '/untrusted-wire-workspace',
    });
    await host.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'fork-1',
      type: 'fork_session',
      sourceSessionId: 'source-session',
      sourceRevision: 0,
    });

    expect(h.bridge.inspectionContexts[0]?.targetSessionId).toMatch(/^create_[a-f0-9]{64}$/u);
    expect(h.bridge.inspectionContexts[1]?.targetSessionId).toMatch(/^fork_[a-f0-9]{64}$/u);
    expect(h.bridge.inspectionContexts[0]?.targetSessionId).not.toContain(':');
    await host[Symbol.asyncDispose]();
  });

  test('pins the admission command context into Host inspection without Session lookup', async () => {
    const h = harness();
    const host = createRuntimeHost({
      storage: h.storage,
      modules: testRuntimeModules(() => h.bridge),
    });
    const context: RuntimeCommandContext = {
      schema: 'kite.runtime-command-context.v1',
      connectionId: 'connection-7',
      requestId: 'rpc-7',
      bindingReference: 'binding-7',
    };

    await host.command(startCommand(), context);

    expect(h.bridge.inspectionContexts[0]?.commandContext).toEqual(context);
    expect(Object.isFrozen(h.bridge.inspectionContexts[0]?.commandContext)).toBeTrue();
    await host[Symbol.asyncDispose]();
  });

  test('coalesces same-digest pending calls into a durable replay and rejects a different digest', async () => {
    let release!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ commitGate });
    const host = createRuntimeHost({
      storage: h.storage,
      modules: testRuntimeModules(() => h.bridge),
    });
    const first = host.command(startCommand());
    const same = host.command(startCommand());
    const different = host.command(startCommand('different'));

    await expect(different).resolves.toEqual({
      status: 'rejected',
      commandId: 'command-1',
      code: 'invalid_command',
    });
    release();
    await expect(first).resolves.toEqual(applied('command-1', 'session-1', 1));
    await expect(same).resolves.toMatchObject({ status: 'idempotent_replay' });
    expect(h.bridge.inspections).toHaveLength(1);
    await host[Symbol.asyncDispose]();
  });

  test('does not activate or schedule after a failed commit or persisted/returned mismatch', async () => {
    for (const options of [
      { commitFailure: new Error('commit failed') },
      { mismatchPersistedRevision: true },
    ]) {
      const h = harness(options);
      const host = createRuntimeHost({
        storage: h.storage,
        modules: testRuntimeModules(() => h.bridge),
      });
      await expect(host.command(startCommand())).rejects.toThrow();
      expect(h.order).not.toContain('activate');
      expect(h.order).not.toContain('schedule');
      await host[Symbol.asyncDispose]();
    }
  });

  test('replays a receipt after activation fails without re-inspection or reactivation', async () => {
    const h = harness({ activationFailure: new Error('response failed') });
    const host = createRuntimeHost({
      storage: h.storage,
      modules: testRuntimeModules(() => h.bridge),
    });

    await expect(host.command(startCommand())).rejects.toThrow('response failed');
    await host[Symbol.asyncDispose]();
    const restarted = harness();
    for (const [key, value] of h.records) restarted.records.set(key, value);
    const restartedHost = createRuntimeHost({
      storage: restarted.storage,
      modules: testRuntimeModules(() => restarted.bridge),
    });
    await expect(restartedHost.command(startCommand())).resolves.toMatchObject({
      status: 'idempotent_replay',
    });
    expect(h.bridge.inspections).toHaveLength(1);
    expect(h.bridge.commits).toHaveLength(1);
    expect(h.order.filter((entry) => entry === 'activate')).toHaveLength(1);
    expect(restarted.bridge.recoveries).toEqual([]);
    await restartedHost[Symbol.asyncDispose]();
  });

  test('does not persist terminal non-applied receipts', async () => {
    const h = harness({
      terminal: { status: 'rejected', commandId: 'command-1', code: 'policy_denied' },
    });
    const host = createRuntimeHost({
      storage: h.storage,
      modules: testRuntimeModules(() => h.bridge),
    });

    await expect(host.command(startCommand())).resolves.toEqual({
      status: 'rejected',
      commandId: 'command-1',
      code: 'policy_denied',
    });
    expect(h.records).toHaveLength(0);
    expect(h.bridge.commits).toHaveLength(0);
    await host[Symbol.asyncDispose]();
  });

  test('keeps command IDs scoped by session', async () => {
    const h = harness();
    const host = createRuntimeHost({
      storage: h.storage,
      modules: testRuntimeModules(() => h.bridge),
    });
    await host.command({ ...startCommand(), sessionId: 'session-a' });
    await host.command({ ...startCommand(), sessionId: 'session-b' });
    expect(h.records).toHaveLength(2);
    expect(h.bridge.inspections).toHaveLength(2);
    await host[Symbol.asyncDispose]();
  });
});

function startCommand(input = 'hello'): StartCommand {
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId: 'command-1',
    type: 'start_turn',
    sessionId: 'session-1',
    expectedRevision: 0,
    input,
  };
}

function applied(commandId: string, sessionId: string, revision: number) {
  return { status: 'applied' as const, commandId, sessionId, revision };
}

function projection(sessionId: string): RuntimeSessionProjection {
  return {
    schema: 'kite.runtime-projection.v1',
    sessionId,
    revision: 0,
    lifecycle: 'open',
    interactionQueue: { revision: 0, interactions: [] },
  };
}

function receiptKey(
  input: Pick<RuntimeCommandCommitEvidence, 'scopeSessionId' | 'commandId'>,
): string {
  return `${input.scopeSessionId}\u0000${input.commandId}`;
}
