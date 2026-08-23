import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { digestCapabilityValueV1 } from '@kite/builtin-runtime';
import {
  LocalWorkspaceFilesystemProviderV1,
  verifyBuiltinWorkspaceFilesystemTerminalV1,
  WorkspaceFilesystemGrantAuthorityV1,
} from '@kite/builtin-runtime/filesystem';
import { BuiltinModelEffectCoordinatorV1 } from '@kite/builtin-runtime/model';
import { PlanArtifactStore } from '@kite/builtin-runtime/planning';
import {
  canonicalPathForComparison,
  SandboxPreparationArtifactStoreV1,
  type ShellExecutor,
} from '@kite/builtin-runtime/sandbox';
import {
  createRuntimeHostInteractionIdV1,
  createRuntimeHostStateInitialStateV1,
  runtimeHostStateNormalizeToolOutcomeEventV1 as normalizeCurrentToolOutcomeEventV1,
  type RuntimeHostStateInitialStateInputV1,
  type RuntimeState,
} from '@kite/runtime-host';
import type {
  PrivateSuspendedSubagentRecordV1,
  RuntimeJsonValueV1,
  SubagentHandleV1,
  SuspendedSubagentSnapshot,
} from '@kite/runtime-spi';
import { projectPrimaryModelEffectV1 } from '#app/bootstrap/runtime/model-effect';
import { ProviderReadinessCoordinatorV1 } from '#app/bootstrap/runtime/provider-readiness';
import type { RuntimeActionProvider } from '#app/bootstrap/runtime/state-runner';
import { subagentContinuationCursorIdV1 } from '#app/bootstrap/runtime/subagent/continuation-codec';
import { normalizeTerminalRuntimeEventV1 } from '#app/bootstrap/runtime/terminal-outcome';
import type { RuntimeTurnInputV1 } from '#app/bootstrap/runtime/turn-coordinator';
import {
  BuiltinChildRuntimeDriverV1,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjectionV1,
  createGovernedLocalSubagentCompositionV1,
  subagentTaskDigestV1,
} from '#builtin-runtime';
import { createRuntimeHostCapabilityExecutionPortV1 } from '#runtime-host';
import { createRuntimeModuleRegistryV1 } from '#runtime-spi';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { createAppRuntimeEffectExecutorV1 } from '../../apps/kite/src/bootstrap/runtime/runtime-effect-coordinator';
import type { RuntimeExecutorDependencies } from '../../apps/kite/src/bootstrap/runtime/runtime-effect-dependencies';
import type { RuntimeEffectExecutor } from '../../apps/kite/src/bootstrap/runtime/state-runtime';
import { createPipelineSubagentRuntimeV1 } from '../../apps/kite/src/bootstrap/runtime/subagent/pipeline-runtime';
import { executeAppRuntimeToolsV1 } from '../../apps/kite/src/bootstrap/runtime/tool-controller-adapter';
import { createAppToolPipelineCompositionV1 } from '../../apps/kite/src/bootstrap/runtime/tool-pipeline-composition';
import {
  createAppOrdinaryToolPipelineAttemptRuntimeV1,
  createAppToolPipelineAttemptScopeV1,
} from '../../apps/kite/src/bootstrap/runtime/tool-pipeline-ordinary-attempt';
import { createAppStateToolPipelinePersistenceV1 } from '../../apps/kite/src/bootstrap/runtime/tool-pipeline-state-persistence';
import { createAppTaskToolPipelineAttemptRuntimeV1 } from '../../apps/kite/src/bootstrap/runtime/tool-pipeline-task-attempt';
import {
  APP_PREPARED_SHELL_EXECUTION_V1,
  type AppPreparedShellExecutionCarrierV1,
  type AppPreparedShellExecutionPortV1,
  appPreparedShellExecutionPortV1,
  projectAppHostShellResultV1,
} from '../../apps/kite/src/sandbox/prepared-tool-pipeline';
import {
  runTestRuntimeAgentV1 as runRuntimeAgentForTestV1,
  type TestRuntimeAgentInputV1,
} from '../../scripts/support/runtime-agent';
import { createTestModelInvocationHarnessV1 } from './model-invocation';
import {
  type CreateAgentToolsInput,
  builtinCapabilityTurnContextV1 as importBuiltinTurnContextV1,
  createAgentToolsFromBuiltinProjectionV1 as importCreateAgentToolsV1,
  toolAvailabilityContext as importToolAvailabilityContextV1,
} from './tool-runtime-projection';

const TEST_RUNTIME_MODULE_REGISTRY_V1 = createRuntimeModuleRegistryV1(
  createBuiltinRuntimeModules(),
);
const TEST_BUILTIN_TOOL_CATALOG_V1 = createBuiltinToolCatalogProjectionV1(
  TEST_RUNTIME_MODULE_REGISTRY_V1.snapshot(),
);
const TEST_TOOL_PIPELINE_COMPOSITION_V1 = createAppToolPipelineCompositionV1(
  TEST_BUILTIN_TOOL_CATALOG_V1,
);

const TEST_SANDBOX_PREPARATION_ROOT_PREFIX_V1 = join(tmpdir(), 'kite-test-shell-preparations-');
const testSandboxPreparationRootsV1 = new Set<string>();
let testSandboxPreparationCleanupRegisteredV1 = false;

function cleanupTestSandboxPreparationRootsV1(roots = testSandboxPreparationRootsV1): void {
  for (const candidate of roots) {
    if (!candidate.startsWith(TEST_SANDBOX_PREPARATION_ROOT_PREFIX_V1)) continue;
    rmSync(candidate, { recursive: true, force: true });
  }
  roots.clear();
}

