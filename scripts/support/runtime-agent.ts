/**
 * Test-only Runtime composition.
 *
 * Production callers must provide an already-owned Kernel and effect port to
 * `executeRuntimeTurn`. This root-only helper is the only place that
 * deliberately composes the State 25 App coordinator for existing corpus
 * tests and fixtures.
 */

import { createHash } from 'node:crypto';
import { createChatModel, type SupportedChatModel } from '@kite/builtin-runtime/model';
import { sandboxSupportsFullMode } from '@kite/builtin-runtime/sandbox';
import type { RuntimeActionProvider } from '#app/bootstrap/runtime/state-runner';
import type { StateSessionStorage } from '#app/bootstrap/runtime/state-runtime';
import { executeRuntimeTurn, type RuntimeTurnInput } from '#app/bootstrap/runtime/turn-coordinator';
import type { AuthorizedExecutionControl } from '../../apps/kite/src/bootstrap/runtime/RuntimeSessionCoordinator';
import type { RuntimeExecutorDependencies } from '../../apps/kite/src/bootstrap/runtime/runtime-effect-dependencies';
import type { RuntimeEffectExecutor } from '../../apps/kite/src/bootstrap/runtime/state-runtime';
import { restoreStateHostSessionHarness, type StateHostSessionHarness } from './runtime-host-state';

export type TestRuntimeAgentInput = Omit<
  RuntimeTurnInput,
  | 'runtimeSession'
  | 'createRuntimeEffectPort'
  | 'model'
  | 'recoveryIdentityKey'
  | 'registerRunCancellation'
> & {
  readonly openStateSessionStorage: (threadId?: string) => StateSessionStorage;
  readonly model?: SupportedChatModel;
  readonly recoveryIdentityKey?: string;
  readonly onTestExecutionControl?: (control: AuthorizedExecutionControl | null) => void;
};

const TEST_RUNTIME_RECOVERY_IDENTITY_KEY_ =
  '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Run one test turn with an explicitly composed State 25/Store 4 Kernel.
 * The helper owns exactly this Kernel and closes it exactly once after the
 * test entry returns or throws.
 */
export async function* runTestRuntimeAgent(
  input: TestRuntimeAgentInput,
  provider: RuntimeActionProvider,
  createRuntimeEffectPort: (dependencies: RuntimeExecutorDependencies) => RuntimeEffectExecutor,
): AsyncGenerator<import('@kite/agent-kernel').RuntimeEvent> {
  const store = input.openStateSessionStorage(input.threadId);
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
    authorizationMode: input.authorizationMode,
    authorizationSource: input.authorizationSource,
    phase: 'building',
    sandboxAvailable:
      input.sandboxBackend === 'unknown'
        ? false
        : sandboxSupportsFullMode(input.sandboxBackend ?? 'none'),
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
