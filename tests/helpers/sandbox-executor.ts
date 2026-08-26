import { randomUUID } from 'node:crypto';
import type {
  BuiltinPreparedShellExecutionConsumerOptions,
  ResourceLimits,
  SandboxBackend,
  ShellExecutor,
  ShellResult,
} from '@kite-ai/builtin-runtime/sandbox';
import {
  createBuiltinPreparedShellExecutionConsumer,
  detectSandboxBackend,
  findUsableBubblewrap,
  findUsableCgroupPidsRunner,
  LocalSandboxExecutionProvider,
  sandboxPreparationIntentDigest,
} from '@kite-ai/builtin-runtime/sandbox';
import { executePosixSupervised } from '@kite-ai/runtime-host';
import type {
  PreparedSandboxExecution,
  SandboxPreparation,
  SandboxPreparationLifecycle,
  SandboxPreparedProcessCleanup,
  SandboxPreparedProcessExecutionPort,
  SandboxPreparedProcessExecutionResult,
} from '@kite-ai/runtime-spi';
import {
  SandboxExecutionGrantAuthority,
  sandboxPreparationDigest,
} from '#kite-cli/sandbox/runtime-execution';
import { shellTool } from './shell-executor';

export type TestSandboxLifecycleTransition =
  | 'preparation_intent_recorded'
  | 'preparation_ready_recorded'
  | 'execution_dispatch_intent_recorded'
  | 'execution_supervisor_started_recorded'
  | 'disposal_intent_recorded'
  | 'preparation_reconciliation_intent_recorded'
  | 'disposal_receipt_confirmed'
  | 'disposal_receipt_unconfirmed';

export interface TestSandboxDisposalReceipt {
  readonly prepared: Readonly<PreparedSandboxExecution> | null;
  readonly purpose: 'dispose' | 'reconcile_preparation_intent';
  readonly lifecycleIntentDigest: string;
  readonly cleanupAttempt: number;
  readonly disposed: boolean;
}

/**
 * Test-only composition for the Builtin prepared consumer.  The production
 * App composition supplies its own Host process port and durable lifecycle;
 * tests use the same Builtin consumer with a small in-memory SPI lifecycle
 * and the generic Host POSIX supervisor.
 */
export function createBuiltinSandboxExecutionConsumerForTest(
  options: Omit<BuiltinPreparedShellExecutionConsumerOptions, 'preparedProcess'> & {
    readonly preparedProcess?: SandboxPreparedProcessExecutionPort;
  },
): ShellExecutor {
  const preparedConsumer = createBuiltinPreparedShellExecutionConsumer({
    ...options,
    preparedProcess: options.preparedProcess ?? createTestPreparedProcessExecutionPort(),
  });
  const consumer: ShellExecutor = async (input) => {
    const result = await preparedConsumer({
      identity: input.sandboxInvocationIdentity!,
      workspace: input.workspace,
      command: input.command,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.filesystemMode ? { filesystemMode: input.filesystemMode } : {}),
      ...(input.networkMode ? { networkMode: input.networkMode } : {}),
      ...(input.executionTrust ? { executionTrust: input.executionTrust } : {}),
      ...(input.sandboxPreparationLifecycle
        ? { lifecycle: input.sandboxPreparationLifecycle }
        : {}),
    });
    return {
      ok: result.ok,
      command: result.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
      ...(result.sandboxFailure ? { sandboxFailure: result.sandboxFailure } : {}),
      ...(result.processCleanup
        ? {
            processCleanup: {
              confirmedExited: result.processCleanup.confirmedExited,
              gracefulRequested: result.processCleanup.gracefulRequested,
              forced: result.processCleanup.forced,
              unconfirmedDescendantCount: result.processCleanup.unconfirmedDescendantCount,
            },
          }
        : {}),
    };
  };
  return consumer;
}

export function createCompletedPreparedProcessPortForTest(): SandboxPreparedProcessExecutionPort {
  return Object.freeze({
    execute: async () =>
      Object.freeze({
        kind: 'completed' as const,
        executionPhase: 'go_started' as const,
        exitCode: 0,
        stdout: '',
        stderr: '',
        processCleanup: cleanNoProcess(),
      }),
  });
}

