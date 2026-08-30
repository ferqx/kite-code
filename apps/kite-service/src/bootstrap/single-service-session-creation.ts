import { createHash, randomUUID } from 'node:crypto';
import type { WorkerControllerCreateSessionRequest } from '@kite-ai/kite-app-contract/worker-controller';
import {
  RUNTIME_COMMAND_SCHEMA_,
  type RuntimeCommand,
  type RuntimeCommandContext,
} from '@kite-ai/runtime-contract';
import type { RuntimeStorage } from '@kite-ai/runtime-host/storage';
import type {
  SqliteWorkspaceInitialControllerInput,
  SqliteWorkspaceSessionCreationPort,
  SqliteWorkspaceSessionCreationResult,
} from '@kite-ai/runtime-storage-sqlite';
import type { AdmittedWorkspace } from '../runtime-application';
import type { RuntimeEvent, RuntimeState } from './runtime/state-runtime';

interface PreparedSessionCreation {
  readonly command: Extract<RuntimeCommand, { readonly type: 'create_session' }>;
  readonly context: RuntimeCommandContext;
  readonly reference: string;
}

export interface KiteSingleServiceSessionCreationCoordinator {
  prepare(
    request: WorkerControllerCreateSessionRequest,
    binding: Readonly<{
      readonly clientId: string;
      readonly connectionGeneration: number;
      readonly workerInstanceId: string;
    }>,
    workspace: AdmittedWorkspace,
  ): PreparedSessionCreation;
  finish(reference: string): SqliteWorkspaceSessionCreationResult;
  discard(reference: string): void;
}

interface PendingSessionCreation {
  readonly requestKey: string;
  readonly command: PreparedSessionCreation['command'];
  readonly context: RuntimeCommandContext;
  readonly controller: SqliteWorkspaceInitialControllerInput;
  readonly port: SqliteWorkspaceSessionCreationPort<RuntimeEvent, RuntimeState>;
  consumers: number;
  recoveryIdentity?: string;
  result?: SqliteWorkspaceSessionCreationResult;
}

/**
 * Bind Store 9's compound Session+Controller transaction to the Runtime Host commit port. The
 * registry contains only in-flight call context; every authoritative result is committed to
 * kite.sqlite and replayed from its Runtime and Controller receipts.
 */