function createTestSandboxPreparationArtifactStoreV1(
  roots = testSandboxPreparationRootsV1,
): SandboxPreparationArtifactStoreV1 {
  const root = mkdtempSync(TEST_SANDBOX_PREPARATION_ROOT_PREFIX_V1);
  roots.add(root);
  if (roots === testSandboxPreparationRootsV1 && !testSandboxPreparationCleanupRegisteredV1) {
    testSandboxPreparationCleanupRegisteredV1 = true;
    process.once('exit', cleanupTestSandboxPreparationRootsV1);
  }
  return new SandboxPreparationArtifactStoreV1({
    root: join(root, 'sandbox-preparations'),
  });
}

export function testBuiltinToolCatalogV1() {
  return TEST_BUILTIN_TOOL_CATALOG_V1;
}

/** Explicit test-only policy authority; production never imports this helper. */
export function testProviderDataAdmissionV1() {
  return {
    admitted: true,
    reason: 'admitted' as const,
    routeAlias: 'test-runtime-model',
    policyRevision: 'test-runtime-model-v1',
    maxWorkspaceDataClassification: 'confidential' as const,
  };
}

/** Test composition bound to the same frozen Builtin projection and registry snapshot. */
export function testToolPipelineCompositionV1(builtinToolCatalog = TEST_BUILTIN_TOOL_CATALOG_V1) {
  return builtinToolCatalog === TEST_BUILTIN_TOOL_CATALOG_V1
    ? TEST_TOOL_PIPELINE_COMPOSITION_V1
    : createAppToolPipelineCompositionV1(builtinToolCatalog);
}

export function createTestAgentToolsV1(
  input: CreateAgentToolsInput,
  context = importToolAvailabilityContextV1(input),
) {
  const projection = TEST_BUILTIN_TOOL_CATALOG_V1.forTurn(
    importBuiltinTurnContextV1(input, context),
  );
  return importCreateAgentToolsV1(input, projection);
}

/** The catalog is immutable and turn-scoped; retained only for old cache-test call sites. */
export function clearTestToolCacheV1(): void {}

export function testSubagentCompositionV1() {
  const tasks = new Map<
    string,
    {
      owner: import('#builtin-runtime').SubagentTaskArtifactOwnerV1;
      task: string;
      taskDigest: string;
      ref: import('@kite/runtime-spi').SubagentTaskArtifactV1;
    }
  >();
  const handles = new Map<string, SubagentHandleV1>();
  const taskArtifacts: import('#builtin-runtime').SubagentTaskArtifactAccessV1 = {
    write: ({ owner, task }) => {
      const taskDigest = subagentTaskDigestV1(task);
      const artifactId = `pa_${digestCapabilityValueV1({ owner, taskDigest })}`;
      const ref = {
        artifactId,
        kind: 'subagent_task' as const,
        integrityIdentifier: `sha256:${digestCapabilityValueV1({ artifactId, owner })}`,
        byteLength: Buffer.byteLength(JSON.stringify({ owner, task, taskDigest }), 'utf8'),
      };
      tasks.set(artifactId, { owner: structuredClone(owner), task, taskDigest, ref });
      return { ref, taskDigest };
    },
    read: (ref, expected) => {
      const value = tasks.get(ref.artifactId);
      if (
        !value ||
        JSON.stringify(value.ref) !== JSON.stringify(ref) ||
        JSON.stringify(value.owner) !==
          JSON.stringify({
            parentInvocationId: expected.parentInvocationId,
            parentAttempt: expected.parentAttempt,
            parentToolCallId: expected.parentToolCallId,
            childInvocationId: expected.childInvocationId,
          }) ||
        value.taskDigest !== expected.taskDigest
      ) {
        throw new Error('Test Subagent task Artifact binding is invalid.');
      }
      return {
        artifactFormatVersion: 1 as const,
        owner: structuredClone(value.owner),
        task: value.task,
        taskDigest: value.taskDigest,
        taskByteLength: Buffer.byteLength(value.task, 'utf8'),
      };
    },
  };
  const lifecycleArtifacts: import('#builtin-runtime').SubagentLifecycleArtifactAccessV1 = {
    write: (handle, verifier) => {
      const verified = verifier.verifyHandle(handle);
      const artifactId = `pa_${digestCapabilityValueV1({ handleId: verified.handleId, integrityIdentifier: verified.integrityIdentifier })}`;
      handles.set(artifactId, structuredClone(verified));
      return {
        artifactId,
        kind: 'subagent_handle',
        integrityIdentifier: `sha256:${digestCapabilityValueV1({ artifactId })}`,
        byteLength: Buffer.byteLength(JSON.stringify(verified), 'utf8'),
      };
    },
    read: (ref, verifier) => {
      const handle = handles.get(ref.artifactId);
      if (!handle) throw new Error('Test Subagent handle Artifact is unavailable.');
      return verifier.verifyHandle(structuredClone(handle));
    },
  };
  return createGovernedLocalSubagentCompositionV1({
    driver: new BuiltinChildRuntimeDriverV1(),
    taskArtifacts,
    lifecycleArtifacts,
  });
}

export function testSubagentContinuationArtifactsV1(): import('#builtin-runtime').SubagentContinuationArtifactAccessV1 {
  const values = new Map<
    string,
    {
      owner: import('#builtin-runtime').SubagentContinuationArtifactOwnerV1;
      snapshot: import('@kite/runtime-spi').SuspendedSubagentSnapshot;
    }
  >();
  return {
    write: ({ owner, snapshot }) => {
      const artifactId = `pa_${digestCapabilityValueV1({ owner, snapshot })}`;
      values.set(artifactId, {
        owner: structuredClone(owner),
        snapshot: structuredClone(snapshot),
      });
      return {
        artifactId,
        kind: 'subagent_continuation',
        integrityIdentifier: `sha256:${digestCapabilityValueV1({ artifactId })}`,
        byteLength: Buffer.byteLength(JSON.stringify({ owner, snapshot }), 'utf8'),
      };
    },
    read: (ref, expected) => {
      const value = values.get(ref.artifactId);
      if (!value || JSON.stringify(value.owner) !== JSON.stringify(expected)) {
        throw new Error('Test continuation Artifact binding is invalid.');
      }
      return structuredClone(value.snapshot);
    },
  };
}