function createTestPreparedProcessExecutionPort(): SandboxPreparedProcessExecutionPort {
  return Object.freeze({
    execute: async (input: Parameters<SandboxPreparedProcessExecutionPort['execute']>[0]) => {
      if (input.prepared.backend === 'windows_restricted_token') {
        return Object.freeze({
          kind: 'failed' as const,
          executionPhase: 'not_started' as const,
          exitCode: null,
          stdout: '',
          stderr: 'Windows prepared process execution is not available in the POSIX test adapter.',
          failure: Object.freeze({
            code: 'invalid_prepared_execution' as const,
            message:
              'Windows prepared process execution is not available in the POSIX test adapter.',
          }),
          processCleanup: cleanNoProcess(),
        });
      }

      let supervisorStartAttempted = false;
      let goStarted = false;
      const supervised = await executePosixSupervised({
        prepared: input.prepared,
        dispatchId: input.dispatchIntent.dispatchId,
        supervisorNonce: input.dispatchIntent.supervisorNonce,
        dispatchIntentDigest: input.dispatchIntent.dispatchIntentDigest,
        lifecycle: {
          recordExecutionSupervisorStarted: async (prepared, started) => {
            supervisorStartAttempted = true;
            const acknowledgement = await input.lifecycle.recordExecutionSupervisorStarted(
              prepared,
              started,
            );
            return (
              acknowledgement.acknowledged === true &&
              acknowledgement.stage === 'execution_supervisor_started' &&
              acknowledgement.dispatchId === started.dispatchId &&
              acknowledgement.dispatchIntentDigest === started.dispatchIntentDigest &&
              acknowledgement.supervisorPid === started.supervisorPid &&
              acknowledgement.processGroupId === started.processGroupId &&
              acknowledgement.processStartIdentity === started.processStartIdentity
            );
          },
        },
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        onGoStarted: () => {
          goStarted = true;
        },
      });
      const cleanup = normalizeCleanup(supervised.outcome.processCleanup);
      if (!goStarted) {
        return failedProcess(
          supervisorStartAttempted ? 'supervisor_start_not_acknowledged' : 'spawn_failed',
          supervised.outcome.stderr || 'Supervisor failed before GO.',
          supervisorStartAttempted ? 'supervisor_started_before_go' : 'not_started',
          cleanup,
        );
      }
      if (!supervised.cleanupConfirmed || !cleanup.confirmedExited) {
        return unknownProcess(
          'post_go_cleanup_unknown',
          supervised.outcome.stderr || 'Process-tree cleanup could not be confirmed.',
          cleanup,
          supervised.outcome.stdout,
          supervised.outcome.stderr,
        );
      }
      if (
        supervised.outcome.terminationReason === 'timed_out' ||
        supervised.outcome.terminationReason === 'cancelled'
      ) {
        return Object.freeze({
          kind: 'terminated' as const,
          executionPhase: 'go_started' as const,
          terminationReason: supervised.outcome.terminationReason,
          exitCode: supervised.outcome.exitCode,
          stdout: supervised.outcome.stdout,
          stderr: supervised.outcome.stderr,
          processCleanup: cleanup,
        });
      }
      if (supervised.outcome.exitCode === -1) {
        return unknownProcess(
          'post_go_terminal_unknown',
          supervised.outcome.stderr || 'A trustworthy process terminal is unavailable.',
          cleanup,
          supervised.outcome.stdout,
          supervised.outcome.stderr,
        );
      }
      return Object.freeze({
        kind: 'completed' as const,
        executionPhase: 'go_started' as const,
        exitCode: supervised.outcome.exitCode,
        stdout: supervised.outcome.stdout,
        stderr: supervised.outcome.stderr,
        processCleanup: cleanup,
      });
    },
  });
}

function failedProcess(
  code: 'supervisor_start_not_acknowledged' | 'spawn_failed' | 'invalid_prepared_execution',
  message: string,
  executionPhase: 'not_started' | 'supervisor_started_before_go' = 'not_started',
  processCleanup: Readonly<SandboxPreparedProcessCleanup> = cleanNoProcess(),
): Readonly<SandboxPreparedProcessExecutionResult> {
  return Object.freeze({
    kind: 'failed' as const,
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
    kind: 'unknown' as const,
    executionPhase: 'unknown_after_go' as const,
    exitCode: null,
    stdout,
    stderr,
    unknown: Object.freeze({ code, message }),
    retryable: false as const,
    processCleanup,
  });
}

