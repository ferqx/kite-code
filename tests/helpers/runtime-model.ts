import { digestCapability } from '@/core/capabilities/catalog';
import { invokeRuntimeModel } from '@/core/controllers/model-controller';
import { executeRuntimeTools } from '@/core/controllers/tool-controller';
import { ProviderReadinessCoordinatorV1 } from '@/core/execution/tool-pipeline';
import { createPipelineSubagentRuntimeV1 } from '@/core/execution/tool-pipeline/subagent-runtime';
import {
  LocalWorkspaceFilesystemProviderV1,
  WorkspaceFilesystemGrantAuthorityV1,
} from '@/core/execution/workspace-filesystem';
import { subagentTaskDigestV1 } from '@/core/persistence/subagent-task-artifacts';
import { type RunRuntimeAgentInput, runRuntimeAgent } from '@/core/runtime/agent';
import {
  createRuntimeEffectExecutor,
  type RuntimeExecutorDependencies,
} from '@/core/runtime/executor';
import type { RuntimeEffectExecutor } from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import type { RuntimeActionProvider } from '@/core/runtime/runner';
import type { RuntimeState } from '@/core/runtime/state';
import { normalizeTerminalRuntimeEventV1 } from '@/core/runtime/terminal-outcome';
import { normalizeCurrentToolOutcomeEventV1 } from '@/core/runtime/tool-outcome-events';
import { createGovernedLocalSubagentCompositionV1 } from '@/core/subagent/composition';
import { subagentContinuationCursorIdV1 } from '@/core/subagent/continuation-codec';
import { canonicalPathForComparison } from '@/core/tools/path-utils';
import type {
  PrivateSuspendedSubagentRecordV1,
  SuspendedSubagentSnapshot,
} from '@/protocol/subagent';
import type { SubagentHandleV1 } from '@/protocol/subagent-provider';
import { createTestModelInvocationHarnessV1 } from './model-invocation';

