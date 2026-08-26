import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { digestCapabilityValue } from '@kite-ai/builtin-runtime/capability';

import {
  LocalWorkspaceFilesystemProvider,
  verifyBuiltinWorkspaceFilesystemTerminal,
  WorkspaceFilesystemGrantAuthority,
} from '@kite-ai/builtin-runtime/filesystem';
import { BuiltinModelEffectCoordinator } from '@kite-ai/builtin-runtime/model';
import { PlanArtifactStore } from '@kite-ai/builtin-runtime/planning';
import {
  canonicalPathForComparison,
  SandboxPreparationArtifactStore,
  type ShellExecutor,
} from '@kite-ai/builtin-runtime/sandbox';
import {
  BuiltinChildRuntimeDriver,
  createGovernedLocalSubagentComposition,
  subagentTaskDigest,
} from '@kite-ai/builtin-runtime/subagent';
import { createRuntimeHostInteractionId } from '@kite-ai/runtime-host';
import {
  createRuntimeHostStateInitialState,
  runtimeHostStateNormalizeToolOutcomeEvent as normalizeCurrentToolOutcomeEvent,
  type RuntimeHostStateInitialStateInput,
  type RuntimeState,
} from '@kite-ai/runtime-host/kernel-adapter';
import type {
  PrivateSuspendedSubagentRecord,
  RuntimeJsonValue,
  SubagentHandle,
  SuspendedSubagentSnapshot,
} from '@kite-ai/runtime-spi';
import { createBuiltinRuntimeModules, createBuiltinToolCatalogProjection } from '#builtin-runtime';
import { projectPrimaryModelEffect } from '#kite-cli/bootstrap/runtime/model-effect';
import { ProviderReadinessCoordinator } from '#kite-cli/bootstrap/runtime/provider-readiness';
import type { RuntimeActionProvider } from '#kite-cli/bootstrap/runtime/state-runner';
import { subagentContinuationCursorId } from '#kite-cli/bootstrap/runtime/subagent/continuation-codec';
import { normalizeTerminalRuntimeEvent } from '#kite-cli/bootstrap/runtime/terminal-outcome';
import type { RuntimeTurnInput } from '#kite-cli/bootstrap/runtime/turn-coordinator';
import { createRuntimeHostCapabilityExecutionPortFromSnapshot } from '#runtime-host';
import { createRuntimeModuleRegistry } from '#runtime-spi';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { createAppRuntimeEffectExecutor } from '../../apps/kite-cli/src/bootstrap/runtime/runtime-effect-coordinator';
import type { RuntimeExecutorDependencies } from '../../apps/kite-cli/src/bootstrap/runtime/runtime-effect-dependencies';
import type { RuntimeEffectExecutor } from '../../apps/kite-cli/src/bootstrap/runtime/state-runtime';
import { createPipelineSubagentRuntime } from '../../apps/kite-cli/src/bootstrap/runtime/subagent/pipeline-runtime';
import { createAppToolPipelineComposition } from '../../apps/kite-cli/src/bootstrap/runtime/tool-pipeline-composition';
import {
  createAppOrdinaryToolPipelineAttemptRuntime,
  createAppToolPipelineAttemptScope,
} from '../../apps/kite-cli/src/bootstrap/runtime/tool-pipeline-ordinary-attempt';
import { createAppTaskToolPipelineAttemptRuntime } from '../../apps/kite-cli/src/bootstrap/runtime/tool-pipeline-task-attempt';
import { executeAppRuntimeTools } from '../../apps/kite-cli/src/runtime/tool-execution/router';
import { createAppStateToolPipelinePersistence } from '../../apps/kite-cli/src/runtime/tool-persistence';
import {
  APP_PREPARED_SHELL_EXECUTION_,
  type AppPreparedShellExecutionCarrier,
  type AppPreparedShellExecutionPort,
  appPreparedShellExecutionPort,
  projectAppHostShellResult,
} from '../../apps/kite-cli/src/sandbox/prepared-tool-pipeline';
import {
  runTestRuntimeAgent as runRuntimeAgentForTest,
  type TestRuntimeAgentInput,
} from '../../scripts/support/runtime-agent';
import { createTestModelInvocationHarness } from './model-invocation';
import {
  type CreateAgentToolsInput,
  builtinCapabilityTurnContext as importBuiltinTurnContext,
  createAgentToolsFromBuiltinProjection as importCreateAgentTools,
  toolAvailabilityContext as importToolAvailabilityContext,
} from './tool-runtime-projection';

