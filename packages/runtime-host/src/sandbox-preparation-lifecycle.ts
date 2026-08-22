import type {
  PreparedSandboxExecutionV1,
  SandboxDisposalIntentAcknowledgementV1,
  SandboxDisposalReceiptAcknowledgementV1,
  SandboxExecutionDispatchIntentAcknowledgementV1,
  SandboxExecutionSupervisorStartedAcknowledgementV1,
  SandboxPreparationArtifactPortV1,
  SandboxPreparationIntentAcknowledgementV1,
  SandboxPreparationLifecycleV1,
  SandboxPreparationReadyAcknowledgementV1,
  SandboxPreparationV1,
  SandboxPreparedProcessCleanupV1,
  SandboxPreparedProcessExecutionPortV1,
  SandboxPreparedProcessExecutionResultV1,
} from '@kite/runtime-spi';
import {
  executePosixSupervisedV1,
  type RuntimeHostPreparedProcessInputV1,
  type RuntimeHostPreparedProcessResultV1,
} from './posix-supervisor';

export type RuntimeHostSandboxLifecycleEvidenceV1 =
  | {
      readonly stage: 'preparation_intent';
      readonly preparation: Readonly<SandboxPreparationV1>;
      readonly acknowledgement: Readonly<SandboxPreparationIntentAcknowledgementV1>;
    }
  | {
      readonly stage: 'preparation_ready';
      readonly preparationIntent: Readonly<SandboxPreparationIntentAcknowledgementV1>;
      readonly prepared: Readonly<PreparedSandboxExecutionV1>;
      readonly acknowledgement: Readonly<SandboxPreparationReadyAcknowledgementV1>;
    }
  | {
      readonly stage: 'execution_dispatch_intent';
      readonly preparationReady: Readonly<SandboxPreparationReadyAcknowledgementV1>;
      readonly prepared: Readonly<PreparedSandboxExecutionV1>;
      readonly acknowledgement: Readonly<SandboxExecutionDispatchIntentAcknowledgementV1>;
    }
  | {
      readonly stage: 'execution_supervisor_started';
      readonly dispatchIntent: Readonly<SandboxExecutionDispatchIntentAcknowledgementV1>;
      readonly prepared: Readonly<PreparedSandboxExecutionV1>;
      readonly acknowledgement: Readonly<SandboxExecutionSupervisorStartedAcknowledgementV1>;
    }
  | {
      readonly stage: 'disposal_intent';
      readonly preparationIntent: Readonly<SandboxPreparationIntentAcknowledgementV1>;
      readonly preparationReady: Readonly<SandboxPreparationReadyAcknowledgementV1> | null;
      readonly prepared: Readonly<PreparedSandboxExecutionV1> | null;
      readonly acknowledgement: Readonly<SandboxDisposalIntentAcknowledgementV1>;
    }
  | {
      readonly stage: 'disposal_receipt';
      readonly disposalIntent: Readonly<SandboxDisposalIntentAcknowledgementV1>;
      readonly prepared: Readonly<PreparedSandboxExecutionV1> | null;
      readonly acknowledgement: Readonly<SandboxDisposalReceiptAcknowledgementV1>;
    };

export type RuntimeHostSandboxLifecycleEvidenceVerificationResultV1 =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly code: 'not_reflected' | 'identity_mismatch' | 'stale_stage';
    };