export function createKiteSingleServiceSessionCreationCoordinator(input: {
  readonly storage: RuntimeStorage<RuntimeEvent, RuntimeState>;
  readonly creationForWorkspace: (
    workspace: AdmittedWorkspace,
  ) => SqliteWorkspaceSessionCreationPort<RuntimeEvent, RuntimeState>;
}): Readonly<{
  readonly storage: RuntimeStorage<RuntimeEvent, RuntimeState>;
  readonly coordinator: KiteSingleServiceSessionCreationCoordinator;
}> {
  const pendingByReference = new Map<string, PendingSessionCreation>();
  const pendingByRequest = new Map<string, PendingSessionCreation>();
  const pendingByCommand = new Map<string, PendingSessionCreation>();
  const pendingBySession = new Map<string, PendingSessionCreation>();

  const coordinator: KiteSingleServiceSessionCreationCoordinator = Object.freeze({
    prepare(request, binding, workspace) {
      const requestKey = `${request.sessionId}\0${request.requestId}`;
      const current = pendingByRequest.get(requestKey);
      if (current) {
        if (
          current.controller.requestDigest !== request.requestDigest ||
          current.controller.clientId !== binding.clientId ||
          current.controller.connectionGeneration !== binding.connectionGeneration ||
          current.controller.workerInstanceId !== binding.workerInstanceId ||
          current.controller.resumeSecret !== request.resumeSecret ||
          current.controller.resumeExpiresAtMs !== request.resumeExpiresAtMs
        ) {
          throw new Error('Atomic Session creation request identity changed.');
        }
        current.consumers += 1;
        return {
          command: current.command,
          context: current.context,
          reference: current.context.bindingReference!,
        };
      }
      if (pendingBySession.has(request.sessionId)) {
        throw new Error('Atomic Session creation target already has an in-flight request.');
      }
      const commandId = `service-create-${createHash('sha256')
        .update(`${request.sessionId}\0${request.requestId}\0${request.requestDigest}`, 'utf8')
        .digest('hex')}`;
      const reference = `service-create-${randomUUID()}`;
      const command = Object.freeze({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId,
        type: 'create_session' as const,
        workspace: workspace.canonicalPath,
        bootstrapSessionId: request.sessionId,
      });
      const context: RuntimeCommandContext = Object.freeze({
        schema: 'kite.runtime-command-context.v1',
        connectionId: `service-create-${createHash('sha256')
          .update(`${binding.clientId}\0${binding.connectionGeneration}`, 'utf8')
          .digest('hex')}`,
        requestId: request.requestId,
        bindingReference: reference,
      });
      const pending: PendingSessionCreation = {
        requestKey,
        command,
        context,
        controller: Object.freeze({
          sessionId: request.sessionId,
          requestId: request.requestId,
          requestDigest: request.requestDigest,
          clientId: binding.clientId,
          connectionGeneration: binding.connectionGeneration,
          workerInstanceId: binding.workerInstanceId,
          resumeSecret: request.resumeSecret,
          resumeExpiresAtMs: request.resumeExpiresAtMs,
        }),
        port: input.creationForWorkspace(workspace),
        consumers: 1,
      };
      pendingByReference.set(reference, pending);
      pendingByRequest.set(requestKey, pending);
      pendingByCommand.set(commandId, pending);
      pendingBySession.set(request.sessionId, pending);
      return { command, context, reference };
    },
    finish(reference) {
      const pending = pendingByReference.get(reference);
      if (!pending?.result) throw new Error('Atomic Session creation did not commit.');
      return pending.result;
    },
    discard(reference) {
      const pending = pendingByReference.get(reference);
      if (!pending) return;
      pending.consumers -= 1;
      if (pending.consumers > 0) return;
      pendingByReference.delete(reference);
      pendingByRequest.delete(pending.requestKey);
      pendingByCommand.delete(pending.command.commandId);
      pendingBySession.delete(pending.controller.sessionId);
    },
  } satisfies KiteSingleServiceSessionCreationCoordinator);

  const wrapped = Object.create(input.storage) as RuntimeStorage<RuntimeEvent, RuntimeState>;
  Object.defineProperty(wrapped, 'close', {
    enumerable: true,
    configurable: false,
    writable: false,
    value: () => input.storage.close(),
  });
  Object.defineProperty(wrapped, 'transactions', {
    enumerable: true,
    configurable: false,
    writable: false,
    value: Object.freeze({
      ...input.storage.transactions,
      commitDecision(transaction: Parameters<typeof input.storage.transactions.commitDecision>[0]) {
        const commandId = transaction.commandReceipt?.commandId;
        const pending = commandId ? pendingByCommand.get(commandId) : undefined;
        if (!pending) return input.storage.transactions.commitDecision(transaction);
        if (
          transaction.sessionId !== pending.controller.sessionId ||
          transaction.commandReceipt?.targetSessionId !== pending.controller.sessionId
        ) {
          throw new Error('Atomic Session creation transaction identity changed.');
        }
        pending.result = pending.port.create({
          runtime: transaction,
          controller: pending.controller,
          recoveryIdentity: requirePendingRecoveryIdentity(pending),
        });
      },
    }),
  });
  Object.defineProperty(wrapped, 'recoveryIdentities', {
    enumerable: true,
    configurable: false,
    writable: false,
    value: Object.freeze({
      read(sessionId: string) {
        const pending = pendingBySession.get(sessionId);
        return pending
          ? (pending.recoveryIdentity ?? null)
          : input.storage.recoveryIdentities.read(sessionId);
      },
      getOrCreate(sessionId: string, allocate: () => string) {
        const pending = pendingBySession.get(sessionId);
        if (!pending) return input.storage.recoveryIdentities.getOrCreate(sessionId, allocate);
        if (pending.recoveryIdentity) return pending.recoveryIdentity;
        const value = allocate();
        if (!/^[a-f0-9]{64}$/u.test(value)) {
          throw new Error('Atomic Session recovery identity is invalid.');
        }
        pending.recoveryIdentity = value;
        return value;
      },
      remove(sessionId: string) {
        if (pendingBySession.has(sessionId)) {
          throw new Error('Atomic Session recovery identity cannot be removed before commit.');
        }
        input.storage.recoveryIdentities.remove(sessionId);
      },
    }),
  });

  return Object.freeze({ storage: Object.freeze(wrapped), coordinator });
}

function requirePendingRecoveryIdentity(pending: PendingSessionCreation): string {
  if (!pending.recoveryIdentity) {
    throw new Error('Atomic Session recovery identity was not allocated.');
  }
  return pending.recoveryIdentity;
}
