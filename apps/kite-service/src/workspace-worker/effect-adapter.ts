import { createHash } from 'node:crypto';
import type { ClassifiedInvocation, PreparedToolInvocation } from '@kite-ai/runtime-spi';
import type {
  SqliteWorkspaceAuthority,
  SqliteWorkspaceControllerLeaseBinding,
  SqliteWorkspaceEffectEvidence,
  SqliteWorkspaceResourceLease,
} from '@kite-ai/runtime-storage-sqlite';
import {
  createWorkspaceEffectGate,
  type WorkspaceEffectAttempt,
  type WorkspaceEffectEvidencePort,
  type WorkspaceEffectGate,
  type WorkspaceResourceLease,
  type WorkspaceResourceLeasePort,
} from './effect-gate';

/**
 * The narrow Worker-side authorization seam.  A caller must provide the
 * already-authenticated WorkerCommandContext; this adapter never looks up an
 * active Controller lease, guesses a generation, or uses a process mutex as
 * authorization.
 */
export type WorkspaceEffectControllerAuthorizer = (
  attempt: Readonly<WorkspaceEffectAttempt>,
) => boolean | Promise<boolean>;

export interface WorkspaceStoreEffectAdapterInput {
  /** The open Store 8 authority for exactly one Worker Workspace. */
  readonly authority: Pick<SqliteWorkspaceAuthority, 'binding' | 'effects' | 'resources'>;
  /** OS-user shared-resource lease; Store 8 only records its evidence. */
  readonly resourceLease: WorkspaceResourceLeasePort;
  /** Exact authenticated Controller/Worker context verifier. */
  readonly authorizeController: WorkspaceEffectControllerAuthorizer;
}

export interface WorkspaceStoreEffectAdapter {
  readonly gate: WorkspaceEffectGate;
  readonly evidence: WorkspaceEffectEvidencePort;
  readonly resources: WorkspaceResourceLeasePort;
}

/** Stable caller-owned facts required to create one effect attempt. */
export interface WorkspaceEffectAttemptContext {
  readonly sessionId: string;
  readonly commandId: string | null;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly controllerGeneration: number;
  readonly workerInstanceId: string;
  readonly ownerId: string;
  readonly workerScopeId: string;
  readonly workspaceDigest: string;
  /** Canonical resource identity selected by the mechanism owner. */
  readonly resourceId: string;
  readonly kind: WorkspaceEffectAttempt['kind'];
  readonly expiresAtMs: number;
  readonly capabilityDigest?: string;
}

export interface WorkspaceEffectDispatchComposition {
  readonly gate: WorkspaceEffectGate;
  readonly createAttempt: (input: {
    readonly context: Readonly<WorkspaceEffectAttemptContext>;
    readonly prepared: Readonly<PreparedToolInvocation>;
    readonly classified: Readonly<ClassifiedInvocation>;
    readonly attempt: number;
  }) => WorkspaceEffectAttempt;
}

/** Raised by the pipeline when an already-acknowledged effect has no safe result to replay. */
export class WorkspaceEffectOutcomeUnknownError extends Error {
  readonly code = 'workspace_effect_outcome_unknown' as const;

  constructor() {
    super('Workspace effect outcome is unknown and is not replayable.');
    this.name = 'WorkspaceEffectOutcomeUnknownError';
  }
}

/**
 * Bind a prepared invocation to explicit Worker/Controller context.  The
 * request digest comes from the prepared admission authority; callers cannot
 * replace it with a digest recomputed from mutable arguments.
 */
export function createWorkspaceEffectAttempt(input: {
  readonly context: Readonly<WorkspaceEffectAttemptContext>;
  readonly prepared: Readonly<PreparedToolInvocation>;
}): WorkspaceEffectAttempt {
  const admissionDigest = input.prepared.identity.admissionDigest;
  if (!admissionDigest || !/^[a-f0-9]{64}$/u.test(admissionDigest)) {
    throw new Error('Workspace effect requires an admitted prepared invocation.');
  }
  const identity = input.prepared.identity;
  const attempt: WorkspaceEffectAttempt = Object.freeze({
    ...input.context,
    invocationId: identity.invocationId,
    attemptId: identity.attemptId,
    requestDigest: admissionDigest,
  });
  return attempt;
}

/**
 * Use only the canonical Builtin classification.  This helper deliberately
 * does not infer mutation from an operation name or argument shape.
 */
export function requiresWorkspaceEffectGate(classified: Readonly<ClassifiedInvocation>): boolean {
  return (
    classified.sideEffect === true ||
    classified.effectClass === 'workspace_write' ||
    classified.effectClass === 'external_side_effect' ||
    classified.effectClass === 'unknown' ||
    Object.values(classified.effectiveEffects).some(
      (effect) => effect === 'write' || effect === 'destructive' || effect === 'unknown',
    )
  );
}