/**
 * Persist a full child continuation into the test Artifact seam and return
 * the low-information Runtime projection used after the CUT-01 cutover.
 * Keeping this helper explicit prevents tests from smuggling legacy full
 * snapshots into RuntimeState.
 */
export function testPrivateSuspendedSubagentV1(
  snapshot: SuspendedSubagentSnapshot,
  options: {
    parentInvocationId: string;
    parentAttempt: number;
    parentToolCallId: string;
    artifacts?: import('#builtin-runtime').SubagentContinuationArtifactAccessV1;
  },
): {
  record: PrivateSuspendedSubagentRecordV1;
  artifacts: import('#builtin-runtime').SubagentContinuationArtifactAccessV1;
} {
  const artifacts = options.artifacts ?? testSubagentContinuationArtifactsV1();
  const continuationId = subagentContinuationCursorIdV1(snapshot);
  const continuationArtifact = artifacts.write({
    owner: {
      parentInvocationId: options.parentInvocationId,
      parentAttempt: options.parentAttempt,
      parentToolCallId: options.parentToolCallId,
      childInvocationId: snapshot.subagentId,
      continuationId,
    },
    snapshot,
  });
  return {
    record: {
      storage: 'private_artifact_v1',
      subagentId: snapshot.subagentId,
      role: snapshot.role,
      continuationId,
      modelInvocationOrdinal: snapshot.modelInvocationOrdinal ?? 0,
      continuationArtifact,
      parentInvocationId: options.parentInvocationId,
      parentAttempt: options.parentAttempt,
      blockedTool: {
        reasonCode: snapshot.blockedTool.reasonCode,
        toolCallId: snapshot.blockedTool.toolCallId,
        ...(snapshot.blockedTool.runtimeToolCallId
          ? { runtimeToolCallId: snapshot.blockedTool.runtimeToolCallId }
          : {}),
        toolName: snapshot.blockedTool.toolName,
      },
    },
    artifacts,
  };
}

/**
 * Install a private suspension fixture together with the exact live parent
 * invocation/lifecycle authority required by production resume reads.
 */
export function installTestPrivateSuspendedSubagentV1(
  state: RuntimeState,
  toolCallId: string,
  snapshot: SuspendedSubagentSnapshot,
  options: {
    parentInvocationId?: string;
    parentAttempt?: number;
    artifacts?: import('#builtin-runtime').SubagentContinuationArtifactAccessV1;
  } = {},
): import('#builtin-runtime').SubagentContinuationArtifactAccessV1 {
  const parentInvocationId = options.parentInvocationId ?? `test-parent-${toolCallId}`;
  const parentAttempt = options.parentAttempt ?? 1;
  const { record, artifacts } = testPrivateSuspendedSubagentV1(snapshot, {
    parentInvocationId,
    parentAttempt,
    parentToolCallId: toolCallId,
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
  });
  state.suspendedSubagents[toolCallId] = record;
  const now = new Date().toISOString();
  const digest = (value: unknown) => `sha256:${digestCapabilityValueV1(value)}`;
  const taskArtifact = {
    artifactId: `pa_${'1'.repeat(64)}`,
    kind: 'subagent_task' as const,
    integrityIdentifier: `sha256:${'2'.repeat(64)}`,
    byteLength: 1,
  };
  const existing = state.capabilities.invocations[parentInvocationId];
  state.capabilities.invocations[parentInvocationId] = {
    ...(existing ?? {
      invocationId: parentInvocationId,
      toolCallId,
      capabilityId: 'builtin:task',
      capabilityRevision: digest('builtin:task'),
      argumentsDigest: digest({ toolCallId }),
      authorizationDigest: digest('test-authorization'),
      effectiveEffectsDigest: digest('test-effects'),
      status: 'running' as const,
      recordedAt: now,
      startedAt: now,
    }),
    invocationId: parentInvocationId,
    toolCallId,
    capabilityId: 'builtin:task',
    status: 'running',
    attemptsStarted: parentAttempt,
    subagentProviderLifecycle: {
      attempt: parentAttempt,
      purpose: 'start',
      childInvocationId: snapshot.subagentId,
      taskArtifact,
      dispatchIntentDigest: digest({ parentInvocationId, parentAttempt, toolCallId }),
      status: 'cleanup_completed',
      recordedAt: now,
      observationStatus: 'blocked',
      observedAt: now,
      cleanupAttempt: 1,
      cleanupKind: 'handle_reconcile',
      cleanupStartedAt: now,
      cleanupConfirmed: true,
      cleanupCompletedAt: now,
    },
  };
  return artifacts;
}

export function testSubagentTaskRequestsV1(): import('#builtin-runtime').SubagentTaskRequestArtifactAccessV1 {
  const values = new Map<
    string,
    {
      parentModelInvocationId: string;
      parentToolCallId: string;
      role: 'explore' | 'plan' | 'code' | 'review';
      task: string;
    }
  >();
  return {
    write: (input) => {
      const artifactId = `pa_${digestCapabilityValueV1({ input })}`;
      values.set(artifactId, structuredClone(input));
      return {
        artifactId,
        kind: 'subagent_task_request',
        integrityIdentifier: `sha256:${digestCapabilityValueV1({ artifactId })}`,
        byteLength: Buffer.byteLength(JSON.stringify(input), 'utf8'),
      };
    },
    read: (ref, expected) => {
      const value = values.get(ref.artifactId);
      if (
        !value ||
        value.parentModelInvocationId !== expected.parentModelInvocationId ||
        value.parentToolCallId !== expected.parentToolCallId
      ) {
        throw new Error('Test task request Artifact binding is invalid.');
      }
      return { role: value.role, task: value.task };
    },
  };
}

