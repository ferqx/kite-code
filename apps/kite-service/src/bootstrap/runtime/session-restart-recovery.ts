import type {
  SandboxPreparationArtifactStore,
  ShellExecutor,
} from '@kite-ai/builtin-runtime/sandbox';
import {
  hasPendingSandboxPreparationRecovery,
  SANDBOX_PREPARATION_RECOVERY_,
  type SandboxPreparationRecoveryConsumer,
} from '../../sandbox/runtime-recovery';
import type { AuthorizedExecutionControl } from './RuntimeSessionCoordinator';
import {
  eventsForRestartedSessionRecovery,
  eventsForSettledSubagentHistory,
} from './state-actions';
import type { RuntimeEvent, RuntimeState } from './state-runtime';
import { hasPendingSubagentProviderRecovery } from './subagent-provider-recovery';

interface RestartRecoveryModelRuntime {
  readonly reconcilePendingSubagents?: (
    persistence: {
      getState(): Readonly<RuntimeState>;
      persistEvents(events: RuntimeEvent[]): Promise<boolean>;
    },
    options?: Readonly<{
      terminalDisposition?: 'unknown' | 'preserve_user_cancellation';
    }>,
  ) => Promise<boolean>;
  readonly sandboxPreparationArtifacts?: SandboxPreparationArtifactStore;
}

export interface RuntimeSessionRestartRecoveryResult {
  readonly complete: boolean;
  readonly changed: boolean;
  readonly events: readonly RuntimeEvent[];
  readonly failure?:
    | 'ownership'
    | 'subagent_provider'
    | 'sandbox_preparation'
    | 'state_finalization';
}

/**
 * Reconcile process-owned resources before a restored Session is presented or
 * scheduled. The State coordinator remains the sole writer and every emitted
 * fact is returned exactly as persisted for live/replay projection parity.
 */
export async function reconcileRuntimeSessionAfterRestart(input: {
  readonly control: AuthorizedExecutionControl;
  readonly modelInvocationRuntime: RestartRecoveryModelRuntime;
  readonly shellExecutor?: ShellExecutor;
  readonly historyEvents: readonly RuntimeEvent[];
  readonly recoveryOwnership: Readonly<{
    kind: 'fenced_previous_execution';
    controllerGeneration: number;
    assertCurrent(): boolean;
  }>;
}): Promise<RuntimeSessionRestartRecoveryResult> {
  const emitted: RuntimeEvent[] = [];
  const ownsRecovery = (): boolean =>
    input.recoveryOwnership.kind === 'fenced_previous_execution' &&
    Number.isSafeInteger(input.recoveryOwnership.controllerGeneration) &&
    input.recoveryOwnership.controllerGeneration > 0 &&
    input.recoveryOwnership.assertCurrent();
  if (!ownsRecovery()) {
    return { complete: false, changed: false, events: [], failure: 'ownership' };
  }
  const persistence = {
    getState: () => input.control.getState(),
    persistEvents: async (events: RuntimeEvent[]): Promise<boolean> => {
      if (events.length === 0) return true;
      if (!ownsRecovery()) return false;
      try {
        const applied = input.control.processEventBatch(events);
        emitted.push(...applied);
        return true;
      } catch {
        return false;
      }
    },
  };

  let providerRecovered = true;
  if (hasPendingSubagentProviderRecovery(input.control.getState())) {
    providerRecovered = input.modelInvocationRuntime.reconcilePendingSubagents
      ? await input.modelInvocationRuntime.reconcilePendingSubagents(persistence, {
          terminalDisposition:
            input.control.getState().turn.abortCause === 'user'
              ? 'preserve_user_cancellation'
              : 'unknown',
        })
      : false;
  }

  // A parent Tool may already be terminal while its child presentation event
  // was lost with the previous process. Once Provider cleanup is confirmed,
  // close that proven child card even if an unrelated sandbox resource still
  // needs reconciliation. Do not finalize an unfinished parent Tool here.
  const settledChildren = eventsForSettledSubagentHistory(input.control.getState(), [
    ...input.historyEvents,
    ...emitted,
  ]);
  if (!(await persistence.persistEvents(settledChildren))) {
    return {
      complete: false,
      changed: emitted.length > 0,
      events: emitted,
      failure: 'state_finalization',
    };
  }

  if (!providerRecovered) {
    return {
      complete: false,
      changed: emitted.length > 0,
      events: emitted,
      failure: 'subagent_provider',
    };
  }

  if (hasPendingSandboxPreparationRecovery(input.control.getState())) {
    const recovery = (
      input.shellExecutor as ShellExecutor & Partial<SandboxPreparationRecoveryConsumer>
    )?.[SANDBOX_PREPARATION_RECOVERY_];
    const artifacts = input.modelInvocationRuntime.sandboxPreparationArtifacts;
    const recovered =
      artifacts && recovery
        ? await recovery.call(input.shellExecutor, { artifacts, persistence })
        : false;
    if (!recovered) {
      return {
        complete: false,
        changed: emitted.length > 0,
        events: emitted,
        failure: 'sandbox_preparation',
      };
    }
  }

  const finalization = eventsForRestartedSessionRecovery(
    input.control.getState(),
    [...input.historyEvents, ...emitted],
    input.recoveryOwnership,
  );
  if (!(await persistence.persistEvents(finalization))) {
    return {
      complete: false,
      changed: emitted.length > 0,
      events: emitted,
      failure: 'state_finalization',
    };
  }
  return { complete: true, changed: emitted.length > 0, events: emitted };
}
