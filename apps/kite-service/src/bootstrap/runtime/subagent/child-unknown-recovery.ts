import type { SubagentResultArtifactAccess } from '@kite-ai/builtin-runtime/subagent';
import type { KiteSessionAppServerStorageOwner } from '../../kite-session-app-server-storage';
import { classifyFailure } from '../failures';
import type { RuntimeSessionCoordinator } from '../RuntimeSessionCoordinator';
import { reconcileRuntimeSessionAfterRestart } from '../session-restart-recovery';
import { failedTerminalOutcome } from '../terminal-outcome';
import type { RuntimeTurnInput } from '../turn-coordinator';
import { sealChildTerminalResult } from './child-terminal-bridge';
import type { SubAgentResult } from './types';

/**
 * A fenced previous owner may turn a persisted external attempt into an
 * explicit unknown result. The callback leaves cleanup unconfirmed so the
 * Store can verify recovery_required authority before parent import.
 */
export async function recoverUnknownChildTerminal(input: {
  readonly owner: KiteSessionAppServerStorageOwner;
  readonly childThreadId: string;
  readonly ensureChild: () => RuntimeSessionCoordinator;
  readonly modelRuntime: RuntimeTurnInput['modelInvocationRuntime'];
  readonly shellExecutor: RuntimeTurnInput['shellExecutor'];
  readonly artifacts: SubagentResultArtifactAccess;
  readonly parentOwnerKey: string;
}): Promise<boolean> {
  let sealed = false;
  await input.owner.reconcileInterruptedSession(
    input.childThreadId,
    async (generation, assertCurrent) => {
      if (!assertCurrent()) throw new Error('Child recovery generation was lost.');
      const child = input.ensureChild();
      const before = child.getState();
      if (
        !before.childSessionOrigin?.taskInputAdmitted ||
        before.childSessionOrigin.terminal ||
        before.resourceBudget.status !== 'active' ||
        (!Object.values(before.modelInvocations).some(
          (invocation) =>
            invocation.dispatchCertainty === 'attempted' ||
            invocation.dispatchCertainty === 'unknown',
        ) &&
          !Object.values(before.tools.calls).some((call) => call.status === 'running'))
      )
        throw new Error('Child has no unconfirmed external attempt to recover.');
      const message = 'Child Session execution was interrupted; external effects are unknown.';
      if (!before.terminalOutcome) {
        child.control.processEventBatch([
          {
            type: 'run.error',
            message,
            recoverable: false,
            turnId: before.turn.turnId,
            outcome: failedTerminalOutcome(classifyFailure('unknown', message), {
              knownExternalEffects: 'unknown',
            }),
          },
        ]);
      }
      const history = input.owner.storage.sessions
        .loadEventsStrict(input.childThreadId)
        .map((entry) => entry.event);
      const recovered = await reconcileRuntimeSessionAfterRestart({
        control: child.control,
        modelInvocationRuntime: input.modelRuntime,
        shellExecutor: input.shellExecutor,
        historyEvents: history,
        recoveryOwnership: {
          kind: 'fenced_previous_execution',
          controllerGeneration: generation,
          assertCurrent,
        },
      });
      if (!recovered.complete || !assertCurrent())
        throw new Error('Child external execution could not be fenced for unknown recovery.');
      const state = child.getState();
      if (state.turn.status === 'active') {
        child.control.processEventBatch([
          {
            type: 'turn.aborted',
            turnId: state.turn.turnId,
            reason: message,
            cause: 'error',
          },
        ]);
      }
      const terminal = child.getState();
      if (
        terminal.terminalOutcome?.status !== 'unknown' ||
        terminal.terminalOutcome.knownExternalEffects !== 'unknown' ||
        terminal.turn.status === 'active'
      )
        throw new Error('Child recovery did not produce an exact unknown terminal.');
      const result: SubAgentResult = {
        ok: false,
        summary: 'Child Session outcome is unknown after interrupted execution.',
        terminalStatus: 'unknown',
        toolCallCount: Object.keys(terminal.tools.calls).length,
        durationMs: 0,
      };
      sealChildTerminalResult({
        getChildState: () => child.getState(),
        artifacts: input.artifacts,
        parentOwnerKey: input.parentOwnerKey,
        result,
        cleanupConfirmed: false,
        cancelRequested: terminal.turn.abortCause === 'user',
        terminalReceiptId: `child-unknown:${input.childThreadId}:${generation}`,
        commitSeal: (event) => child.session.commitChildSessionTerminalSeal(event),
      });
      if (!assertCurrent() || child.getState().childSessionOrigin?.terminal?.status !== 'unknown')
        throw new Error('Child unknown terminal seal lost its recovery generation.');
      sealed = true;
      return 'cleanup_unconfirmed';
    },
  );
  return sealed;
}
