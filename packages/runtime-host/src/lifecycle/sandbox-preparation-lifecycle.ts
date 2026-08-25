import type {
  PreparedSandboxExecution,
  SandboxDisposalIntentAcknowledgement,
  SandboxDisposalReceiptAcknowledgement,
  SandboxExecutionDispatchIntentAcknowledgement,
  SandboxExecutionSupervisorStartedAcknowledgement,
  SandboxPreparation,
  SandboxPreparationArtifactPort,
  SandboxPreparationIntentAcknowledgement,
  SandboxPreparationLifecycle,
  SandboxPreparationReadyAcknowledgement,
  SandboxPreparedProcessCleanup,
  SandboxPreparedProcessExecutionPort,
  SandboxPreparedProcessExecutionResult,
} from '@kite/runtime-spi';
import {
  executePosixSupervised,
  type RuntimeHostPreparedProcessInput,
  type RuntimeHostPreparedProcessResult,
} from '../process/posix-supervisor';

export type RuntimeHostSandboxLifecycleEvidence =
  | {
      readonly stage: 'preparation_intent';
      readonly preparation: Readonly<SandboxPreparation>;
      readonly acknowledgement: Readonly<SandboxPreparationIntentAcknowledgement>;
    }
  | {
      readonly stage: 'preparation_ready';
      readonly preparationIntent: Readonly<SandboxPreparationIntentAcknowledgement>;
      readonly prepared: Readonly<PreparedSandboxExecution>;
      readonly acknowledgement: Readonly<SandboxPreparationReadyAcknowledgement>;
    }
  | {
      readonly stage: 'execution_dispatch_intent';
      readonly preparationReady: Readonly<SandboxPreparationReadyAcknowledgement>;
      readonly prepared: Readonly<PreparedSandboxExecution>;
      readonly acknowledgement: Readonly<SandboxExecutionDispatchIntentAcknowledgement>;
    }
  | {
      readonly stage: 'execution_supervisor_started';
      readonly dispatchIntent: Readonly<SandboxExecutionDispatchIntentAcknowledgement>;
      readonly prepared: Readonly<PreparedSandboxExecution>;
      readonly acknowledgement: Readonly<SandboxExecutionSupervisorStartedAcknowledgement>;
    }
  | {
      readonly stage: 'disposal_intent';
      readonly preparationIntent: Readonly<SandboxPreparationIntentAcknowledgement>;
      readonly preparationReady: Readonly<SandboxPreparationReadyAcknowledgement> | null;
      readonly prepared: Readonly<PreparedSandboxExecution> | null;
      readonly acknowledgement: Readonly<SandboxDisposalIntentAcknowledgement>;
    }
  | {
      readonly stage: 'disposal_receipt';
      readonly disposalIntent: Readonly<SandboxDisposalIntentAcknowledgement>;
      readonly prepared: Readonly<PreparedSandboxExecution> | null;
      readonly acknowledgement: Readonly<SandboxDisposalReceiptAcknowledgement>;
    };

export type RuntimeHostSandboxLifecycleEvidenceVerificationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly code: 'not_reflected' | 'identity_mismatch' | 'stale_stage';
    };

/** App-owned durable callbacks. Host owns ordering, never domain-state or event encoding. */
export interface RuntimeHostSandboxLifecyclePersistence {
  persistPreparationIntent(input: {
    readonly preparation: Readonly<SandboxPreparation>;
  }): Promise<Readonly<SandboxPreparationIntentAcknowledgement>>;
  persistPreparationReady(input: {
    readonly preparationIntent: Readonly<SandboxPreparationIntentAcknowledgement>;
    readonly prepared: Readonly<PreparedSandboxExecution>;
    readonly preparationArtifact: ReturnType<SandboxPreparationArtifactPort['write']>;
  }): Promise<Readonly<SandboxPreparationReadyAcknowledgement>>;
  persistExecutionDispatchIntent(input: {
    readonly preparationReady: Readonly<SandboxPreparationReadyAcknowledgement>;
    readonly prepared: Readonly<PreparedSandboxExecution>;
    readonly dispatchId: string;
    readonly supervisorNonce: string;
  }): Promise<Readonly<SandboxExecutionDispatchIntentAcknowledgement>>;
  persistExecutionSupervisorStarted(input: {
    readonly dispatchIntent: Readonly<SandboxExecutionDispatchIntentAcknowledgement>;
    readonly prepared: Readonly<PreparedSandboxExecution>;
    readonly supervisorPid: number;
    readonly processGroupId: number;
    readonly processStartIdentity: string;
  }): Promise<Readonly<SandboxExecutionSupervisorStartedAcknowledgement>>;
  persistDisposalIntent(input: {
    readonly preparationIntent: Readonly<SandboxPreparationIntentAcknowledgement>;
    readonly preparationReady: Readonly<SandboxPreparationReadyAcknowledgement> | null;
    readonly prepared: Readonly<PreparedSandboxExecution> | null;
  }): Promise<Readonly<SandboxDisposalIntentAcknowledgement>>;
  persistDisposalReceipt(input: {
    readonly disposalIntent: Readonly<SandboxDisposalIntentAcknowledgement>;
    readonly prepared: Readonly<PreparedSandboxExecution> | null;
    readonly disposed: boolean;
  }): Promise<Readonly<SandboxDisposalReceiptAcknowledgement>>;
}

