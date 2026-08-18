import { randomUUID } from 'node:crypto';
import { sandboxPreparationIntentDigestV1 } from '@/core/capabilities/sandbox-preparation-evidence';
import {
  createSandboxExecutionConsumerV1,
  SandboxExecutionGrantAuthorityV1,
  sandboxPreparationDigestV1,
} from '@/core/execution/sandbox-execution';
import { LocalSandboxExecutionProviderV1 } from '@/core/execution/sandbox-execution/local-provider';
import { findUsableCgroupPidsRunnerV1 } from '@/core/sandbox/cgroup-pids';
import type { SandboxBackend } from '@/core/sandbox/platform';
import { detectSandboxBackend, findUsableBubblewrap } from '@/core/sandbox/platform';
import type { ResourceLimits } from '@/core/sandbox/types';
import { type ShellExecutor, shellTool } from '@/core/tools/shell';
import type {
  PreparedSandboxExecutionV1,
  SandboxPreparationV1,
} from '@/protocol/sandbox-execution-provider';

export type TestSandboxLifecycleTransitionV1 =
  | 'preparation_intent_recorded'
  | 'preparation_ready_recorded'
  | 'execution_dispatch_intent_recorded'
  | 'execution_supervisor_started_recorded'
  | 'disposal_intent_recorded'
  | 'preparation_reconciliation_intent_recorded'
  | 'disposal_receipt_confirmed'
  | 'disposal_receipt_unconfirmed';

export interface TestSandboxDisposalReceiptV1 {
  readonly prepared: Readonly<PreparedSandboxExecutionV1> | null;
  readonly purpose: 'dispose' | 'reconcile_preparation_intent';
  readonly lifecycleIntentDigest: string;
  readonly cleanupAttempt: number;
  readonly disposed: boolean;
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
    brokeredGitFeatureRevision?: typeof import('@/protocol/git').BROKERED_GIT_FEATURE_REVISION_V1;
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
  const grants = new SandboxExecutionGrantAuthorityV1();
  const provider = new LocalSandboxExecutionProviderV1(grants.verifier(), {
    backend,
    canonicalWorkspace: options.workspace,
    filesystemScope: options.filesystemScope,
    runtimeReadOnlyRoots: options.runtimeReadOnlyRoots,
    brokeredGitFeatureRevision: options.brokeredGitFeatureRevision,
    startupProbe: options.startupProbe,
    bubblewrapPath: backend === 'bubblewrap' ? (findUsableBubblewrap() ?? undefined) : undefined,
    cgroupPidsRunner:
      backend === 'bubblewrap' && options.maxProcessTreeTasks
        ? (findUsableCgroupPidsRunnerV1() ?? undefined)
        : undefined,
  });
  const consumer = createSandboxExecutionConsumerV1({
    provider,
    backend,
    grants,
    canonicalWorkspace: options.workspace,
    executionBoundaryDigest: options.executionBoundaryDigest ?? 'test-sandbox-boundary-v1',
    protectedPathRevision: options.protectedPathRevision ?? 'test-protected-path-boundary-v1',
    maxProcessTreeTasks: options.maxProcessTreeTasks,
    resourceLimits: options.resourceLimits,
  });
  return withAcknowledgedSandboxLifecycleForTestV1(consumer);
}

/**
 * Test-only Runtime lifecycle oracle for native App-composition tests.
 * Production callers must receive these facts from the durable Tool Pipeline.
 */