/**
 * Compose the Store 8 durable effect evidence with the OS-user resource
 * lease.  The Store facade owns effect/resource state; the filesystem lease
 * owns only cross-Workspace exclusion.  No result body, raw capability, or
 * canonical path is persisted by this composition.
 */
export function createWorkspaceStoreEffectAdapter(
  input: Readonly<WorkspaceStoreEffectAdapterInput>,
): WorkspaceStoreEffectAdapter {
  if (
    !input ||
    typeof input !== 'object' ||
    !input.authority ||
    !input.authority.binding ||
    !input.authority.effects ||
    !input.authority.resources ||
    !input.resourceLease ||
    typeof input.resourceLease.acquire !== 'function' ||
    typeof input.authorizeController !== 'function'
  ) {
    throw new TypeError('Workspace Store effect adapter inputs are invalid.');
  }

  const { authority } = input;
  const binding = authority.binding;
  assertBinding(binding);
  const workspaceDigest = normalizedWorkspaceDigest(binding.workspaceIdentityDigest);

  const authorize = async (attempt: Readonly<WorkspaceEffectAttempt>): Promise<void> => {
    assertAttemptBinding(attempt, binding);
    if (!(await input.authorizeController(attempt))) {
      throw new Error('Workspace effect Controller authority is not current.');
    }
  };

  const evidence: WorkspaceEffectEvidencePort = Object.freeze({
    inspect: async (attempt: WorkspaceEffectAttempt) => {
      await authorize(attempt);
      const inspected = authority.effects.inspect(
        attempt.sessionId,
        attempt.attemptId,
        controllerLeaseFor(attempt),
      );
      if (inspected.status === 'missing') return 'absent' as const;
      assertEffectEvidence(inspected.evidence, attempt, binding);
      switch (inspected.status) {
        case 'prepared':
          return 'prepared' as const;
        case 'terminal':
          return 'terminal' as const;
        case 'unknown':
          return 'outcome_unknown' as const;
      }
    },
    prepare: async (attempt: WorkspaceEffectAttempt) => {
      await authorize(attempt);
      const prepared = authority.effects.prepare({
        sessionId: attempt.sessionId,
        effectId: attempt.attemptId,
        ownerId: attempt.ownerId,
        invocationId: attempt.invocationId,
        attemptId: attempt.attemptId,
        requestDigest: attempt.requestDigest,
        expiresAtMs: attempt.expiresAtMs,
        ...(attempt.capabilityDigest === undefined
          ? {}
          : { capabilityDigest: attempt.capabilityDigest }),
        controllerLease: controllerLeaseFor(attempt),
      });
      if (prepared.status === 'rejected') {
        throw new Error(`Workspace effect preparation was rejected: ${prepared.reason}.`);
      }
      assertEffectEvidence(prepared.evidence, attempt, binding);
      // A terminal replay discovered after the initial inspect is not safe to
      // reinterpret as a new dispatch.  The caller must reconcile it.
      if (prepared.evidence.state !== 'prepared') {
        throw new Error('Workspace effect preparation is no longer dispatchable.');
      }
    },
    acknowledgeDispatch: async (attempt: WorkspaceEffectAttempt) => {
      await authorize(attempt);
      // Store 8's effect evidence intentionally has no separate mutable
      // "dispatch_acknowledged" row: the prepared row plus the external
      // resource held record is the durable pre-dispatch fence.  Re-read both
      // identities here so a changed lease cannot cross the dispatch boundary.
      const inspected = authority.effects.inspect(
        attempt.sessionId,
        attempt.attemptId,
        controllerLeaseFor(attempt),
      );
      if (inspected.status !== 'prepared') {
        throw new Error('Workspace effect dispatch acknowledgement is stale.');
      }
      assertEffectEvidence(inspected.evidence, attempt, binding);
      const resource = authority.resources.inspect(
        attempt.sessionId,
        attempt.resourceId,
        controllerLeaseFor(attempt),
      );
      if (resource?.state !== 'held') {
        throw new Error('Workspace resource lease acknowledgement is stale.');
      }
      assertResourceLease(resource, attempt, binding);
    },
    commitTerminal: async (attempt: WorkspaceEffectAttempt) => {
      await authorize(attempt);
      const inspected = authority.effects.inspect(
        attempt.sessionId,
        attempt.attemptId,
        controllerLeaseFor(attempt),
      );
      if (inspected.status === 'terminal') {
        assertEffectEvidence(inspected.evidence, attempt, binding);
        return;
      }
      if (inspected.status === 'unknown') {
        assertEffectEvidence(inspected.evidence, attempt, binding);
        throw new Error('Workspace effect outcome is already unknown.');
      }
      if (inspected.status !== 'prepared') {
        throw new Error('Workspace effect terminal evidence is missing.');
      }
      assertEffectEvidence(inspected.evidence, attempt, binding);
      const terminal = authority.effects.terminal({
        sessionId: attempt.sessionId,
        effectId: attempt.attemptId,
        ownerId: attempt.ownerId,
        invocationId: attempt.invocationId,
        attemptId: attempt.attemptId,
        requestDigest: attempt.requestDigest,
        outcome: 'succeeded',
        terminalDigest: terminalDigest(attempt, 'succeeded'),
        terminalCode: 'dispatch_succeeded',
        controllerLease: controllerLeaseFor(attempt),
      });
      if (terminal.status === 'rejected' || terminal.status === 'unknown') {
        throw new Error('Workspace effect terminal evidence could not be committed.');
      }
      assertEffectEvidence(terminal.evidence, attempt, binding);
    },
    commitUnknown: async (attempt: WorkspaceEffectAttempt) => {
      await authorize(attempt);
      const inspected = authority.effects.inspect(
        attempt.sessionId,
        attempt.attemptId,
        controllerLeaseFor(attempt),
      );
      if (inspected.status === 'terminal' || inspected.status === 'unknown') {
        assertEffectEvidence(inspected.evidence, attempt, binding);
        return;
      }
      if (inspected.status !== 'prepared') {
        throw new Error('Workspace effect unknown evidence is missing.');
      }
      assertEffectEvidence(inspected.evidence, attempt, binding);
      const unknown = authority.effects.terminal({
        sessionId: attempt.sessionId,
        effectId: attempt.attemptId,
        ownerId: attempt.ownerId,
        invocationId: attempt.invocationId,
        attemptId: attempt.attemptId,
        requestDigest: attempt.requestDigest,
        outcome: 'unknown',
        terminalDigest: terminalDigest(attempt, 'unknown'),
        terminalCode: 'dispatch_unknown',
        controllerLease: controllerLeaseFor(attempt),
      });
      if (unknown.status === 'rejected') {
        throw new Error('Workspace effect unknown evidence was rejected.');
      }
      // `stale_lease` and `reconciliation_required` are deliberately not
      // converted into a replayable success.  The authority has either
      // written unknown or requires a separate owner reconciliation.
      if (unknown.status === 'unknown' && unknown.reason === 'missing_preparation') {
        throw new Error('Workspace effect unknown evidence is missing.');
      }
      if ('evidence' in unknown) assertEffectEvidence(unknown.evidence, attempt, binding);
    },
  });

  const resources: WorkspaceResourceLeasePort = Object.freeze({
    acquire: async (attempt: WorkspaceEffectAttempt) => {
      await authorize(attempt);
      const prepared = authority.resources.prepare({
        sessionId: attempt.sessionId,
        resourceId: attempt.resourceId,
        ownerId: attempt.ownerId,
        attemptId: attempt.attemptId,
        requestDigest: attempt.requestDigest,
        expiresAtMs: attempt.expiresAtMs,
        controllerLease: controllerLeaseFor(attempt),
      });
      assertResourceLease(prepared, attempt, binding);
      if (prepared.state !== 'prepared') {
        throw new Error('Workspace resource lease requires reconciliation.');
      }

      const external = await input.resourceLease.acquire(attempt);
      if (external.resourceId !== attempt.resourceId) {
        await disposeQuietly(external);
        throw new Error('Workspace resource lease identity changed.');
      }
      const externalLeaseDigest = resourceLeaseDigest(attempt, prepared.leaseRevision);
      let recorded = false;
      try {
        authority.resources.recordAcquired({
          sessionId: attempt.sessionId,
          resourceId: attempt.resourceId,
          ownerId: attempt.ownerId,
          attemptId: attempt.attemptId,
          requestDigest: attempt.requestDigest,
          leaseRevision: prepared.leaseRevision,
          expiresAtMs: attempt.expiresAtMs,
          externalLeaseDigest,
          controllerLease: controllerLeaseFor(attempt),
        });
        recorded = true;
      } catch (error) {
        await disposeQuietly(external);
        throw error;
      }

      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        await external[Symbol.asyncDispose]();
        authority.resources.recordReleased({
          sessionId: attempt.sessionId,
          resourceId: attempt.resourceId,
          ownerId: attempt.ownerId,
          attemptId: attempt.attemptId,
          requestDigest: attempt.requestDigest,
          leaseRevision: prepared.leaseRevision,
          externalLeaseDigest,
          controllerLease: controllerLeaseFor(attempt),
        });
        released = true;
      };

      // Keep the local boolean in the closure even if a future compiler
      // removes a branch around the record call; an unrecorded acquisition
      // must never be exposed as a usable lease.
      if (!recorded) {
        await disposeQuietly(external);
        throw new Error('Workspace resource lease evidence was not recorded.');
      }
      const lease: WorkspaceResourceLease = Object.freeze({
        resourceId: attempt.resourceId,
        [Symbol.asyncDispose]: release,
      });
      return lease;
    },
  });

  return Object.freeze({
    gate: createWorkspaceEffectGate({
      workerScopeId: binding.workerScopeId,
      workspaceDigest,
      evidence,
      resources,
    }),
    evidence,
    resources,
  });
}