export function testModelInvocationRuntimeV1(workspace: string) {
  const harness = createTestModelInvocationHarnessV1({ workspace });
  const capabilityArtifacts = testCapabilityArtifactWriterV1();
  return {
    builtinToolCatalog: TEST_BUILTIN_TOOL_CATALOG_V1,
    gateway: harness.gateway,
    modelEffects: new BuiltinModelEffectCoordinatorV1(harness.gateway),
    capabilityArtifacts,
    workspaceFilesystem: testWorkspaceFilesystemRuntimeV1(workspace, capabilityArtifacts),
  };
}

export function testWorkspaceFilesystemRuntimeV1(
  workspace: string,
  capabilityArtifacts?: import('@kite/builtin-runtime').CapabilityArtifactReaderV1,
) {
  const grants = new WorkspaceFilesystemGrantAuthorityV1();
  return {
    canonicalWorkspace: canonicalPathForComparison(workspace),
    grants,
    provider: new LocalWorkspaceFilesystemProviderV1(grants.verifier()),
    ...(capabilityArtifacts ? { capabilityArtifacts } : {}),
    preimageArtifacts: {
      write: (input: {
        invocationId: string;
        operationDigest: string;
        targetIdentityDigest: string;
        preimage: import('@kite/runtime-spi').WorkspaceFilesystemPreimageObservationV1;
      }) => {
        const identity = digestCapabilityValueV1(input);
        return {
          artifactId: `pa_${identity}`,
          kind: 'filesystem_preimage' as const,
          integrityIdentifier: `sha256:${digestCapabilityValueV1({ identity })}`,
          byteLength: Buffer.byteLength(JSON.stringify(input), 'utf8'),
        };
      },
    },
  } as const;
}

export function testCapabilityArtifactWriterV1() {
  const artifacts = new Map<
    string,
    {
      invocationId: string;
      result: import('@kite/runtime-contract').CapabilityResult;
    }
  >();
  return {
    write: (invocationId: string, result: import('@kite/runtime-contract').CapabilityResult) => {
      const identity = digestCapabilityValueV1({ invocationId, result });
      const ref = {
        artifactId: `pa_${identity}`,
        kind: 'capability_result' as const,
        integrityIdentifier: `sha256:${digestCapabilityValueV1({ identity })}`,
        byteLength: Buffer.byteLength(JSON.stringify(result), 'utf8'),
      };
      artifacts.set(ref.artifactId, { invocationId, result: structuredClone(result) });
      return ref;
    },
    read: (ref: import('@kite/runtime-contract').CapabilityArtifactRef) => {
      const envelope = artifacts.get(ref.artifactId);
      if (!envelope) throw new Error('Test Capability Artifact is unavailable.');
      return structuredClone(envelope.result);
    },
    readEnvelope: (ref: import('@kite/runtime-contract').CapabilityArtifactRef) => {
      const envelope = artifacts.get(ref.artifactId);
      if (!envelope) throw new Error('Test Capability Artifact is unavailable.');
      return {
        artifactFormatVersion: 2 as const,
        invocationId: envelope.invocationId,
        result: structuredClone(envelope.result),
      };
    },
  } as const;
}

export function runTestRuntimeAgentV1(
  input: Omit<TestRuntimeAgentInputV1, 'modelInvocationRuntime'> & {
    modelInvocationRuntime?: RuntimeTurnInputV1['modelInvocationRuntime'];
  },
  provider: RuntimeActionProvider,
) {
  return (async function* () {
    const sandboxPreparationRoots = new Set<string>();
    try {
      yield* runRuntimeAgentForTestV1(
        {
          ...input,
          capabilityExecution: input.capabilityExecution ?? testRuntimeCapabilityExecutionPortV1(),
          modelInvocationRuntime:
            input.modelInvocationRuntime ?? testModelInvocationRuntimeV1(input.workspace),
          providerDataAdmission:
            input.providerDataAdmission ??
            (input.sessionLoggingContentInspector ? undefined : testProviderDataAdmissionV1),
        },
        provider,
        (dependencies) => createTestRuntimeEffectExecutorV1(dependencies, sandboxPreparationRoots),
      );
    } finally {
      // This helper owns preparation stores it creates for one test Runtime.
      // Finalizing the returned generator is the lifecycle boundary that also
      // applies under Bun's same-process --rerun-each qualification mode.
      cleanupTestSandboxPreparationRootsV1(sandboxPreparationRoots);
    }
  })();
}