/** App-owned durable callbacks. Host owns ordering, never State/event encoding. */
export interface RuntimeHostSandboxLifecyclePersistenceV1 {
  persistPreparationIntent(input: {
    readonly preparation: Readonly<SandboxPreparationV1>;
  }): Promise<Readonly<SandboxPreparationIntentAcknowledgementV1>>;
  persistPreparationReady(input: {
    readonly preparationIntent: Readonly<SandboxPreparationIntentAcknowledgementV1>;
    readonly prepared: Readonly<PreparedSandboxExecutionV1>;
    readonly preparationArtifact: ReturnType<SandboxPreparationArtifactPortV1['write']>;
  }): Promise<Readonly<SandboxPreparationReadyAcknowledgementV1>>;
  persistExecutionDispatchIntent(input: {
    readonly preparationReady: Readonly<SandboxPreparationReadyAcknowledgementV1>;
    readonly prepared: Readonly<PreparedSandboxExecutionV1>;
    readonly dispatchId: string;
    readonly supervisorNonce: string;
  }): Promise<Readonly<SandboxExecutionDispatchIntentAcknowledgementV1>>;
  persistExecutionSupervisorStarted(input: {
    readonly dispatchIntent: Readonly<SandboxExecutionDispatchIntentAcknowledgementV1>;
    readonly prepared: Readonly<PreparedSandboxExecutionV1>;
    readonly supervisorPid: number;
    readonly processGroupId: number;
    readonly processStartIdentity: string;
  }): Promise<Readonly<SandboxExecutionSupervisorStartedAcknowledgementV1>>;
  persistDisposalIntent(input: {
    readonly preparationIntent: Readonly<SandboxPreparationIntentAcknowledgementV1>;
    readonly preparationReady: Readonly<SandboxPreparationReadyAcknowledgementV1> | null;
    readonly prepared: Readonly<PreparedSandboxExecutionV1> | null;
  }): Promise<Readonly<SandboxDisposalIntentAcknowledgementV1>>;
  persistDisposalReceipt(input: {
    readonly disposalIntent: Readonly<SandboxDisposalIntentAcknowledgementV1>;
    readonly prepared: Readonly<PreparedSandboxExecutionV1> | null;
    readonly disposed: boolean;
  }): Promise<Readonly<SandboxDisposalReceiptAcknowledgementV1>>;
}

export interface RuntimeHostSandboxLifecycleEvidencePortV1 {
  verify(
    evidence: Readonly<RuntimeHostSandboxLifecycleEvidenceV1>,
  ): RuntimeHostSandboxLifecycleEvidenceVerificationResultV1;
}

export type RuntimeHostSandboxLifecycleFailureCodeV1 =
  | 'invalid_input'
  | 'invalid_stage'
  | 'invalid_acknowledgement'
  | 'evidence_rejected'
  | 'artifact_identity_mismatch'
  | 'already_consumed';

export class RuntimeHostSandboxLifecycleErrorV1 extends Error {
  readonly code: RuntimeHostSandboxLifecycleFailureCodeV1;

  constructor(code: RuntimeHostSandboxLifecycleFailureCodeV1, message: string) {
    super(message);
    this.name = 'RuntimeHostSandboxLifecycleErrorV1';
    this.code = code;
  }
}

interface RuntimeHostSandboxLifecycleAuthorityV1 {
  preparation?: Readonly<SandboxPreparationV1>;
  preparationIntent?: Readonly<SandboxPreparationIntentAcknowledgementV1>;
  prepared?: Readonly<PreparedSandboxExecutionV1>;
  preparationReady?: Readonly<SandboxPreparationReadyAcknowledgementV1>;
  dispatchIntent?: Readonly<SandboxExecutionDispatchIntentAcknowledgementV1>;
  supervisorStarted?: Readonly<SandboxExecutionSupervisorStartedAcknowledgementV1>;
  disposalIntent?: Readonly<SandboxDisposalIntentAcknowledgementV1>;
  disposed: boolean;
  processConsumed: boolean;
}

const sandboxLifecycleAuthoritiesV1 = new WeakMap<
  SandboxPreparationLifecycleV1,
  RuntimeHostSandboxLifecycleAuthorityV1
>();

/**
 * Generic durable lifecycle coordinator. Persistence supplies opaque digests
 * and evidence; Host enforces exact-object, single-owner stage ordering only.
 */
