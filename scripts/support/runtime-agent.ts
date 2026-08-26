/**
 * Test-only Runtime composition.
 *
 * Production callers must provide an already-owned Kernel and effect port to
 * `executeRuntimeTurn`. This root-only helper is the only place that
 * deliberately composes the current State App coordinator for existing corpus
 * tests and fixtures.
 */

import { createHash } from 'node:crypto';
import type { AgentState, RuntimeEvent } from '@kite-ai/agent-kernel';
import { createChatModel, type SupportedChatModel } from '@kite-ai/builtin-runtime/model';
import { sandboxBackendAvailable } from '@kite-ai/builtin-runtime/sandbox';
import type { RuntimeActionProvider } from '#kite-service/bootstrap/runtime/state-runner';
import type { StateRuntimeStorage } from '#kite-service/bootstrap/runtime/state-runtime';
import {
  executeRuntimeTurn,
  type RuntimeTurnInput,
} from '#kite-service/bootstrap/runtime/turn-coordinator';
import type { AuthorizedExecutionControl } from '../../apps/kite-service/src/bootstrap/runtime/RuntimeSessionCoordinator';
import type { RuntimeExecutorDependencies } from '../../apps/kite-service/src/bootstrap/runtime/runtime-effect-dependencies';
import type { RuntimeEffectExecutor } from '../../apps/kite-service/src/bootstrap/runtime/state-runtime';
import { restoreStateHostSessionHarness, type StateHostSessionHarness } from './runtime-host-state';
import type { TestRuntimeStore } from './runtime-storage';

export type TestRuntimeAgentInput = Omit<
  RuntimeTurnInput,
  | 'runtimeSession'
  | 'createRuntimeEffectPort'
  | 'model'
  | 'recoveryIdentityKey'
  | 'registerRunCancellation'
> & {
  readonly openStateRuntimeStorage: (threadId?: string) => StateRuntimeStorage;
  readonly model?: SupportedChatModel;
  readonly recoveryIdentityKey?: string;
  readonly onTestExecutionControl?: (control: AuthorizedExecutionControl | null) => void;
};

const TEST_RUNTIME_RECOVERY_IDENTITY_KEY_ =
  '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Run one test turn with an explicitly composed State/Store Kernel.
 * The helper owns exactly this Kernel and closes it exactly once after the
 * test entry returns or throws.
 */
export async function* runTestRuntimeAgent(
  input: TestRuntimeAgentInput,
  provider: RuntimeActionProvider,
  createRuntimeEffectPort: (dependencies: RuntimeExecutorDependencies) => RuntimeEffectExecutor,
): AsyncGenerator<import('@kite-ai/agent-kernel').RuntimeEvent> {
  const store = input.openStateRuntimeStorage(input.threadId) as TestRuntimeStore<
    RuntimeEvent,
    AgentState
  >;
  const recoveryIdentityKey = input.recoveryIdentityKey ?? TEST_RUNTIME_RECOVERY_IDENTITY_KEY_;
  const { onTestExecutionControl, ...turnInput } = input;
  const kernel: StateHostSessionHarness = restoreStateHostSessionHarness({
    threadId: input.threadId,
    userId: input.userId,
    workspace: input.workspace,
    projectId: 'project_test_runtime_agent',
    canonicalWorkspaceDigest: `sha256:${createHash('sha256')
      .update(input.workspace)
      .digest('hex')}`,
    store,
    recoveryIdentityKey,
    interactionMode: input.interactionMode ?? input.config.interactionMode ?? 'accept_edits',
    phase: 'building',
    sandboxAvailable:
      input.sandboxBackend === 'unknown'
        ? false
        : sandboxBackendAvailable(input.sandboxBackend ?? 'none'),
    modelArtifactEvidence: input.modelInvocationRuntime.evidence,
    capabilityArtifactEvidence: input.modelInvocationRuntime.capabilityArtifacts,
  });

  try {
    yield* executeRuntimeTurn(
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
