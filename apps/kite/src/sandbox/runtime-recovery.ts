import { digestCapabilityBindingValue } from '@kite/builtin-runtime/capability';
import type { SandboxPreparationArtifactStore } from '@kite/builtin-runtime/sandbox';
import {
  cleanupPosixSandboxRuntimeRootsNoSpawn,
  decodeWindowsRestrictedTokenPreparedTransport,
  type SandboxExecutionGrantAuthority,
  sandboxAbandonmentLifecycleIntentDigest,
  sandboxDisposalLifecycleIntentDigest,
  sandboxPreparedPlanDigest,
  sandboxRuntimeRootsForPreparation,
} from '@kite/builtin-runtime/sandbox';
import { reconcilePosixSupervisor } from '@kite/runtime-host';
import type { SandboxExecutionProvider } from '@kite/runtime-spi';
import type { RuntimeEvent, RuntimeState } from '../bootstrap/runtime/state-runtime';
import { reconcileWindowsRestrictedTokenPrepared } from './windows-restricted-token-runtime';

export interface SandboxPreparationRecoveryPersistence {
  getState(): Readonly<RuntimeState>;
  persistEvents(events: RuntimeEvent[]): Promise<boolean>;
}

export const SANDBOX_PREPARATION_RECOVERY_ = Symbol.for('kite.sandbox-preparation-recovery.v1');

export interface SandboxPreparationRecoveryConsumer {
  [SANDBOX_PREPARATION_RECOVERY_](input: {
    readonly artifacts: SandboxPreparationArtifactStore;
    readonly persistence: SandboxPreparationRecoveryPersistence;
  }): Promise<boolean>;
}

export function hasPendingSandboxPreparationRecovery(state: Readonly<RuntimeState>): boolean {
  return Object.values(state.capabilities.invocations).some((invocation) => {
    if (invocation.sandboxPreparationReady) {
      return invocation.sandboxDisposal?.status !== 'completed';
    }
    return (
      invocation.sandboxPreparationIntent !== undefined &&
      invocation.sandboxPreparationAbandonment?.status !== 'completed'
    );
  });
}

export async function reconcilePendingSandboxPreparationsAfterCrash(input: {
  readonly provider: SandboxExecutionProvider;
  readonly grants: SandboxExecutionGrantAuthority;
  readonly artifacts: SandboxPreparationArtifactStore;
  readonly persistence: SandboxPreparationRecoveryPersistence;
}): Promise<boolean> {
  for (const invocation of Object.values(input.persistence.getState().capabilities.invocations)) {
    if (
      invocation.sandboxPreparationIntent &&
      !invocation.sandboxPreparationReady &&
      invocation.sandboxPreparationAbandonment?.status !== 'completed'
    ) {
      if (
        !(await reconcileAbandonedSandboxPreparationIntent({
          invocationId: invocation.invocationId,
          provider: input.provider,
          grants: input.grants,
          persistence: input.persistence,
        }))
      ) {
        return false;
      }
      continue;
    }
    if (!invocation.sandboxPreparationReady || invocation.sandboxDisposal?.status === 'completed') {
      continue;
    }
    if (
      !(await reconcileSandboxPreparationAfterCrash({
        invocationId: invocation.invocationId,
        provider: input.provider,
        grants: input.grants,
        artifacts: input.artifacts,
        persistence: input.persistence,
      }))
    ) {
      return false;
    }
  }
  return true;
}