export function withAcknowledgedSandboxLifecycleForTestV1(
  executor: ShellExecutor,
  options: {
    readonly onTransition?: (transition: TestSandboxLifecycleTransitionV1) => void;
    readonly onDisposalReceipt?: (receipt: TestSandboxDisposalReceiptV1) => void;
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
    let preparation: Readonly<SandboxPreparationV1> | undefined;
    let prepared: Readonly<PreparedSandboxExecutionV1> | undefined;
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
          readonly prepared: Readonly<PreparedSandboxExecutionV1> | null;
        }
      | undefined;
    const transition = (next: TestSandboxLifecycleTransitionV1): void => {
      options.onTransition?.(next);
    };
    const samePrepared = (candidate: Readonly<PreparedSandboxExecutionV1>): boolean =>
      Boolean(
        preparation &&
          candidate.preparationDigest === sandboxPreparationDigestV1(preparation) &&
          candidate.toolCallId === preparation.toolCallId &&
          candidate.capabilityId === preparation.capabilityId &&
          candidate.capabilityRevision === preparation.capabilityRevision &&
          candidate.invocationId === preparation.invocationId &&
          candidate.attempt === preparation.attempt &&
          candidate.canonicalWorkspace === preparation.canonicalWorkspace &&
          candidate.commandDigest === preparation.commandDigest,
      );
    return executor({
      ...input,
      sandboxInvocationIdentity: {
        toolCallId: `test-tool:${invocationId}`,
        capabilityId: 'builtin:shell_execute',
        capabilityRevision: 'builtin-shell-execute-r1',
        invocationId,
        attempt: 1,
        effectiveEffectsDigest: 'test-effects',
        admissionDigest: 'test-admission',
        cancellationCorrelation: randomUUID(),
      },
      sandboxPreparationLifecycle: {
        async recordPreparationIntent(candidate) {
          if (phase !== 'empty') throw new Error('duplicate preparation intent');
          preparation = candidate;
          phase = 'intent_recorded';
          transition('preparation_intent_recorded');
          return {
            intentDigest: sandboxPreparationIntentDigestV1({
              attempt: candidate.attempt,
              toolCallId: candidate.toolCallId,
              capabilityId: candidate.capabilityId,
              capabilityRevision: candidate.capabilityRevision,
              canonicalWorkspace: candidate.canonicalWorkspace,
              effectiveEffectsDigest: candidate.effectiveEffectsDigest,
              admissionDigest: candidate.admissionDigest,
              preparationDigest: sandboxPreparationDigestV1(candidate),
              commandDigest: candidate.commandDigest,
              executionBoundaryDigest: candidate.executionBoundaryDigest,
              resourceSemantics: 'allocating',
            }),
          };
        },
        async recordPreparationReady(candidate) {
          if (phase !== 'intent_recorded' || !samePrepared(candidate)) return false;
          prepared = candidate;
          phase = 'ready_recorded';
          transition('preparation_ready_recorded');
          return true;
        },
        async recordExecutionDispatchIntent(candidate, candidateDispatch) {
          if (phase !== 'ready_recorded' || candidate !== prepared || !samePrepared(candidate)) {
            throw new Error('dispatch before exact preparation-ready acknowledgement');
          }
          const dispatchIntentDigest = `test-dispatch:${candidateDispatch.dispatchId}`;
          dispatch = {
            dispatchId: candidateDispatch.dispatchId,
            dispatchIntentDigest,
          };
          phase = 'dispatch_recorded';
          transition('execution_dispatch_intent_recorded');
          return { dispatchIntentDigest };
        },
        async recordExecutionSupervisorStarted(candidate, candidateSupervisor) {
          if (
            phase !== 'dispatch_recorded' ||
            candidate !== prepared ||
            candidateSupervisor.dispatchId !== dispatch?.dispatchId ||
            candidateSupervisor.dispatchIntentDigest !== dispatch?.dispatchIntentDigest
          ) {
            return false;
          }
          phase = 'supervisor_started';
          transition('execution_supervisor_started_recorded');
          return true;
        },
        async recordDisposalIntent(candidate) {
          const purpose = candidate === null ? 'reconcile_preparation_intent' : 'dispose';
          if (
            (candidate === null && phase !== 'intent_recorded') ||
            (candidate !== null &&
              (candidate !== prepared ||
                !['ready_recorded', 'dispatch_recorded', 'supervisor_started'].includes(phase)))
          ) {
            return null;
          }
          const lifecycleIntentDigest = `test-${purpose}:${invocationId}`;
          cleanup = { purpose, lifecycleIntentDigest, prepared: candidate };
          phase = 'disposal_intent_recorded';
          transition(
            purpose === 'dispose'
              ? 'disposal_intent_recorded'
              : 'preparation_reconciliation_intent_recorded',
          );
          return {
            purpose,
            lifecycleIntentDigest,
            cleanupAttempt: 1,
          };
        },
        async recordDisposalReceipt(receipt) {
          if (
            phase !== 'disposal_intent_recorded' ||
            receipt.prepared !== cleanup?.prepared ||
            receipt.purpose !== cleanup.purpose ||
            receipt.lifecycleIntentDigest !== cleanup.lifecycleIntentDigest ||
            receipt.cleanupAttempt !== 1
          ) {
            return false;
          }
          phase = 'disposal_receipt_recorded';
          options.onDisposalReceipt?.(receipt);
          transition(
            receipt.disposed ? 'disposal_receipt_confirmed' : 'disposal_receipt_unconfirmed',
          );
          return true;
        },
      },
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