function controllerLeaseFor(
  attempt: Readonly<WorkspaceEffectAttempt>,
): SqliteWorkspaceControllerLeaseBinding {
  return Object.freeze({
    sessionId: attempt.sessionId,
    clientId: attempt.clientId,
    connectionGeneration: attempt.connectionGeneration,
    controllerGeneration: attempt.controllerGeneration,
    workerInstanceId: attempt.workerInstanceId,
  });
}

function assertBinding(value: SqliteWorkspaceAuthority['binding']): void {
  if (
    !safeId(value.layoutGeneration) ||
    !safeId(value.workerScopeId) ||
    !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value.workspaceIdentityDigest)
  ) {
    throw new TypeError('Workspace Store effect binding is invalid.');
  }
}

function assertAttemptBinding(
  attempt: Readonly<WorkspaceEffectAttempt>,
  binding: SqliteWorkspaceAuthority['binding'],
): void {
  if (
    attempt.workerScopeId !== binding.workerScopeId ||
    attempt.workspaceDigest !== normalizedWorkspaceDigest(binding.workspaceIdentityDigest)
  ) {
    throw new Error('Workspace effect attempt does not belong to this Store.');
  }
}

function normalizedWorkspaceDigest(value: string): `sha256:${string}` {
  return (value.startsWith('sha256:') ? value : `sha256:${value}`) as `sha256:${string}`;
}