/** Reclaim an allocation whose host died after intent acknowledgement but before ready evidence. */
async function reconcileAbandonedSandboxPreparationIntent(input: {
  readonly invocationId: string;
  readonly provider: SandboxExecutionProvider;
  readonly grants: SandboxExecutionGrantAuthority;
  readonly persistence: SandboxPreparationRecoveryPersistence;
  readonly now?: () => Date;
}): Promise<boolean> {
  let invocation = input.persistence.getState().capabilities.invocations[input.invocationId];
  const intent = invocation?.sandboxPreparationIntent;
  if (!invocation || !intent || invocation.sandboxPreparationReady) return false;
  if (invocation.sandboxPreparationAbandonment?.status === 'completed') return true;
  const lifecycleIntentDigest = sandboxAbandonmentLifecycleIntentDigest({
    invocationId: invocation.invocationId,
    attempt: intent.attempt,
    intentDigest: intent.intentDigest,
    preparationDigest: intent.preparationDigest,
  });
  if (!invocation.sandboxPreparationAbandonment) {
    const startedAt = (input.now?.() ?? new Date()).toISOString();
    if (
      !(await input.persistence.persistEvents([
        {
          type: 'capability.sandbox_preparation_abandonment_started',
          invocationId: invocation.invocationId,
          attempt: intent.attempt,
          intentDigest: intent.intentDigest,
          lifecycleIntentDigest,
          startedAt,
        },
      ]))
    ) {
      return false;
    }
    invocation = input.persistence.getState().capabilities.invocations[input.invocationId];
  }
  if (invocation?.sandboxPreparationAbandonment?.status !== 'pending') return false;
  if (invocation.sandboxPreparationAbandonment.lifecycleIntentDigest !== lifecycleIntentDigest)
    return false;
  const cleanupAttempt = invocation.sandboxPreparationAbandonment.attempts + 1;
  const runtimeCleanupConfirmed =
    process.platform === 'win32'
      ? false
      : cleanupPosixSandboxRuntimeRootsNoSpawn(
          sandboxRuntimeRootsForPreparation(intent.canonicalWorkspace, intent.preparationDigest),
        );
  const disposed = await Promise.resolve()
    .then(() =>
      input.provider.reconcilePreparationIntent({
        grant: input.grants.issueCleanup({
          purpose: 'reconcile_preparation_intent',
          intent,
          invocationId: invocation.invocationId,
          lifecycleIntentDigest,
          cleanupAttempt,
          cleanupConfirmed: runtimeCleanupConfirmed,
        }),
      }),
    )
    .catch(() => ({ ok: false as const }));
  const disposedAt = (input.now?.() ?? new Date()).toISOString();
  if (
    !(await input.persistence.persistEvents([
      {
        type: 'capability.sandbox_preparation_abandonment_completed',
        invocationId: invocation.invocationId,
        attempt: intent.attempt,
        intentDigest: intent.intentDigest,
        lifecycleIntentDigest,
        cleanupAttempt,
        disposed: disposed.ok,
        disposedAt,
      },
    ]))
  ) {
    return false;
  }
  return disposed.ok;
}

