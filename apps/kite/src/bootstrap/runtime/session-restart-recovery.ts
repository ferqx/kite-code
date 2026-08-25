import type { SandboxPreparationArtifactStore, ShellExecutor } from '@kite/builtin-runtime/sandbox';
import {
  hasPendingSandboxPreparationRecovery,
  SANDBOX_PREPARATION_RECOVERY_,
  type SandboxPreparationRecoveryConsumer,
} from '../../sandbox/runtime-recovery';
import type { AuthorizedExecutionControl } from './RuntimeSessionCoordinator';
import { eventsForRestartedSessionRecovery } from './state-actions';
import type { RuntimeEvent, RuntimeState } from './state-runtime';
import { hasPendingSubagentProviderRecovery } from './subagent-provider-recovery';

interface RestartRecoveryModelRuntime {
  readonly reconcilePendingSubagents?: (persistence: {
    getState(): Readonly<RuntimeState>;
    persistEvents(events: RuntimeEvent[]): Promise<boolean>;
  }) => Promise<boolean>;
  readonly sandboxPreparationArtifacts?: SandboxPreparationArtifactStore;
}

export interface RuntimeSessionRestartRecoveryResult {
  readonly complete: boolean;
  readonly changed: boolean;
  readonly events: readonly RuntimeEvent[];
  readonly failure?: 'subagent_provider' | 'sandbox_preparation' | 'state_finalization';
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
}): Promise<RuntimeSessionRestartRecoveryResult> {
  const emitted: RuntimeEvent[] = [];
  const persistence = {
    getState: () => input.control.getState(),
    persistEvents: async (events: RuntimeEvent[]): Promise<boolean> => {
      if (events.length === 0) return true;
      try {
        const applied = input.control.processEventBatch(events);
        emitted.push(...applied);
        return true;
      } catch {
        return false;
      }
    },
  };

  if (hasPendingSubagentProviderRecovery(input.control.getState())) {
    const recovered = input.modelInvocationRuntime.reconcilePendingSubagents
      ? await input.modelInvocationRuntime.reconcilePendingSubagents(persistence)
      : false;
    if (!recovered) {
      return {
        complete: false,
        changed: emitted.length > 0,
        events: emitted,
        failure: 'subagent_provider',
      };
    }
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

  const finalization = eventsForRestartedSessionRecovery(input.control.getState());
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
