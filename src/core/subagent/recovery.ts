import type { RuntimeEvent } from '@/core/runtime/events';
import type { RuntimeState } from '@/core/runtime/state';
import type { GovernedSubagentCompositionV1 } from './composition';
import { subagentDispatchIntentDigestV1 } from './lifecycle-evidence';

export function hasPendingSubagentProviderRecoveryV1(state: Readonly<RuntimeState>): boolean {
  return Object.values(state.capabilities.invocations).some(
    (invocation) =>
      invocation.subagentProviderLifecycle !== undefined &&
      invocation.subagentProviderLifecycle.status !== 'cleanup_completed',
  );
}

export async function reconcilePendingSubagentProvidersAfterCrashV1(input: {
  readonly composition: GovernedSubagentCompositionV1;
  readonly persistence: {
    getState(): Readonly<RuntimeState>;
    persistEvents(events: RuntimeEvent[]): Promise<boolean>;
  };
}): Promise<boolean> {
  for (const initial of Object.values(input.persistence.getState().capabilities.invocations)) {
    const lifecycle = initial.subagentProviderLifecycle;
    if (!lifecycle || lifecycle.status === 'cleanup_completed') continue;
    let cleanupAttempt = lifecycle.cleanupAttempt ?? 0;
    if (lifecycle.status !== 'cleanup_pending' || lifecycle.cleanupCompletedAt !== undefined) {
      cleanupAttempt += 1;
      if (
        !(await input.persistence.persistEvents([
          {
            type: 'capability.subagent_cleanup_started',
            invocationId: initial.invocationId,
            attempt: lifecycle.attempt,
            dispatchIntentDigest: lifecycle.dispatchIntentDigest,
            cleanupAttempt,
            cleanupKind: lifecycle.handleArtifact ? 'handle_reconcile' : 'undispatched',
            startedAt: new Date().toISOString(),
          },
        ]))
      ) {
        return false;
      }
    }
    const current = input.persistence.getState().capabilities.invocations[initial.invocationId];
    if (!current) return false;
    const pending = current.subagentProviderLifecycle;
    if (
      pending?.status !== 'cleanup_pending' ||
      pending.cleanupAttempt !== cleanupAttempt ||
      pending.cleanupKind !== (lifecycle.handleArtifact ? 'handle_reconcile' : 'undispatched') ||
      pending.attempt !== lifecycle.attempt ||
      pending.dispatchIntentDigest !== lifecycle.dispatchIntentDigest
    ) {
      return false;
    }
    let cleanupConfirmed = false;
    if (!pending.handleArtifact) {
      // Two-phase contract proves Driver dispatch is impossible before handle-ready ack.
      cleanupConfirmed = true;
    } else {
      let handle: Readonly<import('@/protocol/subagent-provider').SubagentHandleV1>;
      try {
        handle = input.composition.lifecycleArtifacts.read(
          pending.handleArtifact,
          input.composition.grants.verifier(),
        );
      } catch {
        return false;
      }
      if (
        handle.parentInvocationId !== current.invocationId ||
        handle.parentToolCallId !== current.toolCallId ||
        handle.parentAttempt !== pending.attempt ||
        handle.childInvocationId !== pending.childInvocationId ||
        handle.purpose !== pending.purpose ||
        handle.taskArtifact.artifactId !== pending.taskArtifact.artifactId ||
        handle.taskArtifact.integrityIdentifier !== pending.taskArtifact.integrityIdentifier ||
        handle.taskArtifact.byteLength !== pending.taskArtifact.byteLength ||
        handle.integrityIdentifier !== pending.handleIntegrityIdentifier ||
        subagentDispatchIntentDigestV1(handle) !== pending.dispatchIntentDigest
      ) {
        return false;
      }
      let reconciled = await input.composition.provider.reconcile({ handle });
      if (reconciled.ok && reconciled.value.status === 'running') {
        // Same-process restore retains the singleton Provider. Prepared handles
        // are abandoned without Driver I/O; activated handles are cancelled
        // and observed within the Provider's one absolute cleanup grace.
        await input.composition.provider.cancel({
          handle,
          reason: 'runtime_restore_reconciliation',
        });
        await input.composition.provider.observe({ handle });
        reconciled = await input.composition.provider.reconcile({ handle });
      }
      cleanupConfirmed =
        reconciled.ok && reconciled.value.status === 'stopped' && reconciled.value.cleanupConfirmed;
    }
    if (
      !(await input.persistence.persistEvents([
        {
          type: 'capability.subagent_cleanup_completed',
          invocationId: current.invocationId,
          attempt: pending.attempt,
          dispatchIntentDigest: pending.dispatchIntentDigest,
          cleanupAttempt,
          cleanupKind: pending.handleArtifact ? 'handle_reconcile' : 'undispatched',
          cleanupConfirmed,
          completedAt: new Date().toISOString(),
        },
      ]))
    ) {
      return false;
    }
    const completed = input.persistence.getState().capabilities.invocations[current.invocationId];
    if (
      !cleanupConfirmed ||
      completed?.subagentProviderLifecycle?.status !== 'cleanup_completed' ||
      completed.subagentProviderLifecycle.cleanupConfirmed !== true
    ) {
      return false;
    }
    const unknownReason = 'Subagent Provider lifecycle was reconciled after Runtime restore.';
    const finishedAt = new Date().toISOString();
    if (
      !(await input.persistence.persistEvents([
        {
          type: 'capability.execution_unknown',
          invocationId: current.invocationId,
          reason: unknownReason,
          finishedAt,
        },
      ]))
    ) {
      return false;
    }
    const terminal = input.persistence.getState().capabilities.invocations[current.invocationId];
    if (
      terminal?.status !== 'unknown' ||
      terminal.attemptsStarted !== pending.attempt ||
      terminal.finishedAt !== finishedAt ||
      terminal.error !== unknownReason ||
      terminal.subagentProviderLifecycle?.status !== 'cleanup_completed' ||
      terminal.subagentProviderLifecycle.cleanupConfirmed !== true
    ) {
      return false;
    }
  }
  return true;
}