export async function projectTestPrimaryModelEffectV1(
  input: Omit<
    Parameters<typeof projectPrimaryModelEffectV1>[0],
    'builtinToolCatalog' | 'modelEffectCoordinator'
  > & {
    builtinToolCatalog?: Parameters<typeof projectPrimaryModelEffectV1>[0]['builtinToolCatalog'];
    modelInvocationGateway?: import('@kite/builtin-runtime/model').ModelInvocationGatewayV1;
    modelEffectCoordinator?: BuiltinModelEffectCoordinatorV1;
  },
) {
  if (input.modelEffectCoordinator && input.modelInvocationGateway) {
    throw new Error('Test primary Model effect accepts one coordinator or one Gateway, not both.');
  }
  const harness = createTestModelInvocationHarnessV1({
    workspace: input.state.session.workspace,
    state: input.state,
  });
  const gateway = input.modelInvocationGateway ?? harness.gateway;
  const {
    builtinToolCatalog,
    modelEffectCoordinator,
    modelInvocationGateway: _modelInvocationGateway,
    ...controllerInput
  } = input;
  const result = await projectPrimaryModelEffectV1({
    ...controllerInput,
    providerDataAdmission: controllerInput.providerDataAdmission ?? testProviderDataAdmissionV1,
    modelEffectCoordinator: modelEffectCoordinator ?? new BuiltinModelEffectCoordinatorV1(gateway),
    modelInvocationPersistence: input.modelInvocationPersistence ?? harness.persistence,
    subagentTaskRequests: input.subagentTaskRequests ?? testSubagentTaskRequestsV1(),
    builtinToolCatalog: builtinToolCatalog ?? TEST_BUILTIN_TOOL_CATALOG_V1,
  });
  // Direct controller tests do not have the Runtime runner to forward the
  // Gateway's acknowledged batches. Preserve their observable event surface
  // without changing the production controller's no-duplicate return value.
  return result.length > 0 ? result : harness.events;
}

export function createTestRuntimeEffectExecutorV1(
  dependencies: RuntimeExecutorDependencies,
  sandboxPreparationRoots = testSandboxPreparationRootsV1,
) {
  const subagentComposition = testSubagentCompositionV1();
  const subagentContinuationArtifacts = testSubagentContinuationArtifactsV1();
  const subagentTaskRequests = dependencies.subagentTaskRequests ?? testSubagentTaskRequestsV1();
  const shellExecutor = testPreparedShellExecutorV1(dependencies.shellExecutor);
  const sandboxPreparationArtifacts =
    dependencies.sandboxPreparationArtifacts ??
    (shellExecutor
      ? createTestSandboxPreparationArtifactStoreV1(sandboxPreparationRoots)
      : undefined);
  const modelInvocationGateway =
    dependencies.modelInvocationGateway ?? testModelInvocationRuntimeV1(process.cwd()).gateway;
  const builtinToolCatalog = dependencies.builtinToolCatalog ?? TEST_BUILTIN_TOOL_CATALOG_V1;
  const executor = createAppRuntimeEffectExecutorV1({
    ...dependencies,
    providerDataAdmission: dependencies.providerDataAdmission ?? testProviderDataAdmissionV1,
    ...(shellExecutor ? { shellExecutor } : {}),
    ...(sandboxPreparationArtifacts ? { sandboxPreparationArtifacts } : {}),
    capabilityExecution: dependencies.capabilityExecution ?? testRuntimeCapabilityExecutionPortV1(),
    builtinToolCatalog,
    toolPipelineComposition:
      dependencies.toolPipelineComposition ??
      (builtinToolCatalog === TEST_BUILTIN_TOOL_CATALOG_V1
        ? TEST_TOOL_PIPELINE_COMPOSITION_V1
        : createAppToolPipelineCompositionV1(builtinToolCatalog)),
    modelInvocationGateway,
    modelEffectCoordinator:
      dependencies.modelEffectCoordinator ??
      new BuiltinModelEffectCoordinatorV1(modelInvocationGateway),
    capabilityArtifactStore:
      dependencies.capabilityArtifactStore ?? testCapabilityArtifactWriterV1(),
    planArtifactStore: dependencies.planArtifactStore ?? new PlanArtifactStore(),
    subagentRuntimeFactory:
      dependencies.subagentRuntimeFactory ??
      (() => createPipelineSubagentRuntimeV1(() => subagentComposition)),
    subagentContinuationArtifacts:
      dependencies.subagentContinuationArtifacts ?? subagentContinuationArtifacts,
    subagentTaskRequests: dependencies.subagentTaskRequests ?? subagentTaskRequests,
  });
  const wrapped: RuntimeEffectExecutor = async (effect, state, emit, executionContext) => {
    let preparedState = state;
    if (effect.type === 'run_tools') {
      let preparedCalls = state.tools.calls;
      for (const toolCallId of effect.toolCallIds) {
        const call = preparedCalls[toolCallId];
        if (call?.name !== 'task' || !call.modelInvocationId) continue;
        if (
          !call.args ||
          typeof call.args !== 'object' ||
          Array.isArray(call.args) ||
          !('task' in call.args) ||
          typeof call.args.task !== 'string' ||
          !('subagent_type' in call.args) ||
          !['explore', 'plan', 'code', 'review'].includes(String(call.args.subagent_type))
        ) {
          continue;
        }
        preparedCalls = {
          ...preparedCalls,
          [toolCallId]: {
            ...call,
            args: {
              subagent_type: call.args.subagent_type,
              taskArtifact: subagentTaskRequests.write({
                parentModelInvocationId: call.modelInvocationId,
                parentToolCallId: toolCallId,
                role: call.args.subagent_type as 'explore' | 'plan' | 'code' | 'review',
                task: call.args.task,
              }),
            },
          },
        };
      }
      if (preparedCalls !== state.tools.calls) {
        preparedState = {
          ...state,
          tools: {
            ...state.tools,
            calls: preparedCalls,
          },
        };
      }
    }
    return executor(effect, preparedState, emit, executionContext);
  };
  return wrapped;
}