export interface RuntimeHostSandboxLifecycleEvidencePort {
  verify(
    evidence: Readonly<RuntimeHostSandboxLifecycleEvidence>,
  ): RuntimeHostSandboxLifecycleEvidenceVerificationResult;
}

export type RuntimeHostSandboxLifecycleFailureCode =
  | 'invalid_input'
  | 'invalid_stage'
  | 'invalid_acknowledgement'
  | 'evidence_rejected'
  | 'artifact_identity_mismatch'
  | 'already_consumed';

export class RuntimeHostSandboxLifecycleError extends Error {
  readonly code: RuntimeHostSandboxLifecycleFailureCode;

  constructor(code: RuntimeHostSandboxLifecycleFailureCode, message: string) {
    super(message);
    this.name = 'RuntimeHostSandboxLifecycleError';
    this.code = code;
  }
}

interface RuntimeHostSandboxLifecycleAuthority {
  preparation?: Readonly<SandboxPreparation>;
  preparationIntent?: Readonly<SandboxPreparationIntentAcknowledgement>;
  prepared?: Readonly<PreparedSandboxExecution>;
  preparationReady?: Readonly<SandboxPreparationReadyAcknowledgement>;
  dispatchIntent?: Readonly<SandboxExecutionDispatchIntentAcknowledgement>;
  supervisorStarted?: Readonly<SandboxExecutionSupervisorStartedAcknowledgement>;
  disposalIntent?: Readonly<SandboxDisposalIntentAcknowledgement>;
  disposed: boolean;
  processConsumed: boolean;
}

const sandboxLifecycleAuthorities = new WeakMap<
  SandboxPreparationLifecycle,
  RuntimeHostSandboxLifecycleAuthority
>();

/**
 * Generic durable lifecycle coordinator. Persistence supplies opaque digests
 * and evidence; Host enforces exact-object, single-owner stage ordering only.
 */
