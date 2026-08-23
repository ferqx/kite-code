import { digestCapabilityBindingValueV1 } from '@kite/builtin-runtime/capability';
import type { SandboxPreparationArtifactStoreV1 } from '@kite/builtin-runtime/sandbox';
import {
  cleanupPosixSandboxRuntimeRootsNoSpawnV1,
  decodeWindowsRestrictedTokenPreparedTransportV1,
  type SandboxExecutionGrantAuthorityV1,
  sandboxAbandonmentLifecycleIntentDigestV1,
  sandboxDisposalLifecycleIntentDigestV1,
  sandboxPreparedPlanDigestV1,
  sandboxRuntimeRootsForPreparationV1,
} from '@kite/builtin-runtime/sandbox';
import { reconcilePosixSupervisorV1 } from '@kite/runtime-host';
import type { SandboxExecutionProviderV1 } from '@kite/runtime-spi';
import type { RuntimeEvent, RuntimeState } from '../bootstrap/runtime/state-runtime';
import { reconcileWindowsRestrictedTokenPreparedV1 } from './windows-restricted-token-runtime';

export interface SandboxPreparationRecoveryPersistenceV1 {
  getState(): Readonly<RuntimeState>;
  persistEvents(events: RuntimeEvent[]): Promise<boolean>;
}

export const SANDBOX_PREPARATION_RECOVERY_V1 = Symbol.for('kite.sandbox-preparation-recovery.v1');

export interface SandboxPreparationRecoveryConsumerV1 {
  [SANDBOX_PREPARATION_RECOVERY_V1](input: {
    readonly artifacts: SandboxPreparationArtifactStoreV1;
    readonly persistence: SandboxPreparationRecoveryPersistenceV1;
  }): Promise<boolean>;
}

export function hasPendingSandboxPreparationRecoveryV1(state: Readonly<RuntimeState>): boolean {
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

export async function reconcilePendingSandboxPreparationsAfterCrashV1(input: {
  readonly provider: SandboxExecutionProviderV1;
  readonly grants: SandboxExecutionGrantAuthorityV1;
  readonly artifacts: SandboxPreparationArtifactStoreV1;
  readonly persistence: SandboxPreparationRecoveryPersistenceV1;
}): Promise<boolean> {
  for (const invocation of Object.values(input.persistence.getState().capabilities.invocations)) {
    if (
      invocation.sandboxPreparationIntent &&
      !invocation.sandboxPreparationReady &&
      invocation.sandboxPreparationAbandonment?.status !== 'completed'
    ) {
      if (
        !(await reconcileAbandonedSandboxPreparationIntentV1({
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
      !(await reconcileSandboxPreparationAfterCrashV1({
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
async function reconcileAbandonedSandboxPreparationIntentV1(input: {
  readonly invocationId: string;
  readonly provider: SandboxExecutionProviderV1;
  readonly grants: SandboxExecutionGrantAuthorityV1;
  readonly persistence: SandboxPreparationRecoveryPersistenceV1;
  readonly now?: () => Date;
}): Promise<boolean> {
  let invocation = input.persistence.getState().capabilities.invocations[input.invocationId];
  const intent = invocation?.sandboxPreparationIntent;
  if (!invocation || !intent || invocation.sandboxPreparationReady) return false;
  if (invocation.sandboxPreparationAbandonment?.status === 'completed') return true;
  const lifecycleIntentDigest = sandboxAbandonmentLifecycleIntentDigestV1({
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
      : cleanupPosixSandboxRuntimeRootsNoSpawnV1(
          sandboxRuntimeRootsForPreparationV1(intent.canonicalWorkspace, intent.preparationDigest),
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
export async function reconcileSandboxPreparationAfterCrashV1(input: {
  readonly invocationId: string;
  readonly provider: SandboxExecutionProviderV1;
  readonly grants: SandboxExecutionGrantAuthorityV1;
  readonly artifacts: SandboxPreparationArtifactStoreV1;
  readonly persistence: SandboxPreparationRecoveryPersistenceV1;
  readonly now?: () => Date;
}): Promise<boolean> {
  const invocation = input.persistence.getState().capabilities.invocations[input.invocationId];
  const ready = invocation?.sandboxPreparationReady;
  if (!invocation || !ready) return false;
  if (invocation.sandboxDisposal?.status === 'completed') return true;
  let prepared: Readonly<import('@kite/runtime-spi').PreparedSandboxExecutionV1>;
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
    digestCapabilityBindingValueV1(prepared.backendCapabilities) !==
      ready.backendCapabilitiesDigest ||
    prepared.enforcement !== ready.enforcement ||
    prepared.resourceSemantics !== ready.resourceSemantics ||
    digestCapabilityBindingValueV1(prepared.cleanup) !== ready.cleanupDigest ||
    sandboxPreparedPlanDigestV1(prepared) !== ready.planDigest
  ) {
    return false;
  }
  const lifecycleIntentDigest = sandboxDisposalLifecycleIntentDigestV1({
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
      cleanupConfirmed = await reconcileWindowsRestrictedTokenPreparedV1(
        decodeWindowsRestrictedTokenPreparedTransportV1(serialized),
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
      cleanupConfirmed = await reconcilePosixSupervisorV1({
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
        cleanupPosixSandboxRuntimeRootsNoSpawnV1({ controlRoot, dataRoot });
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