export async function executeTestRuntimeToolsV1(
  input: Omit<Parameters<typeof executeAppRuntimeToolsV1>[0], 'toolPipelineComposition'> & {
    toolPipelineComposition?: Parameters<
      typeof executeAppRuntimeToolsV1
    >[0]['toolPipelineComposition'];
  },
) {
  const sandboxPreparationRoots = new Set<string>();
  try {
    const subagentTaskRequests = testSubagentTaskRequestsV1();
    let preparedState = input.state;
    for (const toolCallId of input.toolCallIds) {
      const call = preparedState.tools.calls[toolCallId];
      if (!call) continue;
      let preparedCall = call.modelInvocationId
        ? call
        : { ...call, modelInvocationId: `test-parent-model:${toolCallId}` };
      if (
        preparedCall.name === 'task' &&
        preparedCall.modelInvocationId &&
        preparedCall.args &&
        typeof preparedCall.args === 'object' &&
        !Array.isArray(preparedCall.args) &&
        'task' in preparedCall.args &&
        typeof preparedCall.args.task === 'string' &&
        'subagent_type' in preparedCall.args &&
        ['explore', 'plan', 'code', 'review'].includes(String(preparedCall.args.subagent_type))
      ) {
        preparedCall = {
          ...preparedCall,
          args: {
            subagent_type: preparedCall.args.subagent_type,
            taskArtifact: subagentTaskRequests.write({
              parentModelInvocationId: preparedCall.modelInvocationId,
              parentToolCallId: toolCallId,
              role: preparedCall.args.subagent_type as 'explore' | 'plan' | 'code' | 'review',
              task: preparedCall.args.task,
            }),
          },
        };
      }
      if (preparedCall !== call) {
        preparedState = {
          ...preparedState,
          tools: {
            ...preparedState.tools,
            calls: { ...preparedState.tools.calls, [toolCallId]: preparedCall },
          },
        };
      }
    }
    const harness = createTestModelInvocationHarnessV1({
      workspace: preparedState.session.workspace,
      state: preparedState,
    });
    let readinessState = preparedState;
    const observedEvents: import('@kite/agent-kernel').RuntimeEvent[] = [];
    const readinessCoordinator = input.mcpManager
      ? (input.providerReadinessCoordinator ?? new ProviderReadinessCoordinatorV1(input.mcpManager))
      : input.providerReadinessCoordinator;
    const applyObserved = (events: import('@kite/agent-kernel').RuntimeEvent[]) => {
      for (const event of events) {
        if (!input.emitRuntimeEvent || event.type !== 'tool.progress') observedEvents.push(event);
        const normalized = normalizeCurrentToolOutcomeEventV1(
          normalizeTerminalRuntimeEventV1(event),
          readinessState,
          new Date().toISOString(),
        );
        readinessState = reduceRuntimeState(readinessState, normalized);
      }
    };
    const persistRuntimeEvents = async (
      events: import('@kite/agent-kernel').RuntimeEvent[],
    ): Promise<boolean> => {
      const applied = input.persistRuntimeEvents
        ? await input.persistRuntimeEvents(events)
        : input.persistRuntimeEvent && events.length === 1
          ? await input.persistRuntimeEvent(events[0]!)
          : true;
      if (applied) {
        applyObserved(events);
        for (const event of events) {
          if (
            event.type !== 'capability.invocation_recorded' &&
            event.type !== 'capability.execution_started'
          ) {
            input.emitRuntimeEvent?.(event);
          }
        }
      }
      return applied;
    };
    const persistRuntimeEvent = async (event: import('@kite/agent-kernel').RuntimeEvent) =>
      persistRuntimeEvents([event]);
    const capabilityArtifacts = input.capabilityArtifactStore ?? testCapabilityArtifactWriterV1();
    const shellExecutor = testPreparedShellExecutorV1(input.shellExecutor);
    const sandboxPreparationArtifacts =
      input.sandboxPreparationArtifacts ??
      (shellExecutor
        ? createTestSandboxPreparationArtifactStoreV1(sandboxPreparationRoots)
        : undefined);
    const persistStrictToolPipelineEvents = async (
      events: import('@kite/agent-kernel').RuntimeEvent[],
    ): Promise<boolean> => {
      const beforeRevision = readinessState.revision;
      const applied = await persistRuntimeEvents(events);
      if (applied && readinessState.revision === beforeRevision) {
        readinessState = { ...readinessState, revision: beforeRevision + events.length };
      }
      return applied;
    };
    const toolPipelinePersistence = createAppStateToolPipelinePersistenceV1({
      getState: () => readinessState,
      persistAttemptStartEvents: persistStrictToolPipelineEvents,
      persistTerminalRecoveryEvents: persistStrictToolPipelineEvents,
      persistReceiptEvents: persistStrictToolPipelineEvents,
      now: () => new Date().toISOString(),
      capabilityArtifactWriter: capabilityArtifacts,
      verifyBuiltinWorkspaceFilesystemTerminal: verifyBuiltinWorkspaceFilesystemTerminalV1,
      providerAction: Object.freeze({
        enabled: input.taskConfig?.features?.mcpProviderActionV1 === true,
        createInteractionId: createRuntimeHostInteractionIdV1,
      }),
      verificationEnabled: input.taskConfig?.features?.verificationV1 === true,
    });
    const toolPipelineScope = createAppToolPipelineAttemptScopeV1({
      persistence: toolPipelinePersistence,
    });
    const ordinaryToolPipelineAttemptRuntime =
      input.ordinaryToolPipelineAttemptRuntime ??
      createAppOrdinaryToolPipelineAttemptRuntimeV1({
        persistence: toolPipelinePersistence,
        scope: toolPipelineScope,
      });
    const taskToolPipelineAttemptRuntime =
      input.taskToolPipelineAttemptRuntime ??
      createAppTaskToolPipelineAttemptRuntimeV1({
        persistence: toolPipelinePersistence,
        scope: toolPipelineScope,
      });
    const subagentComposition = testSubagentCompositionV1();
    const subagentContinuationArtifacts = testSubagentContinuationArtifactsV1();
    const builtinToolCatalog = input.builtinToolCatalog ?? TEST_BUILTIN_TOOL_CATALOG_V1;
    await executeAppRuntimeToolsV1({
      ...input,
      providerDataAdmission: input.providerDataAdmission ?? testProviderDataAdmissionV1,
      ...(shellExecutor ? { shellExecutor } : {}),
      ...(sandboxPreparationArtifacts ? { sandboxPreparationArtifacts } : {}),
      state: preparedState,
      capabilityExecution: input.capabilityExecution ?? testRuntimeCapabilityExecutionPortV1(),
      builtinToolCatalog,
      toolPipelineComposition:
        input.toolPipelineComposition ??
        (builtinToolCatalog === TEST_BUILTIN_TOOL_CATALOG_V1
          ? TEST_TOOL_PIPELINE_COMPOSITION_V1
          : createAppToolPipelineCompositionV1(builtinToolCatalog)),
      ordinaryToolPipelineAttemptRuntime,
      taskToolPipelineAttemptRuntime,
      ...(readinessCoordinator ? { providerReadinessCoordinator: readinessCoordinator } : {}),
      persistRuntimeEvent,
      persistRuntimeEvents,
      getRuntimeState: input.getRuntimeState ?? (() => readinessState),
      emitRuntimeEvent: (event) => {
        input.emitRuntimeEvent?.(event);
        applyObserved([event]);
      },
      emitTerminalEventBatch: (events) => {
        input.emitTerminalEventBatch?.(events);
        for (const event of events) input.emitRuntimeEvent?.(event);
        applyObserved(events);
      },
      capabilityArtifactStore: capabilityArtifacts,
      // Test-only composition supplies an explicit store. Production callers
      // must inject the App-owned store and never use this fixture path.
      planArtifactStore: input.planArtifactStore ?? new PlanArtifactStore(),
      workspaceFilesystemRuntime:
        input.workspaceFilesystemRuntime ??
        testWorkspaceFilesystemRuntimeV1(
          preparedState.session.workspace,
          'read' in capabilityArtifacts ? capabilityArtifacts : undefined,
        ),
      modelEffectCoordinator:
        input.modelEffectCoordinator ?? new BuiltinModelEffectCoordinatorV1(harness.gateway),
      modelInvocationPersistence: input.modelInvocationPersistence ?? harness.persistence,
      subagentRuntimeFactory:
        input.subagentRuntimeFactory ??
        (() => createPipelineSubagentRuntimeV1(() => subagentComposition)),
      subagentContinuationArtifacts:
        input.subagentContinuationArtifacts ?? subagentContinuationArtifacts,
      subagentTaskRequests: input.subagentTaskRequests ?? subagentTaskRequests,
    });
    return input.emitRuntimeEvent ? [] : observedEvents;
  } finally {
    cleanupTestSandboxPreparationRootsV1(sandboxPreparationRoots);
  }
}

