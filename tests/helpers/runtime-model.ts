import { digestCapability } from '@/core/capabilities/catalog';
import { invokeRuntimeModel } from '@/core/controllers/model-controller';
import { executeRuntimeTools } from '@/core/controllers/tool-controller';
import { ProviderReadinessCoordinatorV1 } from '@/core/execution/tool-pipeline';
import {
  LocalWorkspaceFilesystemProviderV1,
  WorkspaceFilesystemGrantAuthorityV1,
} from '@/core/execution/workspace-filesystem';
import { type RunRuntimeAgentInput, runRuntimeAgent } from '@/core/runtime/agent';
import {
  createRuntimeEffectExecutor,
  type RuntimeExecutorDependencies,
} from '@/core/runtime/executor';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import type { RuntimeActionProvider } from '@/core/runtime/runner';
import { normalizeTerminalRuntimeEventV1 } from '@/core/runtime/terminal-outcome';
import { normalizeCurrentToolOutcomeEventV1 } from '@/core/runtime/tool-outcome-events';
import { canonicalPathForComparison } from '@/core/tools/path-utils';
import { createTestModelInvocationHarnessV1 } from './model-invocation';

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
    capabilityArtifactStore:
      dependencies.capabilityArtifactStore ?? testCapabilityArtifactWriterV1(),
  });
}

export async function executeTestRuntimeToolsV1(input: Parameters<typeof executeRuntimeTools>[0]) {
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
  });
  return input.emitRuntimeEvent ? [] : observedEvents;
}