/** Reconcile one allocating preparation after restore using durable plan evidence only. */
export async function reconcileSandboxPreparationAfterCrash(input: {
  readonly invocationId: string;
  readonly provider: SandboxExecutionProvider;
  readonly grants: SandboxExecutionGrantAuthority;
  readonly artifacts: SandboxPreparationArtifactStore;
  readonly persistence: SandboxPreparationRecoveryPersistence;
  readonly now?: () => Date;
}): Promise<boolean> {
  const invocation = input.persistence.getState().capabilities.invocations[input.invocationId];
  const ready = invocation?.sandboxPreparationReady;
  if (!invocation || !ready) return false;
  if (invocation.sandboxDisposal?.status === 'completed') return true;
  let prepared: Readonly<import('@kite/runtime-spi').PreparedSandboxExecution>;
  try {
    prepared = input.artifacts.read(ready.preparationArtifact);
  } catch {
    return false;
  }
  if (
    !invocation.sandboxPreparationIntent ||
    prepared.toolCallId !== invocation.sandboxPreparationIntent.toolCallId ||
    prepared.capabilityId !== invocation.sandboxPreparationIntent.capabilityId ||
    prepared.capabilityRevision !== invocation.sandboxPreparationIntent.capabilityRevision ||
    prepared.canonicalWorkspace !== invocation.sandboxPreparationIntent.canonicalWorkspace ||
    prepared.cwd !== prepared.canonicalWorkspace ||
    prepared.effectiveEffectsDigest !==
      invocation.sandboxPreparationIntent.effectiveEffectsDigest ||
    prepared.admissionDigest !== invocation.sandboxPreparationIntent.admissionDigest ||
    prepared.invocationId !== invocation.invocationId ||
    prepared.attempt !== ready.attempt ||
    prepared.preparationDigest !== ready.preparationDigest ||
    prepared.commandDigest !== ready.commandDigest ||
    prepared.backend !== ready.backend ||
    digestCapabilityBindingValue(prepared.backendCapabilities) !==
      ready.backendCapabilitiesDigest ||
    prepared.enforcement !== ready.enforcement ||
    prepared.resourceSemantics !== ready.resourceSemantics ||
    digestCapabilityBindingValue(prepared.cleanup) !== ready.cleanupDigest ||
    sandboxPreparedPlanDigest(prepared) !== ready.planDigest
  ) {
    return false;
  }
  const lifecycleIntentDigest = sandboxDisposalLifecycleIntentDigest({
    invocationId: invocation.invocationId,
    attempt: ready.attempt,
    readyDigest: ready.readyDigest,
    planDigest: ready.planDigest,
    cleanupDigest: ready.cleanupDigest,
  });
  if (!invocation.sandboxDisposal) {
    const startedAt = (input.now?.() ?? new Date()).toISOString();
    if (
      !(await input.persistence.persistEvents([
        {
          type: 'capability.sandbox_disposal_started',
          invocationId: invocation.invocationId,
          attempt: ready.attempt,
          readyDigest: ready.readyDigest,
          lifecycleIntentDigest,
          startedAt,
        },
      ]))
    ) {
      return false;
    }
  } else if (invocation.sandboxDisposal.status !== 'pending') {
    return false;
  }
  const currentDisposal =
    input.persistence.getState().capabilities.invocations[input.invocationId]?.sandboxDisposal;
  if (!currentDisposal || currentDisposal.lifecycleIntentDigest !== lifecycleIntentDigest) {
    return false;
  }
  const cleanupAttempt = currentDisposal.attempts + 1;
  let cleanupConfirmed = false;
  if (prepared.backend === 'windows_restricted_token') {
    const serialized = prepared.cleanup.recoveryPayload.transport;
    if (typeof serialized !== 'string') return false;
    try {
      cleanupConfirmed = await reconcileWindowsRestrictedTokenPrepared(
        decodeWindowsRestrictedTokenPreparedTransport(serialized),
        {
          supervisorNonce: invocation.sandboxExecutionDispatch?.supervisorNonce ?? '',
        },
      );
    } catch {
      cleanupConfirmed = false;
    }
  } else {
    const runtimePath = prepared.cleanup.recoveryPayload.controlRoot;
    if (invocation.sandboxExecutionDispatch) {
      if (typeof runtimePath !== 'string') return false;
      cleanupConfirmed = await reconcilePosixSupervisor({
        runtimePath,
        dispatch: invocation.sandboxExecutionDispatch,
        // Darwin's Seatbelt candidate has no qualified kernel/launchd or
        // descriptor-owned authority for descendants that call setsid(). A
        // killed PGID is therefore retained as pending cleanup evidence.
        descendantContainmentProven: !(
          process.platform === 'darwin' && prepared.backend === 'seatbelt'
        ),
      });
    } else {
      cleanupConfirmed = true;
    }
  }
  if (cleanupConfirmed) {
    if (prepared.cleanup.kind === 'runtime_directory') {
      const controlRoot = prepared.cleanup.recoveryPayload.controlRoot;
      const dataRoot = prepared.cleanup.recoveryPayload.dataRoot;
      cleanupConfirmed =
        typeof controlRoot === 'string' &&
        typeof dataRoot === 'string' &&
        cleanupPosixSandboxRuntimeRootsNoSpawn({ controlRoot, dataRoot });
    } else if (
      prepared.cleanup.kind !== 'none' &&
      prepared.cleanup.kind !== 'windows_restricted_token'
    ) {
      cleanupConfirmed = false;
    }
  }
  const disposed = await Promise.resolve()
    .then(() =>
      input.provider.reconcile({
        grant: input.grants.issueCleanup({
          purpose: 'reconcile',
          prepared,
          lifecycleIntentDigest,
          cleanupAttempt,
          cleanupConfirmed,
        }),
        prepared,
      }),
    )
    .catch(() => ({ ok: false as const }));
  const disposedAt = (input.now?.() ?? new Date()).toISOString();
  if (
    !(await input.persistence.persistEvents([
      {
        type: 'capability.sandbox_disposal_completed',
        invocationId: invocation.invocationId,
        attempt: ready.attempt,
        readyDigest: ready.readyDigest,
        lifecycleIntentDigest,
        cleanupAttempt,
        disposed: disposed.ok,
        disposedAt,
      },
    ]))
  ) {
    return false;
  }
  return disposed.ok;
}