/**
 * Test-only entry point for a single real State 25 tool turn.
 *
 * Callers provide the model-facing tool name and JSON arguments, while the
 * App pipeline remains responsible for projection lookup, parsing,
 * classification, governance, persistence, and dispatch.  This wrapper is
 * intentionally only a fixture constructor and an event/state projection; it
 * does not contain a tool-name switch or a second execution authority.
 */
export interface TestRuntimeToolInvocationInputV1 {
  readonly workspace: string;
  readonly toolName: string;
  readonly args?: RuntimeJsonValueV1;
  readonly toolCallId?: string;
  readonly modelMessageId?: string;
  readonly status?: 'queued' | 'approved';
  readonly state?: RuntimeState | Partial<Omit<RuntimeHostStateInitialStateInputV1, 'workspace'>>;
  /** Existing State 25 call facts needed by dynamic MCP/private-task fixtures. */
  readonly callOverrides?: Partial<RuntimeState['tools']['calls'][string]>;
  /** App-owned dependencies and ports are forwarded to the one pipeline entry point. */
  readonly execution?: Omit<
    Parameters<typeof executeTestRuntimeToolsV1>[0],
    'state' | 'toolCallIds'
  >;
}

export type TestRuntimeToolTerminalEventV1 = Extract<
  RuntimeEvent,
  { type: 'tool.finished' | 'tool.failed' | 'tool.rejected' }
>;

export interface TestRuntimeToolInvocationResultV1 {
  readonly toolCallId: string;
  readonly initialState: RuntimeState;
  readonly state: RuntimeState;
  readonly events: readonly RuntimeEvent[];
  readonly terminal?: TestRuntimeToolTerminalEventV1;
  readonly result?: Extract<RuntimeEvent, { type: 'tool.finished' }>['result'];
}

/**
 * Construct one pending call in a real State 25 turn and execute it through
 * the existing App composition.  Persistence and event sinks are wrapped only
 * to expose the resulting State 25 projection to tests; injected callbacks
 * still run first and retain their production behavior.
 */