function assertEffectEvidence(
  evidence: Readonly<SqliteWorkspaceEffectEvidence>,
  attempt: Readonly<WorkspaceEffectAttempt>,
  binding: SqliteWorkspaceAuthority['binding'],
): void {
  if (
    evidence.sessionId !== attempt.sessionId ||
    evidence.effectId !== attempt.attemptId ||
    evidence.workerScopeId !== binding.workerScopeId ||
    evidence.workspaceIdentityDigest !== binding.workspaceIdentityDigest ||
    evidence.layoutGeneration !== binding.layoutGeneration ||
    evidence.ownerId !== attempt.ownerId ||
    evidence.invocationId !== attempt.invocationId ||
    evidence.attemptId !== attempt.attemptId ||
    evidence.requestDigest !== attempt.requestDigest ||
    evidence.capabilityDigest !== (attempt.capabilityDigest ?? null)
  ) {
    throw new Error('Workspace effect evidence identity does not match the attempt.');
  }
}

function assertResourceLease(
  resource: Readonly<SqliteWorkspaceResourceLease>,
  attempt: Readonly<WorkspaceEffectAttempt>,
  binding: SqliteWorkspaceAuthority['binding'],
): void {
  if (
    resource.sessionId !== attempt.sessionId ||
    resource.resourceId !== attempt.resourceId ||
    resource.workerScopeId !== binding.workerScopeId ||
    resource.workspaceIdentityDigest !== binding.workspaceIdentityDigest ||
    resource.layoutGeneration !== binding.layoutGeneration ||
    resource.ownerId !== attempt.ownerId ||
    resource.attemptId !== attempt.attemptId ||
    resource.requestDigest !== attempt.requestDigest
  ) {
    throw new Error('Workspace resource evidence identity does not match the attempt.');
  }
}

function terminalDigest(
  attempt: Readonly<WorkspaceEffectAttempt>,
  outcome: 'succeeded' | 'unknown',
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schema: 'kite.workspace-effect-terminal.v1',
        sessionId: attempt.sessionId,
        attemptId: attempt.attemptId,
        invocationId: attempt.invocationId,
        requestDigest: attempt.requestDigest,
        outcome,
      }),
      'utf8',
    )
    .digest('hex');
}

function resourceLeaseDigest(
  attempt: Readonly<WorkspaceEffectAttempt>,
  leaseRevision: number,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schema: 'kite.workspace-resource-lease.v1',
        sessionId: attempt.sessionId,
        resourceId: attempt.resourceId,
        attemptId: attempt.attemptId,
        ownerId: attempt.ownerId,
        leaseRevision,
      }),
      'utf8',
    )
    .digest('hex');
}

async function disposeQuietly(lease: WorkspaceResourceLease): Promise<void> {
  try {
    await lease[Symbol.asyncDispose]();
  } catch {
    // The original acquisition/recording failure remains authoritative.
  }
}

function safeId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && !/\p{Cc}/u.test(value)
  );
}