function normalizeCleanup(
  cleanup: Readonly<NonNullable<ShellResult['processCleanup']>> | undefined,
): Readonly<SandboxPreparedProcessCleanup> {
  return Object.freeze({
    confirmedExited: cleanup?.confirmedExited === true,
    gracefulRequested: cleanup?.gracefulRequested === true,
    forced: cleanup?.forced === true,
    unconfirmedDescendantCount:
      Number.isSafeInteger(cleanup?.unconfirmedDescendantCount) &&
      Number(cleanup?.unconfirmedDescendantCount) >= 0
        ? Number(cleanup?.unconfirmedDescendantCount)
        : 1,
  });
}

function cleanNoProcess(): Readonly<SandboxPreparedProcessCleanup> {
  return Object.freeze({
    confirmedExited: true,
    gracefulRequested: false,
    forced: false,
    unconfirmedDescendantCount: 0,
  });
}

/** Native test oracle only. Production has no direct or in-memory lifecycle entry. */
export function createSandboxExecutor(
  options: {
    enabled: boolean;
    workspace: string;
    filesystemScope?: 'read_only' | 'workspace_write';
    unavailableFallback?: 'bare_shell' | 'fail';
    runtimeReadOnlyRoots?: readonly string[];
    resourceLimits?: Partial<ResourceLimits>;
    maxProcessTreeTasks?: number;
    startupProbe?: boolean;
    selectedBackend?: SandboxBackend;
    brokeredGitFeatureRevision?: typeof import('@kite-ai/runtime-spi').BROKERED_GIT_FEATURE_REVISION_;
    executionBoundaryDigest?: string;
    protectedPathRevision?: string;
  },
  bareShellFallback: ShellExecutor = shellTool,
): ShellExecutor {
  if (!options.enabled) {
    return options.unavailableFallback === 'fail'
      ? deniedExecutor('sandbox_disabled')
      : bareShellFallback;
  }
  const backend = options.selectedBackend ?? detectSandboxBackend();
  if (backend === 'none') {
    return options.unavailableFallback === 'fail'
      ? deniedExecutor('sandbox_backend_unavailable')
      : bareShellFallback;
  }
  const grants = new SandboxExecutionGrantAuthority();
  const provider = new LocalSandboxExecutionProvider(grants.verifier(), {
    backend,
    canonicalWorkspace: options.workspace,
    filesystemScope: options.filesystemScope,
    runtimeReadOnlyRoots: options.runtimeReadOnlyRoots,
    brokeredGitFeatureRevision: options.brokeredGitFeatureRevision,
    startupProbe: options.startupProbe,
    bubblewrapPath: backend === 'bubblewrap' ? (findUsableBubblewrap() ?? undefined) : undefined,
    cgroupPidsRunner:
      backend === 'bubblewrap' && options.maxProcessTreeTasks
        ? (findUsableCgroupPidsRunner() ?? undefined)
        : undefined,
  });
  const consumer = createBuiltinSandboxExecutionConsumerForTest({
    provider,
    backend,
    grants,
    canonicalWorkspace: options.workspace,
    executionBoundaryDigest: options.executionBoundaryDigest ?? 'test-sandbox-boundary-v1',
    protectedPathRevision: options.protectedPathRevision ?? 'test-protected-path-boundary-v1',
    maxProcessTreeTasks: options.maxProcessTreeTasks,
    resourceLimits: options.resourceLimits,
  });
  return withAcknowledgedSandboxLifecycleForTest(consumer);
}

/**
 * Test-only Runtime lifecycle oracle for native App-composition tests.
 * Production callers must receive these facts from the durable Tool Pipeline.
 */