export async function executeTestRuntimeToolV1(
  input: TestRuntimeToolInvocationInputV1,
): Promise<TestRuntimeToolInvocationResultV1> {
  const toolCallId = input.toolCallId ?? `test-tool:${input.toolName}`;
  const initialState =
    input.state && 'tools' in input.state
      ? input.state
      : createRuntimeHostStateInitialStateV1({
          ...input.state,
          threadId: input.state?.threadId ?? `test-thread:${toolCallId}`,
          userId: input.state?.userId ?? 'test-user',
          recoveryIdentityKey: input.state?.recoveryIdentityKey ?? '0'.repeat(64),
          workspace: input.workspace,
        });
  const existingCall = initialState.tools.calls[toolCallId];
  if (existingCall && existingCall.name !== input.toolName) {
    throw new Error(`State 25 tool call '${toolCallId}' already belongs to another tool.`);
  }
  const preparedState: RuntimeState = {
    ...initialState,
    tools: {
      ...initialState.tools,
      calls: {
        ...initialState.tools.calls,
        [toolCallId]: {
          ...(existingCall ?? {}),
          ...input.callOverrides,
          toolCallId,
          modelMessageId:
            input.modelMessageId ??
            input.callOverrides?.modelMessageId ??
            existingCall?.modelMessageId ??
            `test-message:${toolCallId}`,
          name: input.toolName,
          args: input.args ?? input.callOverrides?.args ?? existingCall?.args ?? {},
          status: input.status ?? input.callOverrides?.status ?? existingCall?.status ?? 'queued',
          createdAtTurnId: existingCall?.createdAtTurnId ?? initialState.turn.turnId,
        },
      },
      queue: initialState.tools.queue.includes(toolCallId)
        ? [...initialState.tools.queue]
        : [...initialState.tools.queue, toolCallId],
    },
  };

  const execution = input.execution ?? {};
  const {
    emitRuntimeEvent: suppliedEmitRuntimeEvent,
    emitTerminalEventBatch: suppliedEmitTerminalEventBatch,
    persistRuntimeEvent: suppliedPersistRuntimeEvent,
    persistRuntimeEvents: suppliedPersistRuntimeEvents,
    getRuntimeState: suppliedGetRuntimeState,
    ...forwardedExecution
  } = execution;
  let state = preparedState;
  const events: RuntimeEvent[] = [];
  const observedEventObjects = new WeakSet<object>();
  const observe = (event: RuntimeEvent): void => {
    // The test composition observes the same event object once through the
    // persistence acknowledgement and again through the App notification
    // sink.  Deduplicate only that exact delivery.  Distinct events with the
    // same JSON payload (for example repeated progress chunks) remain
    // independently observable and reducible.
    if (observedEventObjects.has(event)) return;
    observedEventObjects.add(event);
    events.push(event);
    const normalized = normalizeCurrentToolOutcomeEventV1(
      normalizeTerminalRuntimeEventV1(event),
      state,
      new Date().toISOString(),
    );
    const next = reduceRuntimeState(state, normalized);
    state = { ...next, revision: state.revision + 1 };
  };
  const persistRuntimeEvents = async (batch: RuntimeEvent[]): Promise<boolean> => {
    const applied = suppliedPersistRuntimeEvents
      ? await suppliedPersistRuntimeEvents(batch)
      : suppliedPersistRuntimeEvent && batch.length === 1
        ? await suppliedPersistRuntimeEvent(batch[0]!)
        : true;
    if (applied) for (const event of batch) observe(event);
    return applied;
  };
  const persistRuntimeEvent = async (event: RuntimeEvent): Promise<boolean> => {
    const applied = suppliedPersistRuntimeEvent
      ? await suppliedPersistRuntimeEvent(event)
      : suppliedPersistRuntimeEvents
        ? await suppliedPersistRuntimeEvents([event])
        : true;
    if (applied) observe(event);
    return applied;
  };
  const emitRuntimeEvent = (event: RuntimeEvent): void => {
    suppliedEmitRuntimeEvent?.(event);
    observe(event);
  };
  const emitTerminalEventBatch = (batch: RuntimeEvent[]): void => {
    suppliedEmitTerminalEventBatch?.(batch);
    for (const event of batch) observe(event);
  };

  const returnedEvents = await executeTestRuntimeToolsV1({
    ...forwardedExecution,
    state: preparedState,
    toolCallIds: [toolCallId],
    emitRuntimeEvent,
    emitTerminalEventBatch,
    persistRuntimeEvent,
    persistRuntimeEvents,
    getRuntimeState: suppliedGetRuntimeState ?? (() => state),
  });
  for (const event of returnedEvents) observe(event);

  let terminal: TestRuntimeToolTerminalEventV1 | undefined;
  for (const event of events) {
    if (
      event.type === 'tool.finished' ||
      event.type === 'tool.failed' ||
      event.type === 'tool.rejected'
    ) {
      terminal = event;
    }
  }
  return {
    toolCallId,
    initialState: preparedState,
    state,
    events,
    ...(terminal ? { terminal } : {}),
    ...(terminal?.type === 'tool.finished' ? { result: terminal.result } : {}),
  };
}

/**
 * Test-only composition for legacy call sites that inject a raw Shell mock.
 * Production obtains this carrier only from App sandbox startup composition.
 */
function testPreparedShellExecutorV1(
  executor: ShellExecutor | undefined,
): ShellExecutor | undefined {
  if (!executor || appPreparedShellExecutionPortV1(executor)) return executor;
  const wrapped: ShellExecutor = (input) => executor(input);
  Object.defineProperty(wrapped, APP_PREPARED_SHELL_EXECUTION_V1, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      execute: async (input: Parameters<AppPreparedShellExecutionPortV1['execute']>[0]) =>
        projectAppHostShellResultV1(
          await executor({
            workspace: input.workspace,
            command: input.command,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
            ...(input.networkMode ? { networkMode: input.networkMode } : {}),
            ...(input.filesystemMode ? { filesystemMode: input.filesystemMode } : {}),
            ...(input.executionTrust ? { executionTrust: input.executionTrust } : {}),
            sandboxInvocationIdentity: input.identity,
          }),
        ),
    }),
  });
  return Object.freeze(wrapped as AppPreparedShellExecutionCarrierV1);
}

export function testRuntimeCapabilityExecutionPortV1() {
  return createRuntimeHostCapabilityExecutionPortV1(TEST_RUNTIME_MODULE_REGISTRY_V1);
}
