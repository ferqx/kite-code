import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_COMMAND_SCHEMA_,
  type RuntimeCommand,
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
import { deferred, testRuntimeModules, testStorage } from './helpers';

type StartTurn = Extract<RuntimeCommand, { readonly type: 'start_turn' }>;
type ActivationFailure = 'before_publish' | 'after_publish';

interface CrashBridgeOptions {
  readonly activationFailure?: ActivationFailure;
  readonly commitFailure?: 'before_receipt' | 'after_receipt';
  readonly execute?: boolean;
  readonly holdBeforeAttempt?: boolean;
  readonly runFailure?: boolean;
}

/**
 * This fake is intentionally narrower than a Store implementation: its only
 * mutable state is the receipt record written by the commit transaction. That
 * makes every restart assertion prove the Host lookup path, rather than an
 * in-memory command cache.
 */
class StrictReceiptPort {
  readonly records = new Map<string, RuntimeStoredCommandReceipt>();
  readonly lookups: RuntimeCommandReceiptLookupInput[] = [];

  lookup(input: RuntimeCommandReceiptLookupInput) {
    this.lookups.push(input);
    const record = this.records.get(receiptKey(input));
    if (!record) return { status: 'missing' as const };
    return {
      status: record.requestDigest === input.requestDigest ? 'replay' : 'digest_mismatch',
      receipt: record,
    };
  }

  persist(evidence: RuntimeCommandCommitEvidence, revision: number): void {
    const key = receiptKey(evidence);
    if (this.records.has(key)) throw new Error(`duplicate fake receipt write: ${key}`);
    this.records.set(key, createRuntimeStoredCommandReceipt(evidence, revision));
  }
}

class CrashWindowBridge implements RuntimeHostExecutionBridge {
  readonly inspections: RuntimeCommand[] = [];
  readonly commits: RuntimeCommandCommitEvidence[] = [];
  readonly recoveries: string[] = [];
  readonly activations: ActivationFailure[] = [];
  readonly preparedExecutions: string[] = [];
  readonly schedules: string[] = [];
  readonly runs: string[] = [];
  readonly attempts: string[] = [];
  readonly terminals: string[] = [];
  readonly #receiptPort: StrictReceiptPort;
  readonly #options: CrashBridgeOptions;
  readonly #beforeAttempt = deferred();

  constructor(receiptPort: StrictReceiptPort, options: CrashBridgeOptions = {}) {
    this.#receiptPort = receiptPort;
    this.#options = options;
  }

  releaseAttempt(): void {
    this.#beforeAttempt.resolve();
  }