export function testSubagentCompositionV1() {
  const tasks = new Map<
    string,
    {
      owner: import('@/core/persistence/subagent-task-artifacts').SubagentTaskArtifactOwnerV1;
      task: string;
      taskDigest: string;
      ref: import('@/protocol/subagent-provider').SubagentTaskArtifactV1;
    }
  >();
  const handles = new Map<string, SubagentHandleV1>();
  const taskArtifacts: import('@/core/persistence/subagent-task-artifacts').SubagentTaskArtifactAccessV1 =
    {
      write: ({ owner, task }) => {
        const taskDigest = subagentTaskDigestV1(task);
        const artifactId = `pa_${digestCapability({ owner, taskDigest })}`;
        const ref = {
          artifactId,
          kind: 'subagent_task' as const,
          integrityIdentifier: `hmac-sha256:${digestCapability({ artifactId, owner })}`,
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
  const lifecycleArtifacts: import('@/core/persistence/subagent-lifecycle-artifacts').SubagentLifecycleArtifactAccessV1 =
    {
      write: (handle, verifier) => {
        const verified = verifier.verifyHandle(handle);
        const artifactId = `pa_${digestCapability({ handleId: verified.handleId, integrityIdentifier: verified.integrityIdentifier })}`;
        handles.set(artifactId, structuredClone(verified));
        return {
          artifactId,
          kind: 'subagent_handle',
          integrityIdentifier: `hmac-sha256:${digestCapability({ artifactId })}`,
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
    integrityKey: new Uint8Array(32).fill(11),
    taskArtifacts,
    lifecycleArtifacts,
  });
}

export function testSubagentContinuationArtifactsV1(): import('@/core/persistence/subagent-continuation-artifacts').SubagentContinuationArtifactAccessV1 {
  const values = new Map<
    string,
    {
      owner: import('@/core/persistence/subagent-continuation-artifacts').SubagentContinuationArtifactOwnerV1;
      snapshot: import('@/protocol/subagent').SuspendedSubagentSnapshot;
    }
  >();
  return {
    write: ({ owner, snapshot }) => {
      const artifactId = `pa_${digestCapability({ owner, snapshot })}`;
      values.set(artifactId, {
        owner: structuredClone(owner),
        snapshot: structuredClone(snapshot),
      });
      return {
        artifactId,
        kind: 'subagent_continuation',
        integrityIdentifier: `hmac-sha256:${digestCapability({ artifactId })}`,
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
    artifacts?: import('@/core/persistence/subagent-continuation-artifacts').SubagentContinuationArtifactAccessV1;
  },
): {
  record: PrivateSuspendedSubagentRecordV1;
  artifacts: import('@/core/persistence/subagent-continuation-artifacts').SubagentContinuationArtifactAccessV1;
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
    artifacts?: import('@/core/persistence/subagent-continuation-artifacts').SubagentContinuationArtifactAccessV1;
  } = {},
): import('@/core/persistence/subagent-continuation-artifacts').SubagentContinuationArtifactAccessV1 {
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
  const digest = (value: unknown) => `sha256:${digestCapability(value)}`;
  const taskArtifact = {
    artifactId: `pa_${'1'.repeat(64)}`,
    kind: 'subagent_task' as const,
    integrityIdentifier: `hmac-sha256:${'2'.repeat(64)}`,
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

export function testSubagentTaskRequestsV1(): import('@/core/persistence/subagent-task-artifacts').SubagentTaskRequestArtifactAccessV1 {
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
      const artifactId = `pa_${digestCapability({ input })}`;
      values.set(artifactId, structuredClone(input));
      return {
        artifactId,
        kind: 'subagent_task_request',
        integrityIdentifier: `hmac-sha256:${digestCapability({ artifactId })}`,
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
    gateway: harness.gateway,
    capabilityArtifacts,
    workspaceFilesystem: testWorkspaceFilesystemRuntimeV1(workspace, capabilityArtifacts),
  };
}

export function testWorkspaceFilesystemRuntimeV1(
  workspace: string,
  capabilityArtifacts?: import('@/core/persistence/capability-artifacts').CapabilityArtifactReaderV1,
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
        preimage: import('@/protocol/workspace-filesystem-provider').WorkspaceFilesystemPreimageObservationV1;
      }) => {
        const identity = digestCapability(input);
        return {
          artifactId: `pa_${identity}`,
          kind: 'filesystem_preimage' as const,
          integrityIdentifier: `hmac-sha256:${digestCapability({ identity })}`,
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
      result: import('@/protocol/capabilities').CapabilityResult;
    }
  >();
  return {
    write: (invocationId: string, result: import('@/protocol/capabilities').CapabilityResult) => {
      const identity = digestCapability({ invocationId, result });
      const ref = {
        artifactId: `pa_${identity}`,
        kind: 'capability_result' as const,
        integrityIdentifier: `hmac-sha256:${digestCapability({ identity })}`,
        byteLength: Buffer.byteLength(JSON.stringify(result), 'utf8'),
      };
      artifacts.set(ref.artifactId, { invocationId, result: structuredClone(result) });
      return ref;
    },
    read: (ref: import('@/protocol/capabilities').CapabilityArtifactRef) => {
      const envelope = artifacts.get(ref.artifactId);
      if (!envelope) throw new Error('Test Capability Artifact is unavailable.');
      return structuredClone(envelope.result);
    },
    readEnvelope: (ref: import('@/protocol/capabilities').CapabilityArtifactRef) => {
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
    subagentTaskRequests: input.subagentTaskRequests ?? testSubagentTaskRequestsV1(),
  });
  // Direct controller tests do not have the Runtime runner to forward the
  // Gateway's acknowledged batches. Preserve their observable event surface
  // without changing the production controller's no-duplicate return value.
  return result.length > 0 ? result : harness.events;
}

export function createTestRuntimeEffectExecutorV1(dependencies: RuntimeExecutorDependencies) {
  const subagentComposition = testSubagentCompositionV1();
  const subagentContinuationArtifacts = testSubagentContinuationArtifactsV1();
  const subagentTaskRequests = dependencies.subagentTaskRequests ?? testSubagentTaskRequestsV1();
  const executor = createRuntimeEffectExecutor({
    ...dependencies,
    modelInvocationGateway:
      dependencies.modelInvocationGateway ?? testModelInvocationRuntimeV1(process.cwd()).gateway,
    capabilityArtifactStore:
      dependencies.capabilityArtifactStore ?? testCapabilityArtifactWriterV1(),
    subagentRuntimeFactory:
      dependencies.subagentRuntimeFactory ??
      (() => createPipelineSubagentRuntimeV1(() => subagentComposition)),
    subagentContinuationArtifacts:
      dependencies.subagentContinuationArtifacts ?? subagentContinuationArtifacts,
    subagentTaskRequests: dependencies.subagentTaskRequests ?? subagentTaskRequests,
  });
  const wrapped: RuntimeEffectExecutor = async (effect, state, emit, executionContext) => {
    if (effect.type === 'run_tools') {
      for (const toolCallId of effect.toolCallIds) {
        const call = state.tools.calls[toolCallId];
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
        call.args = {
          subagent_type: call.args.subagent_type,
          taskArtifact: subagentTaskRequests.write({
            parentModelInvocationId: call.modelInvocationId,
            parentToolCallId: toolCallId,
            role: call.args.subagent_type as 'explore' | 'plan' | 'code' | 'review',
            task: call.args.task,
          }),
        };
      }
    }
    return executor(effect, state, emit, executionContext);
  };
  return wrapped;
}

export async function executeTestRuntimeToolsV1(input: Parameters<typeof executeRuntimeTools>[0]) {
  const subagentTaskRequests = testSubagentTaskRequestsV1();
  for (const toolCallId of input.toolCallIds) {
    const call = input.state.tools.calls[toolCallId];
    if (call && !call.modelInvocationId) {
      call.modelInvocationId = `test-parent-model:${toolCallId}`;
    }
    if (
      call?.name === 'task' &&
      call.modelInvocationId &&
      call.args &&
      typeof call.args === 'object' &&
      !Array.isArray(call.args) &&
      'task' in call.args &&
      typeof call.args.task === 'string' &&
      'subagent_type' in call.args &&
      ['explore', 'plan', 'code', 'review'].includes(String(call.args.subagent_type))
    ) {
      call.args = {
        subagent_type: call.args.subagent_type,
        taskArtifact: subagentTaskRequests.write({
          parentModelInvocationId: call.modelInvocationId,
          parentToolCallId: toolCallId,
          role: call.args.subagent_type as 'explore' | 'plan' | 'code' | 'review',
          task: call.args.task,
        }),
      };
    }
  }
  const harness = createTestModelInvocationHarnessV1({
    workspace: input.state.session.workspace,
    state: input.state,
  });
  let readinessState = input.state;
  const observedEvents: import('@/core/runtime/events').RuntimeEvent[] = [];
  const readinessCoordinator = input.mcpManager
    ? (input.providerReadinessCoordinator ?? new ProviderReadinessCoordinatorV1(input.mcpManager))
    : input.providerReadinessCoordinator;
  const applyObserved = (events: import('@/core/runtime/events').RuntimeEvent[]) => {
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
    events: import('@/core/runtime/events').RuntimeEvent[],
  ): Promise<boolean> => {
    const applied = input.persistRuntimeEvents
      ? await input.persistRuntimeEvents(events)
      : input.persistRuntimeEvent && events.length === 1
        ? await input.persistRuntimeEvent(events[0]!)
        : true;
    if (applied) applyObserved(events);
    return applied;
  };
  const persistRuntimeEvent = async (event: import('@/core/runtime/events').RuntimeEvent) =>
    persistRuntimeEvents([event]);
  const capabilityArtifacts = input.capabilityArtifactStore ?? testCapabilityArtifactWriterV1();
  const subagentComposition = testSubagentCompositionV1();
  const subagentContinuationArtifacts = testSubagentContinuationArtifactsV1();
  await executeRuntimeTools({
    ...input,
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
    workspaceFilesystemRuntime:
      input.workspaceFilesystemRuntime ??
      testWorkspaceFilesystemRuntimeV1(
        input.state.session.workspace,
        'read' in capabilityArtifacts ? capabilityArtifacts : undefined,
      ),
    modelInvocationGateway: input.modelInvocationGateway ?? harness.gateway,
    modelInvocationPersistence: input.modelInvocationPersistence ?? harness.persistence,
    subagentRuntimeFactory:
      input.subagentRuntimeFactory ??
      (() => createPipelineSubagentRuntimeV1(() => subagentComposition)),
    subagentContinuationArtifacts:
      input.subagentContinuationArtifacts ?? subagentContinuationArtifacts,
    subagentTaskRequests: input.subagentTaskRequests ?? subagentTaskRequests,
  });
  return input.emitRuntimeEvent ? [] : observedEvents;
}