export function createRuntimeHostSandboxPreparationLifecycleV1(input: {
  readonly persistence: RuntimeHostSandboxLifecyclePersistenceV1;
  readonly evidence: RuntimeHostSandboxLifecycleEvidencePortV1;
  readonly artifacts: SandboxPreparationArtifactPortV1;
}): SandboxPreparationLifecycleV1 {
  const authority: RuntimeHostSandboxLifecycleAuthorityV1 = {
    disposed: false,
    processConsumed: false,
  };
  const lifecycle = Object.freeze<SandboxPreparationLifecycleV1>({
    recordPreparationIntent: async (preparation) => {
      assertFrozenObjectV1(preparation, 'preparation');
      if (authority.preparationIntent)
        fail('already_consumed', 'Preparation intent already exists.');
      const acknowledgement = await input.persistence.persistPreparationIntent({ preparation });
      assertAcknowledgementV1(acknowledgement, 'preparation_intent');
      verifyEvidenceV1(input.evidence, {
        stage: 'preparation_intent',
        preparation,
        acknowledgement,
      });
      authority.preparation = preparation;
      authority.preparationIntent = acknowledgement;
      return acknowledgement;
    },
    recordPreparationReady: async (prepared) => {
      assertFrozenObjectV1(prepared, 'prepared execution');
      const preparationIntent = required(
        authority.preparationIntent,
        'Preparation intent must be acknowledged before ready.',
      );
      if (authority.preparationReady) fail('already_consumed', 'Preparation ready already exists.');
      const preparationArtifact = input.artifacts.write(prepared);
      assertFrozenObjectV1(preparationArtifact, 'preparation artifact reference');
      if (input.artifacts.read(preparationArtifact) !== prepared) {
        fail('artifact_identity_mismatch', 'Preparation Artifact did not return the exact plan.');
      }
      const acknowledgement = await input.persistence.persistPreparationReady({
        preparationIntent,
        prepared,
        preparationArtifact,
      });
      assertAcknowledgementV1(acknowledgement, 'preparation_ready');
      if (acknowledgement.preparationArtifact !== preparationArtifact) {
        fail('artifact_identity_mismatch', 'Ready acknowledgement changed the Artifact identity.');
      }
      verifyEvidenceV1(input.evidence, {
        stage: 'preparation_ready',
        preparationIntent,
        prepared,
        acknowledgement,
      });
      authority.prepared = prepared;
      authority.preparationReady = acknowledgement;
      return acknowledgement;
    },
    recordExecutionDispatchIntent: async (prepared, dispatch) => {
      assertExactPreparedV1(authority, prepared);
      const preparationReady = required(
        authority.preparationReady,
        'Preparation ready must be acknowledged before dispatch intent.',
      );
      if (authority.dispatchIntent) fail('already_consumed', 'Dispatch intent already exists.');
      if (!dispatch.dispatchId || !dispatch.supervisorNonce) {
        fail('invalid_input', 'Dispatch identity must be non-empty.');
      }
      const acknowledgement = await input.persistence.persistExecutionDispatchIntent({
        preparationReady,
        prepared,
        ...dispatch,
      });
      assertAcknowledgementV1(acknowledgement, 'execution_dispatch_intent');
      if (
        acknowledgement.dispatchId !== dispatch.dispatchId ||
        acknowledgement.supervisorNonce !== dispatch.supervisorNonce
      ) {
        fail('invalid_acknowledgement', 'Dispatch acknowledgement changed its identity.');
      }
      verifyEvidenceV1(input.evidence, {
        stage: 'execution_dispatch_intent',
        preparationReady,
        prepared,
        acknowledgement,
      });
      authority.dispatchIntent = acknowledgement;
      return acknowledgement;
    },
    recordExecutionSupervisorStarted: async (prepared, supervisor) => {
      assertExactPreparedV1(authority, prepared);
      const dispatchIntent = required(
        authority.dispatchIntent,
        'Dispatch intent must be acknowledged before supervisor start.',
      );
      if (authority.supervisorStarted) {
        fail('already_consumed', 'Supervisor start already exists.');
      }
      if (
        supervisor.dispatchId !== dispatchIntent.dispatchId ||
        supervisor.dispatchIntentDigest !== dispatchIntent.dispatchIntentDigest
      ) {
        fail('invalid_input', 'Supervisor start does not match the dispatch intent.');
      }
      const acknowledgement = await input.persistence.persistExecutionSupervisorStarted({
        dispatchIntent,
        prepared,
        supervisorPid: supervisor.supervisorPid,
        processGroupId: supervisor.processGroupId,
        processStartIdentity: supervisor.processStartIdentity,
      });
      assertAcknowledgementV1(acknowledgement, 'execution_supervisor_started');
      if (
        acknowledgement.dispatchId !== supervisor.dispatchId ||
        acknowledgement.dispatchIntentDigest !== supervisor.dispatchIntentDigest ||
        acknowledgement.supervisorPid !== supervisor.supervisorPid ||
        acknowledgement.processGroupId !== supervisor.processGroupId ||
        acknowledgement.processStartIdentity !== supervisor.processStartIdentity
      ) {
        fail('invalid_acknowledgement', 'Supervisor acknowledgement changed its identity.');
      }
      verifyEvidenceV1(input.evidence, {
        stage: 'execution_supervisor_started',
        dispatchIntent,
        prepared,
        acknowledgement,
      });
      authority.supervisorStarted = acknowledgement;
      return acknowledgement;
    },
    recordDisposalIntent: async (prepared) => {
      const preparationIntent = required(
        authority.preparationIntent,
        'Preparation intent must exist before disposal.',
      );
      if (authority.disposed) fail('already_consumed', 'Sandbox lifecycle is already disposed.');
      if (authority.disposalIntent) fail('invalid_stage', 'A disposal receipt is still pending.');
      const preparationReady = authority.preparationReady ?? null;
      if (prepared === null) {
        if (preparationReady) {
          fail('invalid_stage', 'Ready preparation requires exact-plan disposal.');
        }
      } else {
        assertExactPreparedV1(authority, prepared);
      }
      const acknowledgement = await input.persistence.persistDisposalIntent({
        preparationIntent,
        preparationReady,
        prepared,
      });
      assertAcknowledgementV1(acknowledgement, 'disposal_intent');
      const expectedPurpose = prepared === null ? 'reconcile_preparation_intent' : 'dispose';
      if (
        acknowledgement.purpose !== expectedPurpose ||
        !Number.isSafeInteger(acknowledgement.cleanupAttempt) ||
        acknowledgement.cleanupAttempt < 1
      ) {
        fail('invalid_acknowledgement', 'Disposal acknowledgement changed its identity.');
      }
      verifyEvidenceV1(input.evidence, {
        stage: 'disposal_intent',
        preparationIntent,
        preparationReady,
        prepared,
        acknowledgement,
      });
      authority.disposalIntent = acknowledgement;
      return acknowledgement;
    },
    recordDisposalReceipt: async ({
      prepared,
      purpose,
      lifecycleIntentDigest,
      cleanupAttempt,
      disposed,
    }) => {
      const disposalIntent = required(
        authority.disposalIntent,
        'Disposal intent must be acknowledged before its receipt.',
      );
      if (
        purpose !== disposalIntent.purpose ||
        lifecycleIntentDigest !== disposalIntent.lifecycleIntentDigest ||
        cleanupAttempt !== disposalIntent.cleanupAttempt ||
        (prepared === null) !== (purpose === 'reconcile_preparation_intent')
      ) {
        fail('invalid_input', 'Disposal receipt does not match its intent.');
      }
      if (prepared !== null) assertExactPreparedV1(authority, prepared);
      const acknowledgement = await input.persistence.persistDisposalReceipt({
        disposalIntent,
        prepared,
        disposed,
      });
      assertAcknowledgementV1(acknowledgement, 'disposal_receipt');
      if (
        acknowledgement.purpose !== purpose ||
        acknowledgement.lifecycleIntentDigest !== lifecycleIntentDigest ||
        acknowledgement.cleanupAttempt !== cleanupAttempt ||
        acknowledgement.disposed !== disposed
      ) {
        fail('invalid_acknowledgement', 'Disposal receipt acknowledgement changed its identity.');
      }
      verifyEvidenceV1(input.evidence, {
        stage: 'disposal_receipt',
        disposalIntent,
        prepared,
        acknowledgement,
      });
      authority.disposalIntent = undefined;
      authority.disposed = disposed;
      return acknowledgement;
    },
  });
  sandboxLifecycleAuthoritiesV1.set(lifecycle, authority);
  return lifecycle;
}

