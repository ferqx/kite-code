import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { createToolRecoveryJournalV1 } from '@kite/agent-kernel';
import {
  BuiltinChildRuntimeDriverV1,
  CapabilityArtifactStore,
  createCapabilityBindingV1,
  createCapabilitySnapshotV1,
  descriptorRevisionV1,
  digestCapabilityValueV1,
  getRoleConfig,
  SubagentGrantAuthorityV1,
} from '@kite/builtin-runtime';
import {
  exposedMcpToolName,
  McpConnectionManager,
  McpProviderError,
} from '@kite/builtin-runtime/mcp';
import { aiMessage } from '@kite/builtin-runtime/model';
import type { CapabilityDescriptor } from '@kite/runtime-contract';
import {
  createRuntimeHostStateInitialStateV1,
  getActivePlanning,
  runtimeHostStateNormalizeToolOutcomeEventV1 as normalizeCurrentToolOutcomeEventV1,
  setActivePlanning,
} from '@kite/runtime-host';
import {
  SUBAGENT_PROVIDER_SCHEMA_V1,
  type SubagentHandleV1,
  type SubagentProviderV1,
} from '@kite/runtime-spi';
import {
  deserializeSubagentContinuation,
  serializeSubagentContinuation,
  subagentContinuationCursorIdV1,
} from '#app/bootstrap/runtime/subagent/continuation-codec';
import type { AgentConfig } from '#app/config/index';
import type { SubagentLifecycleArtifactAccessV1 } from '#builtin-runtime';
import { type SubagentTaskArtifactAccessV1, subagentTaskDigestV1 } from '#builtin-runtime';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { createPipelineSubagentRuntimeV1 } from '../../apps/kite/src/bootstrap/runtime/subagent/pipeline-runtime';
import { normalizeTerminalRuntimeEventV1 } from '../../apps/kite/src/bootstrap/runtime/terminal-outcome';
import {
  blockedSubagentReviewEvent,
  buildBlockedToolRequest,
  createKernelApprovalBindingForBlockedSubagentV1,
  serializeConcurrentSubagentApprovalEvents,
  toRuntimeSubagentEvent,
} from '../../apps/kite/src/bootstrap/runtime/tool-controller-adapter';
import { createAppToolPipelineCompositionV1 } from '../../apps/kite/src/bootstrap/runtime/tool-pipeline-composition';
import { currentPlanDocument } from '../helpers/current-plan';
import {
  createTestRuntimeEffectExecutorV1,
  executeTestRuntimeToolsV1,
  installTestPrivateSuspendedSubagentV1,
  testBuiltinToolCatalogV1,
  testCapabilityArtifactWriterV1,
  testRuntimeCapabilityExecutionPortV1,
  testSubagentCompositionV1,
  testSubagentContinuationArtifactsV1,
  testSubagentTaskRequestsV1,
} from '../helpers/runtime-model';
import { toolAvailabilityContext } from '../helpers/tool-runtime-projection';
import { createMockModel } from '../mock-model';

const TASK_ARTIFACT_REF = Object.freeze({
  artifactId: `pa_${'6'.repeat(64)}`,
  kind: 'subagent_task' as const,
  integrityIdentifier: `sha256:${'7'.repeat(64)}`,
  byteLength: 256,
});
const TASK_ARTIFACTS: SubagentTaskArtifactAccessV1 = {
  write: ({ task }) => ({ ref: TASK_ARTIFACT_REF, taskDigest: subagentTaskDigestV1(task) }),
  read: (_ref, expected) => ({
    artifactFormatVersion: 1,
    owner: expected,
    task: 'fixture task',
    taskDigest: expected.taskDigest,
    taskByteLength: Buffer.byteLength('fixture task'),
  }),
};
let storedHandle: SubagentHandleV1 | undefined;
const LIFECYCLE_ARTIFACTS: SubagentLifecycleArtifactAccessV1 = {
  write: (handle) => {
    storedHandle = handle;
    return {
      artifactId: `pa_${'8'.repeat(64)}`,
      kind: 'subagent_handle',
      integrityIdentifier: `sha256:${'9'.repeat(64)}`,
      byteLength: 512,
    };
  },
  read: () => {
    if (!storedHandle) throw new Error('missing fixture handle');
    return storedHandle;
  },
};

function privateSuspensionFaultState(status: 'approved' | 'queued' = 'approved') {
  const state = createRuntimeHostStateInitialStateV1({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: `private-continuation-${status}`,
    userId: 'user',
    workspace: process.cwd(),
  });
  state.tools.calls.task = {
    toolCallId: 'task',
    modelInvocationId: 'model-parent-private',
    modelMessageId: 'model-message-private',
    name: 'task',
    args: { subagent_type: 'review', task: 'Review a private continuation failure.' },
    status,
    sideEffect: false,
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = [...state.tools.queue, 'task'];
  state.capabilities.invocations['outer-private'] = {
    invocationId: 'outer-private',
    toolCallId: 'task',
    capabilityId: 'builtin:task',
    capabilityRevision: digestCapabilityValueV1({ value: 'capability' }),
    argumentsDigest: digestCapabilityValueV1({ value: 'arguments' }),
    authorizationDigest: digestCapabilityValueV1({ value: 'authorization' }),
    admissionDigest: digestCapabilityValueV1({ value: 'admission' }),
    effectiveEffectsDigest: digestCapabilityValueV1({ value: 'effects' }),
    status: 'running',
    recordedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    attemptsStarted: 1,
    subagentProviderLifecycle: {
      attempt: 1,
      purpose: 'start',
      childInvocationId: 'child-private-continuation',
      taskArtifact: TASK_ARTIFACT_REF,
      dispatchIntentDigest: `sha256:${digestCapabilityValueV1({ value: 'intent' })}`,
      status: 'cleanup_completed',
      recordedAt: new Date().toISOString(),
      observationStatus: 'blocked',
      observedAt: new Date().toISOString(),
      cleanupAttempt: 1,
      cleanupKind: 'handle_reconcile',
      cleanupStartedAt: new Date().toISOString(),
      cleanupConfirmed: true,
      cleanupCompletedAt: new Date().toISOString(),
    },
  };
  state.suspendedSubagents.task = {
    storage: 'private_artifact_v1',
    subagentId: 'child-private-continuation',
    role: 'review',
    continuationId: 'continuation-private',
    modelInvocationOrdinal: 1,
    continuationArtifact: {
      artifactId: `pa_${'a'.repeat(64)}`,
      kind: 'subagent_continuation',
      integrityIdentifier: `sha256:${'b'.repeat(64)}`,
      byteLength: 256,
    },
    parentInvocationId: 'outer-private',
    parentAttempt: 1,
    blockedTool: {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: 'blocked-private',
      toolName: 'shell_execute',
    },
  };
  return state;
}

function canonicalMcpDescriptor(
  input: Omit<CapabilityDescriptor, 'revision'> & { revision?: string },
): CapabilityDescriptor {
  const { revision: _ignored, ...withoutRevision } = input;
  return { ...withoutRevision, revision: descriptorRevisionV1(withoutRevision) };
}

function issueMcpBinding(
  state: ReturnType<typeof createRuntimeHostStateInitialStateV1>,
  descriptor: CapabilityDescriptor,
  exposedToolName: string,
) {
  const binding = createCapabilityBindingV1({
    capabilityId: descriptor.capabilityId,
    capabilityRevision: descriptor.revision,
    exposedToolName,
    inputSchema: descriptor.inputSchema ?? {},
    turnId: state.turn.turnId,
  });
  state.capabilities.bindings[binding.bindingId] = binding;
  return binding;
}

function applyExactApprovalFixtureV1(
  state: ReturnType<typeof createRuntimeHostStateInitialStateV1>,
  toolCallId: string,
  events: readonly RuntimeEvent[],
): void {
  const requested = events.find(
    (
      event,
    ): event is Extract<RuntimeEvent, { type: 'approval.requested' | 'auto_review.requested' }> =>
      (event.type === 'approval.requested' || event.type === 'auto_review.requested') &&
      event.toolCallId === toolCallId,
  );
  const call = state.tools.calls[toolCallId];
  if (!requested || !call) {
    throw new Error(`Missing exact approval fixture for ${toolCallId}: ${JSON.stringify(events)}.`);
  }
  call.status = 'approved';
  call.approvalGrant = 'approve_once';
  call.approvalHash = requested.approval.approvalHash;
}

function v2ExecutingPlanState() {
  let state = startCurrentTask(
    createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-plan-evidence',
      userId: 'user',
      workspace: process.cwd(),
    }),
    'plan-task',
  );
  state = setActivePlanning(state, {
    kind: 'executing',
    document: currentPlanDocument({
      taskId: 'plan-task',
      planId: 'plan-evidence',
      version: 2,
      title: 'Evidence-backed execution plan',
      bodyMarkdown: 'Execute the approved change and verify its observable behavior.',
      steps: [{ id: 'implement', title: 'Implement the approved change', status: 'pending' }],
      structuralDigest: 'digest-evidence',
      createdAtTurnId: state.turn.turnId,
      updatedAtTurnId: state.turn.turnId,
    }),
    executionMode: 'auto',
    approvedAtTurnId: state.turn.turnId,
  });
  return state;
}

function startCurrentTask(
  state: ReturnType<typeof createRuntimeHostStateInitialStateV1>,
  taskId = 'test-task',
) {
  return reduceRuntimeState(state, {
    type: 'task.started',
    taskId,
    userGoal: 'Exercise the current Runtime tool contract.',
    turnId: state.turn.turnId,
  });
}

function setTestPlanning(
  state: ReturnType<typeof createRuntimeHostStateInitialStateV1>,
  planning: ReturnType<typeof getActivePlanning>,
): void {
  const taskId = state.activeTaskId ?? 'test-task';
  state.activeTaskId = taskId;
  state.tasks[taskId] ??= {
    taskId,
    userGoal: 'Exercise test planning.',
    status: 'active',
    startedAtTurnId: state.turn.turnId,
    sideEffectsStarted: false,
    planning: { kind: 'building_without_plan' },
    planHistory: [],
  };
  state.tasks[taskId]!.planning = planning;
}

const EXACT_TASK_RESUME_TEST_CONFIG: AgentConfig = {
  apiKey: 'unused',
  baseURL: 'https://example.invalid',
  modelName: 'fixture',
  providerName: 'fixture',
  providerType: 'openai-compatible',
  sandbox: { enabled: false },
};

