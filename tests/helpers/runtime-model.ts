import { invokeRuntimeModel } from '@/core/controllers/model-controller';
import { executeRuntimeTools } from '@/core/controllers/tool-controller';
import { ProviderReadinessCoordinatorV1 } from '@/core/execution/tool-pipeline';
import { type RunRuntimeAgentInput, runRuntimeAgent } from '@/core/runtime/agent';
import {
  createRuntimeEffectExecutor,
  type RuntimeExecutorDependencies,
} from '@/core/runtime/executor';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import type { RuntimeActionProvider } from '@/core/runtime/runner';
import { createTestModelInvocationHarnessV1 } from './model-invocation';

export function testModelInvocationRuntimeV1(workspace: string) {
  const harness = createTestModelInvocationHarnessV1({ workspace });
  return { gateway: harness.gateway };
}

export function runTestRuntimeAgentV1(
  input: RunRuntimeAgentInput,
  provider: RuntimeActionProvider,
) {
  return runRuntimeAgent(
    {
      ...input,
      modelInvocationRuntime:
        input.modelInvocationRuntime ?? testModelInvocationRuntimeV1(input.workspace),
    },
    provider,
  );
}

export async function invokeTestRuntimeModelV1(input: Parameters<typeof invokeRuntimeModel>[0]) {
  const harness = createTestModelInvocationHarnessV1({
    workspace: input.state.session.workspace,
    state: input.state,
  });
  const result = await invokeRuntimeModel({
    ...input,
    modelInvocationGateway: input.modelInvocationGateway ?? harness.gateway,
    modelInvocationPersistence: input.modelInvocationPersistence ?? harness.persistence,
  });
  // Direct controller tests do not have the Runtime runner to forward the
  // Gateway's acknowledged batches. Preserve their observable event surface
  // without changing the production controller's no-duplicate return value.
  return result.length > 0 ? result : harness.events;
}

export function createTestRuntimeEffectExecutorV1(dependencies: RuntimeExecutorDependencies) {
  return createRuntimeEffectExecutor({
    ...dependencies,
    modelInvocationGateway:
      dependencies.modelInvocationGateway ?? testModelInvocationRuntimeV1(process.cwd()).gateway,
  });
}

export function executeTestRuntimeToolsV1(input: Parameters<typeof executeRuntimeTools>[0]) {
  const harness = createTestModelInvocationHarnessV1({
    workspace: input.state.session.workspace,
    state: input.state,
  });
  let readinessState = input.state;
  const readinessCoordinator = input.mcpManager
    ? (input.providerReadinessCoordinator ?? new ProviderReadinessCoordinatorV1(input.mcpManager))
    : input.providerReadinessCoordinator;
  const persistRuntimeEvent = async (
    event: import('@/core/runtime/events').RuntimeEvent,
  ): Promise<boolean> => {
    const applied = input.persistRuntimeEvent ? await input.persistRuntimeEvent(event) : true;
    if (applied) readinessState = reduceRuntimeState(readinessState, event);
    return applied;
  };
  return executeRuntimeTools({
    ...input,
    ...(readinessCoordinator
      ? {
          providerReadinessCoordinator: readinessCoordinator,
          persistRuntimeEvent,
          getRuntimeState: input.getRuntimeState ?? (() => readinessState),
        }
      : {}),
    modelInvocationGateway: input.modelInvocationGateway ?? harness.gateway,
    modelInvocationPersistence: input.modelInvocationPersistence ?? harness.persistence,
  });
}