const TEST_RUNTIME_MODULE_REGISTRY_ = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
const TEST_BUILTIN_TOOL_CATALOG_ = createBuiltinToolCatalogProjection(
  TEST_RUNTIME_MODULE_REGISTRY_.snapshot(),
);
const TEST_TOOL_PIPELINE_COMPOSITION_ = createAppToolPipelineComposition(
  TEST_BUILTIN_TOOL_CATALOG_,
);

const TEST_SANDBOX_PREPARATION_ROOT_PREFIX_ = join(tmpdir(), 'kite-test-shell-preparations-');
const testSandboxPreparationRoots = new Set<string>();
let testSandboxPreparationCleanupRegistered = false;

function cleanupTestSandboxPreparationRoots(roots = testSandboxPreparationRoots): void {
  for (const candidate of roots) {
    if (!candidate.startsWith(TEST_SANDBOX_PREPARATION_ROOT_PREFIX_)) continue;
    rmSync(candidate, { recursive: true, force: true });
  }
  roots.clear();
}

function createTestSandboxPreparationArtifactStore(
  roots = testSandboxPreparationRoots,
): SandboxPreparationArtifactStore {
  const root = mkdtempSync(TEST_SANDBOX_PREPARATION_ROOT_PREFIX_);
  roots.add(root);
  if (roots === testSandboxPreparationRoots && !testSandboxPreparationCleanupRegistered) {
    testSandboxPreparationCleanupRegistered = true;
    process.once('exit', cleanupTestSandboxPreparationRoots);
  }
  return new SandboxPreparationArtifactStore({
    root: join(root, 'sandbox-preparations'),
  });
}

export function testBuiltinToolCatalog() {
  return TEST_BUILTIN_TOOL_CATALOG_;
}

/** Test composition bound to the same frozen Builtin projection and registry snapshot. */
export function testToolPipelineComposition(builtinToolCatalog = TEST_BUILTIN_TOOL_CATALOG_) {
  return builtinToolCatalog === TEST_BUILTIN_TOOL_CATALOG_
    ? TEST_TOOL_PIPELINE_COMPOSITION_
    : createAppToolPipelineComposition(builtinToolCatalog);
}

export function createTestAgentTools(
  input: CreateAgentToolsInput,
  context = importToolAvailabilityContext(input),
) {
  const projection = TEST_BUILTIN_TOOL_CATALOG_.forTurn(importBuiltinTurnContext(input, context));
  return importCreateAgentTools(input, projection);
}

/** The catalog is immutable and turn-scoped; retained only for old cache-test call sites. */
export function clearTestToolCache(): void {}