async function createExactTaskResumeJourneyV1(input: {
  role: 'code' | 'review';
  task: string;
  model: ReturnType<typeof createMockModel>;
  workspace?: string;
}): Promise<{
  state: ReturnType<typeof createRuntimeHostStateInitialStateV1>;
  continuationArtifacts: ReturnType<typeof testSubagentContinuationArtifactsV1>;
  taskRequests: ReturnType<typeof testSubagentTaskRequestsV1>;
  persistRuntimeEvents: (events: RuntimeEvent[]) => Promise<boolean>;
  getRuntimeState: () => ReturnType<typeof createRuntimeHostStateInitialStateV1>;
  initialEvents: RuntimeEvent[];
}> {
  const workspace = input.workspace ?? process.cwd();
  const state = createRuntimeHostStateInitialStateV1({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: `exact-task-resume-${input.role}`,
    userId: 'user',
    workspace,
  });
  const taskRequests = testSubagentTaskRequestsV1();
  const parentModelInvocationId = `exact-parent-model:${input.role}`;
  const taskArtifact = taskRequests.write({
    parentModelInvocationId,
    parentToolCallId: 'task',
    role: input.role,
    task: input.task,
  });
  state.tools.calls.task = {
    toolCallId: 'task',
    modelInvocationId: parentModelInvocationId,
    modelMessageId: parentModelInvocationId,
    name: 'task',
    args: { subagent_type: input.role, taskArtifact },
    status: 'queued',
    sideEffect: input.role === 'code',
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = [...state.tools.queue, 'task'];
  const continuationArtifacts = testSubagentContinuationArtifactsV1();
  let liveState = state;
  const initialEvents: RuntimeEvent[] = [];
  const persistRuntimeEvents = async (events: RuntimeEvent[]): Promise<boolean> => {
    for (const event of events) {
      initialEvents.push(event);
      liveState = reduceRuntimeState(
        liveState,
        normalizeCurrentToolOutcomeEventV1(
          normalizeTerminalRuntimeEventV1(event),
          liveState,
          new Date().toISOString(),
        ),
      );
    }
    return true;
  };
  await executeTestRuntimeToolsV1({
    state: liveState,
    toolCallIds: ['task'],
    taskConfig: EXACT_TASK_RESUME_TEST_CONFIG,
    taskModel: input.model,
    subagentContinuationArtifacts: continuationArtifacts,
    subagentTaskRequests: taskRequests,
    shellExecutor: async ({ command }) => ({
      ok: false,
      command,
      exitCode: -1,
      stdout: '',
      stderr: 'command requires approval but was not approved',
      status: 'rejected' as const,
    }),
    emitRuntimeEvent: (event) => initialEvents.push(event),
    persistRuntimeEvents,
    getRuntimeState: () => liveState,
  });
  const suspended = liveState.suspendedSubagents.task;
  if (!suspended) {
    throw new Error('Exact task resume fixture did not persist a private suspension.');
  }
  const storedSnapshot = continuationArtifacts.read(suspended.continuationArtifact, {
    parentInvocationId: suspended.parentInvocationId,
    parentAttempt: suspended.parentAttempt,
    parentToolCallId: 'task',
    childInvocationId: suspended.subagentId,
    continuationId: suspended.continuationId,
  });
  const restored = deserializeSubagentContinuation(
    storedSnapshot,
    liveState.toolRecovery.identityKey,
  );
  const runtimeChildToolId = suspended.blockedTool.runtimeToolCallId;
  const childCall = runtimeChildToolId ? liveState.tools.calls[runtimeChildToolId] : undefined;
  if (!runtimeChildToolId || !childCall) {
    throw new Error('Exact task resume fixture did not persist the runtime child call.');
  }
  const blocked = {
    ...restored.blockedTool,
    message: `Sub-agent tool '${restored.blockedTool.toolName}' requires approval.`,
    continuation: restored,
  };
  const approvalBinding = createKernelApprovalBindingForBlockedSubagentV1({
    state: liveState,
    parentToolCallId: 'task',
    blocked,
    availCtx: toolAvailabilityContext({
      workspace: liveState.session.workspace,
      threadId: liveState.session.threadId,
    }),
    toolPipelineComposition: createAppToolPipelineCompositionV1(testBuiltinToolCatalogV1()),
  });
  if (!approvalBinding) {
    throw new Error('Exact task resume fixture did not derive the child approval binding.');
  }
  const boundSnapshot = serializeSubagentContinuation(restored, {
    ...blocked,
    approvalBinding,
  });
  const boundArtifact = continuationArtifacts.write({
    owner: {
      parentInvocationId: suspended.parentInvocationId,
      parentAttempt: suspended.parentAttempt,
      parentToolCallId: 'task',
      childInvocationId: suspended.subagentId,
      continuationId: subagentContinuationCursorIdV1(boundSnapshot),
    },
    snapshot: boundSnapshot,
  });
  liveState.suspendedSubagents.task = {
    ...suspended,
    continuationId: subagentContinuationCursorIdV1(boundSnapshot),
    continuationArtifact: boundArtifact,
  };
  const review = initialEvents.find(
    (
      event,
    ): event is Extract<RuntimeEvent, { type: 'approval.requested' | 'auto_review.requested' }> =>
      (event.type === 'approval.requested' || event.type === 'auto_review.requested') &&
      event.toolCallId === 'task',
  );
  if (!review) {
    throw new Error(
      `Exact task resume fixture did not produce a parent review event: ${JSON.stringify({
        call: liveState.tools.calls.task,
        active: liveState.tools.active,
        queue: liveState.tools.queue,
        suspended: liveState.suspendedSubagents.task,
        events: initialEvents.map((event) => ({
          type: event.type,
          toolCallId: 'toolCallId' in event ? event.toolCallId : undefined,
          failure: 'failure' in event ? event.failure : undefined,
        })),
      })}`,
    );
  }
  liveState = reduceRuntimeState(
    liveState,
    normalizeCurrentToolOutcomeEventV1(
      normalizeTerminalRuntimeEventV1({
        type: 'approval.granted',
        interactionId:
          review.type === 'approval.requested' ? review.interactionId : review.reviewId,
        toolCallId: 'task',
        grant: 'approve_once',
      }),
      liveState,
      new Date().toISOString(),
    ),
  );
  return {
    state: liveState,
    continuationArtifacts,
    taskRequests,
    persistRuntimeEvents,
    getRuntimeState: () => liveState,
    initialEvents,
  };
}

function reduceCurrentEvent(
  state: ReturnType<typeof createRuntimeHostStateInitialStateV1>,
  event: RuntimeEvent,
) {
  return reduceRuntimeState(
    state,
    normalizeCurrentToolOutcomeEventV1(event, state, '2026-08-15T00:00:00.000Z'),
  );
}

function childRuntimeToolId(input: {
  parentToolCallId: string;
  subagentId: string;
  modelInvocationId: string;
  modelToolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}) {
  return `subagent-tool:${digestCapabilityValueV1({
    schema: 'kite.subagent-runtime-tool-identity.v1',
    parentToolCallId: input.parentToolCallId,
    subagentId: input.subagentId,
    modelInvocationId: input.modelInvocationId,
    modelToolCallId: input.modelToolCallId,
    toolName: input.toolName,
    arguments: input.args,
  })}`;
}

async function executeUpdatePlan(
  state: ReturnType<typeof v2ExecutingPlanState>,
  args: Record<string, unknown>,
) {
  state.tools.calls.update = {
    toolCallId: 'update',
    modelMessageId: 'model-update',
    name: 'update_plan',
    args,
    status: 'queued',
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = [...state.tools.queue, 'update'];
  return executeTestRuntimeToolsV1({ state, toolCallIds: ['update'] });
}

describe('executeTestRuntimeToolsV1', () => {
  for (const status of ['approved', 'queued'] as const) {
    test(`rejects a ${status} private continuation before a new parent Task attempt`, async () => {
      const state = privateSuspensionFaultState(status);
      let runtimeFactories = 0;
      const events = await executeTestRuntimeToolsV1({
        state,
        toolCallIds: ['task'],
        taskConfig: {
          apiKey: 'unused',
          baseURL: 'https://example.invalid',
          providerName: 'fixture',
          providerType: 'openai-compatible',
          modelName: 'fixture',
          sandbox: { enabled: false },
        },
        taskModel: createMockModel([]),
        subagentContinuationArtifacts: {
          write: () => {
            throw new Error('unexpected write');
          },
          read: () => {
            throw new Error('continuation missing');
          },
        },
        subagentRuntimeFactory: () => {
          runtimeFactories += 1;
          throw new Error('must not construct Provider runtime');
        },
      });
      expect(runtimeFactories).toBe(0);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.rejected',
          toolCallId: 'task',
          reason: expect.stringContaining('continuation'),
        }),
      );
      expect(events.some((event) => event.type === 'capability.execution_unknown')).toBe(false);
      expect(events.some((event) => event.type === 'tool.finished')).toBe(false);
    });
  }

  test('rejects a spliced private continuation before approval replay or parent attempt', async () => {
    const state = privateSuspensionFaultState('queued');
    const suspended = state.suspendedSubagents.task;
    if (!suspended || !('storage' in suspended)) throw new Error('expected private suspension');
    suspended.parentInvocationId = 'spliced-other-thread';
    suspended.parentAttempt = 9;
    let reads = 0;
    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['task'],
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        modelName: 'fixture',
        sandbox: { enabled: false },
      },
      taskModel: createMockModel([]),
      subagentContinuationArtifacts: {
        write: () => {
          throw new Error('unexpected write');
        },
        read: () => {
          reads += 1;
          throw new Error('must reject before Artifact read');
        },
      },
    });
    expect(reads).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.rejected',
        toolCallId: 'task',
        reason: expect.stringContaining('exact live parent'),
      }),
    );
    expect(events.some((event) => event.type === 'capability.execution_unknown')).toBe(false);
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
  });

  test.each([
    'crash',
    'stale',
    'recovery',
  ] as const)('records post-ack Fake Provider %s as execution_unknown without a terminal receipt', async (mode) => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: `provider-unknown-${mode}`,
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.task = {
      toolCallId: 'task',
      modelMessageId: 'provider-parent-message',
      modelInvocationId: 'provider-parent-invocation',
      name: 'task',
      args: {
        subagent_type: 'review',
        task: 'Review the governed Provider recovery boundary and report exact evidence.',
      },
      status: 'queued',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'task'];
    let starts = 0;
    const provider: SubagentProviderV1 = {
      start: async ({ grant }) => {
        starts += 1;
        return {
          ok: true,
          value: {
            schema: SUBAGENT_PROVIDER_SCHEMA_V1,
            handleId: `fake-${mode}`,
            grantId: grant.grantId,
            purpose: grant.purpose,
            childInvocationId: grant.childInvocationId,
            parentInvocationId: grant.parentInvocationId,
            parentToolCallId: grant.parentToolCallId,
            parentAttempt: grant.parentAttempt,
            role: grant.role,
            taskArtifact: grant.taskArtifact,
            taskDigest: grant.taskDigest,
            continuationId: null,
            continuationDigest: null,
            blockedToolCallId: null,
            blockedRuntimeToolCallId: null,
            resumeAttempt: null,
            ownerProcessId: process.pid,
            ownerProcessStartIdentity: 'fixture-process-start',
            providerInstanceId: 'fixture-provider',
            lifecycle: 'running',
            integrityIdentifier: `sha256:${'a'.repeat(64)}`,
          },
        } as const;
      },
      resume: async () => ({
        ok: false,
        failure: { code: 'fake_denied', message: 'resume unavailable' },
      }),
      activate: async () => ({ ok: true, value: { activated: true } }),
      observe: async () => ({
        ok: false,
        failure: {
          code:
            mode === 'crash'
              ? ('fake_crashed' as const)
              : mode === 'stale'
                ? ('stale_handle' as const)
                : ('recovery_required' as const),
          message: mode,
        },
      }),
      cancel: async () => ({ ok: true, value: { cancelled: true } }),
      reconcile: async () => ({
        ok: false,
        failure: { code: 'recovery_required', message: mode },
      }),
    };
    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['task'],
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        providerName: 'fixture',
        modelName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
      },
      taskModel: createMockModel([]),
      subagentRuntimeFactory: () =>
        createPipelineSubagentRuntimeV1(() => ({
          grants: new SubagentGrantAuthorityV1({ idSource: () => `grant-${mode}` }),
          driver: new BuiltinChildRuntimeDriverV1(),
          provider,
          taskArtifacts: TASK_ARTIFACTS,
          lifecycleArtifacts: LIFECYCLE_ARTIFACTS,
        })),
    });
    const recorded = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'capability.invocation_recorded' }> =>
        event.type === 'capability.invocation_recorded' && event.toolCallId === 'task',
    );
    expect(starts).toBe(1);
    expect(recorded).toBeDefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'capability.execution_unknown',
        invocationId: recorded?.invocationId,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool.failed', toolCallId: 'task' }),
    );
    expect(
      events.some(
        (event) =>
          (event.type === 'capability.execution_failed' ||
            event.type === 'capability.execution_succeeded') &&
          event.invocationId === recorded?.invocationId,
      ),
    ).toBe(false);
    expect(
      events.some((event) => event.type === 'tool.finished' && event.toolCallId === 'task'),
    ).toBe(false);
  });

  test('Pipeline to LocalProvider preserves planning task projection', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'planning-provider-parity',
      userId: 'user',
      workspace: process.cwd(),
    });
    setTestPlanning(state, { kind: 'planning_empty' });
    state.tools.calls.task = {
      toolCallId: 'task',
      modelMessageId: 'planning-model',
      name: 'task',
      args: {
        subagent_type: 'plan',
        task: 'Design a bounded Runtime architecture plan with repository evidence.',
      },
      status: 'queued',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'task'];
    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['task'],
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        providerName: 'fixture',
        modelName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
      },
      taskModel: createMockModel([
        { message: aiMessage({ content: 'bounded architecture plan' }) },
      ]),
    });
    const finished = events.find(
      (event) => event.type === 'tool.finished' && event.toolCallId === 'task',
    );
    expect(finished?.type).toBe('tool.finished');
    if (finished?.type === 'tool.finished') {
      expect(JSON.parse(finished.result.stdout).nextActions).toEqual([
        'write_plan:save',
        'write_plan:submit',
      ]);
    }
  });

  test('Pipeline to LocalProvider permits every path inside the trusted workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-provider-protected-path-'));
    const directory = join(workspace, '.agents', 'skills', 'fixture');
    const protectedFile = join(directory, 'SKILL.md');
    mkdirSync(directory, { recursive: true });
    writeFileSync(protectedFile, 'keep\n');
    try {
      const state = createRuntimeHostStateInitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'provider-protected-path',
        userId: 'user',
        workspace,
      });
      state.tools.calls.task = {
        toolCallId: 'task',
        modelMessageId: 'protected-model',
        name: 'task',
        args: { subagent_type: 'code', task: 'write protected skill config' },
        status: 'queued',
        sideEffect: false,
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, 'task'];
      const events = await executeTestRuntimeToolsV1({
        state,
        toolCallIds: ['task'],
        taskConfig: {
          apiKey: 'unused',
          baseURL: 'https://example.invalid',
          providerName: 'fixture',
          modelName: 'fixture',
          providerType: 'openai-compatible',
          sandbox: { enabled: false },
          executionBoundary: {
            filesystemScope: 'workspace_write',
            workspaceRoot: workspace,
            networkMode: 'off',
            networkAllowlist: [],
            allowLocalAndPrivateNetwork: false,
            protectedPathPolicy: 'deny',
            maxProcessTreeSizePerShellInvocation: 8,
            sandboxRequired: false,
            sandboxUnavailable: 'fail',
          },
        },
        taskModel: createMockModel([
          {
            message: aiMessage({
              content: 'write protected skill',
              tool_calls: [
                {
                  id: 'protected-write',
                  name: 'write_file',
                  args: { path: '.agents/skills/fixture/SKILL.md', content: 'changed\n' },
                },
              ],
            }),
          },
          { message: aiMessage({ content: 'write confirmed' }) },
        ]),
      });
      expect(readFileSync(protectedFile, 'utf8')).toBe('changed\n');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'subagent.tool_result',
          subagent: expect.objectContaining({
            ok: true,
          }),
        }),
      );
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool.rejected' }));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('dispatches a review child for the mixed-language multi-agent user request', async () => {
    const state = reduceRuntimeState(
      createRuntimeHostStateInitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'autonomous-review-delegation',
        userId: 'user',
        workspace: process.cwd(),
      }),
      {
        type: 'user.message_appended',
        messageId: 'user-review',
        content: '调用多agent审核这些问题，确认策略无误。',
      },
    );
    state.tools.calls.review = {
      toolCallId: 'review',
      modelMessageId: 'model-review',
      name: 'task',
      args: {
        subagent_type: 'review',
        task: 'Review the reported policy issues and return concrete file evidence.',
      },
      status: 'queued',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'review'];
    const model = createMockModel([{ message: aiMessage({ content: 'Review complete.' }) }]);

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['review'],
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'fixture',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
      },
      taskModel: model,
    });

    expect(model.callCount.count).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.started' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.completed' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.finished',
        toolCallId: 'review',
        result: expect.objectContaining({ ok: true }),
      }),
    );
  });

  test('routes child read then edit through namespaced Runtime calls and durable receipts', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-child-runtime-filesystem-'));
    writeFileSync(join(workspace, 'child.txt'), 'child evidence\n', 'utf8');
    try {
      const state = createRuntimeHostStateInitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'child-runtime-filesystem',
        userId: 'user',
        workspace,
      });
      state.tools.calls.task = {
        toolCallId: 'task',
        modelMessageId: 'parent-model',
        name: 'task',
        args: {
          subagent_type: 'code',
          task: 'Read child.txt, replace child with updated, then report.',
        },
        status: 'queued',
        sideEffect: true,
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, 'task'];
      const model = createMockModel([
        {
          message: aiMessage({
            content: 'Reading evidence.',
            tool_calls: [
              { id: 'model-child-read', name: 'read_file', args: { path: 'child.txt' } },
            ],
          }),
        },
        {
          message: aiMessage({
            content: 'Editing after the durable read.',
            tool_calls: [
              {
                id: 'model-child-edit',
                name: 'edit_file',
                args: {
                  path: 'child.txt',
                  old_string: 'child evidence',
                  new_string: 'updated evidence',
                },
              },
            ],
          }),
        },
        { message: aiMessage({ content: 'Read and edit complete.' }) },
      ]);

      const events = await executeTestRuntimeToolsV1({
        state,
        toolCallIds: ['task'],
        taskConfig: {
          apiKey: 'unused',
          baseURL: 'https://example.invalid',
          modelName: 'fixture',
          providerName: 'fixture',
          providerType: 'openai-compatible',
          sandbox: { enabled: false },
        },
        taskModel: model,
      });

      const childStarted = events.find(
        (event): event is Extract<RuntimeEvent, { type: 'subagent.started' }> =>
          event.type === 'subagent.started',
      );
      const childQueued = events.find(
        (event): event is Extract<RuntimeEvent, { type: 'tool.queued' }> =>
          event.type === 'tool.queued' && event.name === 'read_file',
      );
      expect(childQueued?.toolCallId.startsWith('subagent-tool:')).toBe(true);
      const invocationRecordedIndex = events.findIndex(
        (event) =>
          event.type === 'capability.invocation_recorded' &&
          event.toolCallId === childQueued?.toolCallId,
      );
      const attemptIndex = events.findIndex(
        (event, index) =>
          index > invocationRecordedIndex && event.type === 'capability.execution_started',
      );
      const childTerminalIndex = events.findIndex(
        (event) => event.type === 'tool.finished' && event.toolCallId === childQueued?.toolCallId,
      );
      expect(invocationRecordedIndex).toBeGreaterThan(events.indexOf(childQueued!));
      expect(attemptIndex).toBeGreaterThan(invocationRecordedIndex);
      expect(childTerminalIndex).toBeGreaterThan(attemptIndex);
      const filesystemReceipt = events.find(
        (event): event is Extract<RuntimeEvent, { type: 'capability.execution_succeeded' }> =>
          event.type === 'capability.execution_succeeded' && Boolean(event.filesystemObservation),
      );
      expect(filesystemReceipt).toBeDefined();
      expect(filesystemReceipt?.filesystemObservation?.actorIdentityDigest).toBe(
        digestCapabilityValueV1({
          schema: 'kite.workspace-filesystem-actor.v1',
          threadId: state.session.threadId,
          actorIdentity: childStarted?.subagent.id,
        }),
      );
      expect(
        events.some(
          (event) =>
            event.type === 'capability.filesystem_mutation_ready' &&
            event.invocationId !== filesystemReceipt?.invocationId,
        ),
      ).toBe(true);
      expect(readFileSync(join(workspace, 'child.txt'), 'utf8')).toBe('updated evidence\n');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.finished',
          toolCallId: 'task',
          result: expect.objectContaining({ ok: true }),
        }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('executes independent task calls concurrently', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'parallel-task-execution',
      userId: 'user',
      workspace: process.cwd(),
    });
    for (const [ordinal, toolCallId] of ['review-a', 'review-b'].entries()) {
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'parallel-task-model',
        ordinal,
        name: 'task',
        args: {
          subagent_type: 'review',
          task: `Review independent runtime concern ${ordinal + 1} and report evidence.`,
        },
        status: 'queued',
        effectClass: 'read_only',
        sideEffect: false,
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, toolCallId];
    }
    const model = createMockModel([
      { message: aiMessage({ content: 'First review complete.' }), delay: 25 },
      { message: aiMessage({ content: 'Second review complete.' }), delay: 25 },
    ]);
    const languageModel = model.model as typeof model.model & {
      doGenerate: (...args: unknown[]) => Promise<unknown>;
    };
    const generate = languageModel.doGenerate.bind(languageModel);
    let running = 0;
    let maximumRunning = 0;
    languageModel.doGenerate = async (...args: unknown[]) => {
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      try {
        return await generate(...args);
      } finally {
        running -= 1;
      }
    };

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['review-a', 'review-b'],
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'fixture',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
      },
      taskModel: model,
    });

    expect(maximumRunning).toBe(2);
    expect(events.filter((event) => event.type === 'subagent.completed')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'tool.finished')).toHaveLength(2);
  });

  test('serializes concurrent child approvals without dropping suspended siblings', () => {
    const approval = {
      type: 'approval.requested' as const,
      interactionId: 'approval-a',
      toolCallId: 'task-a',
      approval: {} as never,
    };
    const serialized = serializeConcurrentSubagentApprovalEvents([
      [{ type: 'subagent.suspended', toolCallId: 'task-a', snapshot: {} as never }, approval],
      [
        { type: 'subagent.suspended', toolCallId: 'task-b', snapshot: {} as never },
        { ...approval, interactionId: 'approval-b', toolCallId: 'task-b' },
      ],
    ]);

    expect(serialized.filter((event) => event.type === 'subagent.suspended')).toHaveLength(2);
    expect(serialized.filter((event) => event.type === 'approval.requested')).toHaveLength(1);
    expect(serialized).toContainEqual({
      type: 'subagent.approval_deferred',
      toolCallId: 'task-b',
    });
  });

  test('surfaces a deferred child approval without restarting the child model', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'deferred-child-approval',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'auto';
    state.tools.calls.task = {
      toolCallId: 'task',
      modelMessageId: 'parallel-task-model',
      name: 'task',
      args: { subagent_type: 'review', task: 'Read the external fixture and report evidence.' },
      status: 'queued',
      effectClass: 'read_only',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'task'];
    const continuation = {
      id: 'deferred-child',
      role: getRoleConfig('review'),
      task: 'Read the external fixture and report evidence.',
      messages: [],
      toolCallCount: 1,
      steps: [],
      toolRecovery: createToolRecoveryJournalV1(state.toolRecovery.identityKey),
    };
    const blocked = {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL' as const,
      toolCallId: 'child-read',
      toolName: 'read_file',
      args: { path: '/outside/fixture.txt' },
      command: '/outside/fixture.txt',
      message: 'blocked',
      continuation,
    };
    const approvalBinding = createKernelApprovalBindingForBlockedSubagentV1({
      state,
      parentToolCallId: 'task',
      blocked,
      availCtx: toolAvailabilityContext({
        workspace: state.session.workspace,
        threadId: state.session.threadId,
      }),
      toolPipelineComposition: createAppToolPipelineCompositionV1(testBuiltinToolCatalogV1()),
    });
    if (!approvalBinding) throw new Error('expected Kernel approval binding fixture');
    const continuationArtifacts = installTestPrivateSuspendedSubagentV1(
      state,
      'task',
      serializeSubagentContinuation(continuation, {
        ...blocked,
        approvalBinding,
      }),
    );
    const model = createMockModel([{ message: aiMessage({ content: 'must not run' }) }]);

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['task'],
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'fixture',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
      },
      taskModel: model,
      subagentContinuationArtifacts: continuationArtifacts,
    });

    expect(model.callCount.count).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'approval.requested', toolCallId: 'task' }),
    );
    expect(events.some((event) => event.type === 'auto_review.requested')).toBe(false);
    expect(events.some((event) => event.type === 'tool.started')).toBe(false);
  });

  test('marks the acknowledged outer attempt unknown when continuation publication fails', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'private-continuation-publish-fault',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.task = {
      toolCallId: 'task',
      modelMessageId: 'private-continuation-model',
      name: 'task',
      args: {
        subagent_type: 'review',
        task: 'Read the external private fixture and report exact evidence.',
      },
      status: 'queued',
      effectClass: 'read_only',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'task'];
    const model = createMockModel([
      {
        message: aiMessage({
          content: 'Inspecting the private fixture.',
          tool_calls: [
            {
              id: 'child-private-read',
              name: 'shell_execute',
              args: { command: 'rg fixture /outside/private.txt' },
            },
          ],
        }),
      },
    ]);
    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['task'],
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'fixture',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
      },
      taskModel: model,
      subagentContinuationArtifacts: {
        write: () => {
          throw new Error('continuation publication unavailable');
        },
        read: () => {
          throw new Error('unexpected read');
        },
      },
    });
    const recorded = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'capability.invocation_recorded' }> =>
        event.type === 'capability.invocation_recorded' && event.toolCallId === 'task',
    );
    expect(model.callCount.count).toBe(1);
    expect(recorded).toBeDefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'capability.execution_unknown',
        invocationId: recorded?.invocationId,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'task',
        failure: expect.objectContaining({ kind: 'unknown', retryable: false }),
      }),
    );
    expect(events.some((event) => event.type === 'subagent.suspended')).toBe(false);
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(events.some((event) => event.type === 'tool.finished')).toBe(false);
  });

  test('production executor queues simultaneous child approvals after concurrent dispatch', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'parallel-child-approvals',
      userId: 'user',
      workspace: process.cwd(),
    });
    for (const [ordinal, toolCallId] of ['task-a', 'task-b'].entries()) {
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'parallel-child-approval-model',
        ordinal,
        name: 'task',
        args: {
          subagent_type: 'review',
          task: `Read external fixture ${ordinal + 1} and report the independent evidence.`,
        },
        status: 'queued',
        effectClass: 'read_only',
        sideEffect: false,
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, toolCallId];
    }
    const model = createMockModel([
      {
        message: aiMessage({
          content: 'Inspecting the first fixture.',
          tool_calls: [
            {
              id: 'child-read-a',
              name: 'shell_execute',
              args: { command: 'rg fixture /outside/a.txt' },
            },
          ],
        }),
      },
      {
        message: aiMessage({
          content: 'Inspecting the second fixture.',
          tool_calls: [
            {
              id: 'child-read-b',
              name: 'shell_execute',
              args: { command: 'rg fixture /outside/b.txt' },
            },
          ],
        }),
      },
    ]);
    const config: AgentConfig = {
      apiKey: 'unused',
      baseURL: 'https://example.invalid',
      modelName: 'fixture',
      providerName: 'fixture',
      providerType: 'openai-compatible',
      sandbox: { enabled: false },
    };
    const terminal = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['task-a', 'task-b'],
      taskConfig: config,
      taskModel: model,
      subagentEventSink: () => {},
    });

    expect(model.callCount.count).toBe(2);
    const starts = terminal.filter((event) => event.type === 'subagent.started');
    expect(starts).toHaveLength(2);
    expect(starts.map((event) => event.subagent.concurrencyGroupId)).toEqual([
      'subagent-batch:task-a',
      'subagent-batch:task-a',
    ]);
    expect(terminal.filter((event) => event.type === 'subagent.suspended')).toHaveLength(2);
    expect(terminal.filter((event) => event.type === 'approval.requested')).toHaveLength(1);
    expect(terminal.filter((event) => event.type === 'subagent.approval_deferred')).toHaveLength(1);
  });

  test.each([
    'missing',
    'mismatched',
  ] as const)('fails closed when a child auto-review continuation is %s', async (snapshotState) => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: `child-auto-review-${snapshotState}`,
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.task = {
      toolCallId: 'task',
      modelMessageId: 'model',
      name: 'task',
      args: { subagent_type: 'code', task: 'Modify the fixture.' },
      status: 'awaiting_auto_review',
      createdAtTurnId: state.turn.turnId,
    };
    state.interactions = {
      kind: 'awaiting_auto_review',
      interactionId: 'review-child',
      toolCallId: 'task',
      toolName: 'shell_execute',
      reason: 'review child command',
      approval: {
        scope: 'once',
        cwd: state.session.workspace,
        threadId: state.session.threadId,
        tool: 'shell_execute',
        command: 'git add fixture.txt',
        risk: 'vcs_mutation',
        approvalHash: 'hash',
        summary: 'Stage fixture.',
        reason: 'Requires automatic review.',
        expectedEffects: ['Mutates version control state'],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
        subagentId: 'expected-child',
      },
    };
    let continuationArtifacts: ReturnType<typeof installTestPrivateSuspendedSubagentV1> | undefined;
    if (snapshotState === 'mismatched') {
      continuationArtifacts = installTestPrivateSuspendedSubagentV1(
        state,
        'task',
        serializeSubagentContinuation(
          {
            id: 'different-child',
            role: getRoleConfig('code'),
            task: 'Modify the fixture.',
            messages: [],
            toolCallCount: 1,
            steps: [],
            toolRecovery: createToolRecoveryJournalV1(state.toolRecovery.identityKey),
          },
          {
            reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
            toolCallId: 'child-shell',
            toolName: 'shell_execute',
            args: { command: 'git add fixture.txt' },
            command: 'git add fixture.txt',
          },
        ),
      );
    }
    const model = createMockModel([]);
    const executor = createTestRuntimeEffectExecutorV1({
      config: { providerName: 'fixture', modelName: 'fixture' } as AgentConfig,
      model,
      ...(continuationArtifacts ? { subagentContinuationArtifacts: continuationArtifacts } : {}),
    });

    const events = await executor(
      { type: 'run_auto_review', reviewId: 'review-child', toolCallId: 'task' },
      state,
    );

    expect(model.callCount.count).toBe(0);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'auto_review.completed',
        result: expect.objectContaining({
          ok: true,
          approved: false,
          reason: expect.stringContaining('continuation'),
        }),
      }),
    ]);
  });

  test.each([
    ['accept_edits', false, 'approval.requested'],
    ['auto', false, 'auto_review.requested'],
    ['auto', true, 'approval.requested'],
  ] as const)('routes a blocked child in %s mode with breaker=%s through %s', (mode, circuitBreakerTripped, expectedType) => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: `child-review-${mode}-${circuitBreakerTripped}`,
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = mode;
    state.autoReview.circuitBreakerTripped = circuitBreakerTripped;
    const availCtx = toolAvailabilityContext({
      workspace: state.session.workspace,
      threadId: state.session.threadId,
    });
    const blocked = {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW' as const,
      toolCallId: 'child-shell',
      toolName: 'shell_execute',
      command: 'git add fixture.txt',
      args: { command: 'git add fixture.txt' },
      message: 'blocked',
      continuation: {
        id: 'child',
        role: getRoleConfig('code'),
        task: 'Modify the fixture in a code subagent.',
        messages: [],
        toolCallCount: 1,
        steps: [],
        toolRecovery: createToolRecoveryJournalV1(state.toolRecovery.identityKey),
      },
    };
    const approvalBinding = createKernelApprovalBindingForBlockedSubagentV1({
      state,
      parentToolCallId: 'task-call',
      blocked,
      availCtx,
      toolPipelineComposition: createAppToolPipelineCompositionV1(testBuiltinToolCatalogV1()),
    });
    if (!approvalBinding) throw new Error('expected Kernel approval binding fixture');
    const event = blockedSubagentReviewEvent({
      state,
      parentToolCallId: 'task-call',
      blocked: {
        ...blocked,
        approvalBinding,
      },
      availCtx,
      toolPipelineComposition: createAppToolPipelineCompositionV1(testBuiltinToolCatalogV1()),
    });

    expect(event.type).toBe(expectedType);
    if (event.type === 'approval.requested') {
      expect(event.toolCallId).toBe('task-call');
      expect(event.approval.callId).toBe('child-shell');
      expect(event.approval.grantOptions).toContain('same_command');
    }
  });

  test('fails closed for missing or tampered child approval bindings before interaction', () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'child-binding-negative',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'accept_edits';
    const runtimeChildToolId = 'runtime-child-shell';
    state.tools.calls[runtimeChildToolId] = {
      toolCallId: runtimeChildToolId,
      modelInvocationId: 'child-model-invocation',
      modelMessageId: 'child-model-message',
      name: 'shell_execute',
      args: { command: 'git add fixture.txt' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    const availCtx = toolAvailabilityContext({
      workspace: state.session.workspace,
      threadId: state.session.threadId,
    });
    const blocked = {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL' as const,
      toolCallId: 'child-shell',
      runtimeToolCallId: runtimeChildToolId,
      toolName: 'shell_execute',
      command: 'git add fixture.txt',
      args: { command: 'git add fixture.txt' },
      message: 'blocked',
      continuation: {
        id: 'child',
        role: getRoleConfig('code'),
        task: 'Modify the fixture in a code subagent.',
        messages: [],
        toolCallCount: 1,
        steps: [],
        toolRecovery: createToolRecoveryJournalV1(state.toolRecovery.identityKey),
      },
    };
    const approvalBinding = createKernelApprovalBindingForBlockedSubagentV1({
      state,
      parentToolCallId: 'task-call',
      blocked,
      availCtx,
      toolPipelineComposition: createAppToolPipelineCompositionV1(testBuiltinToolCatalogV1()),
    });
    if (!approvalBinding) throw new Error('expected Kernel approval binding fixture');

    const variants = [
      ['missing', { ...blocked }],
      ['digest', { ...blocked, approvalBinding: { ...approvalBinding, digest: '0'.repeat(64) } }],
      [
        'child identity',
        { ...blocked, approvalBinding: { ...approvalBinding, childToolCallId: 'other-child' } },
      ],
      [
        'visible tool name',
        {
          ...blocked,
          approvalBinding: {
            ...approvalBinding,
            invocationFact: { ...approvalBinding.invocationFact, exposedToolName: 'write_file' },
          },
        },
      ],
      [
        'arguments digest',
        {
          ...blocked,
          approvalBinding: {
            ...approvalBinding,
            invocationFact: { ...approvalBinding.invocationFact, argumentsDigest: 'f'.repeat(64) },
          },
        },
      ],
      [
        'runtime child identity',
        {
          ...blocked,
          approvalBinding: { ...approvalBinding, runtimeToolCallId: 'runtime-other-child' },
        },
      ],
    ] as const;

    for (const [label, candidate] of variants) {
      expect(() =>
        blockedSubagentReviewEvent({
          state,
          parentToolCallId: 'task-call',
          blocked: candidate,
          availCtx,
          toolPipelineComposition: createAppToolPipelineCompositionV1(testBuiltinToolCatalogV1()),
        }),
      ).toThrow('exact Kernel approval binding digest');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test('reserves and reconciles the actual child tool when a suspended Sub-agent resumes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-subagent-resume-budget-'));
    try {
      const order: string[] = [];
      const journey = await createExactTaskResumeJourneyV1({
        role: 'code',
        task: 'Run the approved command and finish.',
        model: createMockModel([
          {
            message: aiMessage({
              content: 'I need to run the approved command.',
              tool_calls: [
                { id: 'child-shell', name: 'shell_execute', args: { command: 'fixture-command' } },
              ],
            }),
          },
          { message: aiMessage({ content: 'The command was approved.' }) },
        ]),
        workspace,
      });
      const model = createMockModel([{ message: aiMessage({ content: 'Done.' }) }]);
      const mockModel = model.model as typeof model.model & {
        doGenerate: (...args: unknown[]) => Promise<unknown>;
      };
      const generate = mockModel.doGenerate.bind(mockModel);
      mockModel.doGenerate = async (...args: unknown[]) => {
        order.push('model-dispatch');
        return generate(...args);
      };
      const config: AgentConfig = {
        ...EXACT_TASK_RESUME_TEST_CONFIG,
        features: { resourceBudgetV1: true, boundedCancellationV1: true },
      };
      const host = testRuntimeCapabilityExecutionPortV1();
      let builtinTaskHostInvokes = 0;
      let builtinTaskExecutorReceipts = 0;
      let resumeInvokes = 0;
      const subagentComposition = testSubagentCompositionV1();
      const pipelineRuntime = createPipelineSubagentRuntimeV1(() => subagentComposition);

      const events = await executeTestRuntimeToolsV1({
        state: journey.state,
        toolCallIds: ['task'],
        taskConfig: config,
        taskModel: model,
        subagentContinuationArtifacts: journey.continuationArtifacts,
        subagentTaskRequests: journey.taskRequests,
        persistRuntimeEvents: journey.persistRuntimeEvents,
        getRuntimeState: journey.getRuntimeState,
        capabilityExecution: {
          invoke: async (invocation) => {
            if (invocation.binding.capabilityId === 'builtin:task') {
              builtinTaskHostInvokes += 1;
            }
            const receipt = await host.invoke(invocation);
            if (
              invocation.binding.capabilityId === 'builtin:task' &&
              receipt.status === 'succeeded'
            ) {
              builtinTaskExecutorReceipts += 1;
            }
            return receipt;
          },
        },
        subagentRuntimeFactory: () =>
          Object.freeze({
            ...pipelineRuntime,
            resume: async (...args: Parameters<typeof pipelineRuntime.resume>) => {
              resumeInvokes += 1;
              return pipelineRuntime.resume(...args);
            },
          }),
        capabilityArtifactStore: new CapabilityArtifactStore({
          root: join(workspace, 'capability-artifacts'),
        }),
        subagentEventSink: () => {},
        shellExecutor: async ({ command }) => {
          order.push('tool-dispatch');
          return { ok: true, command, exitCode: 0, stdout: workspace, stderr: '' };
        },
        descendantResourceAdmission: {
          reserveTool: async () => {
            order.push('reserve-tool');
            return { reservationId: 'child-tool' };
          },
          reconcileTool: async ({ reservationId }) => {
            expect(reservationId).toBe('child-tool');
            order.push('reconcile-tool');
          },
          reserveModel: async () => {
            order.push('reserve-model');
            return { reservationId: 'child-model', maxOutputTokens: 64 };
          },
          reconcileModel: async ({ reservationId }) => {
            expect(reservationId).toBe('child-model');
            order.push('reconcile-model');
          },
          markUnknown: async () => {
            order.push('unknown');
          },
          markLocalProviderAdmissionDenied: async () => {
            order.push('released');
          },
        },
      });

      expect(order).toEqual(['reserve-tool', 'tool-dispatch', 'reconcile-tool', 'model-dispatch']);
      expect(builtinTaskHostInvokes).toBe(1);
      expect(builtinTaskExecutorReceipts).toBe(1);
      expect(resumeInvokes).toBe(1);
      expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.completed' }));
      const finalState = journey.getRuntimeState();
      const finalCall = finalState.tools.calls.task;
      const suspended = journey.state.suspendedSubagents.task;
      const parentInvocation = suspended
        ? finalState.capabilities.invocations[suspended.parentInvocationId]
        : undefined;
      const childRuntimeToolId = suspended?.blockedTool.runtimeToolCallId;
      const childCall = childRuntimeToolId ? finalState.tools.calls[childRuntimeToolId] : undefined;
      expect(suspended).toBeDefined();
      expect(parentInvocation?.toolCallId).toBe('task');
      expect(parentInvocation?.attemptsStarted).toBe((suspended?.parentAttempt ?? 0) + 1);
      expect(childCall?.modelInvocationId).toEqual(expect.any(String));
      expect(childCall?.modelInvocationId).not.toBe(parentInvocation?.invocationId);
      expect(finalCall?.status).toBe('succeeded');
      expect(finalCall?.result?.resultMeta).toEqual(
        expect.objectContaining({
          digestScope: 'raw',
          contentDigest: expect.any(String),
          modelContentDigest: expect.any(String),
          rawResultDigest: expect.any(String),
        }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('records an approved child tool post-ack settlement failure as unknown during resume', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-subagent-resume-tool-throws-'));
    try {
      const journey = await createExactTaskResumeJourneyV1({
        role: 'code',
        task: 'Run the approved command and finish.',
        model: createMockModel([
          {
            message: aiMessage({
              content: 'I need to run the approved command.',
              tool_calls: [
                {
                  id: 'child-shell',
                  name: 'shell_execute',
                  args: { command: 'fixture-command' },
                },
              ],
            }),
          },
          { message: aiMessage({ content: 'The command was approved.' }) },
        ]),
        workspace,
      });
      let dispatches = 0;
      const events = await executeTestRuntimeToolsV1({
        state: journey.state,
        toolCallIds: ['task'],
        taskConfig: EXACT_TASK_RESUME_TEST_CONFIG,
        taskModel: createMockModel([]),
        subagentContinuationArtifacts: journey.continuationArtifacts,
        subagentTaskRequests: journey.taskRequests,
        persistRuntimeEvents: journey.persistRuntimeEvents,
        getRuntimeState: journey.getRuntimeState,
        subagentEventSink: () => {},
        shellExecutor: async ({ command }) => {
          dispatches += 1;
          return { ok: true, command, exitCode: 0, stdout: '', stderr: '' };
        },
        descendantResourceAdmission: {
          reserveTool: async () => ({ reservationId: 'child-tool' }),
          reconcileTool: async () => {
            throw new Error('fixture reconciliation failed after dispatch');
          },
          reserveModel: async () => ({ reservationId: 'child-model', maxOutputTokens: 64 }),
          reconcileModel: async () => {},
          markUnknown: async () => {},
          markLocalProviderAdmissionDenied: async () => {},
        },
      });

      expect(dispatches).toBe(1);
      const childToolCallId = journey.state.suspendedSubagents.task?.blockedTool.runtimeToolCallId;
      expect(childToolCallId).toEqual(expect.any(String));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          toolCallId: childToolCallId,
          failure: expect.objectContaining({ kind: 'unknown', retryable: false }),
        }),
      );
      expect(
        events.some((event) => event.type === 'tool.failed' && event.toolCallId === 'task'),
      ).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('rejects a stale parent approval binding before child replay or parent Host dispatch', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-child-resume-stale-approval-'));
    try {
      const journey = await createExactTaskResumeJourneyV1({
        role: 'code',
        task: 'Run the approved command and finish.',
        model: createMockModel([
          {
            message: aiMessage({
              content: 'I need to run the approved command.',
              tool_calls: [
                {
                  id: 'child-shell',
                  name: 'shell_execute',
                  args: { command: 'fixture-command' },
                },
              ],
            }),
          },
        ]),
        workspace,
      });
      const call = journey.getRuntimeState().tools.calls.task;
      if (!call) throw new Error('Expected the approved parent Task call.');
      call.approvalHash = '0'.repeat(64);
      let hostInvokes = 0;
      let resumeInvokes = 0;
      let shellInvokes = 0;
      const host = testRuntimeCapabilityExecutionPortV1();
      const pipelineRuntime = createPipelineSubagentRuntimeV1(() => testSubagentCompositionV1());

      const events = await executeTestRuntimeToolsV1({
        state: journey.state,
        toolCallIds: ['task'],
        taskConfig: EXACT_TASK_RESUME_TEST_CONFIG,
        taskModel: createMockModel([]),
        subagentContinuationArtifacts: journey.continuationArtifacts,
        subagentTaskRequests: journey.taskRequests,
        persistRuntimeEvents: journey.persistRuntimeEvents,
        getRuntimeState: journey.getRuntimeState,
        capabilityExecution: {
          invoke: async (invocation) => {
            hostInvokes += 1;
            return host.invoke(invocation);
          },
        },
        subagentRuntimeFactory: () =>
          Object.freeze({
            ...pipelineRuntime,
            resume: async (...args: Parameters<typeof pipelineRuntime.resume>) => {
              resumeInvokes += 1;
              return pipelineRuntime.resume(...args);
            },
          }),
        capabilityArtifactStore: new CapabilityArtifactStore({
          root: join(workspace, 'capability-artifacts'),
        }),
        shellExecutor: async ({ command }) => {
          shellInvokes += 1;
          return { ok: true, command, exitCode: 0, stdout: '', stderr: '' };
        },
        subagentEventSink: () => {},
      });

      expect(hostInvokes).toBe(0);
      expect(resumeInvokes).toBe(0);
      expect(shellInvokes).toBe(0);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.rejected',
          toolCallId: 'task',
          reason: expect.stringContaining('approval binding'),
        }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('rejects a mismatched child continuation before approval replay or dispatch', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-child-resume-identity-mismatch-'));
    try {
      const state = createRuntimeHostStateInitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'child-resume-identity-mismatch',
        userId: 'user',
        workspace,
      });
      state.tools.calls.task = {
        toolCallId: 'task',
        modelMessageId: 'parent-model',
        name: 'task',
        args: { subagent_type: 'code', task: 'Run the approved child operation and finish.' },
        status: 'approved',
        approvalGrant: 'approve_once',
        createdAtTurnId: state.turn.turnId,
      };
      const runtimeChildToolId = childRuntimeToolId({
        parentToolCallId: 'task',
        subagentId: 'child',
        modelInvocationId: 'child-model-invocation',
        modelToolCallId: 'child-shell',
        toolName: 'shell_execute',
        args: { command: 'pwd' },
      });
      state.tools.calls[runtimeChildToolId] = {
        toolCallId: runtimeChildToolId,
        modelInvocationId: 'child-model-invocation',
        modelMessageId: 'child-model-invocation',
        name: 'shell_execute',
        args: { command: 'pwd' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, runtimeChildToolId];
      const continuationArtifacts = installTestPrivateSuspendedSubagentV1(
        state,
        'task',
        serializeSubagentContinuation(
          {
            id: 'child',
            role: getRoleConfig('code'),
            task: 'Run the approved child operation and finish.',
            messages: [],
            toolCallCount: 1,
            steps: [],
            toolRecovery: createToolRecoveryJournalV1(state.toolRecovery.identityKey),
          },
          {
            reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
            toolCallId: 'child-write',
            runtimeToolCallId: runtimeChildToolId,
            toolName: 'write_file',
            args: { path: 'must-not-exist.txt', content: 'unauthorized' },
            command: 'write_file must-not-exist.txt',
          },
        ),
      );
      const model = createMockModel([]);
      const host = testRuntimeCapabilityExecutionPortV1();
      let hostInvokes = 0;
      let resumeInvokes = 0;
      const subagentComposition = testSubagentCompositionV1();
      const pipelineRuntime = createPipelineSubagentRuntimeV1(() => subagentComposition);

      const events = await executeTestRuntimeToolsV1({
        state,
        toolCallIds: ['task'],
        taskConfig: {
          apiKey: 'unused',
          baseURL: 'https://example.invalid',
          modelName: 'fixture',
          providerName: 'fixture',
          providerType: 'openai-compatible',
          sandbox: { enabled: false },
        },
        taskModel: model,
        subagentContinuationArtifacts: continuationArtifacts,
        capabilityExecution: {
          invoke: async (invocation) => {
            hostInvokes += 1;
            return host.invoke(invocation);
          },
        },
        subagentRuntimeFactory: () =>
          Object.freeze({
            ...pipelineRuntime,
            resume: async (...args: Parameters<typeof pipelineRuntime.resume>) => {
              resumeInvokes += 1;
              return pipelineRuntime.resume(...args);
            },
          }),
        subagentEventSink: () => {},
      });

      expect(model.callCount.count).toBe(0);
      expect(hostInvokes).toBe(0);
      expect(resumeInvokes).toBe(0);
      expect(existsSync(join(workspace, 'must-not-exist.txt'))).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.rejected',
          toolCallId: 'task',
          reason: expect.stringContaining('identity'),
        }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('releases the exact child reservation without dispatch when attempt acknowledgement fails', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-child-attempt-ack-rejected-'));
    try {
      const state = createRuntimeHostStateInitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'child-attempt-ack-rejected',
        userId: 'user',
        workspace,
      });
      state.tools.calls.task = {
        toolCallId: 'task',
        modelMessageId: 'parent-model',
        name: 'task',
        args: { subagent_type: 'code', task: 'Write child.txt and then report the result.' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, 'task'];
      const model = createMockModel([
        {
          message: aiMessage({
            content: 'Writing.',
            tool_calls: [
              {
                id: 'child-write',
                name: 'write_file',
                args: { path: 'child.txt', content: 'must not be written' },
              },
            ],
          }),
        },
        { message: aiMessage({ content: 'The write was rejected.' }) },
      ]);
      let toolReservations = 0;
      let releasedReservations = 0;

      const events = await executeTestRuntimeToolsV1({
        state,
        toolCallIds: ['task'],
        taskConfig: {
          apiKey: 'unused',
          baseURL: 'https://example.invalid',
          modelName: 'fixture',
          providerName: 'fixture',
          providerType: 'openai-compatible',
          sandbox: { enabled: false },
        },
        taskModel: model,
        subagentEventSink: () => {},
        descendantResourceAdmission: {
          reserveModel: async () => ({ reservationId: 'model' }),
          reconcileModel: async () => {},
          reserveTool: async () => {
            toolReservations += 1;
            return { reservationId: 'child-pre-ack-reservation' };
          },
          reconcileTool: async () => {},
          markUnknown: async () => {},
          markLocalProviderAdmissionDenied: async (reservationId) => {
            expect(reservationId).toBe('child-pre-ack-reservation');
            releasedReservations += 1;
          },
        },
        persistRuntimeEvents: async (batch) =>
          !batch.some(
            (event) =>
              event.type === 'capability.invocation_recorded' &&
              event.toolCallId.startsWith('subagent-tool:'),
          ),
      });

      expect(existsSync(join(workspace, 'child.txt'))).toBe(false);
      expect(toolReservations).toBe(1);
      expect(releasedReservations).toBe(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          toolCallId: expect.stringMatching(/^subagent-tool:/),
          failure: expect.objectContaining({ kind: 'persistence_unavailable' }),
        }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('records unknown and does not retry when a child receipt artifact fails', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-child-receipt-failure-'));
    try {
      const state = createRuntimeHostStateInitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'child-receipt-failure',
        userId: 'user',
        workspace,
      });
      state.tools.calls.task = {
        toolCallId: 'task',
        modelMessageId: 'parent-model',
        name: 'task',
        args: { subagent_type: 'code', task: 'Write child.txt once and then report the result.' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, 'task'];
      const model = createMockModel([
        {
          message: aiMessage({
            content: 'Writing once.',
            tool_calls: [
              {
                id: 'child-write',
                name: 'write_file',
                args: { path: 'child.txt', content: 'written once' },
              },
            ],
          }),
        },
        { message: aiMessage({ content: 'Receipt was unavailable; stopping.' }) },
      ]);
      const childInvocations = new Set<string>();
      const artifacts = testCapabilityArtifactWriterV1();
      let rejectedArtifacts = 0;

      const events = await executeTestRuntimeToolsV1({
        state,
        toolCallIds: ['task'],
        taskConfig: {
          apiKey: 'unused',
          baseURL: 'https://example.invalid',
          modelName: 'fixture',
          providerName: 'fixture',
          providerType: 'openai-compatible',
          sandbox: { enabled: false },
        },
        taskModel: model,
        subagentEventSink: () => {},
        persistRuntimeEvents: async (batch) => {
          for (const event of batch) {
            if (
              event.type === 'capability.invocation_recorded' &&
              event.toolCallId.startsWith('subagent-tool:')
            ) {
              childInvocations.add(event.invocationId);
            }
          }
          return true;
        },
        capabilityArtifactStore: {
          write: (invocationId, result) => {
            if (childInvocations.has(invocationId)) {
              rejectedArtifacts += 1;
              throw new Error('fixture child artifact failure');
            }
            return artifacts.write(invocationId, result);
          },
        },
      });

      expect(readFileSync(join(workspace, 'child.txt'), 'utf8')).toBe('written once');
      expect(rejectedArtifacts).toBe(1);
      expect(
        events.filter(
          (event) =>
            event.type === 'capability.execution_unknown' &&
            childInvocations.has(event.invocationId),
        ),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === 'capability.filesystem_mutation_ready'),
      ).toHaveLength(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('Skill fork keeps its durable MCP binding across an acknowledged safe-read retry', async () => {
    const state = startCurrentTask(
      createRuntimeHostStateInitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'skill-fork-mcp-retry',
        userId: 'user',
        workspace: process.cwd(),
      }),
    );
    const mcpDescriptor = canonicalMcpDescriptor({
      capabilityId: 'mcp:fixture/read',
      kind: 'mcp_tool',
      displayName: 'read',
      description: 'Read fixture data.',
      provider: { type: 'mcp', id: 'fixture', provenance: 'remote' },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      declaredEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
      execution: { retry: 'safe_read' },
      availability: 'available',
      diagnostics: [],
    });
    const skillDescriptor = canonicalMcpDescriptor({
      capabilityId: 'skill:fixture-read',
      kind: 'skill',
      displayName: 'fixture-read',
      description: 'Read fixture data in a governed fork.',
      provider: {
        type: 'skill',
        id: 'fixture-read',
        provenance: 'project',
        version: '1.0.0',
      },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { outcome: { type: 'string' } },
        required: ['outcome'],
        additionalProperties: false,
      },
      declaredEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
      execution: { retry: 'never' },
      availability: 'available',
      diagnostics: [],
    });
    const skillCatalog: import('@kite/builtin-runtime').SkillCatalogSnapshot = {
      revision: 'skill-catalog-retry',
      capabilities: createCapabilitySnapshotV1([skillDescriptor]),
      entries: [
        {
          sourcePath: '/workspace/.kite-code/skills/fixture-read',
          source: 'project',
          origin: '.kite-code',
          diagnostics: [],
          descriptor: skillDescriptor,
          contract: {
            schemaVersion: 1,
            name: 'fixture-read',
            version: '1.0.0',
            description: 'Read fixture data in a governed fork.',
            instructions: 'Call the fixture read capability once.',
            invocation: { allowImplicit: true, allowManual: true },
            context: { mode: 'fork', agent: 'code' },
            inputSchema: skillDescriptor.inputSchema!,
            outputSchema: skillDescriptor.outputSchema!,
            capabilityCeiling: [mcpDescriptor.capabilityId],
            deniedCapabilities: [],
            effectiveCapabilityCeiling: [mcpDescriptor.capabilityId],
            effects: { filesystem: 'none', network: 'read', externalState: 'read' },
            effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
            minimumApproval: 'none',
            effectiveMinimumApproval: 'none',
            execution: { timeoutMs: 1_000, maxAttempts: 1 },
            verification: { mode: 'not_required' },
            recovery: { retry: 'never' },
            files: ['SKILL.md'],
            dependencyRevisions: { [mcpDescriptor.capabilityId]: mcpDescriptor.revision },
          },
        },
      ],
    };
    state.capabilities.disclosures[skillDescriptor.capabilityId] = {
      capabilityId: skillDescriptor.capabilityId,
      capabilityRevision: skillDescriptor.revision,
      issuedForTurnId: state.turn.turnId,
    };
    state.tools.calls.activate = {
      toolCallId: 'activate',
      modelMessageId: 'parent-model',
      name: 'activate_skill',
      args: { skill_id: skillDescriptor.capabilityId, input: {} },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'activate'];

    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(
        providerId: string,
        timeoutMs?: number,
        signal?: AbortSignal,
      ): Promise<void>;
    };
    runtimeManager.ensureProviderReady = async () => {};
    manager.getCapabilitySnapshot = () => createCapabilitySnapshotV1([mcpDescriptor]);
    manager.findCapability = (capabilityId) =>
      capabilityId === mcpDescriptor.capabilityId ? mcpDescriptor : undefined;
    manager.getCapabilityRoute = () => ({
      transport: 'stdio',
      serverIdentity: 'fixture',
      endpointRevision: 'stdio-fixture-v1',
      toolRevision: mcpDescriptor.revision,
    });
    let providerCalls = 0;
    manager.callCapability = async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        throw new McpProviderError({
          providerId: 'fixture',
          kind: 'provider_unavailable',
          message: 'transient fixture outage',
          recoveryAction: 'retry',
          retryable: true,
        });
      }
      return { content: [{ type: 'text', text: 'fixture data' }] };
    };
    const settlementOrder: string[] = [];
    let activationHostInvokes = 0;
    let runtimeFactories = 0;
    let childStarts = 0;
    const activationHost = testRuntimeCapabilityExecutionPortV1();
    const activationSubagentRuntime = createPipelineSubagentRuntimeV1(() =>
      testSubagentCompositionV1(),
    );
    const countedActivationSubagentRuntime = Object.freeze({
      ...activationSubagentRuntime,
      start: async (...args: Parameters<typeof activationSubagentRuntime.start>) => {
        childStarts += 1;
        return activationSubagentRuntime.start(...args);
      },
    });
    let reservation = 0;
    const activationConfig: AgentConfig = {
      apiKey: 'unused',
      baseURL: 'https://example.invalid',
      modelName: 'fixture',
      providerName: 'fixture',
      providerType: 'openai-compatible',
      sandbox: { enabled: false },
      features: {
        capabilityCatalogV1: true,
        mcpRuntimeBindingV1: true,
        mcpExecutionRecordV1: true,
        toolSearchV1: true,
        skillWorkflowV1: true,
        skillActivationV2: true,
      },
    };
    let preAckHostInvokes = 0;
    let preAckRuntimeFactories = 0;
    const approvalEvents = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['activate'],
      mcpManager: runtimeManager,
      skillCatalog,
      taskConfig: activationConfig,
      capabilityExecution: {
        invoke: async (invocation) => {
          preAckHostInvokes += 1;
          return activationHost.invoke(invocation);
        },
      },
      subagentRuntimeFactory: () => {
        preAckRuntimeFactories += 1;
        return activationSubagentRuntime;
      },
    });
    expect(preAckHostInvokes).toBe(0);
    expect(preAckRuntimeFactories).toBe(0);
    applyExactApprovalFixtureV1(state, 'activate', approvalEvents);
    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['activate'],
      mcpManager: runtimeManager,
      skillCatalog,
      taskConfig: activationConfig,
      taskModel: createMockModel([
        {
          message: aiMessage({
            content: 'Read the fixture.',
            tool_calls: [{ id: 'skill-mcp-read', name: 'mcp__fixture__read', args: {} }],
          }),
        },
        { message: aiMessage({ content: '{"outcome":"done"}' }) },
      ]),
      descendantResourceAdmission: {
        reserveModel: async () => ({ reservationId: 'model' }),
        reconcileModel: async () => {},
        reserveTool: async () => {
          reservation += 1;
          settlementOrder.push(`reserve-${reservation}`);
          return { reservationId: `tool-${reservation}` };
        },
        reconcileTool: async ({ reservationId }) => {
          settlementOrder.push(`reconcile-${reservationId}`);
        },
        markUnknown: async (reservationId) => {
          settlementOrder.push(`unknown-${reservationId}`);
        },
        markLocalProviderAdmissionDenied: async () => {},
      },
      capabilityExecution: {
        invoke: async (invocation) => {
          if (invocation.binding.capabilityId === 'builtin:activate_skill') {
            activationHostInvokes += 1;
          }
          return activationHost.invoke(invocation);
        },
      },
      subagentRuntimeFactory: () => {
        runtimeFactories += 1;
        return countedActivationSubagentRuntime;
      },
    });

    expect(providerCalls).toBe(2);
    expect(activationHostInvokes).toBe(1);
    expect(runtimeFactories).toBe(1);
    expect(childStarts).toBe(1);
    expect(settlementOrder).toEqual([
      'reserve-1',
      'unknown-tool-1',
      'reserve-2',
      'reconcile-tool-2',
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'capability.bindings_issued',
        bindings: [expect.objectContaining({ capabilityId: mcpDescriptor.capabilityId })],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'skill.frame_closed', status: 'closed' }),
    );

    const rejectedBindingEvents = await executeTestRuntimeToolsV1({
      state: structuredClone(state),
      toolCallIds: ['activate'],
      mcpManager: runtimeManager,
      skillCatalog,
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'fixture',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: {
          capabilityCatalogV1: true,
          mcpRuntimeBindingV1: true,
          mcpExecutionRecordV1: true,
          toolSearchV1: true,
          skillWorkflowV1: true,
          skillActivationV2: true,
        },
      },
      taskModel: createMockModel([
        {
          message: aiMessage({
            content: 'Must not dispatch.',
            tool_calls: [{ id: 'unacknowledged-skill-mcp', name: 'mcp__fixture__read', args: {} }],
          }),
        },
      ]),
      persistRuntimeEvents: async (batch) =>
        !batch.some((event) => event.type === 'capability.bindings_issued'),
    });

    expect(providerCalls).toBe(2);
    expect(rejectedBindingEvents).not.toContainEqual(
      expect.objectContaining({ type: 'subagent.started' }),
    );
    expect(rejectedBindingEvents).toContainEqual(
      expect.objectContaining({
        type: 'tool.rejected',
        toolCallId: 'activate',
        reason: expect.stringContaining('resolvable capability bindings'),
      }),
    );
  });

  test('ordinary inline activate_skill never creates a Subagent runtime', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0'.repeat(64),
      threadId: 'ordinary-inline-activate',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.activeTaskId = 'inline-task';
    const descriptor = canonicalMcpDescriptor({
      capabilityId: 'skill:inline-fixture',
      kind: 'skill',
      displayName: 'Inline Fixture Skill',
      description: 'Inline activation fixture.',
      provider: { type: 'skill', id: 'inline-fixture', provenance: 'project' },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object', properties: {}, additionalProperties: false },
      declaredEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
      effectiveEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
      execution: { retry: 'never' },
      availability: 'available',
      diagnostics: [],
    });
    const skillCatalog: import('@kite/builtin-runtime').SkillCatalogSnapshot = {
      revision: 'inline-skill-catalog',
      capabilities: createCapabilitySnapshotV1([descriptor]),
      entries: [
        {
          sourcePath: '/workspace/.kite-code/skills/inline-fixture',
          source: 'project',
          origin: '.kite-code',
          diagnostics: [],
          descriptor,
          contract: {
            schemaVersion: 1,
            name: 'inline-fixture',
            version: '1.0.0',
            description: 'Inline activation fixture.',
            instructions: 'Activate inline.',
            invocation: { allowImplicit: true, allowManual: true },
            context: { mode: 'inline', agent: 'code' },
            inputSchema: descriptor.inputSchema!,
            outputSchema: descriptor.outputSchema!,
            capabilityCeiling: [],
            deniedCapabilities: [],
            effectiveCapabilityCeiling: [],
            effects: descriptor.declaredEffects,
            effectiveEffects: descriptor.effectiveEffects,
            minimumApproval: 'none',
            effectiveMinimumApproval: 'none',
            execution: { timeoutMs: 1_000, maxAttempts: 1 },
            verification: { mode: 'not_required' },
            recovery: { retry: 'never' },
            files: [],
            dependencyRevisions: {},
          },
        },
      ],
    };
    state.capabilities.disclosures[descriptor.capabilityId] = {
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      issuedForTurnId: state.turn.turnId,
    };
    state.tools.calls.activate = {
      toolCallId: 'activate',
      modelMessageId: 'inline-model',
      ordinal: 0,
      name: 'activate_skill',
      args: { skill_id: descriptor.capabilityId, input: {} },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'activate'];
    const config: AgentConfig = {
      apiKey: 'unused',
      baseURL: 'https://example.invalid',
      modelName: 'fixture',
      providerName: 'fixture',
      providerType: 'openai-compatible',
      sandbox: { enabled: false },
      features: { skillWorkflowV1: true, skillActivationV2: true },
    };
    const host = testRuntimeCapabilityExecutionPortV1();
    let hostInvokes = 0;
    let runtimeFactories = 0;
    const execution = {
      invoke: async (invocation: Parameters<typeof host.invoke>[0]) => {
        hostInvokes += 1;
        return host.invoke(invocation);
      },
    };
    const persistenceFailureState = structuredClone(state);
    const persistenceFailureApprovalEvents = await executeTestRuntimeToolsV1({
      state: persistenceFailureState,
      toolCallIds: ['activate'],
      skillCatalog,
      taskConfig: config,
      capabilityExecution: execution,
      subagentRuntimeFactory: () => {
        throw new Error('Approval discovery must not create a Subagent runtime.');
      },
    });
    applyExactApprovalFixtureV1(
      persistenceFailureState,
      'activate',
      persistenceFailureApprovalEvents,
    );
    const persistenceThrowState = structuredClone(persistenceFailureState);
    let persistenceFailureHostInvokes = 0;
    let persistenceFailureRuntimeFactories = 0;
    const persistenceFailureEvents = await executeTestRuntimeToolsV1({
      state: persistenceFailureState,
      toolCallIds: ['activate'],
      skillCatalog,
      taskConfig: config,
      capabilityExecution: {
        invoke: async (invocation) => {
          persistenceFailureHostInvokes += 1;
          return host.invoke(invocation);
        },
      },
      persistRuntimeEvents: async (batch) =>
        !batch.some(
          (event) =>
            event.type === 'capability.invocation_recorded' && event.toolCallId === 'activate',
        ),
      subagentRuntimeFactory: () => {
        persistenceFailureRuntimeFactories += 1;
        throw new Error('Unacknowledged activation must not create a Subagent runtime.');
      },
    });
    expect(persistenceFailureHostInvokes).toBe(0);
    expect(persistenceFailureRuntimeFactories).toBe(0);
    expect(persistenceFailureEvents).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'activate',
        failure: expect.objectContaining({ kind: 'persistence_unavailable' }),
      }),
    );
    expect(persistenceFailureEvents).not.toContainEqual(
      expect.objectContaining({ type: 'skill.activation_started' }),
    );
    expect(persistenceFailureEvents).not.toContainEqual(
      expect.objectContaining({ type: 'subagent.started' }),
    );
    let persistenceThrowHostInvokes = 0;
    let persistenceThrowRuntimeFactories = 0;
    const persistenceThrowEvents = await executeTestRuntimeToolsV1({
      state: persistenceThrowState,
      toolCallIds: ['activate'],
      skillCatalog,
      taskConfig: config,
      capabilityExecution: {
        invoke: async (invocation) => {
          persistenceThrowHostInvokes += 1;
          return host.invoke(invocation);
        },
      },
      persistRuntimeEvents: async (batch) => {
        if (
          batch.some(
            (event) =>
              event.type === 'capability.invocation_recorded' && event.toolCallId === 'activate',
          )
        ) {
          throw new Error('Fixture persistence writer failed before activation acknowledgement.');
        }
        return true;
      },
      subagentRuntimeFactory: () => {
        persistenceThrowRuntimeFactories += 1;
        throw new Error('Thrown persistence failure must not create a Subagent runtime.');
      },
    });
    expect(persistenceThrowHostInvokes).toBe(0);
    expect(persistenceThrowRuntimeFactories).toBe(0);
    expect(persistenceThrowEvents).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'activate',
        failure: expect.objectContaining({ kind: 'persistence_unavailable' }),
      }),
    );
    expect(persistenceThrowEvents).not.toContainEqual(
      expect.objectContaining({ type: 'skill.activation_started' }),
    );
    expect(persistenceThrowEvents).not.toContainEqual(
      expect.objectContaining({ type: 'subagent.started' }),
    );
    const approvalEvents = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['activate'],
      skillCatalog,
      taskConfig: config,
      capabilityExecution: execution,
      subagentRuntimeFactory: () => {
        runtimeFactories += 1;
        throw new Error('Inline activation must not create a Subagent runtime.');
      },
    });
    expect(hostInvokes).toBe(0);
    expect(runtimeFactories).toBe(0);
    applyExactApprovalFixtureV1(state, 'activate', approvalEvents);
    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['activate'],
      skillCatalog,
      taskConfig: config,
      capabilityExecution: execution,
      subagentRuntimeFactory: () => {
        runtimeFactories += 1;
        throw new Error('Inline activation must not create a Subagent runtime.');
      },
    });
    expect(hostInvokes).toBe(1);
    expect(runtimeFactories).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'skill.activation_started' }));
    expect(events.filter((event) => event.type === 'skill.frame_closed')).toEqual([]);
    expect(events.filter((event) => event.type === 'tool.finished')).toHaveLength(1);
  });

  test('does not dispatch an approved child continuation after its live recovery identity changes', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'stale-subagent-resume-identity',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.task = {
      toolCallId: 'task',
      modelMessageId: 'model',
      name: 'task',
      args: { subagent_type: 'code', task: 'Run pwd.' },
      status: 'approved',
      approvalGrant: 'approve_once',
      createdAtTurnId: state.turn.turnId,
    };
    const continuationArtifacts = installTestPrivateSuspendedSubagentV1(
      state,
      'task',
      serializeSubagentContinuation(
        {
          id: 'child',
          role: getRoleConfig('code'),
          task: 'Run pwd.',
          messages: [],
          toolCallCount: 1,
          steps: [],
          toolRecovery: createToolRecoveryJournalV1(state.toolRecovery.identityKey),
        },
        {
          reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
          toolCallId: 'child-shell',
          toolName: 'shell_execute',
          args: { command: 'pwd' },
          command: 'pwd',
        },
      ),
    );
    const live = structuredClone(state);
    live.toolRecovery = createToolRecoveryJournalV1('b'.repeat(64));
    let dispatched = false;
    const host = testRuntimeCapabilityExecutionPortV1();
    let hostInvokes = 0;
    let resumeInvokes = 0;
    const subagentComposition = testSubagentCompositionV1();
    const pipelineRuntime = createPipelineSubagentRuntimeV1(() => subagentComposition);

    const events = await executeTestRuntimeToolsV1({
      state,
      getRuntimeState: () => live,
      toolCallIds: ['task'],
      taskConfig: {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'fixture',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
      },
      taskModel: createMockModel([]),
      subagentContinuationArtifacts: continuationArtifacts,
      capabilityExecution: {
        invoke: async (invocation) => {
          hostInvokes += 1;
          return host.invoke(invocation);
        },
      },
      subagentRuntimeFactory: () =>
        Object.freeze({
          ...pipelineRuntime,
          resume: async (...args: Parameters<typeof pipelineRuntime.resume>) => {
            resumeInvokes += 1;
            return pipelineRuntime.resume(...args);
          },
        }),
      shellExecutor: async ({ command }) => {
        dispatched = true;
        return { ok: true, command, exitCode: 0, stdout: '', stderr: '' };
      },
      subagentEventSink: () => {},
    });

    expect(dispatched).toBe(false);
    expect(hostInvokes).toBe(0);
    expect(resumeInvokes).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.rejected',
        reason: expect.stringContaining('no longer matches the live runtime'),
      }),
    );
  });

  test('keeps a read-only child shell ceiling after an approved continuation resumes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-read-only-subagent-resume-'));
    try {
      const journey = await createExactTaskResumeJourneyV1({
        role: 'code',
        task: 'Review the project without making changes.',
        model: createMockModel([
          {
            message: aiMessage({
              content: 'I need to run the project tests.',
              tool_calls: [
                {
                  id: 'child-shell',
                  name: 'shell_execute',
                  args: { command: 'fixture-command' },
                },
              ],
            }),
          },
        ]),
        workspace,
      });
      const state = journey.getRuntimeState();
      const suspended = state.suspendedSubagents.task;
      if (!suspended?.blockedTool.runtimeToolCallId) {
        throw new Error('Expected an exact review child suspension.');
      }
      const originalRuntimeToolCallId = suspended.blockedTool.runtimeToolCallId;
      const originalSnapshot = journey.continuationArtifacts.read(suspended.continuationArtifact, {
        parentInvocationId: suspended.parentInvocationId,
        parentAttempt: suspended.parentAttempt,
        parentToolCallId: 'task',
        childInvocationId: suspended.subagentId,
        continuationId: suspended.continuationId,
      });
      const restoredCode = deserializeSubagentContinuation(
        originalSnapshot,
        state.toolRecovery.identityKey,
      );
      const restored = { ...restoredCode, role: getRoleConfig('review') };
      const deniedCommand = 'bun run typecheck';
      const originalChild = state.tools.calls[originalRuntimeToolCallId];
      if (!originalChild?.modelInvocationId) {
        throw new Error('Expected the exact child model invocation identity.');
      }
      const deniedRuntimeToolCallId = childRuntimeToolId({
        parentToolCallId: 'task',
        subagentId: suspended.subagentId,
        modelInvocationId: originalChild.modelInvocationId,
        modelToolCallId: 'child-shell',
        toolName: 'shell_execute',
        args: { command: deniedCommand },
      });
      const { approvalBinding: _originalApprovalBinding, ...blockedWithoutApproval } =
        restored.blockedTool;
      const deniedBlocked = {
        ...blockedWithoutApproval,
        toolCallId: 'child-shell',
        runtimeToolCallId: deniedRuntimeToolCallId,
        toolName: 'shell_execute' as const,
        args: { command: deniedCommand },
        command: deniedCommand,
        message: 'blocked',
        continuation: restored,
      };
      const deniedChild = {
        ...originalChild,
        toolCallId: deniedRuntimeToolCallId,
        name: 'shell_execute' as const,
        args: { command: deniedCommand },
      };
      delete state.tools.calls[originalRuntimeToolCallId];
      state.tools.calls[deniedRuntimeToolCallId] = deniedChild;
      state.tools.queue = [
        ...state.tools.queue.filter((id) => id !== originalRuntimeToolCallId),
        deniedRuntimeToolCallId,
      ];
      const deniedApprovalBinding = createKernelApprovalBindingForBlockedSubagentV1({
        state,
        parentToolCallId: 'task',
        blocked: deniedBlocked,
        availCtx: toolAvailabilityContext({
          workspace: state.session.workspace,
          threadId: state.session.threadId,
        }),
        toolPipelineComposition: createAppToolPipelineCompositionV1(testBuiltinToolCatalogV1()),
      });
      if (!deniedApprovalBinding) {
        throw new Error('Expected an exact read-only ceiling approval binding.');
      }
      const exactDeniedBlocked = { ...deniedBlocked, approvalBinding: deniedApprovalBinding };
      const deniedSnapshot = serializeSubagentContinuation(restored, exactDeniedBlocked);
      const deniedArtifact = journey.continuationArtifacts.write({
        owner: {
          parentInvocationId: suspended.parentInvocationId,
          parentAttempt: suspended.parentAttempt,
          parentToolCallId: 'task',
          childInvocationId: suspended.subagentId,
          continuationId: subagentContinuationCursorIdV1(deniedSnapshot),
        },
        snapshot: deniedSnapshot,
      });
      state.suspendedSubagents.task = {
        ...suspended,
        role: 'review',
        continuationId: subagentContinuationCursorIdV1(deniedSnapshot),
        continuationArtifact: deniedArtifact,
        blockedTool: {
          ...suspended.blockedTool,
          toolCallId: deniedBlocked.toolCallId,
          runtimeToolCallId: deniedRuntimeToolCallId,
          toolName: deniedBlocked.toolName,
        },
      };
      const parentCall = state.tools.calls.task;
      if (!parentCall) throw new Error('Expected the exact approved parent Task call.');
      parentCall.approvalHash = deniedApprovalBinding.digest;

      const host = testRuntimeCapabilityExecutionPortV1();
      let hostInvokes = 0;
      let childHostInvokes = 0;
      let resumeInvokes = 0;
      const subagentComposition = testSubagentCompositionV1();
      const pipelineRuntime = createPipelineSubagentRuntimeV1(() => subagentComposition);
      let shellExecutions = 0;
      const events = await executeTestRuntimeToolsV1({
        state: journey.state,
        toolCallIds: ['task'],
        taskConfig: EXACT_TASK_RESUME_TEST_CONFIG,
        taskModel: createMockModel([
          { message: aiMessage({ content: 'The command was rejected by the read-only ceiling.' }) },
        ]),
        subagentContinuationArtifacts: journey.continuationArtifacts,
        subagentTaskRequests: journey.taskRequests,
        persistRuntimeEvents: journey.persistRuntimeEvents,
        getRuntimeState: journey.getRuntimeState,
        subagentEventSink: () => {},
        capabilityExecution: {
          invoke: async (invocation) => {
            hostInvokes += 1;
            if (invocation.binding.capabilityId === 'builtin:shell_execute') {
              childHostInvokes += 1;
            }
            return host.invoke(invocation);
          },
        },
        subagentRuntimeFactory: () =>
          Object.freeze({
            ...pipelineRuntime,
            resume: async (...args: Parameters<typeof pipelineRuntime.resume>) => {
              resumeInvokes += 1;
              return pipelineRuntime.resume(...args);
            },
          }),
        shellExecutor: async ({ command }) => {
          shellExecutions += 1;
          return { ok: true, command, exitCode: 0, stdout: 'unexpected', stderr: '' };
        },
      });

      expect(shellExecutions).toBe(0);
      expect(hostInvokes).toBe(1);
      expect(childHostInvokes).toBe(0);
      expect(resumeInvokes).toBe(1);
      const finalState = journey.getRuntimeState();
      const parentInvocation = finalState.capabilities.invocations[suspended.parentInvocationId];
      expect(parentInvocation?.attemptsStarted).toBe(suspended.parentAttempt + 1);
      expect(finalState.tools.calls[deniedRuntimeToolCallId]?.status).toBe('queued');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'subagent.tool_result',
          subagent: expect.objectContaining({
            ok: false,
            summary: expect.stringContaining('read-only command'),
          }),
        }),
      );
      expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.completed' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'subagent.failed' }));
      const journalEvent = events.find(
        (event) => event.type === 'subagent.recovery_journal_merged',
      );
      expect(journalEvent?.type).toBe('subagent.recovery_journal_merged');
      if (journalEvent?.type === 'subagent.recovery_journal_merged') {
        expect(Object.values(journalEvent.journal.failures)[0]?.outcome).toMatchObject({
          status: 'rejected',
          failure: { kind: 'policy_denied' },
          dispatchState: 'not_started',
          externalEffects: 'none',
        });
      }
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'tool.finished', toolCallId: 'task' }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('executes a normalized model tool name against the original remote MCP name', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-normalized-mcp-name',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization = { mode: 'full_access', commandGrants: {} };
    const remoteToolName = '搜索 docs / latest';
    const exposedName = exposedMcpToolName('docs.provider', remoteToolName);
    const descriptor = canonicalMcpDescriptor({
      capabilityId: `mcp:docs.provider/${remoteToolName}`,
      revision: 'revision-1',
      kind: 'mcp_tool' as const,
      displayName: remoteToolName,
      description: 'search fixture',
      provider: { type: 'mcp' as const, id: 'docs.provider', provenance: 'remote' as const },
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      declaredEffects: {
        filesystem: 'none' as const,
        network: 'read' as const,
        externalState: 'read' as const,
      },
      effectiveEffects: {
        filesystem: 'none' as const,
        network: 'read' as const,
        externalState: 'read' as const,
      },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' as const },
      availability: 'available' as const,
      diagnostics: [],
    });
    const binding = issueMcpBinding(state, descriptor, exposedName);
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: exposedName,
      args: { query: 'runtime' },
      status: 'queued',
      bindingId: binding.bindingId,
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'mcp'];
    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(
        providerId: string,
        timeoutMs?: number,
        signal?: AbortSignal,
      ): Promise<void>;
    };
    let calledWith: { server: string; tool: string } | undefined;
    let providerCalls = 0;
    runtimeManager.ensureProviderReady = async () => {};
    runtimeManager.getCapabilityRoute = () => ({
      transport: 'stdio',
      serverIdentity: descriptor.provider.id,
      endpointRevision: 'stdio-v1',
      toolRevision: descriptor.revision,
    });
    manager.findCapability = () => descriptor;
    manager.callCapability = async () => {
      providerCalls += 1;
      calledWith = { server: descriptor.provider.id, tool: descriptor.displayName };
      return { content: [{ type: 'text', text: 'ok' }] };
    };

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['mcp'],
      mcpManager: runtimeManager,
      sandboxAvailable: true,
      taskConfig: {
        apiKey: 'test',
        baseURL: 'http://localhost',
        modelName: 'mock',
        providerName: 'mock',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: { capabilityCatalogV1: true, mcpRuntimeBindingV1: true },
      },
    });

    expect(calledWith).toEqual({ server: 'docs.provider', tool: remoteToolName });
    expect(providerCalls).toBe(1);
    expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
  });

  test('sealed network boundary rejects every MCP provider path before readiness or search', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'sealed-mcp-network',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization = { mode: 'full_access', commandGrants: {} };
    const descriptor = canonicalMcpDescriptor({
      capabilityId: 'mcp:docs/search',
      revision: 'revision-1',
      kind: 'mcp_tool' as const,
      displayName: 'search',
      description: 'search fixture',
      provider: { type: 'mcp' as const, id: 'docs', provenance: 'remote' as const },
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      declaredEffects: {
        filesystem: 'none' as const,
        network: 'read' as const,
        externalState: 'read' as const,
      },
      effectiveEffects: {
        filesystem: 'none' as const,
        network: 'read' as const,
        externalState: 'read' as const,
      },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' as const },
      availability: 'available' as const,
      diagnostics: [],
    });
    const dynamicName = exposedMcpToolName('docs', 'search');
    const binding = issueMcpBinding(state, descriptor, dynamicName);
    state.tools.calls.resource = {
      toolCallId: 'resource',
      modelMessageId: 'model',
      name: 'read_mcp_resource',
      args: { server: 'docs', uri: 'docs://one' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls.dynamic = {
      toolCallId: 'dynamic',
      modelMessageId: 'model',
      name: dynamicName,
      args: { query: 'runtime' },
      status: 'queued',
      bindingId: binding.bindingId,
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls.search = {
      toolCallId: 'search',
      modelMessageId: 'model',
      name: 'tool_search',
      args: { query: 'docs search' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'resource', 'dynamic', 'search'];

    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(providerId: string, timeoutMs?: number): Promise<void>;
    };
    let providerCalls = 0;
    runtimeManager.ensureProviderReady = async () => {
      providerCalls += 1;
    };
    manager.findCapability = () => {
      providerCalls += 1;
      return descriptor;
    };
    manager.callCapability = async () => {
      providerCalls += 1;
      return { content: [] };
    };

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['resource', 'dynamic', 'search'],
      mcpManager: runtimeManager,
      taskConfig: {
        apiKey: 'test',
        baseURL: 'http://localhost',
        modelName: 'mock',
        providerName: 'mock',
        providerType: 'openai-compatible',
        sandbox: { enabled: true },
        features: {
          capabilityCatalogV1: true,
          mcpRuntimeBindingV1: true,
          toolSearchV1: true,
          networkBoundaryV1: true,
        },
        executionBoundary: {
          filesystemScope: 'workspace_write',
          workspaceRoot: process.cwd(),
          networkMode: 'allowlist',
          networkAllowlist: ['docs.example'],
          allowLocalAndPrivateNetwork: false,
          protectedPathPolicy: 'deny',
          maxProcessTreeSizePerShellInvocation: 8,
          sandboxRequired: true,
          sandboxUnavailable: 'fail',
        },
      },
    });

    expect(providerCalls).toBe(0);
    expect(events).toHaveLength(3);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.finished',
          toolCallId: 'resource',
          result: expect.objectContaining({ ok: false, status: 'error' }),
        }),
        expect.objectContaining({
          type: 'tool.finished',
          toolCallId: 'dynamic',
          result: expect.objectContaining({ ok: false, status: 'error' }),
        }),
        expect.objectContaining({ type: 'tool.rejected', toolCallId: 'search' }),
      ]),
    );
    expect(
      events.find((event) => 'toolCallId' in event && event.toolCallId === 'search'),
    ).toMatchObject({
      type: 'tool.rejected',
      failure: { kind: 'mandatory_policy_unavailable' },
    });
  });

  test('ask_user emits user_input.requested with the interrupt spec payload', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-ask-user-interrupt',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.ask = {
      toolCallId: 'ask',
      modelMessageId: 'model',
      name: 'ask_user',
      args: {
        questions: [
          {
            question: 'Continue with the migration?',
            options: [
              {
                label: 'Continue',
                description: 'Proceed with the migration now.',
                recommended: true,
              },
              {
                label: 'Pause',
                description: 'Keep the current state and stop here.',
                recommended: false,
              },
            ],
          },
        ],
      },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'ask'];

    const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['ask'] });

    const requested = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'user_input.requested' }> =>
        event.type === 'user_input.requested',
    );
    expect(requested).toBeDefined();
    // 载荷是 Schema 规范化的中断内容：question 从 questions[0] 派生，
    // options/allow_free_text 补齐默认值——模型原始 args 不直通事件。
    expect(requested?.request).toEqual({
      question: 'Continue with the migration?',
      options: [
        {
          id: 'q1-o1',
          label: 'Continue',
          description: 'Proceed with the migration now.',
        },
        {
          id: 'q1-o2',
          label: 'Pause',
          description: 'Keep the current state and stop here.',
        },
      ],
      allow_free_text: true,
      recommended: 'q1-o1',
      questions: [
        {
          id: 'q1',
          question: 'Continue with the migration?',
          options: [
            {
              id: 'q1-o1',
              label: 'Continue',
              description: 'Proceed with the migration now.',
            },
            {
              id: 'q1-o2',
              label: 'Pause',
              description: 'Keep the current state and stop here.',
            },
          ],
          recommended: 'q1-o1',
          allow_free_text: true,
        },
      ],
    });
  });

  test('full mode allows ask_user to open a user-input interaction', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-full-mode-ask-user',
      userId: 'user',
      workspace: process.cwd(),
      interactionMode: 'full',
    });
    state.tools.calls.ask = {
      toolCallId: 'ask',
      modelMessageId: 'model',
      name: 'ask_user',
      args: {
        questions: [
          {
            question: 'Choose a path?',
            options: [
              { label: 'A', description: 'Choose A.', recommended: true },
              { label: 'B', description: 'Choose B.', recommended: false },
            ],
          },
        ],
      },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'ask'];

    const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['ask'] });

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'user_input.requested', toolCallId: 'ask' }),
    );
    expect(events.some((event) => event.type === 'tool.rejected')).toBe(false);
  });

  test('controller routes the ask_user payload through the Builtin-owned normalizer', () => {
    const source = readFileSync(
      new URL('../../apps/kite/src/bootstrap/runtime/tool-controller-adapter.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('normalizeAskUserRequestV1(');
    expect(source).not.toContain('askUserSpec');
  });

  test('fails closed when a provider reconnect changes the bound descriptor revision', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-provider-revision-drift',
      userId: 'user',
      workspace: process.cwd(),
    });
    const descriptor = canonicalMcpDescriptor({
      capabilityId: 'mcp:github/read',
      revision: 'revision-1',
      kind: 'mcp_tool' as const,
      displayName: 'read',
      description: 'read fixture',
      provider: { type: 'mcp' as const, id: 'github', provenance: 'remote' as const },
      inputSchema: { type: 'object', properties: {} },
      declaredEffects: {
        filesystem: 'none' as const,
        network: 'read' as const,
        externalState: 'read' as const,
      },
      effectiveEffects: {
        filesystem: 'none' as const,
        network: 'read' as const,
        externalState: 'read' as const,
      },
      policy: { workspaceTrustRequired: false, minimumApproval: 'none' as const },
      availability: 'available' as const,
      diagnostics: [],
    });
    const binding = issueMcpBinding(state, descriptor, 'mcp__github__read');
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: 'mcp__github__read',
      args: {},
      status: 'queued',
      bindingId: binding.bindingId,
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'mcp'];
    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(providerId: string, timeoutMs?: number): Promise<void>;
    };
    let reconnected = false;
    let called = false;
    manager.findCapability = () =>
      reconnected ? { ...descriptor, revision: 'revision-2' } : descriptor;
    runtimeManager.ensureProviderReady = async () => {
      reconnected = true;
    };
    manager.callCapability = async () => {
      called = true;
      return { content: [] };
    };

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['mcp'],
      mcpManager: runtimeManager,
      taskConfig: {
        apiKey: '',
        baseURL: 'http://localhost',
        modelName: 'test',
        providerName: 'test',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: { capabilityCatalogV1: true, mcpRuntimeBindingV1: true },
      },
    });

    expect(called).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.failed',
        failure: expect.objectContaining({
          kind: 'provider_capability_changed',
          retryable: false,
        }),
      }),
    );
  });

  test('classifies an unavailable bound MCP provider without string matching', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-provider-auth',
      userId: 'user',
      workspace: process.cwd(),
    });
    const unavailableDescriptor = canonicalMcpDescriptor({
      capabilityId: 'mcp:github/publish',
      kind: 'mcp_tool',
      displayName: 'publish',
      description: 'Publish a fixture release.',
      provider: { type: 'mcp', id: 'github', provenance: 'remote' },
      inputSchema: { type: 'object', properties: {} },
      declaredEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
      effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
      policy: { workspaceTrustRequired: false, minimumApproval: 'user' },
      availability: 'available',
      diagnostics: [],
    });
    const binding = issueMcpBinding(state, unavailableDescriptor, 'mcp__github__publish');
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: 'mcp__github__publish',
      args: {},
      status: 'queued',
      bindingId: binding.bindingId,
      capabilityId: binding.capabilityId,
      capabilityRevision: binding.capabilityRevision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'mcp'];
    const manager = new McpConnectionManager();
    let providerCalls = 0;
    manager.callCapability = async () => {
      providerCalls += 1;
      return { content: [] };
    };
    manager.getProviderDirectorySnapshot = () => ({
      revision: 'directory',
      entries: [
        {
          providerId: 'github',
          status: 'login_required',
          required: false,
          source: 'user',
          lastKnownCapabilityNames: ['publish'],
          diagnosticCode: 'auth_required',
          retryable: false,
        },
      ],
    });

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['mcp'],
      mcpManager: manager,
      taskConfig: {
        apiKey: '',
        baseURL: 'http://localhost',
        modelName: 'test',
        providerName: 'test',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: { capabilityCatalogV1: true, mcpRuntimeBindingV1: true },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.failed',
        failure: expect.objectContaining({
          kind: 'provider_auth_required',
          needsUserIntervention: true,
          retryable: false,
        }),
      }),
    ]);
    expect(providerCalls).toBe(0);

    const actionEvents = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['mcp'],
      mcpManager: manager,
      taskConfig: {
        apiKey: '',
        baseURL: 'http://localhost',
        modelName: 'test',
        providerName: 'test',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: {
          capabilityCatalogV1: true,
          mcpRuntimeBindingV1: true,
          mcpProviderActionV1: true,
        },
      },
    });
    expect(actionEvents.map((event) => event.type)).toEqual([
      'tool.failed',
      'provider.action_required',
    ]);
    expect(actionEvents[1]).toMatchObject({
      providerId: 'github',
      action: 'login',
      originatingToolCallId: 'mcp',
    });
    expect(JSON.stringify(actionEvents[1])).not.toContain('old-revision');
  });

  test('rejects an empty ask_user request instead of opening a blank prompt', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-empty-ask',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.ask = {
      toolCallId: 'ask',
      modelMessageId: 'model',
      name: 'ask_user',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'ask'];

    const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['ask'] });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'ask',
        failure: expect.objectContaining({ kind: 'tool_invalid_args' }),
      }),
    ]);
  });

  test('rejects the removed top-level ask_user shape', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-legacy-ask-shape',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.ask = {
      toolCallId: 'ask',
      modelMessageId: 'model',
      name: 'ask_user',
      args: {
        question: 'Continue?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'ask'];

    const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['ask'] });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'ask',
        failure: expect.objectContaining({
          kind: 'tool_invalid_args',
          message: expect.stringContaining('questions'),
        }),
      }),
    ]);
  });

  test('fails closed when a dynamic MCP call has no Runtime-issued binding', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-unbound-mcp',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: 'mcp__fixture__read',
      args: { id: '1' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'mcp'];
    const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['mcp'] });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.failed',
        failure: expect.objectContaining({ kind: 'tool_invalid_args' }),
      }),
    ]);
  });

  test('enforces an active Skill frame capability ceiling before executing a builtin', async () => {
    let state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-skill-ceiling',
      userId: 'user',
      workspace: process.cwd(),
    });
    state = {
      ...state,
      activeTaskId: 'task',
      tasks: {
        task: {
          taskId: 'task',
          userGoal: 'skill task',
          status: 'active',
          startedAtTurnId: state.turn.turnId,
          sideEffectsStarted: false,
          planning: { kind: 'building_without_plan' },
          planHistory: [],
        },
      },
      skills: {
        catalogRevision: 'skills-r1',
        frames: {
          activation: {
            activationId: 'activation',
            skillId: 'skill:read-only',
            skillRevision: 'skill-r1',
            taskId: 'task',
            input: {},
            contextMode: 'inline',
            agent: 'code',
            capabilityCeiling: ['builtin:read_file'],
            verificationMode: 'not_required',
            requestedBy: 'user',
            activatedAt: '2026-07-15T00:00:00.000Z',
            status: 'active',
          },
        },
      },
    };
    state.tools.calls.write = {
      toolCallId: 'write',
      modelMessageId: 'model',
      name: 'write_file',
      args: { path: 'blocked.txt', content: 'blocked' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'write'];

    const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['write'] });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.rejected',
        toolCallId: 'write',
        reason: expect.stringContaining('capability ceiling'),
      }),
    ]);
  });

  test('records a side-effecting MCP invocation before execution and persists only digests', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-recorded-mcp',
      userId: 'user',
      workspace: process.cwd(),
    });
    const descriptor = canonicalMcpDescriptor({
      capabilityId: 'mcp:fixture/write',
      revision: 'write-revision',
      kind: 'mcp_tool' as const,
      displayName: 'write',
      description: 'write fixture',
      provider: { type: 'mcp' as const, id: 'fixture', provenance: 'remote' as const },
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      declaredEffects: {
        filesystem: 'none' as const,
        network: 'write' as const,
        externalState: 'write' as const,
      },
      effectiveEffects: {
        filesystem: 'none' as const,
        network: 'write' as const,
        externalState: 'write' as const,
      },
      policy: { workspaceTrustRequired: false, minimumApproval: 'user' as const },
      execution: { retry: 'idempotency_key' as const, idempotencyKeyArgument: 'idempotency_key' },
      availability: 'available' as const,
      diagnostics: [],
    });
    const binding = issueMcpBinding(state, descriptor, 'mcp__fixture__write');
    state.tools.calls.mcp = {
      toolCallId: 'mcp',
      modelMessageId: 'model',
      name: 'mcp__fixture__write',
      args: { id: 'secret-argument' },
      status: 'queued',
      bindingId: binding.bindingId,
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.active = [...state.tools.active, 'mcp'];
    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(): Promise<void>;
    };
    runtimeManager.ensureProviderReady = async () => {};
    manager.findCapability = (capabilityId) =>
      capabilityId === descriptor.capabilityId ? descriptor : undefined;
    manager.getCapabilityRoute = () => ({
      transport: 'stdio',
      serverIdentity: descriptor.provider.id,
      endpointRevision: 'stdio-v1',
      toolRevision: descriptor.revision,
    });
    let providerDispatches = 0;
    manager.callCapability = async ({ arguments: args }) => {
      providerDispatches += 1;
      return {
        content: [
          { type: 'resource_link', uri: 'resource://fixture/secret-argument', name: 'fixture' },
        ],
        structuredContent: { ok: true },
        ...(typeof args.idempotency_key === 'string' ? {} : { isError: true }),
      } as never;
    };
    const config: AgentConfig = {
      apiKey: '',
      baseURL: 'http://localhost',
      modelName: 'test',
      providerName: 'test',
      providerType: 'openai-compatible',
      sandbox: { enabled: false },
      features: {
        capabilityCatalogV1: true,
        mcpRuntimeBindingV1: true,
        mcpExecutionRecordV1: true,
        verificationV1: true,
      },
    };

    const artifactStore = new CapabilityArtifactStore();
    artifactStore.write = () => ({
      artifactId: `pa_${'a'.repeat(64)}`,
      kind: 'capability_result',
      integrityIdentifier: `sha256:${'b'.repeat(64)}`,
      byteLength: 42,
    });
    const hostPort = testRuntimeCapabilityExecutionPortV1();
    let hostInvocations = 0;
    const capabilityExecution = {
      invoke: async (invocation: Parameters<typeof hostPort.invoke>[0]) => {
        hostInvocations += 1;
        return hostPort.invoke(invocation);
      },
    };
    applyExactApprovalFixtureV1(
      state,
      'mcp',
      await executeTestRuntimeToolsV1({
        state,
        toolCallIds: ['mcp'],
        mcpManager: runtimeManager,
        capabilityExecution,
        taskConfig: config,
      }),
    );
    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['mcp'],
      mcpManager: runtimeManager,
      capabilityExecution,
      taskConfig: config,
      capabilityArtifactStore: artifactStore,
    });

    const recorded = events.find((event) => event.type === 'capability.invocation_recorded');
    expect(recorded).toMatchObject({
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
    });
    expect(JSON.stringify(recorded)).not.toContain('secret-argument');
    expect(events.find((event) => event.type === 'capability.execution_succeeded')).toMatchObject({
      artifact: { kind: 'capability_result' },
    });
    const verification = events.find((event) => event.type === 'verification.requested');
    expect(verification).toMatchObject({ mode: 'required' });
    expect(JSON.stringify(verification)).not.toContain('secret-argument');
    expect(events.map((event) => event.type)).toEqual([
      'provider.readiness_intent_recorded',
      'provider.readiness_waiter_registered',
      'provider.readiness_attempt_started',
      'provider.readiness_succeeded',
      'tool.started',
      'capability.invocation_recorded',
      'capability.execution_started',
      'capability.execution_succeeded',
      'verification.requested',
      'tool.finished',
    ]);
    expect(hostInvocations).toBe(1);

    const flagOffEvents = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['mcp'],
      mcpManager: manager,
      taskConfig: {
        ...config,
        features: { ...config.features, verificationV1: false },
      },
      capabilityArtifactStore: artifactStore,
    });
    expect(flagOffEvents.some((event) => event.type === 'verification.requested')).toBe(false);

    const dispatchesBeforeReceiptFailure = providerDispatches;
    const receiptFailureEvents = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['mcp'],
      mcpManager: manager,
      taskConfig: config,
      capabilityArtifactStore: {
        write: () => {
          throw new Error('fixture artifact failure');
        },
      },
    });
    expect(providerDispatches).toBe(dispatchesBeforeReceiptFailure + 1);
    expect(receiptFailureEvents.some((event) => event.type === 'tool.finished')).toBe(false);
    expect(receiptFailureEvents.some((event) => event.type === 'verification.requested')).toBe(
      false,
    );
    expect(receiptFailureEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'capability.execution_unknown' }),
        expect.objectContaining({
          type: 'tool.failed',
          failure: expect.objectContaining({ kind: 'persistence_unavailable' }),
        }),
      ]),
    );
  });

  test('routes read_mcp_resource through readiness, one Host attempt, and the same MCP manager', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0'.repeat(64),
      threadId: 'ordinary-mcp-resource',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization = { mode: 'full_access', commandGrants: {} };
    state.tools.calls.resource = {
      toolCallId: 'resource',
      modelMessageId: 'model',
      name: 'read_mcp_resource',
      args: { server: 'docs', uri: 'docs://one' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'resource'];

    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(providerId: string, timeoutMs?: number): Promise<void>;
    };
    let status: 'connecting' | 'ready' = 'connecting';
    let readinessCalls = 0;
    let resourceCalls = 0;
    runtimeManager.ensureProviderReady = async (providerId) => {
      expect(providerId).toBe('docs');
      readinessCalls += 1;
      status = 'ready';
    };
    manager.getProviderDirectorySnapshot = () => ({
      revision: `directory-${status}`,
      entries: [
        {
          providerId: 'docs',
          status,
          required: false,
          source: 'user',
          lastKnownCapabilityNames: [],
          retryable: status !== 'ready',
        },
      ],
    });
    manager.getResourceDirectorySnapshot = () => ({
      revision: 'resources-v1',
      resources: [
        {
          providerId: 'docs',
          uri: 'docs://one',
          name: 'one',
          mimeType: 'text/plain',
        },
      ],
    });
    manager.readResource = async (server, uri) => {
      expect({ server, uri }).toEqual({ server: 'docs', uri: 'docs://one' });
      resourceCalls += 1;
      return 'resource body';
    };

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['resource'],
      mcpManager: runtimeManager,
      sandboxAvailable: true,
      taskConfig: {
        apiKey: 'test',
        baseURL: 'http://localhost',
        modelName: 'mock',
        providerName: 'mock',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: { capabilityCatalogV1: true, mcpRuntimeBindingV1: true },
      },
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'capability.execution_succeeded' }),
        expect.objectContaining({ type: 'tool.finished', toolCallId: 'resource' }),
      ]),
    );
    expect(events.some((event) => event.type === 'capability.execution_unknown')).toBe(false);
    expect(readinessCalls).toBe(1);
    expect(resourceCalls).toBe(1);
  });

  test('commits confirmed read_mcp_resource auth failure and provider action without MCP read', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0'.repeat(64),
      threadId: 'ordinary-mcp-resource-auth',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization = { mode: 'full_access', commandGrants: {} };
    state.tools.calls.resource = {
      toolCallId: 'resource',
      modelMessageId: 'model',
      name: 'read_mcp_resource',
      args: { server: 'docs', uri: 'docs://one' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'resource'];

    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(providerId: string, timeoutMs?: number): Promise<void>;
    };
    let readinessCalls = 0;
    let resourceCalls = 0;
    runtimeManager.ensureProviderReady = async () => {
      readinessCalls += 1;
      throw new McpProviderError({
        providerId: 'docs',
        kind: 'provider_auth_required',
        message: 'Login required.',
        recoveryAction: 'login',
      });
    };
    manager.getProviderDirectorySnapshot = () => ({
      revision: 'directory-login-required',
      entries: [
        {
          providerId: 'docs',
          status: 'login_required',
          required: false,
          source: 'user',
          lastKnownCapabilityNames: [],
          diagnosticCode: 'auth_required',
          retryable: false,
        },
      ],
    });
    manager.readResource = async () => {
      resourceCalls += 1;
      return 'must not be read';
    };

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['resource'],
      mcpManager: runtimeManager,
      sandboxAvailable: true,
      taskConfig: {
        apiKey: 'test',
        baseURL: 'http://localhost',
        modelName: 'mock',
        providerName: 'mock',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: {
          capabilityCatalogV1: true,
          mcpRuntimeBindingV1: true,
          mcpProviderActionV1: true,
        },
      },
    });

    expect(readinessCalls).toBe(1);
    expect(resourceCalls).toBe(0);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'capability.execution_failed' }),
        expect.objectContaining({
          type: 'tool.failed',
          toolCallId: 'resource',
          failure: expect.objectContaining({
            kind: 'provider_auth_required',
            needsUserIntervention: true,
          }),
        }),
        expect.objectContaining({
          type: 'provider.action_required',
          providerId: 'docs',
          action: 'login',
          originatingToolCallId: 'resource',
        }),
      ]),
    );
    expect(events.some((event) => event.type === 'capability.execution_unknown')).toBe(false);
  });

  test('records read_mcp_resource unknown when readiness intent persistence fails', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0'.repeat(64),
      threadId: 'ordinary-mcp-resource-unknown',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization = { mode: 'full_access', commandGrants: {} };
    state.tools.calls.resource = {
      toolCallId: 'resource',
      modelMessageId: 'model',
      name: 'read_mcp_resource',
      args: { server: 'docs', uri: 'docs://one' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'resource'];

    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(providerId: string, timeoutMs?: number): Promise<void>;
    };
    let readinessCalls = 0;
    let resourceCalls = 0;
    runtimeManager.ensureProviderReady = async () => {
      readinessCalls += 1;
    };
    manager.getProviderDirectorySnapshot = () => ({
      revision: 'directory-connecting',
      entries: [
        {
          providerId: 'docs',
          status: 'connecting',
          required: false,
          source: 'user',
          lastKnownCapabilityNames: [],
          retryable: true,
        },
      ],
    });
    manager.readResource = async () => {
      resourceCalls += 1;
      return 'must not be read';
    };

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['resource'],
      mcpManager: runtimeManager,
      sandboxAvailable: true,
      persistRuntimeEvent: async (event) => event.type !== 'provider.readiness_intent_recorded',
      taskConfig: {
        apiKey: 'test',
        baseURL: 'http://localhost',
        modelName: 'mock',
        providerName: 'mock',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
        features: { capabilityCatalogV1: true, mcpRuntimeBindingV1: true },
      },
    });

    expect(readinessCalls).toBe(0);
    expect(resourceCalls).toBe(0);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'capability.execution_unknown' }),
        expect.objectContaining({
          type: 'tool.failed',
          toolCallId: 'resource',
          failure: expect.objectContaining({ kind: 'unknown' }),
        }),
      ]),
    );
    expect(events.some((event) => event.type === 'capability.execution_succeeded')).toBe(false);
    expect(events.some((event) => event.type === 'capability.execution_failed')).toBe(false);
  });

  test('derives the internal summary question from the first canonical item', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-batch-ask',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.ask = {
      toolCallId: 'ask',
      modelMessageId: 'model',
      name: 'ask_user',
      args: {
        questions: [
          {
            question: 'What scope should be covered?',
            options: [
              {
                label: 'Focused',
                description: 'Cover only the critical path.',
                recommended: true,
              },
              {
                label: 'Complete',
                description: 'Cover the full production rollout.',
                recommended: false,
              },
            ],
          },
        ],
      },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'ask'];

    const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['ask'] });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'user_input.requested',
        request: expect.objectContaining({ question: 'What scope should be covered?' }),
      }),
    ]);
  });

  test('converts delegated lifecycle facts to the public RuntimeEvent protocol', () => {
    expect(
      toRuntimeSubagentEvent({
        type: 'start',
        data: { id: 'sub-1', role: 'explore', task: 'find callers' },
      }),
    ).toEqual({
      type: 'subagent.started',
      subagent: { id: 'sub-1', role: 'explore', task: 'find callers' },
    });
  });

  test('emits a rejection without executing a policy-denied tool', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-tool-policy',
      userId: 'user',
      workspace: process.cwd(),
    });
    setTestPlanning(state, { kind: 'planning_empty' });
    state.tools.calls.denied = {
      toolCallId: 'denied',
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command: 'bun run typecheck' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'denied'];
    let executed = false;

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['denied'],
      shellExecutor: async () => {
        executed = true;
        return { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(executed).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.rejected',
        toolCallId: 'denied',
        reason: 'Deferred shell_execute until building phase.',
        failure: expect.objectContaining({ kind: 'phase_deferred' }),
      }),
    ]);
  });

  test('keeps planning write calls as hard policy denials', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-write-policy',
      userId: 'user',
      workspace: process.cwd(),
    });
    setTestPlanning(state, { kind: 'planning_empty' });
    state.tools.calls.denied = {
      toolCallId: 'denied',
      modelMessageId: 'model',
      name: 'write_file',
      args: { path: 'blocked.txt', content: 'blocked' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'denied'];

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['denied'],
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.rejected',
        toolCallId: 'denied',
        reason:
          'Plan mode is read-only. No file was written. Describe the intended change in the plan and apply it after plan approval.',
        failure: expect.objectContaining({ kind: 'phase_denied' }),
      }),
    ]);
  });

  test('finishes write_plan once and returns the persisted plan identity', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-plan-artifact-'));
    const previousKiteCodeHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = workspace;
    try {
      let state = startCurrentTask(
        createRuntimeHostStateInitialStateV1({
          recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
          threadId: 'runtime-plan-write',
          userId: 'user',
          workspace,
        }),
        'plan-write-task',
      );
      state = reduceRuntimeState(state, {
        type: 'planning.entered',
        taskId: 'plan-write-task',
        source: 'user_command',
      });
      state.tools.calls.write = {
        toolCallId: 'write',
        modelMessageId: 'model',
        name: 'write_plan',
        args: {
          title: 'Inspect runtime',
          body_markdown: 'Inspect the runtime lifecycle and verify every transition.',
          steps: [{ id: 'inspect-runtime', title: 'Inspect runtime lifecycle' }],
        },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, 'write'];

      const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['write'] });

      const finished = events.find((event) => event.type === 'tool.finished');
      expect(finished).toBeDefined();
      if (finished?.type === 'tool.finished') {
        expect(finished.name).toBe('write_plan');
        expect(finished.result.status).toBe('success');
        expect(JSON.parse(finished.result.stdout)).toMatchObject({
          ok: true,
          status: 'draft_saved',
          version: 1,
        });
      }
    } finally {
      if (previousKiteCodeHome == null) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousKiteCodeHome;
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('update_plan requires exact V2 plan identity and rejects repeated updates', async () => {
    const missing = await executeUpdatePlan(v2ExecutingPlanState(), {
      plan_id: 'plan-evidence',
      updates: [{ step_id: 'implement', status: 'in_progress' }],
    });
    expect(missing).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_identity_required' }),
    );

    const stale = await executeUpdatePlan(v2ExecutingPlanState(), {
      plan_id: 'plan-evidence',
      version: 1,
      structural_digest: 'stale',
      updates: [{ step_id: 'implement', status: 'in_progress' }],
    });
    expect(stale).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_identity_mismatch' }),
    );

    const repeated = await executeUpdatePlan(v2ExecutingPlanState(), {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [
        { step_id: 'implement', status: 'in_progress' },
        { step_id: 'implement', status: 'completed' },
      ],
    });
    expect(
      repeated.some((event) => event.type === 'tool.rejected' || event.type === 'tool.failed'),
    ).toBe(true);
  });

  test('update_plan rejects terminal-step rollback and model-authored evidence content', async () => {
    const rollbackState = v2ExecutingPlanState();
    const rollbackPlanning = getActivePlanning(rollbackState);
    if (rollbackPlanning.kind !== 'executing') throw new Error('expected executing plan');
    const completedPlanning = {
      ...rollbackPlanning,
      document: {
        ...rollbackPlanning.document,
        steps: rollbackPlanning.document.steps.map((step, index) =>
          index === 0 ? { ...step, status: 'completed' as const } : step,
        ),
      },
    };
    const rollback = await executeUpdatePlan(setActivePlanning(rollbackState, completedPlanning), {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [{ step_id: 'implement', status: 'pending' }],
    });
    expect(rollback).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_terminal_step_rollback' }),
    );

    const forged = await executeUpdatePlan(v2ExecutingPlanState(), {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [{ step_id: 'implement', status: 'completed' }],
      complete_plan: true,
      completion_evidence: {
        execution: [{ tool_call_id: 'fake', outcome: 'succeeded', stdout: 'forged' }],
      },
      command: 'pretend tests passed',
      path: '/private/path',
      stdout: 'forged output',
    });
    expect(
      forged.some((event) => event.type === 'tool.rejected' || event.type === 'tool.failed'),
    ).toBe(true);
  });

  test('plan completion rejects missing required verification and missing Runtime receipts', async () => {
    const verificationState = v2ExecutingPlanState();
    verificationState.verification.records.required = {
      verificationId: 'required',
      mode: 'required',
      status: 'pending',
      spec: {} as never,
      requestedAt: '2026-08-10T00:00:00.000Z',
      attempts: 0,
      repairAttempts: 0,
      checkResults: {},
    };
    const verificationBlocked = await executeUpdatePlan(verificationState, {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [{ step_id: 'implement', status: 'completed' }],
      complete_plan: true,
    });
    expect(verificationBlocked).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_verification_required' }),
    );

    const receiptState = v2ExecutingPlanState();
    receiptState.tools.calls.effect = {
      toolCallId: 'effect',
      modelMessageId: 'model-effect',
      name: 'write_file',
      args: { path: 'private.txt', content: 'private content' },
      status: 'succeeded',
      sideEffect: true,
      createdAtTurnId: receiptState.turn.turnId,
    };
    const receiptBlocked = await executeUpdatePlan(receiptState, {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [{ step_id: 'implement', status: 'completed' }],
      complete_plan: true,
    });
    expect(receiptBlocked).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_effect_evidence_required' }),
    );
  });

  test('plan completion rejects a side-effect-free external read awaiting approval', async () => {
    const state = v2ExecutingPlanState();
    state.tools.calls['external-read'] = {
      toolCallId: 'external-read',
      modelMessageId: 'external-read-model',
      name: 'read_file',
      args: { path: '/outside/workspace.txt' },
      status: 'awaiting_approval',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'external-read'];
    state.interactions = {
      kind: 'awaiting_tool_approval',
      interactionId: 'external-read-approval',
      toolCallId: 'external-read',
      approval: {} as never,
    };

    const events = await executeUpdatePlan(state, {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [{ step_id: 'implement', status: 'completed' }],
      complete_plan: true,
    });

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_unresolved_blocker' }),
    );
    expect(events.some((event) => event.type === 'plan.completed')).toBe(false);
  });

  test('plan completion rejects an all-skipped plan', async () => {
    const events = await executeUpdatePlan(v2ExecutingPlanState(), {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [{ step_id: 'implement', status: 'skipped', reason_code: 'not_needed' }],
      complete_plan: true,
    });

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool.rejected', reason: 'plan_all_steps_skipped' }),
    );
    expect(events.some((event) => event.type === 'plan.completed')).toBe(false);
  });

  test('projects only Runtime receipt and verification metadata into V2 completion evidence', async () => {
    const state = v2ExecutingPlanState();
    state.tools.calls.effect = {
      toolCallId: 'effect',
      modelMessageId: 'model-effect',
      name: 'write_file',
      args: { path: 'private.txt', content: 'private content' },
      status: 'succeeded',
      sideEffect: true,
      result: { ok: true, summary: 'private command and output' },
      createdAtTurnId: state.turn.turnId,
    };
    state.verification.records.required = {
      verificationId: 'required',
      mode: 'required',
      status: 'passed',
      spec: {} as never,
      requestedAt: '2026-08-10T00:00:00.000Z',
      attempts: 1,
      repairAttempts: 0,
      checkResults: {},
      completedAt: '2026-08-10T00:01:00.000Z',
    };
    const events = await executeUpdatePlan(state, {
      plan_id: 'plan-evidence',
      version: 2,
      structural_digest: 'digest-evidence',
      updates: [{ step_id: 'implement', status: 'completed' }],
      complete_plan: true,
    });
    const completed = events.find((event) => event.type === 'plan.completed');

    expect(completed).toMatchObject({
      type: 'plan.completed',
      planId: 'plan-evidence',
      version: 2,
      structuralDigest: 'digest-evidence',
      completionEvidence: {
        schemaVersion: 1,
        verification: [{ verificationId: 'required', outcome: 'passed' }],
        execution: [{ toolCallId: 'effect', outcome: 'succeeded' }],
        skipped: [],
        unresolved: [],
      },
    });
    expect(JSON.stringify(completed)).not.toContain('private');
  });

  test('cancels later sibling calls when write_plan action=submit opens review', async () => {
    const artifactHome = mkdtempSync(join(tmpdir(), 'openpx-plan-barrier-'));
    const previousKiteCodeHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = artifactHome;
    try {
      let state = startCurrentTask(
        createRuntimeHostStateInitialStateV1({
          recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
          threadId: 'runtime-plan-barrier',
          userId: 'user',
          workspace: process.cwd(),
        }),
        'plan-barrier-task',
      );
      state = reduceRuntimeState(state, {
        type: 'planning.entered',
        taskId: 'plan-barrier-task',
        source: 'user_command',
      });
      state.tools.calls.save = {
        toolCallId: 'save',
        modelMessageId: 'message-0',
        ordinal: 0,
        name: 'write_plan',
        args: {
          title: 'Inspect',
          body_markdown: 'Inspect runtime state transitions in detail.',
          steps: [{ id: 'inspect', title: 'Inspect runtime' }],
          action: 'save',
        },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, 'save'];
      const saveEvents = await executeTestRuntimeToolsV1({ state, toolCallIds: ['save'] });
      for (const event of saveEvents) state = reduceCurrentEvent(state, event);
      const saved = getActivePlanning(state);
      if (saved.kind !== 'planning_draft') throw new Error('saved plan missing');
      state.tools.calls.submit = {
        toolCallId: 'submit',
        modelMessageId: 'message-1',
        ordinal: 0,
        name: 'write_plan',
        args: {
          plan_id: saved.document.planId,
          version: saved.document.version,
          structural_digest: saved.document.structuralDigest,
          action: 'submit',
        },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.calls.write = {
        toolCallId: 'write',
        modelMessageId: 'message-1',
        ordinal: 1,
        name: 'write_file',
        args: { path: 'unsafe.txt', content: 'unsafe' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, 'submit', 'write'];

      const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['submit'] });

      expect(events).toContainEqual({
        type: 'tool.cancelled',
        toolCallId: 'write',
        reason: 'Cancelled because an earlier tool call opened an interaction.',
      });
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'tool.finished', toolCallId: 'submit' }),
      );
      for (const event of events) state = reduceCurrentEvent(state, event);
      expect(state.tools.calls.submit?.status).toBe('awaiting_review');
      expect(state.interactions).toMatchObject({
        kind: 'awaiting_review',
        toolCallId: 'submit',
      });
    } finally {
      if (previousKiteCodeHome == null) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousKiteCodeHome;
      rmSync(artifactHome, { recursive: true, force: true });
    }
  });

  test('write_file in accept_edits mode bypasses approval and executes directly', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-accept-edits-write-'));
    try {
      const state = createRuntimeHostStateInitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'runtime-accept-edits',
        userId: 'user',
        workspace,
      });
      state.mode = 'accept_edits';
      setTestPlanning(state, {
        kind: 'executing',
        document: {
          planSchemaVersion: 2,
          planId: 'plan-approved',
          version: 1,
          title: 'Test',
          bodyMarkdown: 'Test plan.',
          steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
          structuralDigest: 'abc',
          createdAtTurnId: state.turn.turnId,
          updatedAtTurnId: state.turn.turnId,
          completionEvidence: {
            schemaVersion: 1,
            verification: [],
            execution: [],
            skipped: [],
            unresolved: [],
          },
        },
        executionMode: 'accept_edits',
        approvedAtTurnId: state.turn.turnId,
      });
      state.tools.calls.wf = {
        toolCallId: 'wf',
        modelMessageId: 'model',
        ordinal: 0,
        name: 'write_file',
        args: { path: 'test.txt', content: 'hello' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, 'wf'];

      const events = await executeTestRuntimeToolsV1({
        state,
        toolCallIds: ['wf'],
        shellExecutor: {
          execute: async (_command: string, _opts?: Record<string, unknown>) => {
            return {
              ok: true,
              command: 'write_file test.txt',
              exitCode: 0,
              stdout: '',
              stderr: '',
            };
          },
        } as never,
      });
      // Should NOT be rejected — accept_edits mode allows file edits without approval
      const rejected = events.find((e) => e.type === 'tool.rejected');
      expect(rejected).toBeUndefined();

      // Should complete successfully
      const finished = events.find((e) => e.type === 'tool.finished');
      expect(finished).toBeDefined();
      if (finished?.type === 'tool.finished') {
        expect(finished.result.ok).toBe(true);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('edit_file in accept_edits mode bypasses approval and executes directly', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-accept-edits-edit-'));
    try {
      writeFileSync(join(workspace, 'test.txt'), 'old');
      const state = createRuntimeHostStateInitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 'runtime-accept-edits-edit',
        userId: 'user',
        workspace,
      });
      state.mode = 'accept_edits';
      setTestPlanning(state, {
        kind: 'executing',
        document: {
          planSchemaVersion: 2,
          planId: 'plan-approved',
          version: 1,
          title: 'Test',
          bodyMarkdown: 'Test plan.',
          steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
          structuralDigest: 'abc',
          createdAtTurnId: state.turn.turnId,
          updatedAtTurnId: state.turn.turnId,
          completionEvidence: {
            schemaVersion: 1,
            verification: [],
            execution: [],
            skipped: [],
            unresolved: [],
          },
        },
        executionMode: 'accept_edits',
        approvedAtTurnId: state.turn.turnId,
      });
      // ADR-0042 §1：先读取目标文件，使后续 edit_file 通过先读后改校验。
      state.tools.calls.rf = {
        toolCallId: 'rf',
        modelMessageId: 'model',
        ordinal: 0,
        name: 'read_file',
        args: { path: 'test.txt' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, 'rf'];
      await executeTestRuntimeToolsV1({
        state,
        toolCallIds: ['rf'],
        shellExecutor: {
          execute: async (_command: string, _opts?: Record<string, unknown>) => {
            return { ok: true, command: 'read_file test.txt', exitCode: 0, stdout: '', stderr: '' };
          },
        } as never,
      });

      state.tools.calls.ef = {
        toolCallId: 'ef',
        modelMessageId: 'model',
        ordinal: 0,
        name: 'edit_file',
        args: { path: 'test.txt', old_string: 'old', new_string: 'new' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, 'ef'];

      const events = await executeTestRuntimeToolsV1({
        state,
        toolCallIds: ['ef'],
        shellExecutor: {
          execute: async (_command: string, _opts?: Record<string, unknown>) => {
            return { ok: true, command: 'edit_file test.txt', exitCode: 0, stdout: '', stderr: '' };
          },
        } as never,
      });

      // edit_file should NOT be rejected by defense-in-depth — accept_edits mode bypasses approval
      const rejected = events.find((e) => e.type === 'tool.rejected');
      expect(rejected).toBeUndefined();

      // Tool should have been started (not blocked at defense-in-depth)
      const started = events.find((e) => e.type === 'tool.started');
      expect(started).toBeDefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('shell_execute in accept_edits mode still requires approval', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-accept-edits-shell',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'accept_edits';
    setTestPlanning(state, {
      kind: 'executing',
      document: {
        planSchemaVersion: 2,
        planId: 'plan-approved',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'Test plan.',
        steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
        completionEvidence: {
          schemaVersion: 1,
          verification: [],
          execution: [],
          skipped: [],
          unresolved: [],
        },
      },
      executionMode: 'accept_edits',
      approvedAtTurnId: state.turn.turnId,
    });
    state.tools.calls.sh = {
      toolCallId: 'sh',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'npm test' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'sh'];

    const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['sh'] });

    // shell_execute is NOT a file edit — should create an approval interaction
    const approvalRequested = events.find((e) => e.type === 'approval.requested');
    expect(approvalRequested).toBeDefined();

    // Should NOT have executed directly
    const finished = events.find((e) => e.type === 'tool.finished');
    expect(finished).toBeUndefined();
  });

  test('full_access authorization skips approval for later shell calls', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-full-access-follow-up',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization.mode = 'full_access';
    state.tools.calls.followUp = {
      toolCallId: 'followUp',
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command: 'node -e "console.log(84)"' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'followUp'];

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['followUp'],
      sandboxAvailable: true,
      shellExecutor: {
        execute: async () => ({
          ok: true,
          command: 'node -e "console.log(84)"',
          exitCode: 0,
          stdout: '84\n',
          stderr: '',
        }),
      } as never,
    });

    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
  });

  test('starts an allowed shell without waiting for sibling preflight', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-parallel-shell-preflight',
      userId: 'user',
      workspace: process.cwd(),
    });
    for (const [ordinal, toolCallId] of ['first', 'second'].entries()) {
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'parallel-shell-model',
        ordinal,
        name: 'shell_execute',
        args: { command: ordinal === 0 ? 'pwd' : 'ls -la' },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, toolCallId];
    }
    let executionCount = 0;

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['first'],
      shellExecutor: async () => {
        executionCount += 1;
        return { ok: true, command: 'pwd', exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(executionCount).toBe(1);
    expect(events.some((event) => event.type === 'tool.started')).toBe(true);
    expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
  });

  test('does not preflight shell calls across a non-shell sibling', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-shell-interaction-barrier',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization.mode = 'full_access';
    const modelMessageId = 'mixed-tool-model';
    state.tools.queue = [...state.tools.queue, 'shell-before', 'question', 'shell-after'];
    state.tools.calls['shell-before'] = {
      toolCallId: 'shell-before',
      modelMessageId,
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'pwd' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls.question = {
      toolCallId: 'question',
      modelMessageId,
      ordinal: 1,
      name: 'ask_user',
      args: { question: 'Continue?' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.calls['shell-after'] = {
      toolCallId: 'shell-after',
      modelMessageId,
      ordinal: 2,
      name: 'shell_execute',
      args: { command: 'git status' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    let executionCount = 0;

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['shell-before'],
      sandboxAvailable: true,
      shellExecutor: async ({ command }) => {
        executionCount += 1;
        return { ok: true, command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(executionCount).toBe(1);
    expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
  });

  test('starts every approved shell sibling concurrently', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-parallel-shell-execution',
      userId: 'user',
      workspace: process.cwd(),
    });
    for (const [ordinal, toolCallId] of ['first', 'second'].entries()) {
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'parallel-shell-model',
        ordinal,
        name: 'shell_execute',
        args: { command: `node task-${ordinal + 1}.js` },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, toolCallId];
    }
    let running = 0;
    let maximumRunning = 0;
    const executionScopes: Array<{
      networkMode: import('@kite/builtin-runtime/sandbox').ShellInput['networkMode'];
      filesystemMode: import('@kite/builtin-runtime/sandbox').ShellInput['filesystemMode'];
    }> = [];

    const approvalEvents = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['first', 'second'],
    });
    applyExactApprovalFixtureV1(state, 'first', approvalEvents);
    applyExactApprovalFixtureV1(state, 'second', approvalEvents);

    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['first', 'second'],
      shellExecutor: async ({ command, networkMode, filesystemMode }) => {
        executionScopes.push({ networkMode, filesystemMode });
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return { ok: true, command, exitCode: 0, stdout: command, stderr: '' };
      },
    });

    expect(maximumRunning).toBe(2);
    expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'tool.finished')).toHaveLength(2);
    expect(executionScopes).toEqual([
      { networkMode: 'allow_all', filesystemMode: 'allow_all' },
      { networkMode: 'allow_all', filesystemMode: 'allow_all' },
    ]);
  });

  test('ordinary prepared shell dispatch preserves the legacy mode differential corpus', async () => {
    const corpus = [
      {
        command: 'pwd',
        fullAccess: false,
        requiresApproval: false,
        expected: { networkMode: 'disabled' as const, filesystemMode: 'workspace_only' as const },
      },
      {
        command: 'node -e "console.log(1)"',
        fullAccess: true,
        requiresApproval: false,
        expected: { networkMode: 'allow_all' as const, filesystemMode: 'allow_all' as const },
      },
      {
        command: 'cat /outside/fixture.txt',
        fullAccess: true,
        requiresApproval: true,
        expected: { networkMode: 'allow_all' as const, filesystemMode: 'allow_all' as const },
      },
    ] as const;

    for (const [index, candidate] of corpus.entries()) {
      const state = createRuntimeHostStateInitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: `runtime-shell-mode-corpus-${index}`,
        userId: 'user',
        workspace: process.cwd(),
      });
      state.authorization.mode = candidate.fullAccess ? 'full_access' : 'default';
      const toolCallId = `shell-mode-${index}`;
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'shell-mode-corpus',
        name: 'shell_execute',
        args: { command: candidate.command },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, toolCallId];
      const scopes: Array<{
        networkMode: import('@kite/builtin-runtime/sandbox').ShellInput['networkMode'];
        filesystemMode: import('@kite/builtin-runtime/sandbox').ShellInput['filesystemMode'];
      }> = [];
      const run = () =>
        executeTestRuntimeToolsV1({
          state,
          toolCallIds: [toolCallId],
          sandboxAvailable: true,
          shellExecutor: async ({ command, networkMode, filesystemMode }) => {
            scopes.push({ networkMode, filesystemMode });
            return { ok: true, command, exitCode: 0, stdout: '', stderr: '' };
          },
        });

      const firstEvents = await run();
      if (candidate.requiresApproval) {
        applyExactApprovalFixtureV1(state, toolCallId, firstEvents);
        await run();
      }
      expect(scopes).toEqual([candidate.expected]);
    }
  });

  test('ordinary prepared filesystem dispatch preserves the legacy external-path corpus', async () => {
    const catalog = testBuiltinToolCatalogV1();
    const entry = catalog.entries.find(
      (candidate) => candidate.operationId === 'builtin:read_file',
    );
    if (!entry?.executorRevision) throw new Error('read_file catalog entry is unavailable');
    const corpus = [
      { path: 'README.md', expectedAllowExternalPaths: false },
      { path: '/outside/fixture.txt', expectedAllowExternalPaths: true },
    ] as const;

    for (const [index, candidate] of corpus.entries()) {
      const state = createRuntimeHostStateInitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: `runtime-filesystem-mode-corpus-${index}`,
        userId: 'user',
        workspace: process.cwd(),
      });
      const toolCallId = `read-mode-${index}`;
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'filesystem-mode-corpus',
        name: 'read_file',
        args: { path: candidate.path },
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = [...state.tools.queue, toolCallId];
      const observed: boolean[] = [];
      const capabilityExecution = {
        invoke: async (invocation: import('@kite/runtime-spi').CapabilityExecutionInvocationV1) => {
          const mechanisms = invocation.environment.mechanisms as Readonly<Record<string, unknown>>;
          const filesystem = mechanisms.filesystem as Readonly<{ allowExternalPaths: boolean }>;
          observed.push(filesystem.allowExternalPaths);
          return {
            invocationId: invocation.request.invocationId,
            attemptId: invocation.attempt.attemptId,
            providerId: entry.providerId,
            executorRevision: entry.executorRevision!,
            requestDigest: invocation.requestDigest,
            status: 'succeeded' as const,
            dispatchCertainty: 'attempted' as const,
            cleanupCertainty: 'not_required' as const,
            value: {
              schema: 'kite.builtin-operation-result.v1',
              ok: true,
              stdout: 'fixture',
              stderr: '',
            },
          };
        },
      };
      await executeTestRuntimeToolsV1({
        state,
        toolCallIds: [toolCallId],
        capabilityExecution,
        builtinToolCatalog: catalog,
      });
      expect(observed).toEqual([candidate.expectedAllowExternalPaths]);
    }
  });

  test('streams shell lifecycle and progress events while the command is running', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-shell-stream',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization.mode = 'full_access';
    state.tools.calls.stream = {
      toolCallId: 'stream',
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command: 'bun --version' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'stream'];

    const streamed: RuntimeEvent[] = [];
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let observeProgress!: () => void;
    const progressObserved = new Promise<void>((resolve) => {
      observeProgress = resolve;
    });
    const execution = executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['stream'],
      sandboxAvailable: true,
      shellExecutor: async (input) => {
        input.onProgress?.('live output', 'stdout');
        await executionGate;
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: 'live output\n',
          stderr: '',
        };
      },
      emitRuntimeEvent: (event) => {
        streamed.push(event);
        if (event.type === 'tool.progress') observeProgress();
      },
    });

    const progressArrivedWhileRunning = await Promise.race([
      progressObserved.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    const eventTypesWhileRunning = streamed.map((event) => event.type);
    releaseExecution();
    const returned = await execution;

    expect(progressArrivedWhileRunning).toBe(true);
    expect(eventTypesWhileRunning).toEqual(['tool.started', 'tool.progress']);
    expect(returned).toEqual([]);
    expect(streamed.map((event) => event.type)).toEqual([
      'tool.started',
      'tool.progress',
      'capability.execution_succeeded',
      'tool.finished',
    ]);
  });

  test('does not retain high-volume shell progress in the returned event array', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-shell-high-volume-stream',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.authorization.mode = 'full_access';
    state.tools.calls.stream = {
      toolCallId: 'stream',
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command: 'high-volume-output' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'stream'];
    let progressEvents = 0;

    const returned = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['stream'],
      sandboxAvailable: true,
      shellExecutor: async (input) => {
        for (let index = 0; index < 10_000; index += 1) {
          input.onProgress?.(`line-${index}`, 'stdout');
        }
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: 'bounded terminal result',
          stderr: '',
        };
      },
      emitRuntimeEvent: (event) => {
        if (event.type === 'tool.progress') progressEvents += 1;
      },
    });

    expect(progressEvents).toBe(10_000);
    expect(returned).toEqual([]);
  });

  test('requires approval for a network read in accept_edits mode', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-accept-edits-network',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'accept_edits';
    state.tools.calls.fetch = {
      toolCallId: 'fetch',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'web_fetch',
      args: { url: 'https://example.com' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'fetch'];

    const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['fetch'] });

    expect(events.some((event) => event.type === 'approval.requested')).toBe(true);
    expect(events.some((event) => event.type === 'tool.started')).toBe(false);
  });

  test('auto-reviews a network read before execution in auto mode', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-auto-network',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'auto';
    state.tools.calls.fetch = {
      toolCallId: 'fetch',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'web_fetch',
      args: { url: 'https://example.com' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'fetch'];

    const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['fetch'] });

    expect(events.some((event) => event.type === 'auto_review.requested')).toBe(true);
    expect(events.some((event) => event.type === 'tool.started')).toBe(false);
  });

  test('runs a proven workspace-only shell write directly in accept_edits mode', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-accept-edits-shell-write',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'accept_edits';
    setTestPlanning(state, {
      kind: 'executing',
      document: {
        planSchemaVersion: 2,
        planId: 'plan-approved',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'Test plan.',
        steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
        completionEvidence: {
          schemaVersion: 1,
          verification: [],
          execution: [],
          skipped: [],
          unresolved: [],
        },
      },
      executionMode: 'accept_edits',
      approvedAtTurnId: state.turn.turnId,
    });
    state.tools.calls.shell = {
      toolCallId: 'shell',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'touch policy-proof.txt' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'shell'];

    let executed = false;
    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['shell'],
      sandboxAvailable: true,
      shellExecutor: async (input) => {
        executed = true;
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(executed).toBe(true);
    expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
  });

  test('requires approval for a Git mutation in accept_edits mode', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-accept-edits-local-git',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'accept_edits';
    setTestPlanning(state, {
      kind: 'executing',
      document: {
        planSchemaVersion: 2,
        planId: 'plan-approved',
        version: 1,
        title: 'Test',
        bodyMarkdown: 'Test plan.',
        steps: [{ id: 's1', title: 'Do it', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
        completionEvidence: {
          schemaVersion: 1,
          verification: [],
          execution: [],
          skipped: [],
          unresolved: [],
        },
      },
      executionMode: 'accept_edits',
      approvedAtTurnId: state.turn.turnId,
    });
    state.tools.calls.git = {
      toolCallId: 'git',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'git add policy-proof.txt' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'git'];

    let executed = false;
    const events = await executeTestRuntimeToolsV1({
      state,
      toolCallIds: ['git'],
      shellExecutor: async (input) => {
        executed = true;
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(events.some((event) => event.type === 'approval.requested')).toBe(true);
    expect(executed).toBe(false);
  });

  test('write_file in auto mode inherits accept_edits direct execution', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openpx-auto-write-'));
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-auto-write',
      userId: 'user',
      workspace,
    });
    state.mode = 'auto';
    setTestPlanning(state, {
      kind: 'executing',
      document: {
        planSchemaVersion: 2,
        planId: 'plan-auto',
        version: 1,
        title: 'Auto',
        bodyMarkdown: 'Auto plan.',
        steps: [{ id: 's1', title: 'Step', status: 'pending' }],
        structuralDigest: 'abc',
        createdAtTurnId: state.turn.turnId,
        updatedAtTurnId: state.turn.turnId,
        completionEvidence: {
          schemaVersion: 1,
          verification: [],
          execution: [],
          skipped: [],
          unresolved: [],
        },
      },
      executionMode: 'auto',
      approvedAtTurnId: state.turn.turnId,
    });
    state.tools.calls.wf = {
      toolCallId: 'wf',
      modelMessageId: 'model',
      ordinal: 0,
      name: 'write_file',
      args: { path: 'test.txt', content: 'hello' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'wf'];

    try {
      const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['wf'] });

      expect(events.some((event) => event.type === 'auto_review.requested')).toBe(false);
      expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
      expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
      expect(readFileSync(join(workspace, 'test.txt'), 'utf8')).toBe('hello');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('classifies an unregistered tool as tool_not_found through the full pipeline', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-e2e-unknown-tool',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.tools.calls.unknown = {
      toolCallId: 'unknown',
      modelMessageId: 'model',
      name: 'nonexistent_tool_xyz',
      args: { foo: 'bar' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'unknown'];

    const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['unknown'] });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'unknown',
        failure: expect.objectContaining({
          kind: 'tool_not_found',
          message: expect.stringContaining('nonexistent_tool_xyz'),
        }),
      }),
    ]);
  });

  test('propagates parseFailureCode through InvalidToolRequest to ClassifiedFailure', async () => {
    const state = createRuntimeHostStateInitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'runtime-e2e-invalid-args-code',
      userId: 'user',
      workspace: process.cwd(),
    });
    // write_file has required 'path' and 'content' fields; empty args triggers
    // schema validation failure which flows:
    // Registry.parseToolCall(invalid_arguments) → toolRequestFromCall → InvalidToolRequest
    // → Controller classifyFailure('tool_invalid_args', ..., 'invalid_arguments')
    state.tools.calls.wf = {
      toolCallId: 'wf',
      modelMessageId: 'model',
      name: 'write_file',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = [...state.tools.queue, 'wf'];

    const events = await executeTestRuntimeToolsV1({ state, toolCallIds: ['wf'] });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.failed',
        toolCallId: 'wf',
        failure: expect.objectContaining({
          kind: 'tool_invalid_args',
          parseFailureCode: 'invalid_arguments',
        }),
      }),
    ]);
  });
});

