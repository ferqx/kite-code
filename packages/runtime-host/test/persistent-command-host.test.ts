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
  for (const phase of ['revision', 'inspection'] as const) {
    test(`rechecks a competing policy receipt after ${phase} returns conflict`, async () => {
      const first = harness();
      const second = harness();
      const winner = createRuntimeHost({
        storage: first.storage,
        modules: testRuntimeModules(() => first.bridge),
      });
      const follower = createRuntimeHost({
        storage: first.storage,
        modules: testRuntimeModules(() => second.bridge),
      });
      const command = {
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: `policy-${phase}-race`,
        type: 'set_interaction_mode' as const,
        sessionId: 'session-1',
        expectedRevision: 0,
        mode: 'full' as const,
      };
      if (phase === 'revision') {
        const query = second.bridge.query.bind(second.bridge);
        second.bridge.query = async (request) => {
          if (request.type !== 'get_session_projection') return query(request);
          expect(await winner.command(command)).toMatchObject({ status: 'applied' });
          return {
            status: 'ok',
            queryType: request.type,
            revision: 1,
            session: { ...projection('session-1'), revision: 1 },
          };
        };
      } else {
        second.bridge.inspectCommand = async () => {
          expect(await winner.command(command)).toMatchObject({ status: 'applied' });
          return {
            kind: 'terminal',
            receipt: {
              status: 'conflict',
              commandId: command.commandId,
              code: 'revision_conflict',
              currentRevision: 1,
            },
          };
        };
      }
      try {
        expect(await follower.command(command)).toMatchObject({
          status: 'idempotent_replay',
          originalRevision: 1,
        });
        expect(first.bridge.commits).toHaveLength(1);
        expect(second.bridge.commits).toHaveLength(0);
        expect(second.bridge.recoveries).toEqual([]);
      } finally {
        await follower[Symbol.asyncDispose]();
        await winner[Symbol.asyncDispose]();
      }
    });
  }

  test('policy CAS reads do not publish ahead of queued canonical events', async () => {
    const h = harness();
    let revision = 0;
    const at = (value: number) => ({
      ...projection('session-1'),
      revision: value,
      interactionQueue: { interactions: [], revision: value },
    });
    h.bridge.query = async (query) =>
      query.type === 'get_session_projection'
        ? { status: 'ok', queryType: query.type, revision, session: at(revision) }
        : { status: 'ok', queryType: 'list_sessions', sessions: [] };
    h.bridge.inspectCommand = async () => ({
      kind: 'accepted',
      decision: {
        targetSessionId: 'session-1',
        commit: async (evidence) => {
          const stored = createRuntimeStoredCommandReceipt(evidence, 2);
          h.records.set(receiptKey(evidence), stored);
          revision = 2;
          return {
            receipt: applied(evidence.commandId, 'session-1', 2),
            activation: async (publish) => {
              for (const [value, mode] of [
                [1, 'auto'],
                [2, 'full'],
              ] as const)
                publish({
                  schema: 'kite.runtime-notification.v2',
                  durability: 'durable',
                  sessionId: 'session-1',
                  revision: value,
                  projection: {
                    kind: 'session',
                    session: at(value),
                    event: { type: 'interaction_mode.changed', mode },
                  },
                });
            },
          };
        },
      },
    });
    const host = createRuntimeHost({
      storage: h.storage,
      modules: testRuntimeModules(() => h.bridge),
    });
    const stream = host.subscribe({ spec: { scope: 'session', sessionId: 'session-1' } });
    const iterator = stream[Symbol.asyncIterator]();
    try {
      await iterator.next();
      revision = 1; // A live coordinator has committed an event but has not published it yet.
      expect(
        await host.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          commandId: 'queued-policy',
          type: 'set_interaction_mode',
          sessionId: 'session-1',
          expectedRevision: 1,
          mode: 'full',
        }),
      ).toMatchObject({ status: 'applied', revision: 2 });
      expect((await iterator.next()).value).toMatchObject({
        revision: 1,
        projection: { event: { type: 'interaction_mode.changed', mode: 'auto' } },
      });
      expect((await iterator.next()).value).toMatchObject({
        revision: 2,
        projection: { event: { type: 'interaction_mode.changed', mode: 'full' } },
      });
    } finally {
      await host[Symbol.asyncDispose]();
    }
  });

  test('policy receipt races do not swallow activation failures', async () => {
    const h = harness({ activationFailure: new Error('policy publication failed') });
    const host = createRuntimeHost({
      storage: h.storage,
      modules: testRuntimeModules(() => h.bridge),
    });
    const command = {
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'publication-failure',
      type: 'set_interaction_mode' as const,
      sessionId: 'session-1',
      expectedRevision: 0,
      mode: 'full' as const,
    };
    try {
      await expect(host.command(command)).rejects.toThrow('policy publication failed');
      expect(await host.command(command)).toMatchObject({ status: 'idempotent_replay' });
      expect(h.bridge.commits).toHaveLength(1);
      expect(h.bridge.recoveries).toEqual([]);
    } finally {
      await host[Symbol.asyncDispose]();
    }
  });

  test('policy commands and their receipts never request execution ownership or recovery', async () => {
    const h = harness();
    const host = createRuntimeHost({
      storage: h.storage,
      modules: testRuntimeModules(() => h.bridge),
      runWithSessionExecution: () => {
        throw new Error('execution unavailable');
      },
    });
    const command = {
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'policy-command',
      type: 'set_interaction_mode' as const,
      sessionId: 'session-1',
      expectedRevision: 0,
      mode: 'full' as const,
    };
    try {
      expect(await host.command(command)).toMatchObject({ status: 'applied' });
      expect(await host.command(command)).toMatchObject({ status: 'idempotent_replay' });
      expect(h.bridge.recoveries).toEqual([]);
      expect(h.bridge.commits).toHaveLength(1);
      expect(() => host.command(startCommand())).toThrow('execution unavailable');
    } finally {
      await host[Symbol.asyncDispose]();
    }
  });

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
    schema: 'kite.runtime-projection.v2',
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