export interface RuntimeHostSandboxSupervisorPortV1 {
  execute(input: RuntimeHostPreparedProcessInputV1): Promise<{
    readonly outcome: RuntimeHostPreparedProcessResultV1;
    readonly cleanupConfirmed: boolean;
  }>;
}

/**
 * Adapts the generic POSIX supervisor into the neutral SPI process result.
 * It deliberately treats every unconfirmed post-GO result as unknown.
 */
export function createRuntimeHostSandboxPreparedProcessExecutionPortV1(input?: {
  readonly supervisor?: RuntimeHostSandboxSupervisorPortV1;
}): SandboxPreparedProcessExecutionPortV1 {
  const supervisor = input?.supervisor ?? { execute: executePosixSupervisedV1 };
  return Object.freeze<SandboxPreparedProcessExecutionPortV1>({
    execute: async (executionInput) => {
      const authority = sandboxLifecycleAuthoritiesV1.get(executionInput.lifecycle);
      if (
        !authority ||
        authority.prepared !== executionInput.prepared ||
        authority.dispatchIntent !== executionInput.dispatchIntent ||
        authority.processConsumed
      ) {
        return failedProcessV1(
          'dispatch_not_acknowledged',
          'The exact prepared dispatch acknowledgement is unavailable or already consumed.',
          'not_started',
          noProcessCleanupV1(),
        );
      }
      authority.processConsumed = true;
      let supervisorRecordAttempted = false;
      let goStarted = false;
      try {
        const supervised = await supervisor.execute({
          prepared: executionInput.prepared,
          dispatchId: executionInput.dispatchIntent.dispatchId,
          supervisorNonce: executionInput.dispatchIntent.supervisorNonce,
          dispatchIntentDigest: executionInput.dispatchIntent.dispatchIntentDigest,
          lifecycle: {
            recordExecutionSupervisorStarted: async (prepared, started) => {
              supervisorRecordAttempted = true;
              const acknowledgement =
                await executionInput.lifecycle.recordExecutionSupervisorStarted(prepared, started);
              return (
                authority.supervisorStarted === acknowledgement &&
                acknowledgement.dispatchId === started.dispatchId &&
                acknowledgement.dispatchIntentDigest === started.dispatchIntentDigest
              );
            },
          },
          timeoutMs: executionInput.timeoutMs,
          ...(executionInput.signal ? { signal: executionInput.signal } : {}),
          ...(executionInput.onProgress ? { onProgress: executionInput.onProgress } : {}),
          ...(executionInput.ephemeralEnvironment
            ? { ephemeralEnvironment: executionInput.ephemeralEnvironment }
            : {}),
          onGoStarted: () => {
            goStarted = true;
          },
        });
        return projectSupervisedResultV1({
          supervised,
          goStarted,
          supervisorRecordAttempted,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (goStarted) {
          return unknownProcessV1('post_go_transport_lost', message, unknownCleanupV1());
        }
        return failedProcessV1(
          supervisorRecordAttempted ? 'supervisor_start_not_acknowledged' : 'spawn_failed',
          message,
          supervisorRecordAttempted ? 'supervisor_started_before_go' : 'not_started',
          supervisorRecordAttempted ? unknownCleanupV1() : noProcessCleanupV1(),
        );
      }
    },
  });
}

function projectSupervisedResultV1(input: {
  readonly supervised: {
    readonly outcome: RuntimeHostPreparedProcessResultV1;
    readonly cleanupConfirmed: boolean;
  };
  readonly goStarted: boolean;
  readonly supervisorRecordAttempted: boolean;
}): Readonly<SandboxPreparedProcessExecutionResultV1> {
  const cleanup = normalizeCleanupV1(input.supervised.outcome.processCleanup);
  if (!input.goStarted) {
    return failedProcessV1(
      input.supervisorRecordAttempted ? 'supervisor_start_not_acknowledged' : 'spawn_failed',
      input.supervised.outcome.stderr || 'Supervisor failed before GO.',
      input.supervisorRecordAttempted ? 'supervisor_started_before_go' : 'not_started',
      cleanup,
    );
  }
  if (!input.supervised.cleanupConfirmed || !cleanup.confirmedExited) {
    return unknownProcessV1(
      'post_go_cleanup_unknown',
      input.supervised.outcome.stderr || 'Process-tree cleanup could not be confirmed.',
      cleanup,
      input.supervised.outcome.stdout,
      input.supervised.outcome.stderr,
    );
  }
  if (input.supervised.outcome.terminationReason) {
    return Object.freeze({
      kind: 'terminated',
      executionPhase: 'go_started',
      terminationReason: input.supervised.outcome.terminationReason,
      exitCode: input.supervised.outcome.exitCode,
      stdout: input.supervised.outcome.stdout,
      stderr: input.supervised.outcome.stderr,
      processCleanup: cleanup,
    });
  }
  if (input.supervised.outcome.exitCode === -1) {
    return unknownProcessV1(
      'post_go_terminal_unknown',
      input.supervised.outcome.stderr || 'A trustworthy process terminal is unavailable.',
      cleanup,
      input.supervised.outcome.stdout,
      input.supervised.outcome.stderr,
    );
  }
  return Object.freeze({
    kind: 'completed',
    executionPhase: 'go_started',
    exitCode: input.supervised.outcome.exitCode,
    stdout: input.supervised.outcome.stdout,
    stderr: input.supervised.outcome.stderr,
    processCleanup: cleanup,
  });
}

function failedProcessV1(
  code: 'dispatch_not_acknowledged' | 'supervisor_start_not_acknowledged' | 'spawn_failed',
  message: string,
  executionPhase: 'not_started' | 'supervisor_started_before_go',
  processCleanup: Readonly<SandboxPreparedProcessCleanupV1>,
): Readonly<SandboxPreparedProcessExecutionResultV1> {
  return Object.freeze({
    kind: 'failed',
    executionPhase,
    exitCode: null,
    stdout: '',
    stderr: message,
    failure: Object.freeze({ code, message }),
    processCleanup,
  });
}

function unknownProcessV1(
  code: 'post_go_terminal_unknown' | 'post_go_transport_lost' | 'post_go_cleanup_unknown',
  message: string,
  processCleanup: Readonly<SandboxPreparedProcessCleanupV1>,
  stdout = '',
  stderr = message,
): Readonly<SandboxPreparedProcessExecutionResultV1> {
  return Object.freeze({
    kind: 'unknown',
    executionPhase: 'unknown_after_go',
    exitCode: null,
    stdout,
    stderr,
    unknown: Object.freeze({ code, message }),
    retryable: false,
    processCleanup,
  });
}

function normalizeCleanupV1(
  cleanup: RuntimeHostPreparedProcessResultV1['processCleanup'],
): Readonly<SandboxPreparedProcessCleanupV1> {
  return Object.freeze({
    confirmedExited: cleanup?.confirmedExited === true,
    gracefulRequested: cleanup?.gracefulRequested === true,
    forced: cleanup?.forced === true,
    unconfirmedDescendantCount:
      typeof cleanup?.unconfirmedDescendantCount === 'number' &&
      Number.isSafeInteger(cleanup.unconfirmedDescendantCount) &&
      cleanup.unconfirmedDescendantCount >= 0
        ? cleanup.unconfirmedDescendantCount
        : 1,
  });
}

function noProcessCleanupV1(): Readonly<SandboxPreparedProcessCleanupV1> {
  return Object.freeze({
    confirmedExited: true,
    gracefulRequested: false,
    forced: false,
    unconfirmedDescendantCount: 0,
  });
}

function unknownCleanupV1(): Readonly<SandboxPreparedProcessCleanupV1> {
  return Object.freeze({
    confirmedExited: false,
    gracefulRequested: true,
    forced: true,
    unconfirmedDescendantCount: 1,
  });
}

function assertAcknowledgementV1(
  acknowledgement: Readonly<{ readonly acknowledged: true; readonly stage: string }>,
  stage: RuntimeHostSandboxLifecycleEvidenceV1['stage'],
): void {
  assertFrozenObjectV1(acknowledgement, `${stage} acknowledgement`);
  if (acknowledgement.acknowledged !== true || acknowledgement.stage !== stage) {
    fail('invalid_acknowledgement', `${stage} acknowledgement has an invalid shape.`);
  }
}

function verifyEvidenceV1(
  evidencePort: RuntimeHostSandboxLifecycleEvidencePortV1,
  evidence: RuntimeHostSandboxLifecycleEvidenceV1,
): void {
  const result = evidencePort.verify(Object.freeze(evidence));
  if (result.valid !== true) {
    fail('evidence_rejected', `Durable ${evidence.stage} evidence was rejected: ${result.code}.`);
  }
}

function assertExactPreparedV1(
  authority: RuntimeHostSandboxLifecycleAuthorityV1,
  prepared: Readonly<PreparedSandboxExecutionV1>,
): void {
  if (authority.prepared !== prepared) {
    fail('invalid_input', 'Prepared execution is not the exact acknowledged plan.');
  }
}

function assertFrozenObjectV1(value: object, label: string): void {
  if (!Object.isFrozen(value)) fail('invalid_input', `${label} must be frozen.`);
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) fail('invalid_stage', message);
  return value;
}

function fail(code: RuntimeHostSandboxLifecycleFailureCodeV1, message: string): never {
  throw new RuntimeHostSandboxLifecycleErrorV1(code, message);
}