describe('buildBlockedToolRequest', () => {
  const availCtx = toolAvailabilityContext({ workspace: '/tmp/test' });

  test('returns a proper PendingBuiltinToolRequest for a registered builtin tool', () => {
    const blocked = {
      toolCallId: 'tc-1',
      toolName: 'read_file',
      args: { path: 'src/index.ts' },
      command: 'read_file src/index.ts',
    };
    const request = buildBlockedToolRequest(blocked, availCtx, testBuiltinToolCatalogV1());
    expect(request.source).toBe('builtin');
    expect(request.name).toBe('read_file');
    expect(request.id).toBe('tc-1');
    expect(request.args).toEqual({ path: 'src/index.ts' });
    expect(request.protectedCommand).toBe('read_file src/index.ts');
  });

  test('returns a PendingMcpToolRequest for an MCP tool name in the fallback path', () => {
    const blocked = {
      toolCallId: 'tc-2',
      toolName: 'mcp__github__read',
      args: { query: 'test' },
      command: 'mcp__github__read',
    };
    const request = buildBlockedToolRequest(blocked, availCtx, testBuiltinToolCatalogV1());
    expect(request.source).toBe('mcp');
    expect(request.name).toBe('mcp__github__read');
    expect(request.id).toBe('tc-2');
    expect(request.args).toEqual({ query: 'test' });
  });

  test('returns a fallback PendingBuiltinToolRequest for an unknown tool name', () => {
    const blocked = {
      toolCallId: 'tc-3',
      toolName: 'nonexistent_tool',
      args: { foo: 'bar' },
      command: 'nonexistent_tool',
    };
    const request = buildBlockedToolRequest(blocked, availCtx, testBuiltinToolCatalogV1());
    expect(request.source).toBe('builtin');
    expect(request.name as string).toBe('nonexistent_tool');
    expect(request.args).toEqual({ foo: 'bar' });
    expect(request.reason).toContain('blocked for approval');
  });
});