export function testSubagentComposition() {
  const tasks = new Map<
    string,
    {
      owner: import('@kite-ai/builtin-runtime/subagent').SubagentTaskArtifactOwner;
      task: string;
      taskDigest: string;
      ref: import('@kite-ai/runtime-spi').SubagentTaskArtifact;
    }
  >();
  const handles = new Map<string, SubagentHandle>();
  const taskArtifacts: import('@kite-ai/builtin-runtime/subagent').SubagentTaskArtifactAccess = {
    write: ({ owner, task }) => {
      const taskDigest = subagentTaskDigest(task);
      const artifactId = `pa_${digestCapabilityValue({ owner, taskDigest })}`;
      const ref = {
        artifactId,
        kind: 'subagent_task' as const,
        integrityIdentifier: `sha256:${digestCapabilityValue({ artifactId, owner })}`,
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
  const lifecycleArtifacts: import('@kite-ai/builtin-runtime/subagent').SubagentLifecycleArtifactAccess =
    {
      write: (handle, verifier) => {
        const verified = verifier.verifyHandle(handle);
        const artifactId = `pa_${digestCapabilityValue({ handleId: verified.handleId, integrityIdentifier: verified.integrityIdentifier })}`;
        handles.set(artifactId, structuredClone(verified));
        return {
          artifactId,
          kind: 'subagent_handle',
          integrityIdentifier: `sha256:${digestCapabilityValue({ artifactId })}`,
          byteLength: Buffer.byteLength(JSON.stringify(verified), 'utf8'),
        };
      },
      read: (ref, verifier) => {
        const handle = handles.get(ref.artifactId);
        if (!handle) throw new Error('Test Subagent handle Artifact is unavailable.');
        return verifier.verifyHandle(structuredClone(handle));
      },
    };
  return createGovernedLocalSubagentComposition({
    driver: new BuiltinChildRuntimeDriver(),
    taskArtifacts,
    lifecycleArtifacts,
  });
}

export function testSubagentContinuationArtifacts(): import('@kite-ai/builtin-runtime/subagent').SubagentContinuationArtifactAccess {
  const values = new Map<
    string,
    {
      owner: import('@kite-ai/builtin-runtime/subagent').SubagentContinuationArtifactOwner;
      snapshot: import('@kite-ai/runtime-spi').SuspendedSubagentSnapshot;
    }
  >();
  return {
    write: ({ owner, snapshot }) => {
      const artifactId = `pa_${digestCapabilityValue({ owner, snapshot })}`;
      values.set(artifactId, {
        owner: structuredClone(owner),
        snapshot: structuredClone(snapshot),
      });
      return {
        artifactId,
        kind: 'subagent_continuation',
        integrityIdentifier: `sha256:${digestCapabilityValue({ artifactId })}`,
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
export function testPrivateSuspendedSubagent(
  snapshot: SuspendedSubagentSnapshot,
  options: {
    parentInvocationId: string;
    parentAttempt: number;
    parentToolCallId: string;
    artifacts?: import('@kite-ai/builtin-runtime/subagent').SubagentContinuationArtifactAccess;
  },
): {
  record: PrivateSuspendedSubagentRecord;
  artifacts: import('@kite-ai/builtin-runtime/subagent').SubagentContinuationArtifactAccess;
} {
  const artifacts = options.artifacts ?? testSubagentContinuationArtifacts();
  const continuationId = subagentContinuationCursorId(snapshot);
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
export function installTestPrivateSuspendedSubagent(
  state: RuntimeState,
  toolCallId: string,
  snapshot: SuspendedSubagentSnapshot,
  options: {
    parentInvocationId?: string;
    parentAttempt?: number;
    artifacts?: import('@kite-ai/builtin-runtime/subagent').SubagentContinuationArtifactAccess;
  } = {},
): import('@kite-ai/builtin-runtime/subagent').SubagentContinuationArtifactAccess {
  const parentInvocationId = options.parentInvocationId ?? `test-parent-${toolCallId}`;
  const parentAttempt = options.parentAttempt ?? 1;
  const { record, artifacts } = testPrivateSuspendedSubagent(snapshot, {
    parentInvocationId,
    parentAttempt,
    parentToolCallId: toolCallId,
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
  });
  state.suspendedSubagents[toolCallId] = record;
  const now = new Date().toISOString();
  const digest = (value: unknown) => `sha256:${digestCapabilityValue(value)}`;
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

export function testSubagentTaskRequests(): import('@kite-ai/builtin-runtime/subagent').SubagentTaskRequestArtifactAccess {
  const values = new Map<
    string,
    {
      parentModelInvocationId: string;
      parentToolCallId: string;
      name: string;
      role: 'explore' | 'plan' | 'code' | 'review';
      task: string;
    }
  >();
  return {
    write: (input) => {
      const artifactId = `pa_${digestCapabilityValue({ input })}`;
      values.set(artifactId, structuredClone({ ...input, name: input.name ?? 'Test sub-agent' }));
      return {
        artifactId,
        kind: 'subagent_task_request',
        integrityIdentifier: `sha256:${digestCapabilityValue({ artifactId })}`,
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
      return { name: value.name, role: value.role, task: value.task };
    },
  };
}

export function testModelInvocationRuntime(workspace: string) {
  const harness = createTestModelInvocationHarness({ workspace });
  const capabilityArtifacts = testCapabilityArtifactWriter();
  return {
    builtinToolCatalog: TEST_BUILTIN_TOOL_CATALOG_,
    gateway: harness.gateway,
    modelEffects: new BuiltinModelEffectCoordinator(harness.gateway),
    capabilityArtifacts,
    workspaceFilesystem: testWorkspaceFilesystemRuntime(workspace, capabilityArtifacts),
  };
}

export function testWorkspaceFilesystemRuntime(
  workspace: string,
  capabilityArtifacts?: import('@kite-ai/builtin-runtime').CapabilityArtifactReader,
) {
  const grants = new WorkspaceFilesystemGrantAuthority();
  return {
    canonicalWorkspace: canonicalPathForComparison(workspace),
    grants,
    provider: new LocalWorkspaceFilesystemProvider(grants.verifier()),
    ...(capabilityArtifacts ? { capabilityArtifacts } : {}),
    preimageArtifacts: {
      write: (input: {
        invocationId: string;
        operationDigest: string;
        targetIdentityDigest: string;
        preimage: import('@kite-ai/runtime-spi').WorkspaceFilesystemPreimageObservation;
      }) => {
        const identity = digestCapabilityValue(input);
        return {
          artifactId: `pa_${identity}`,
          kind: 'filesystem_preimage' as const,
          integrityIdentifier: `sha256:${digestCapabilityValue({ identity })}`,
          byteLength: Buffer.byteLength(JSON.stringify(input), 'utf8'),
        };
      },
    },
  } as const;
}

export function testCapabilityArtifactWriter() {
  const artifacts = new Map<
    string,
    {
      invocationId: string;
      result: import('@kite-ai/runtime-contract').CapabilityResult;
    }
  >();
  return {
    write: (invocationId: string, result: import('@kite-ai/runtime-contract').CapabilityResult) => {
      const identity = digestCapabilityValue({ invocationId, result });
      const ref = {
        artifactId: `pa_${identity}`,
        kind: 'capability_result' as const,
        integrityIdentifier: `sha256:${digestCapabilityValue({ identity })}`,
        byteLength: Buffer.byteLength(JSON.stringify(result), 'utf8'),
      };
      artifacts.set(ref.artifactId, { invocationId, result: structuredClone(result) });
      return ref;
    },
    read: (ref: import('@kite-ai/runtime-contract').CapabilityArtifactRef) => {
      const envelope = artifacts.get(ref.artifactId);
      if (!envelope) throw new Error('Test Capability Artifact is unavailable.');
      return structuredClone(envelope.result);
    },
    readEnvelope: (ref: import('@kite-ai/runtime-contract').CapabilityArtifactRef) => {
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

export function runTestRuntimeAgent(
  input: Omit<TestRuntimeAgentInput, 'modelInvocationRuntime'> & {
    modelInvocationRuntime?: RuntimeTurnInput['modelInvocationRuntime'];
  },
  provider: RuntimeActionProvider,
) {
  return (async function* () {
    const sandboxPreparationRoots = new Set<string>();
    try {
      yield* runRuntimeAgentForTest(
        {
          ...input,
          capabilityExecution: input.capabilityExecution ?? testRuntimeCapabilityExecutionPort(),
          modelInvocationRuntime:
            input.modelInvocationRuntime ?? testModelInvocationRuntime(input.workspace),
        },
        provider,
        (dependencies) => createTestRuntimeEffectExecutor(dependencies, sandboxPreparationRoots),
      );
    } finally {
      // This helper owns preparation stores it creates for one test Runtime.
      // Finalizing the returned generator is the lifecycle boundary that also
      // applies under Bun's same-process --rerun-each qualification mode.
      cleanupTestSandboxPreparationRoots(sandboxPreparationRoots);
    }
  })();
}

export async function projectTestPrimaryModelEffect(
  input: Omit<
    Parameters<typeof projectPrimaryModelEffect>[0],
    'builtinToolCatalog' | 'modelEffectCoordinator'
  > & {
    builtinToolCatalog?: Parameters<typeof projectPrimaryModelEffect>[0]['builtinToolCatalog'];
    modelInvocationGateway?: import('@kite-ai/builtin-runtime/model').ModelInvocationGateway;
    modelEffectCoordinator?: BuiltinModelEffectCoordinator;
  },
) {
  if (input.modelEffectCoordinator && input.modelInvocationGateway) {
    throw new Error('Test primary Model effect accepts one coordinator or one Gateway, not both.');
  }
  const harness = createTestModelInvocationHarness({
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
  const result = await projectPrimaryModelEffect({
    ...controllerInput,
    modelEffectCoordinator: modelEffectCoordinator ?? new BuiltinModelEffectCoordinator(gateway),
    modelInvocationPersistence: input.modelInvocationPersistence ?? harness.persistence,
    subagentTaskRequests: input.subagentTaskRequests ?? testSubagentTaskRequests(),
    builtinToolCatalog: builtinToolCatalog ?? TEST_BUILTIN_TOOL_CATALOG_,
  });
  // Direct controller tests do not have the Runtime runner to forward the
  // Gateway's acknowledged batches. Preserve their observable event surface
  // without changing the production controller's no-duplicate return value.
  return result.length > 0 ? result : harness.events;
}

export function createTestRuntimeEffectExecutor(
  dependencies: RuntimeExecutorDependencies,
  sandboxPreparationRoots = testSandboxPreparationRoots,
) {
  const subagentComposition = testSubagentComposition();
  const subagentContinuationArtifacts = testSubagentContinuationArtifacts();
  const subagentTaskRequests = dependencies.subagentTaskRequests ?? testSubagentTaskRequests();
  const shellExecutor = testPreparedShellExecutor(dependencies.shellExecutor);
  const sandboxPreparationArtifacts =
    dependencies.sandboxPreparationArtifacts ??
    (shellExecutor
      ? createTestSandboxPreparationArtifactStore(sandboxPreparationRoots)
      : undefined);
  const modelInvocationGateway =
    dependencies.modelInvocationGateway ?? testModelInvocationRuntime(process.cwd()).gateway;
  const builtinToolCatalog = dependencies.builtinToolCatalog ?? TEST_BUILTIN_TOOL_CATALOG_;
  const executor = createAppRuntimeEffectExecutor({
    ...dependencies,
    ...(shellExecutor ? { shellExecutor } : {}),
    ...(sandboxPreparationArtifacts ? { sandboxPreparationArtifacts } : {}),
    capabilityExecution: dependencies.capabilityExecution ?? testRuntimeCapabilityExecutionPort(),
    builtinToolCatalog,
    toolPipelineComposition:
      dependencies.toolPipelineComposition ??
      (builtinToolCatalog === TEST_BUILTIN_TOOL_CATALOG_
        ? TEST_TOOL_PIPELINE_COMPOSITION_
        : createAppToolPipelineComposition(builtinToolCatalog)),
    modelInvocationGateway,
    modelEffectCoordinator:
      dependencies.modelEffectCoordinator ??
      new BuiltinModelEffectCoordinator(modelInvocationGateway),
    capabilityArtifactStore: dependencies.capabilityArtifactStore ?? testCapabilityArtifactWriter(),
    planArtifactStore: dependencies.planArtifactStore ?? new PlanArtifactStore(),
    subagentRuntimeFactory:
      dependencies.subagentRuntimeFactory ??
      (() => createPipelineSubagentRuntime(() => subagentComposition)),
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
              name:
                'name' in call.args && typeof call.args.name === 'string'
                  ? call.args.name
                  : 'Test sub-agent',
              subagent_type: call.args.subagent_type,
              taskArtifact: subagentTaskRequests.write({
                parentModelInvocationId: call.modelInvocationId,
                parentToolCallId: toolCallId,
                name:
                  'name' in call.args && typeof call.args.name === 'string'
                    ? call.args.name
                    : 'Test sub-agent',
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

export async function executeTestRuntimeTools(
  input: Omit<Parameters<typeof executeAppRuntimeTools>[0], 'toolPipelineComposition'> & {
    toolPipelineComposition?: Parameters<
      typeof executeAppRuntimeTools
    >[0]['toolPipelineComposition'];
  },
) {
  const sandboxPreparationRoots = new Set<string>();
  try {
    const subagentTaskRequests = testSubagentTaskRequests();
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
            name:
              'name' in preparedCall.args && typeof preparedCall.args.name === 'string'
                ? preparedCall.args.name
                : 'Test sub-agent',
            subagent_type: preparedCall.args.subagent_type,
            taskArtifact: subagentTaskRequests.write({
              parentModelInvocationId: preparedCall.modelInvocationId,
              parentToolCallId: toolCallId,
              name:
                'name' in preparedCall.args && typeof preparedCall.args.name === 'string'
                  ? preparedCall.args.name
                  : 'Test sub-agent',
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
    const harness = createTestModelInvocationHarness({
      workspace: preparedState.session.workspace,
      state: preparedState,
    });
    let readinessState = preparedState;
    const observedEvents: import('@kite-ai/agent-kernel').RuntimeEvent[] = [];
    const readinessCoordinator = input.mcpManager
      ? (input.providerReadinessCoordinator ?? new ProviderReadinessCoordinator(input.mcpManager))
      : input.providerReadinessCoordinator;
    const applyObserved = (events: import('@kite-ai/agent-kernel').RuntimeEvent[]) => {
      for (const event of events) {
        if (!input.emitRuntimeEvent || event.type !== 'tool.progress') observedEvents.push(event);
        const normalized = normalizeCurrentToolOutcomeEvent(
          normalizeTerminalRuntimeEvent(event),
          readinessState,
          new Date().toISOString(),
        );
        readinessState = reduceRuntimeState(readinessState, normalized);
      }
    };
    const persistRuntimeEvents = async (
      events: import('@kite-ai/agent-kernel').RuntimeEvent[],
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
    const persistRuntimeEvent = async (event: import('@kite-ai/agent-kernel').RuntimeEvent) =>
      persistRuntimeEvents([event]);
    const capabilityArtifacts = input.capabilityArtifactStore ?? testCapabilityArtifactWriter();
    const shellExecutor = testPreparedShellExecutor(input.shellExecutor);
    const sandboxPreparationArtifacts =
      input.sandboxPreparationArtifacts ??
      (shellExecutor
        ? createTestSandboxPreparationArtifactStore(sandboxPreparationRoots)
        : undefined);
    const persistStrictToolPipelineEvents = async (
      events: import('@kite-ai/agent-kernel').RuntimeEvent[],
    ): Promise<boolean> => {
      const beforeRevision = readinessState.revision;
      const applied = await persistRuntimeEvents(events);
      if (applied && readinessState.revision === beforeRevision) {
        readinessState = { ...readinessState, revision: beforeRevision + events.length };
      }
      return applied;
    };
    const toolPipelinePersistence = createAppStateToolPipelinePersistence({
      getState: () => readinessState,
      persistAttemptStartEvents: persistStrictToolPipelineEvents,
      persistTerminalRecoveryEvents: persistStrictToolPipelineEvents,
      persistReceiptEvents: persistStrictToolPipelineEvents,
      now: () => new Date().toISOString(),
      capabilityArtifactWriter: capabilityArtifacts,
      verifyBuiltinWorkspaceFilesystemTerminal: verifyBuiltinWorkspaceFilesystemTerminal,
      providerAction: Object.freeze({
        enabled: input.taskConfig?.features?.mcpProviderAction === true,
        createInteractionId: createRuntimeHostInteractionId,
      }),
      verificationEnabled: input.taskConfig?.features?.verification === true,
    });
    const toolPipelineScope = createAppToolPipelineAttemptScope({
      persistence: toolPipelinePersistence,
    });
    const ordinaryToolPipelineAttemptRuntime =
      input.ordinaryToolPipelineAttemptRuntime ??
      createAppOrdinaryToolPipelineAttemptRuntime({
        persistence: toolPipelinePersistence,
        scope: toolPipelineScope,
      });
    const taskToolPipelineAttemptRuntime =
      input.taskToolPipelineAttemptRuntime ??
      createAppTaskToolPipelineAttemptRuntime({
        persistence: toolPipelinePersistence,
        scope: toolPipelineScope,
      });
    const subagentComposition = testSubagentComposition();
    const subagentContinuationArtifacts = testSubagentContinuationArtifacts();
    const builtinToolCatalog = input.builtinToolCatalog ?? TEST_BUILTIN_TOOL_CATALOG_;
    await executeAppRuntimeTools({
      ...input,
      ...(shellExecutor ? { shellExecutor } : {}),
      ...(sandboxPreparationArtifacts ? { sandboxPreparationArtifacts } : {}),
      state: preparedState,
      capabilityExecution: input.capabilityExecution ?? testRuntimeCapabilityExecutionPort(),
      builtinToolCatalog,
      toolPipelineComposition:
        input.toolPipelineComposition ??
        (builtinToolCatalog === TEST_BUILTIN_TOOL_CATALOG_
          ? TEST_TOOL_PIPELINE_COMPOSITION_
          : createAppToolPipelineComposition(builtinToolCatalog)),
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
        testWorkspaceFilesystemRuntime(
          preparedState.session.workspace,
          'read' in capabilityArtifacts ? capabilityArtifacts : undefined,
        ),
      modelEffectCoordinator:
        input.modelEffectCoordinator ?? new BuiltinModelEffectCoordinator(harness.gateway),
      modelInvocationPersistence: input.modelInvocationPersistence ?? harness.persistence,
      subagentRuntimeFactory:
        input.subagentRuntimeFactory ??
        (() => createPipelineSubagentRuntime(() => subagentComposition)),
      subagentContinuationArtifacts:
        input.subagentContinuationArtifacts ?? subagentContinuationArtifacts,
      subagentTaskRequests: input.subagentTaskRequests ?? subagentTaskRequests,
    });
    return input.emitRuntimeEvent ? [] : observedEvents;
  } finally {
    cleanupTestSandboxPreparationRoots(sandboxPreparationRoots);
  }
}

/**
 * Test-only entry point for a single real State 27 tool turn.
 *
 * Callers provide the model-facing tool name and JSON arguments, while the
 * App pipeline remains responsible for projection lookup, parsing,
 * classification, governance, persistence, and dispatch.  This wrapper is
 * intentionally only a fixture constructor and an event/state projection; it
 * does not contain a tool-name switch or a second execution authority.
 */
export interface TestRuntimeToolInvocationInput {
  readonly workspace: string;
  readonly toolName: string;
  readonly args?: RuntimeJsonValue;
  readonly toolCallId?: string;
  readonly modelMessageId?: string;
  readonly status?: 'queued' | 'approved';
  readonly state?: RuntimeState | Partial<Omit<RuntimeHostStateInitialStateInput, 'workspace'>>;
  /** Existing State 27 call facts needed by dynamic MCP/private-task fixtures. */
  readonly callOverrides?: Partial<RuntimeState['tools']['calls'][string]>;
  /** App-owned dependencies and ports are forwarded to the one pipeline entry point. */
  readonly execution?: Omit<Parameters<typeof executeTestRuntimeTools>[0], 'state' | 'toolCallIds'>;
}

export type TestRuntimeToolTerminalEvent = Extract<
  RuntimeEvent,
  { type: 'tool.finished' | 'tool.failed' | 'tool.rejected' }
>;

export interface TestRuntimeToolInvocationResult {
  readonly toolCallId: string;
  readonly initialState: RuntimeState;
  readonly state: RuntimeState;
  readonly events: readonly RuntimeEvent[];
  readonly terminal?: TestRuntimeToolTerminalEvent;
  readonly result?: Extract<RuntimeEvent, { type: 'tool.finished' }>['result'];
}

/**
 * Construct one pending call in a real State 27 turn and execute it through
 * the existing App composition.  Persistence and event sinks are wrapped only
 * to expose the resulting State 27 projection to tests; injected callbacks
 * still run first and retain their production behavior.
 */
export async function executeTestRuntimeTool(
  input: TestRuntimeToolInvocationInput,
): Promise<TestRuntimeToolInvocationResult> {
  const toolCallId = input.toolCallId ?? `test-tool:${input.toolName}`;
  const initialState =
    input.state && 'tools' in input.state
      ? input.state
      : createRuntimeHostStateInitialState({
          ...input.state,
          threadId: input.state?.threadId ?? `test-thread:${toolCallId}`,
          userId: input.state?.userId ?? 'test-user',
          recoveryIdentityKey: input.state?.recoveryIdentityKey ?? '0'.repeat(64),
          workspace: input.workspace,
        });
  const existingCall = initialState.tools.calls[toolCallId];
  if (existingCall && existingCall.name !== input.toolName) {
    throw new Error(`State 27 tool call '${toolCallId}' already belongs to another tool.`);
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
    const normalized = normalizeCurrentToolOutcomeEvent(
      normalizeTerminalRuntimeEvent(event),
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

  const returnedEvents = await executeTestRuntimeTools({
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

  let terminal: TestRuntimeToolTerminalEvent | undefined;
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
function testPreparedShellExecutor(executor: ShellExecutor | undefined): ShellExecutor | undefined {
  if (!executor || appPreparedShellExecutionPort(executor)) return executor;
  const wrapped: ShellExecutor = (input) => executor(input);
  Object.defineProperty(wrapped, APP_PREPARED_SHELL_EXECUTION_, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      execute: async (input: Parameters<AppPreparedShellExecutionPort['execute']>[0]) =>
        projectAppHostShellResult(
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
  return Object.freeze(wrapped as AppPreparedShellExecutionCarrier);
}

export function testRuntimeCapabilityExecutionPort() {
  return createRuntimeHostCapabilityExecutionPortFromSnapshot(
    TEST_RUNTIME_MODULE_REGISTRY_.snapshot(),
  );
}
