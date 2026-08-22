/**
 * Test-only Runtime composition.
 *
 * Production callers must provide an already-owned Kernel and effect port to
 * `executeRuntimeTurnV1`. This root-only helper is the only place that
 * deliberately composes the State 25 App coordinator for existing corpus
 * tests and fixtures.
 */

import { createChatModel, type SupportedChatModel } from '@kite/builtin-runtime/model';
import { sandboxSupportsFullModeV1 } from '@kite/builtin-runtime/sandbox';
import type { RuntimeActionProvider } from '#app/bootstrap/runtime/state25-runner';
import type { State25SessionStorageV1 } from '#app/bootstrap/runtime/state25-runtime';
import {
  executeRuntimeTurnV1,
  type RuntimeTurnInputV1,
} from '#app/bootstrap/runtime/turn-coordinator';
import type { AuthorizedExecutionControlV1 } from '../../apps/kite/src/bootstrap/runtime/RuntimeSessionCoordinator';
import type { RuntimeExecutorDependencies } from '../../apps/kite/src/bootstrap/runtime/runtime-effect-dependencies';
import type { RuntimeEffectExecutor } from '../../apps/kite/src/bootstrap/runtime/state25-runtime';
import {
  restoreState25HostSessionHarnessV1,
  type State25HostSessionHarnessV1,
} from './runtime-host-state25';

export type TestRuntimeAgentInputV1 = Omit<
  RuntimeTurnInputV1,
  | 'runtimeSession'
  | 'createRuntimeEffectPort'
  | 'model'
  | 'recoveryIdentityKey'
  | 'registerRunCancellation'
> & {
  readonly openState25SessionStorage: (threadId?: string) => State25SessionStorageV1;
  readonly model?: SupportedChatModel;
  readonly recoveryIdentityKey?: string;
  readonly onTestExecutionControl?: (control: AuthorizedExecutionControlV1 | null) => void;
};

const TEST_RUNTIME_RECOVERY_IDENTITY_KEY_V1 =
  '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Run one test turn with an explicitly composed State 25/Store 4 Kernel.
 * The helper owns exactly this Kernel and closes it exactly once after the
 * test entry returns or throws.
 */
export async function* runTestRuntimeAgentV1(
  input: TestRuntimeAgentInputV1,
  provider: RuntimeActionProvider,
  createRuntimeEffectPort: (dependencies: RuntimeExecutorDependencies) => RuntimeEffectExecutor,
): AsyncGenerator<import('@kite/agent-kernel').RuntimeEvent> {
  const store = input.openState25SessionStorage(input.threadId);
  const recoveryIdentityKey = input.recoveryIdentityKey ?? TEST_RUNTIME_RECOVERY_IDENTITY_KEY_V1;
  const { onTestExecutionControl, ...turnInput } = input;
  const kernel: State25HostSessionHarnessV1 = restoreState25HostSessionHarnessV1({
    threadId: input.threadId,
    userId: input.userId,
    workspace: input.workspace,
    store,
    recoveryIdentityKey,
    interactionMode: input.interactionMode ?? input.config.interactionMode ?? 'accept_edits',
    authorizationMode: input.authorizationMode,
    authorizationSource: input.authorizationSource,
    phase: 'building',
    sandboxAvailable:
      input.sandboxBackend === 'unknown'
        ? false
        : sandboxSupportsFullModeV1(input.sandboxBackend ?? 'none'),
    modelArtifactEvidence: input.modelInvocationRuntime.evidence,
    capabilityArtifactEvidence: input.modelInvocationRuntime.capabilityArtifacts,
  });

  try {
    yield* executeRuntimeTurnV1(
      {
        ...turnInput,
        recoveryIdentityKey,
        model:
          input.model ??
          createChatModel({
            ...input.config,
            reasoningEffort: input.thinkingLevel ?? input.config.reasoningEffort ?? null,
          }),
        runtimeSession: kernel,
        createRuntimeEffectPort,
        registerRunCancellation: (cancelRun) => {
          onTestExecutionControl?.(
            cancelRun
              ? {
                  getState: () => kernel.getState(),
                  processEvent: (event) => {
                    kernel.processEvent(event);
                  },
                  processEventBatch: (events) => kernel.processEventBatch(events),
                  cancelRun,
                }
              : null,
          );
        },
      },
      provider,
    );
  } finally {
    kernel.close();
  }
}