export function withAcknowledgedSandboxLifecycleForTest(
  executor: ShellExecutor,
  options: {
    readonly onTransition?: (transition: TestSandboxLifecycleTransition) => void;
    readonly onDisposalReceipt?: (receipt: TestSandboxDisposalReceipt) => void;
  } = {},
): ShellExecutor {
  return async (input) => {
    const invocationId = `test:${randomUUID()}`;
    let phase:
      | 'empty'
      | 'intent_recorded'
      | 'ready_recorded'
      | 'dispatch_recorded'
      | 'supervisor_started'
      | 'disposal_intent_recorded'
      | 'disposal_receipt_recorded' = 'empty';
    let preparation: Readonly<SandboxPreparation> | undefined;
    let prepared: Readonly<PreparedSandboxExecution> | undefined;
    let dispatch:
      | {
          readonly dispatchId: string;
          readonly dispatchIntentDigest: string;
        }
      | undefined;
    let cleanup:
      | {
          readonly purpose: 'dispose' | 'reconcile_preparation_intent';
          readonly lifecycleIntentDigest: string;
          readonly prepared: Readonly<PreparedSandboxExecution> | null;
        }
      | undefined;
    const transition = (next: TestSandboxLifecycleTransition): void => {
      options.onTransition?.(next);
    };
    const samePrepared = (candidate: Readonly<PreparedSandboxExecution>): boolean =>
      Boolean(
        preparation &&
          candidate.preparationDigest === sandboxPreparationDigest(preparation) &&
          candidate.toolCallId === preparation.toolCallId &&
          candidate.capabilityId === preparation.capabilityId &&
          candidate.capabilityRevision === preparation.capabilityRevision &&
          candidate.invocationId === preparation.invocationId &&
          candidate.attempt === preparation.attempt &&
          candidate.canonicalWorkspace === preparation.canonicalWorkspace &&
          candidate.commandDigest === preparation.commandDigest,
      );
    const lifecycle: SandboxPreparationLifecycle = {
      async recordPreparationIntent(candidate) {
        if (phase !== 'empty') throw new Error('duplicate preparation intent');
        preparation = candidate;
        phase = 'intent_recorded';
        transition('preparation_intent_recorded');
        return Object.freeze({
          acknowledged: true as const,
          stage: 'preparation_intent' as const,
          intentDigest: sandboxPreparationIntentDigest({
            attempt: candidate.attempt,
            toolCallId: candidate.toolCallId,
            capabilityId: candidate.capabilityId,
            capabilityRevision: candidate.capabilityRevision,
            canonicalWorkspace: candidate.canonicalWorkspace,
            effectiveEffectsDigest: candidate.effectiveEffectsDigest,
            admissionDigest: candidate.admissionDigest,
            preparationDigest: sandboxPreparationDigest(candidate),
            commandDigest: candidate.commandDigest,
            executionBoundaryDigest: candidate.executionBoundaryDigest,
            resourceSemantics: 'allocating',
          }),
        });
      },
      async recordPreparationReady(candidate) {
        if (phase !== 'intent_recorded' || !samePrepared(candidate)) {
          throw new Error('preparation-ready acknowledgement rejected');
        }
        prepared = candidate;
        phase = 'ready_recorded';
        transition('preparation_ready_recorded');
        return Object.freeze({
          acknowledged: true as const,
          stage: 'preparation_ready' as const,
          readyDigest: `test-ready:${candidate.planId}`,
          preparationArtifact: Object.freeze({
            artifactId: `test-artifact:${candidate.planId}`,
            kind: 'sandbox_preparation' as const,
            integrityIdentifier: `test-integrity:${candidate.planId}`,
            byteLength: 1,
          }),
        });
      },
      async recordExecutionDispatchIntent(candidate, candidateDispatch) {
        if (
          !['empty', 'ready_recorded'].includes(phase) ||
          (phase === 'ready_recorded' && (candidate !== prepared || !samePrepared(candidate)))
        ) {
          throw new Error('dispatch before exact preparation-ready acknowledgement');
        }
        if (phase === 'empty') prepared = candidate;
        const dispatchIntentDigest = `test-dispatch:${candidateDispatch.dispatchId}`;
        dispatch = {
          dispatchId: candidateDispatch.dispatchId,
          dispatchIntentDigest,
        };
        phase = 'dispatch_recorded';
        transition('execution_dispatch_intent_recorded');
        return Object.freeze({
          acknowledged: true as const,
          stage: 'execution_dispatch_intent' as const,
          dispatchId: candidateDispatch.dispatchId,
          supervisorNonce: candidateDispatch.supervisorNonce,
          dispatchIntentDigest,
        });
      },
      async recordExecutionSupervisorStarted(candidate, candidateSupervisor) {
        if (
          phase !== 'dispatch_recorded' ||
          candidate !== prepared ||
          candidateSupervisor.dispatchId !== dispatch?.dispatchId ||
          candidateSupervisor.dispatchIntentDigest !== dispatch?.dispatchIntentDigest
        ) {
          throw new Error('execution supervisor start acknowledgement rejected');
        }
        const dispatchRecord = dispatch;
        phase = 'supervisor_started';
        transition('execution_supervisor_started_recorded');
        return Object.freeze({
          acknowledged: true as const,
          stage: 'execution_supervisor_started' as const,
          dispatchId: dispatchRecord!.dispatchId,
          dispatchIntentDigest: dispatchRecord!.dispatchIntentDigest,
          supervisorPid: candidateSupervisor.supervisorPid,
          processGroupId: candidateSupervisor.processGroupId,
          processStartIdentity: candidateSupervisor.processStartIdentity,
        });
      },
      async recordDisposalIntent(candidate) {
        const purpose = candidate === null ? 'reconcile_preparation_intent' : 'dispose';
        if (
          (candidate === null && phase !== 'intent_recorded') ||
          (candidate !== null &&
            (candidate !== prepared ||
              !['ready_recorded', 'dispatch_recorded', 'supervisor_started'].includes(phase)))
        ) {
          throw new Error('disposal intent acknowledgement rejected');
        }
        const lifecycleIntentDigest = `test-${purpose}:${invocationId}`;
        cleanup = { purpose, lifecycleIntentDigest, prepared: candidate };
        phase = 'disposal_intent_recorded';
        transition(
          purpose === 'dispose'
            ? 'disposal_intent_recorded'
            : 'preparation_reconciliation_intent_recorded',
        );
        return Object.freeze({
          acknowledged: true as const,
          stage: 'disposal_intent' as const,
          purpose,
          lifecycleIntentDigest,
          cleanupAttempt: 1,
        });
      },
      async recordDisposalReceipt(receipt) {
        if (
          phase !== 'disposal_intent_recorded' ||
          receipt.prepared !== cleanup?.prepared ||
          receipt.purpose !== cleanup.purpose ||
          receipt.lifecycleIntentDigest !== cleanup.lifecycleIntentDigest ||
          receipt.cleanupAttempt !== 1
        ) {
          throw new Error('disposal receipt acknowledgement rejected');
        }
        phase = 'disposal_receipt_recorded';
        options.onDisposalReceipt?.(receipt);
        transition(
          receipt.disposed ? 'disposal_receipt_confirmed' : 'disposal_receipt_unconfirmed',
        );
        return Object.freeze({
          acknowledged: true as const,
          stage: 'disposal_receipt' as const,
          purpose: receipt.purpose,
          lifecycleIntentDigest: receipt.lifecycleIntentDigest,
          cleanupAttempt: receipt.cleanupAttempt,
          disposed: receipt.disposed,
        });
      },
    };
    return executor({
      ...input,
      sandboxInvocationIdentity: input.sandboxInvocationIdentity ?? {
        toolCallId: `test-tool:${invocationId}`,
        capabilityId: 'builtin:shell_execute',
        capabilityRevision: 'builtin-shell-execute-r1',
        invocationId,
        attempt: 1,
        effectiveEffectsDigest: 'test-effects',
        admissionDigest: 'test-admission',
        cancellationCorrelation: randomUUID(),
      },
      sandboxPreparationLifecycle: input.sandboxPreparationLifecycle ?? lifecycle,
    });
  };
}

function deniedExecutor(reason: string): ShellExecutor {
  return async (input) => ({
    ok: false,
    command: input.command,
    exitCode: -1,
    stdout: '',
    stderr: `Sandbox unavailable (${reason}); refusing unsandboxed shell execution.`,
    terminationReason: 'sandbox_denied',
  });
}
