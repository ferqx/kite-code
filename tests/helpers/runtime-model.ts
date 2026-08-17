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
import { reduceRuntimeState } from '@/core/runtime/reducer';
import type { RuntimeActionProvider } from '@/core/runtime/runner';
import { normalizeTerminalRuntimeEventV1 } from '@/core/runtime/terminal-outcome';
import { normalizeCurrentToolOutcomeEventV1 } from '@/core/runtime/tool-outcome-events';
import { createGovernedLocalSubagentCompositionV1 } from '@/core/subagent/composition';
import { canonicalPathForComparison } from '@/core/tools/path-utils';
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
  const subagentTaskRequests = testSubagentTaskRequestsV1();
  return createRuntimeEffectExecutor({
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