  async inspectCommand(
    command: RuntimeCommand,
    context: RuntimeHostCommandInspectionContext,
  ): Promise<RuntimeHostCommandInspection> {
    this.inspections.push(command);
    return {
      kind: 'accepted',
      decision: {
        targetSessionId: context.targetSessionId,
        commit: async (evidence) => {
          this.commits.push(evidence);
          if (this.#options.commitFailure === 'before_receipt') {
            throw new Error('commit stopped before receipt write');
          }
          this.#receiptPort.persist(evidence, 1);
          if (this.#options.commitFailure === 'after_receipt') {
            throw new Error('commit response lost after receipt write');
          }
          return {
            receipt: applied(command.commandId, context.targetSessionId, 1),
            ...(this.#options.activationFailure
              ? { activation: this.#activation(this.#options.activationFailure) }
              : {}),
            ...(this.#options.execute
              ? { preparedExecution: { execution: this.#prepared(command, context) } }
              : {}),
          };
        },
      },
    };
  }

  recoverSession(sessionId: string, _publish: (notification: RuntimeNotification) => void) {
    this.recoveries.push(sessionId);
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

  #activation(failure: ActivationFailure) {
    return async (_publish: (notification: RuntimeNotification) => void) => {
      this.activations.push(failure);
      if (failure === 'before_publish') throw new Error('activation failed before publish');
      // The publish barrier has passed, but scheduling must still not start after this failure.
      throw new Error('activation failed after publish');
    };
  }

  #prepared(command: RuntimeCommand, context: RuntimeHostCommandInspectionContext) {
    this.preparedExecutions.push(command.commandId);
    return {
      sessionId: context.targetSessionId,
      operationId: command.commandId,
      committedRevision: 1,
      operation: 'turn' as const,
      run: async () => {
        this.schedules.push(command.commandId);
        this.runs.push(command.commandId);
        if (this.#options.holdBeforeAttempt) await this.#beforeAttempt.promise;
        this.attempts.push(command.commandId);
        if (this.#options.runFailure) throw new Error('run failed after attempt started');
        this.terminals.push(command.commandId);
      },
    };
  }
}

function hostFor(receipts: StrictReceiptPort, bridge: CrashWindowBridge) {
  const storage = {
    ...testStorage(),
    commandReceipts: {
      lookup: (input: RuntimeCommandReceiptLookupInput) => receipts.lookup(input),
    },
  } as RuntimeStorage;
  return createRuntimeHost({ storage, modules: testRuntimeModules(() => bridge) });
}

describe('Host persistent command crash windows', () => {
  test('a commit failure after inspection but before receipt write remains retryable and never activates', async () => {
    const receipts = new StrictReceiptPort();
    const failed = new CrashWindowBridge(receipts, {
      commitFailure: 'before_receipt',
      execute: true,
    });
    const host = hostFor(receipts, failed);

    await expect(host.command(startTurn())).rejects.toThrow('before receipt write');
    expect(receipts.records).toHaveLength(0);
    expect(failed.inspections).toHaveLength(1);
    expect(failed.commits).toHaveLength(1);
    expect(failed.activations).toHaveLength(0);
    expect(failed.preparedExecutions).toHaveLength(0);
    expect(failed.schedules).toHaveLength(0);

    await host[Symbol.asyncDispose]();
    const retry = new CrashWindowBridge(receipts);
    const restarted = hostFor(receipts, retry);
    await expect(restarted.command(startTurn())).resolves.toEqual(
      applied('command-1', 'session-1', 1),
    );
    expect(retry.inspections).toHaveLength(1);
    expect(retry.commits).toHaveLength(1);
    expect(retry.activations).toHaveLength(0);
    expect(retry.schedules).toHaveLength(0);
    await restarted[Symbol.asyncDispose]();
  });

  test('a receipt written before commit resolution is replayed after restart without activation or scheduling', async () => {
    const receipts = new StrictReceiptPort();
    const crashed = new CrashWindowBridge(receipts, {
      commitFailure: 'after_receipt',
      execute: true,
    });
    const host = hostFor(receipts, crashed);

    await expect(host.command(startTurn())).rejects.toThrow('after receipt write');
    expect(receipts.records).toHaveLength(1);
    expect(crashed.activations).toHaveLength(0);
    expect(crashed.preparedExecutions).toHaveLength(0);
    expect(crashed.schedules).toHaveLength(0);
    await host[Symbol.asyncDispose]();

    const replay = new CrashWindowBridge(receipts, { execute: true });
    const restarted = hostFor(receipts, replay);
    await expect(restarted.command(startTurn())).resolves.toEqual(idempotentReplay());
    expect(replay.inspections).toHaveLength(0);
    expect(replay.commits).toHaveLength(0);
    expect(replay.activations).toHaveLength(0);
    expect(replay.preparedExecutions).toHaveLength(0);
    expect(replay.schedules).toHaveLength(0);
    expect(replay.recoveries).toEqual(['session-1']);
    await restarted[Symbol.asyncDispose]();
  });

  test('a lost successful response replays the durable decision, not a second command execution', async () => {
    const receipts = new StrictReceiptPort();
    const first = new CrashWindowBridge(receipts, { execute: true });
    const host = hostFor(receipts, first);

    // Model a client losing the returned response after the command transaction settled.
    await host.command(startTurn());
    await host.waitForSessionIdle('session-1');
    expect(first.terminals).toEqual(['command-1']);
    await host[Symbol.asyncDispose]();

    const replay = new CrashWindowBridge(receipts, { execute: true });
    const restarted = hostFor(receipts, replay);
    await expect(restarted.command(startTurn())).resolves.toEqual(idempotentReplay());
    expect(replay.inspections).toHaveLength(0);
    expect(replay.commits).toHaveLength(0);
    expect(replay.preparedExecutions).toHaveLength(0);
    expect(replay.schedules).toHaveLength(0);
    expect(replay.recoveries).toEqual(['session-1']);
    await restarted[Symbol.asyncDispose]();
  });

  test('activation failure before or after publication does not turn a receipt replay into scheduling', async () => {
    for (const activationFailure of ['before_publish', 'after_publish'] as const) {
      const receipts = new StrictReceiptPort();
      const crashed = new CrashWindowBridge(receipts, { activationFailure, execute: true });
      const host = hostFor(receipts, crashed);

      await expect(host.command(startTurn())).rejects.toThrow('activation failed');
      expect(receipts.records).toHaveLength(1);
      expect(crashed.activations).toEqual([activationFailure]);
      expect(crashed.preparedExecutions).toEqual(['command-1']);
      expect(crashed.schedules).toHaveLength(0);
      await host[Symbol.asyncDispose]();

      const replay = new CrashWindowBridge(receipts, { execute: true });
      const restarted = hostFor(receipts, replay);
      await expect(restarted.command(startTurn())).resolves.toEqual(idempotentReplay());
      expect(replay.inspections).toHaveLength(0);
      expect(replay.commits).toHaveLength(0);
      expect(replay.preparedExecutions).toHaveLength(0);
      expect(replay.schedules).toHaveLength(0);
      expect(replay.recoveries).toEqual(['session-1']);
      await restarted[Symbol.asyncDispose]();
    }
  });

  test('a receipt replay leaves schedule, pre-attempt work, and a failed run to the recovery owner', async () => {
    const receipts = new StrictReceiptPort();
    const original = new CrashWindowBridge(receipts, { execute: true, holdBeforeAttempt: true });
    const host = hostFor(receipts, original);

    await expect(host.command(startTurn())).resolves.toEqual(applied('command-1', 'session-1', 1));
    await until(() => original.runs.length === 1);
    expect(original.preparedExecutions).toEqual(['command-1']);
    expect(original.schedules).toEqual(['command-1']);
    expect(original.attempts).toHaveLength(0);

    const replay = new CrashWindowBridge(receipts, { execute: true });
    const restarted = hostFor(receipts, replay);
    await expect(restarted.command(startTurn())).resolves.toEqual(idempotentReplay());
    expect(replay.inspections).toHaveLength(0);
    expect(replay.commits).toHaveLength(0);
    expect(replay.preparedExecutions).toHaveLength(0);
    expect(replay.schedules).toHaveLength(0);
    expect(replay.runs).toHaveLength(0);
    expect(replay.attempts).toHaveLength(0);
    expect(replay.recoveries).toEqual(['session-1']);

    original.releaseAttempt();
    await host.waitForSessionIdle('session-1');
    await host[Symbol.asyncDispose]();
    await restarted[Symbol.asyncDispose]();

    // This independent receipt models an execution that reaches an attempt but has no terminal evidence.
    const failedReceipts = new StrictReceiptPort();
    const failedExecution = new CrashWindowBridge(failedReceipts, {
      execute: true,
      runFailure: true,
    });
    const executionHost = hostFor(failedReceipts, failedExecution);
    await executionHost.command(startTurn());
    await executionHost.waitForSessionIdle('session-1');
    expect(failedExecution.attempts).toEqual(['command-1']);
    expect(failedExecution.terminals).toHaveLength(0);
    await executionHost[Symbol.asyncDispose]();

    const afterRunFailure = new CrashWindowBridge(failedReceipts, { execute: true });
    const afterRestart = hostFor(failedReceipts, afterRunFailure);
    await expect(afterRestart.command(startTurn())).resolves.toEqual(idempotentReplay());
    expect(afterRunFailure.preparedExecutions).toHaveLength(0);
    expect(afterRunFailure.schedules).toHaveLength(0);
    expect(afterRunFailure.runs).toHaveLength(0);
    expect(afterRunFailure.recoveries).toEqual(['session-1']);
    await afterRestart[Symbol.asyncDispose]();
  });

  test('same digest replays, a different digest fails closed, and command IDs remain scoped by session', async () => {
    const receipts = new StrictReceiptPort();
    const first = new CrashWindowBridge(receipts);
    const host = hostFor(receipts, first);
    await host.command(startTurn('same body', 'session-a'));
    await host.command(startTurn('same body', 'session-b'));
    expect(receipts.records).toHaveLength(2);
    await host[Symbol.asyncDispose]();

    const replay = new CrashWindowBridge(receipts, { execute: true });
    const restarted = hostFor(receipts, replay);
    await expect(restarted.command(startTurn('same body', 'session-a'))).resolves.toEqual(
      idempotentReplay('session-a'),
    );
    await expect(restarted.command(startTurn('different body', 'session-a'))).resolves.toEqual({
      status: 'rejected',
      commandId: 'command-1',
      code: 'invalid_command',
    });
    await expect(restarted.command(startTurn('same body', 'session-b'))).resolves.toEqual(
      idempotentReplay('session-b'),
    );
    expect(replay.inspections).toHaveLength(0);
    expect(replay.commits).toHaveLength(0);
    expect(replay.preparedExecutions).toHaveLength(0);
    expect(replay.schedules).toHaveLength(0);
    expect(replay.recoveries).toEqual(['session-a', 'session-b']);
    await restarted[Symbol.asyncDispose]();
  });
});

function startTurn(input = 'hello', sessionId = 'session-1'): StartTurn {
  return {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId: 'command-1',
    type: 'start_turn',
    sessionId,
    expectedRevision: 0,
    input,
  };
}

function applied(commandId: string, sessionId: string, revision: number) {
  return { status: 'applied' as const, commandId, sessionId, revision };
}

function idempotentReplay(sessionId = 'session-1') {
  return {
    status: 'idempotent_replay' as const,
    commandId: 'command-1',
    sessionId,
    originalRevision: 1,
  };
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

async function until(condition: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for crash-window barrier.');
}