export function createRuntimeHostSandboxPreparationLifecycle(input: {
  readonly persistence: RuntimeHostSandboxLifecyclePersistence;
  readonly evidence: RuntimeHostSandboxLifecycleEvidencePort;
  readonly artifacts: SandboxPreparationArtifactPort;
}): SandboxPreparationLifecycle {
  const authority: RuntimeHostSandboxLifecycleAuthority = {
    disposed: false,
    processConsumed: false,
  };
  const lifecycle = Object.freeze<SandboxPreparationLifecycle>({
    recordPreparationIntent: async (preparation) => {
      assertFrozenObject(preparation, 'preparation');
      if (authority.preparationIntent)
        fail('already_consumed', 'Preparation intent already exists.');
      const acknowledgement = await input.persistence.persistPreparationIntent({ preparation });
      assertAcknowledgement(acknowledgement, 'preparation_intent');
      verifyEvidence(input.evidence, {
        stage: 'preparation_intent',
        preparation,
        acknowledgement,
      });
      authority.preparation = preparation;
      authority.preparationIntent = acknowledgement;
      return acknowledgement;
    },
    recordPreparationReady: async (prepared) => {
      assertFrozenObject(prepared, 'prepared execution');
      const preparationIntent = required(
        authority.preparationIntent,
        'Preparation intent must be acknowledged before ready.',
      );
      if (authority.preparationReady) fail('already_consumed', 'Preparation ready already exists.');
      const preparationArtifact = input.artifacts.write(prepared);
      assertFrozenObject(preparationArtifact, 'preparation artifact reference');
      if (input.artifacts.read(preparationArtifact) !== prepared) {
        fail('artifact_identity_mismatch', 'Preparation Artifact did not return the exact plan.');
      }
      const acknowledgement = await input.persistence.persistPreparationReady({
        preparationIntent,
        prepared,
        preparationArtifact,
      });
      assertAcknowledgement(acknowledgement, 'preparation_ready');
      if (acknowledgement.preparationArtifact !== preparationArtifact) {
        fail('artifact_identity_mismatch', 'Ready acknowledgement changed the Artifact identity.');
      }
      verifyEvidence(input.evidence, {
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
      assertExactPrepared(authority, prepared);
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
      assertAcknowledgement(acknowledgement, 'execution_dispatch_intent');
      if (
        acknowledgement.dispatchId !== dispatch.dispatchId ||
        acknowledgement.supervisorNonce !== dispatch.supervisorNonce
      ) {
        fail('invalid_acknowledgement', 'Dispatch acknowledgement changed its identity.');
      }
      verifyEvidence(input.evidence, {
        stage: 'execution_dispatch_intent',
        preparationReady,
        prepared,
        acknowledgement,
      });
      authority.dispatchIntent = acknowledgement;
      return acknowledgement;
    },
    recordExecutionSupervisorStarted: async (prepared, supervisor) => {
      assertExactPrepared(authority, prepared);
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
      assertAcknowledgement(acknowledgement, 'execution_supervisor_started');
      if (
        acknowledgement.dispatchId !== supervisor.dispatchId ||
        acknowledgement.dispatchIntentDigest !== supervisor.dispatchIntentDigest ||
        acknowledgement.supervisorPid !== supervisor.supervisorPid ||
        acknowledgement.processGroupId !== supervisor.processGroupId ||
        acknowledgement.processStartIdentity !== supervisor.processStartIdentity
      ) {
        fail('invalid_acknowledgement', 'Supervisor acknowledgement changed its identity.');
      }
      verifyEvidence(input.evidence, {
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
        assertExactPrepared(authority, prepared);
      }
      const acknowledgement = await input.persistence.persistDisposalIntent({
        preparationIntent,
        preparationReady,
        prepared,
      });
      assertAcknowledgement(acknowledgement, 'disposal_intent');
      const expectedPurpose = prepared === null ? 'reconcile_preparation_intent' : 'dispose';
      if (
        acknowledgement.purpose !== expectedPurpose ||
        !Number.isSafeInteger(acknowledgement.cleanupAttempt) ||
        acknowledgement.cleanupAttempt < 1
      ) {
        fail('invalid_acknowledgement', 'Disposal acknowledgement changed its identity.');
      }
      verifyEvidence(input.evidence, {
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
      if (prepared !== null) assertExactPrepared(authority, prepared);
      const acknowledgement = await input.persistence.persistDisposalReceipt({
        disposalIntent,
        prepared,
        disposed,
      });
      assertAcknowledgement(acknowledgement, 'disposal_receipt');
      if (
        acknowledgement.purpose !== purpose ||
        acknowledgement.lifecycleIntentDigest !== lifecycleIntentDigest ||
        acknowledgement.cleanupAttempt !== cleanupAttempt ||
        acknowledgement.disposed !== disposed
      ) {
        fail('invalid_acknowledgement', 'Disposal receipt acknowledgement changed its identity.');
      }
      verifyEvidence(input.evidence, {
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
  sandboxLifecycleAuthorities.set(lifecycle, authority);
  return lifecycle;
}

export interface RuntimeHostSandboxSupervisorPort {
  execute(input: RuntimeHostPreparedProcessInput): Promise<{
    readonly outcome: RuntimeHostPreparedProcessResult;
    readonly cleanupConfirmed: boolean;
  }>;
}

/**
 * Adapts the generic POSIX supervisor into the neutral SPI process result.
 * It deliberately treats every unconfirmed post-GO result as unknown.
 */
export function createRuntimeHostSandboxPreparedProcessExecutionPort(input?: {
  readonly supervisor?: RuntimeHostSandboxSupervisorPort;
}): SandboxPreparedProcessExecutionPort {
  const supervisor = input?.supervisor ?? { execute: executePosixSupervised };
  return Object.freeze<SandboxPreparedProcessExecutionPort>({
    execute: async (executionInput) => {
      const authority = sandboxLifecycleAuthorities.get(executionInput.lifecycle);
      if (
        !authority ||
        authority.prepared !== executionInput.prepared ||
        authority.dispatchIntent !== executionInput.dispatchIntent ||
        authority.processConsumed
      ) {
        return failedProcess(
          'dispatch_not_acknowledged',
          'The exact prepared dispatch acknowledgement is unavailable or already consumed.',
          'not_started',
          noProcessCleanup(),
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
        return projectSupervisedResult({
          supervised,
          goStarted,
          supervisorRecordAttempted,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (goStarted) {
          return unknownProcess('post_go_transport_lost', message, unknownCleanup());
        }
        return failedProcess(
          supervisorRecordAttempted ? 'supervisor_start_not_acknowledged' : 'spawn_failed',
          message,
          supervisorRecordAttempted ? 'supervisor_started_before_go' : 'not_started',
          supervisorRecordAttempted ? unknownCleanup() : noProcessCleanup(),
        );
      }
    },
  });
}

function projectSupervisedResult(input: {
  readonly supervised: {
    readonly outcome: RuntimeHostPreparedProcessResult;
    readonly cleanupConfirmed: boolean;
  };
  readonly goStarted: boolean;
  readonly supervisorRecordAttempted: boolean;
}): Readonly<SandboxPreparedProcessExecutionResult> {
  const cleanup = normalizeCleanup(input.supervised.outcome.processCleanup);
  if (!input.goStarted) {
    return failedProcess(
      input.supervisorRecordAttempted ? 'supervisor_start_not_acknowledged' : 'spawn_failed',
      input.supervised.outcome.stderr || 'Supervisor failed before GO.',
      input.supervisorRecordAttempted ? 'supervisor_started_before_go' : 'not_started',
      cleanup,
    );
  }
  if (!input.supervised.cleanupConfirmed || !cleanup.confirmedExited) {
    return unknownProcess(
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
    return unknownProcess(
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

function failedProcess(
  code: 'dispatch_not_acknowledged' | 'supervisor_start_not_acknowledged' | 'spawn_failed',
  message: string,
  executionPhase: 'not_started' | 'supervisor_started_before_go',
  processCleanup: Readonly<SandboxPreparedProcessCleanup>,
): Readonly<SandboxPreparedProcessExecutionResult> {
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

function unknownProcess(
  code: 'post_go_terminal_unknown' | 'post_go_transport_lost' | 'post_go_cleanup_unknown',
  message: string,
  processCleanup: Readonly<SandboxPreparedProcessCleanup>,
  stdout = '',
  stderr = message,
): Readonly<SandboxPreparedProcessExecutionResult> {
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

function normalizeCleanup(
  cleanup: RuntimeHostPreparedProcessResult['processCleanup'],
): Readonly<SandboxPreparedProcessCleanup> {
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

function noProcessCleanup(): Readonly<SandboxPreparedProcessCleanup> {
  return Object.freeze({
    confirmedExited: true,
    gracefulRequested: false,
    forced: false,
    unconfirmedDescendantCount: 0,
  });
}

function unknownCleanup(): Readonly<SandboxPreparedProcessCleanup> {
  return Object.freeze({
    confirmedExited: false,
    gracefulRequested: true,
    forced: true,
    unconfirmedDescendantCount: 1,
  });
}

function assertAcknowledgement(
  acknowledgement: Readonly<{ readonly acknowledged: true; readonly stage: string }>,
  stage: RuntimeHostSandboxLifecycleEvidence['stage'],
): void {
  assertFrozenObject(acknowledgement, `${stage} acknowledgement`);
  if (acknowledgement.acknowledged !== true || acknowledgement.stage !== stage) {
    fail('invalid_acknowledgement', `${stage} acknowledgement has an invalid shape.`);
  }
}

function verifyEvidence(
  evidencePort: RuntimeHostSandboxLifecycleEvidencePort,
  evidence: RuntimeHostSandboxLifecycleEvidence,
): void {
  const result = evidencePort.verify(Object.freeze(evidence));
  if (result.valid !== true) {
    fail('evidence_rejected', `Durable ${evidence.stage} evidence was rejected: ${result.code}.`);
  }
}

function assertExactPrepared(
  authority: RuntimeHostSandboxLifecycleAuthority,
  prepared: Readonly<PreparedSandboxExecution>,
): void {
  if (authority.prepared !== prepared) {
    fail('invalid_input', 'Prepared execution is not the exact acknowledged plan.');
  }
}

function assertFrozenObject(value: object, label: string): void {
  if (!Object.isFrozen(value)) fail('invalid_input', `${label} must be frozen.`);
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) fail('invalid_stage', message);
  return value;
}

function fail(code: RuntimeHostSandboxLifecycleFailureCode, message: string): never {
  throw new RuntimeHostSandboxLifecycleError(code, message);
}
