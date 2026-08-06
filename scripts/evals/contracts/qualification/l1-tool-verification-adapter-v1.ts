import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import type { CapabilityResult } from '../../../../src/core/capabilities/result';
import type { AgentConfig } from '../../../../src/core/config';
import { executeRuntimeTools } from '../../../../src/core/controllers/tool-controller';
import type { McpRuntimeProvider } from '../../../../src/core/mcp/runtime-provider';
import { type AIMessage, aiMessage } from '../../../../src/core/messages';
import { CapabilityArtifactStore } from '../../../../src/core/persistence/capability-artifacts';
import { eventsForRunCancellation } from '../../../../src/core/runtime/actions';
import type { RuntimeEvent } from '../../../../src/core/runtime/events';
import { createRuntimeEffectExecutor } from '../../../../src/core/runtime/executor';
import {
  AgentKernel,
  createAgentKernel,
  type RuntimeEffectExecutor,
} from '../../../../src/core/runtime/kernel';
import {
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
} from '../../../../src/core/runtime/resource-budget';
import { type RuntimeActionProvider, runRuntimeLoop } from '../../../../src/core/runtime/runner';
import { decideNextEffect } from '../../../../src/core/runtime/scheduler';
import { createInitialRuntimeState, type RuntimeState } from '../../../../src/core/runtime/state';
import { createRuntimeStore } from '../../../../src/core/runtime/store';
import type { ShellExecutor } from '../../../../src/core/tools/shell';
import { executeVerificationEffect } from '../../../../src/core/verification/executor';
import {
  evaluateL1ToolVerificationCorpusV1,
  type L1ToolVerificationCaseObservationV1,
  type L1ToolVerificationReportV1,
  l1ObservationForCaseV1,
} from './l1-tool-verification-evaluator-v1';
import {
  buildL1ToolVerificationEvaluatorIdentityV1,
  L1_TOOL_VERIFICATION_ADAPTERS_V1,
  L1_TOOL_VERIFICATION_FIXTURE_ID_V1,
  L1_TOOL_VERIFICATION_RUNNER_ID_V1,
  type L1ToolVerificationAdapterResultV1,
  type L1ToolVerificationEvaluatorIdentityV1,
} from './l1-tool-verification-schema-v1';

export {
  L1_TOOL_VERIFICATION_ADAPTER_IMPLEMENTATIONS_V1,
  L1_TOOL_VERIFICATION_FIXTURE_ID_V1,
  L1_TOOL_VERIFICATION_RUNNER_ID_V1,
} from './l1-tool-verification-schema-v1';

/**
 * L1 fixtures never call a provider, child process, stdio transport, or the
 * project workspace. The only mutable root is a freshly allocated synthetic
 * directory removed synchronously after each closed run.
 */
const L1_SYNTHETIC_ROOT_PREFIX_V1 = 'kite-l1-qualification-';
export const L1_FIXED_CLOCK_START_V1 = '2026-08-05T00:00:00.000Z';

interface ScriptedModelResponseV1 {
  message: AIMessage;
}

interface ScriptedModelV1 {
  model: LanguageModel;
  capabilityMetadata: { streaming: false };
  setRetryListener: (_listener: unknown) => void;
  readonly callCount: { count: number };
}

/**
 * A deliberately tiny AI-SDK-compatible scripted model. It carries no route,
 * credential, endpoint, prompt capture, or response logging; callers retain
 * only the count and event-type oracle below.
 */
function createScriptedModelV1(responses: readonly ScriptedModelResponseV1[]): ScriptedModelV1 {
  const callCount = { count: 0 };
  const model = {
    specificationVersion: 'v4',
    provider: 'qualification-scripted',
    modelId: 'qualification-scripted',
    supportedUrls: {},
    async doGenerate(): Promise<unknown> {
      const response = responses[callCount.count % responses.length];
      callCount.count += 1;
      const message = response?.message ?? aiMessage({ content: '' });
      const toolCalls = message.tool_calls ?? [];
      const content: Array<Record<string, unknown>> = [];
      if (typeof message.content === 'string' && message.content.length > 0) {
        content.push({ type: 'text', text: message.content });
      }
      for (const call of toolCalls) {
        content.push({
          type: 'tool-call',
          toolCallId: call.id ?? `l1-tool-${callCount.count}`,
          toolName: call.name,
          input: call.args as Record<string, unknown>,
        });
      }
      return {
        content,
        finishReason: {
          unified: toolCalls.length > 0 ? 'tool-calls' : 'stop',
          raw: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1 },
          totalTokens: 2,
        },
      };
    },
    async doStream(): Promise<never> {
      throw new Error('L1 scripted model does not stream');
    },
  };
  return {
    model: model as unknown as LanguageModel,
    capabilityMetadata: { streaming: false },
    setRetryListener: () => {},
    callCount,
  };
}

/** In-memory artifact storage prevents the L1 verifier fixture from retaining result content. */
class InMemoryQualificationArtifactStoreV1 extends CapabilityArtifactStore {
  private readonly results = new Map<string, CapabilityResult>();

  override write(invocationId: string, result: CapabilityResult) {
    this.results.set(invocationId, result);
    return {
      artifactId: invocationId,
      relativePath: 'qualification-artifact',
      byteLength: 0,
      digest: `qualification-${invocationId}`,
    };
  }

  override read(ref: { artifactId: string }): CapabilityResult {
    const result = this.results.get(ref.artifactId);
    if (!result) throw new Error('qualification_artifact_missing');
    return result;
  }
}

interface FixtureMcpProviderV1 {
  provider: McpRuntimeProvider;
  getCallCount: () => number;
}

/**
 * A structural in-memory MCP provider, deliberately labeled stdio only so no
 * network/egress path is eligible. It never starts a stdio child process.
 */
function createFixtureMcpProviderV1(): FixtureMcpProviderV1 {
  const descriptor = {
    capabilityId: 'mcp:qualification/write',
    revision: 'qualification-revision-v1',
    kind: 'mcp_tool' as const,
    displayName: 'write',
    description: 'L1 in-memory qualification fixture',
    provider: { type: 'mcp' as const, id: 'qualification', provenance: 'remote' as const },
    inputSchema: {
      type: 'object',
      properties: { operation: { type: 'string' } },
      required: ['operation'],
      additionalProperties: false,
    },
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
    availability: 'available' as const,
    diagnostics: [],
  };
  let calls = 0;
  const provider: McpRuntimeProvider = {
    getCapabilitySnapshot: () => ({
      revision: 'qualification-catalog-v1',
      descriptors: [descriptor],
    }),
    getProviderDirectorySnapshot: () => ({
      revision: 'qualification-directory-v1',
      entries: [
        {
          providerId: 'qualification',
          status: 'ready',
          required: false,
          source: 'explicit',
          lastKnownCapabilityNames: ['write'],
          retryable: false,
        },
      ],
    }),
    getResourceDirectorySnapshot: () => ({ revision: 'qualification-resources-v1', resources: [] }),
    findCapability: (capabilityId) =>
      capabilityId === descriptor.capabilityId ? descriptor : undefined,
    getCapabilityRoute: (capabilityId) =>
      capabilityId === descriptor.capabilityId
        ? {
            transport: 'stdio' as const,
            serverIdentity: 'qualification',
            endpointRevision: 'qualification-stdio-v1',
            toolRevision: descriptor.revision,
          }
        : undefined,
    ensureProviderReady: async () => {},
    callCapability: async () => {
      calls += 1;
      // No response body is needed for this lifecycle fixture. The adapter
      // retains only event-type and state-token observations.
      return { content: [] };
    },
    readResource: async () => '',
  };
  return { provider, getCallCount: () => calls };
}

function l1ConfigV1(): AgentConfig {
  return {
    apiKey: '',
    baseURL: '',
    modelName: 'qualification-scripted',
    providerName: 'qualification-scripted',
    providerType: 'openai-compatible',
    sandbox: { enabled: true },
    features: {
      capabilityCatalogV1: true,
      mcpRuntimeBindingV1: true,
      mcpExecutionRecordV1: true,
      verificationV1: true,
    },
  };
}

interface ScriptedRuntimeRunV1 {
  eventTypes: readonly RuntimeEvent['type'][];
  state: Readonly<RuntimeState>;
  modelCalls: number;
  mcpCalls: number;
}

/**
 * Real Kernel + scheduler + product controllers. Only the Verification effect
 * is intentionally intercepted so the real executor receives a closed,
 * in-memory reviewer rather than a model/provider call.
 */
async function runScriptedRuntimeV1(input: {
  root: string;
  responses: readonly ScriptedModelResponseV1[];
  provider: RuntimeActionProvider;
  mcpProvider?: FixtureMcpProviderV1;
  shellExecutor?: ShellExecutor;
}): Promise<ScriptedRuntimeRunV1> {
  const model = createScriptedModelV1(input.responses);
  const kernel = createAgentKernel({
    threadId: 'qualification-l1-thread',
    userId: 'qualification',
    workspace: input.root,
    storePath: join(input.root, 'runtime.db'),
    interactionMode: 'accept_edits',
  });
  const artifacts = new InMemoryQualificationArtifactStoreV1();
  const config = l1ConfigV1();
  const mcpManager = input.mcpProvider?.provider;
  const productionExecutor = createRuntimeEffectExecutor({
    config,
    model: model as unknown as import('../../../../src/core/model/factory').SupportedChatModel,
    mcpManager,
    shellExecutor: input.shellExecutor,
    runtimeStore: kernel.runtimeStore,
  });
  const executor: RuntimeEffectExecutor = async (effect, state, emit, context) => {
    if (effect.type === 'run_tools') {
      return executeRuntimeTools({
        state: state as RuntimeState,
        toolCallIds: effect.toolCallIds,
        mcpManager,
        shellExecutor: input.shellExecutor,
        taskConfig: config,
        taskModel:
          model as unknown as import('../../../../src/core/model/factory').SupportedChatModel,
        capabilityArtifactStore: artifacts,
      });
    }
    if (
      effect.type === 'run_verification' ||
      effect.type === 'repair_verification' ||
      effect.type === 'run_verification_compensation'
    ) {
      return executeVerificationEffect(effect, state, {
        artifactStore: artifacts,
        mcpManager,
        shellExecutor: input.shellExecutor,
        reviewer: async () => ({
          outcome: 'passed',
          summary: 'L1 in-memory reviewer accepted the sealed fixture receipt.',
        }),
      });
    }
    return productionExecutor(effect, state, emit, context);
  };
  const events: RuntimeEvent[] = [];
  try {
    kernel.processEventBatch([
      { type: 'user.message_appended', messageId: 'qualification-l1-user', content: 'fixture' },
      { type: 'turn.started', turnId: 'qualification-l1-turn' },
    ]);
    for await (const event of runRuntimeLoop(kernel, executor, input.provider, 128)) {
      events.push(event);
    }
    return {
      eventTypes: events.map((event) => event.type),
      state: kernel.getState(),
      modelCalls: model.callCount.count,
      mcpCalls: input.mcpProvider?.getCallCount() ?? 0,
    };
  } finally {
    kernel.close();
  }
}

async function withSyntheticRootAsyncV1<T>(run: (root: string) => Promise<T>): Promise<T> {
  return withFixedClockAsyncV1(async () => {
    const root = mkdtempSync(join(tmpdir(), L1_SYNTHETIC_ROOT_PREFIX_V1));
    try {
      return await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

/**
 * The product runtime currently has no clock dependency seam.  The diagnostic
 * harness therefore installs a process-local fixed Date constructor around
 * each sealed fixture, serialized so overlapping invocations cannot restore a
 * real clock under another fixture.  This is test-harness-only and never
 * changes the product default clock or context-window policy.
 */
let fixedClockTailV1: Promise<void> = Promise.resolve();

async function withFixedClockAsyncV1<T>(run: () => Promise<T>): Promise<T> {
  let release: (() => void) | undefined;
  const previous = fixedClockTailV1;
  fixedClockTailV1 = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  const nativeDate = globalThis.Date;
  const fixedTimestampMs = nativeDate.parse(L1_FIXED_CLOCK_START_V1);
  const fixedDate = new Proxy(nativeDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [fixedTimestampMs] : args, newTarget);
    },
    apply(target, thisArg, args) {
      return args.length === 0
        ? new target(fixedTimestampMs).toString()
        : Reflect.apply(target, thisArg, args);
    },
    get(target, property, receiver) {
      if (property === 'now') return () => fixedTimestampMs;
      return Reflect.get(target, property, receiver);
    },
  });
  globalThis.Date = fixedDate as typeof Date;
  try {
    return await run();
  } finally {
    globalThis.Date = nativeDate;
    release?.();
  }
}

function hasAll(
  eventTypes: readonly RuntimeEvent['type'][],
  required: readonly RuntimeEvent['type'][],
): boolean {
  return required.every((eventType) => eventTypes.includes(eventType));
}

async function runToolApprovalExecutionVerificationV1(): Promise<boolean> {
  return withSyntheticRootAsyncV1(async (root) => {
    const mcpProvider = createFixtureMcpProviderV1();
    const result = await runScriptedRuntimeV1({
      root,
      mcpProvider,
      responses: [
        {
          message: aiMessage({
            content: '',
            tool_calls: [
              {
                id: 'qualification-write',
                name: 'mcp__qualification__write',
                args: { operation: 'apply' },
              },
            ],
          }),
        },
        { message: aiMessage({ content: 'done' }) },
      ],
      provider: {
        requestAction: async (effect) => {
          if (effect.type !== 'request_tool_approval') {
            throw new Error(`unexpected_l1_interaction:${effect.type}`);
          }
          return { type: 'approve', interactionId: effect.interactionId, grant: 'approve_once' };
        },
      },
    });
    const verification = Object.values(result.state.verification.records)[0];
    return (
      result.mcpCalls === 1 &&
      result.modelCalls === 2 &&
      verification?.status === 'passed' &&
      verification?.requestedAt === L1_FIXED_CLOCK_START_V1 &&
      hasAll(result.eventTypes, [
        'approval.requested',
        'approval.granted',
        'tool.started',
        'verification.requested',
        'verification.completed',
        'tool.finished',
        'turn.completed',
      ])
    );
  });
}

async function runInvalidToolArgumentsCorrectedV1(): Promise<boolean> {
  return withSyntheticRootAsyncV1(async (root) => {
    writeFileSync(join(root, 'fixture.txt'), 'fixture');
    const result = await runScriptedRuntimeV1({
      root,
      responses: [
        {
          message: aiMessage({
            content: '',
            tool_calls: [{ id: 'invalid-read', name: 'read_file', args: {} }],
          }),
        },
        {
          message: aiMessage({
            content: '',
            tool_calls: [
              { id: 'corrected-read', name: 'read_file', args: { path: 'fixture.txt' } },
            ],
          }),
        },
        { message: aiMessage({ content: 'done' }) },
      ],
      provider: { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    });
    return (
      result.modelCalls === 3 &&
      result.state.turn.status === 'completed' &&
      result.eventTypes.includes('tool.failed') &&
      result.eventTypes.includes('tool.finished') &&
      result.eventTypes.includes('turn.completed') &&
      Object.values(result.state.tools.calls).some(
        (call) => call.failure?.kind === 'tool_invalid_args',
      )
    );
  });
}

async function runApprovalRejectionAbortsTurnV1(): Promise<boolean> {
  return withSyntheticRootAsyncV1(async (root) => {
    const mcpProvider = createFixtureMcpProviderV1();
    const result = await runScriptedRuntimeV1({
      root,
      mcpProvider,
      responses: [
        {
          message: aiMessage({
            content: '',
            tool_calls: [
              {
                id: 'rejected-write',
                name: 'mcp__qualification__write',
                args: { operation: 'apply' },
              },
            ],
          }),
        },
      ],
      provider: {
        requestAction: async (effect) => ({
          type: 'reject',
          interactionId: effect.interactionId,
          reason: 'fixture_rejection',
        }),
      },
    });
    return (
      result.mcpCalls === 0 &&
      result.state.turn.status === 'aborted' &&
      hasAll(result.eventTypes, ['approval.rejected', 'turn.aborted']) &&
      !result.eventTypes.includes('tool.started')
    );
  });
}

async function runApprovedParallelToolsV1(): Promise<boolean> {
  return withSyntheticRootAsyncV1(async (root) => {
    const state = createInitialRuntimeState({
      threadId: 'qualification-l1-parallel',
      userId: 'qualification',
      workspace: root,
    });
    for (const [ordinal, toolCallId] of ['one', 'two'].entries()) {
      state.tools.calls[toolCallId] = {
        toolCallId,
        modelMessageId: 'qualification-parallel-model',
        ordinal,
        name: 'shell_execute',
        args: { command: `fixture-${ordinal}` },
        status: 'approved',
        approvalGrant: 'approve_once',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push(toolCallId);
    }
    let running = 0;
    let maximumRunning = 0;
    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['one', 'two'],
      shellExecutor: async (input) => {
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        started += 1;
        if (started === 2) release();
        await bothStarted;
        running -= 1;
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });
    return (
      maximumRunning === 2 &&
      events.filter((event) => event.type === 'tool.started').length === 2 &&
      events.filter((event) => event.type === 'tool.finished').length === 2
    );
  });
}

async function runUnknownDispatchAndLateTerminalV1(): Promise<boolean> {
  return withSyntheticRootAsyncV1(async (root) => {
    const threadId = 'qualification-l1-late-terminal';
    const storePath = join(root, 'runtime.db');
    const kernel = createAgentKernel({
      threadId,
      userId: 'qualification',
      workspace: root,
      storePath,
      interactionMode: 'accept_edits',
    });
    let abandonedLease: ReturnType<AgentKernel['beginEffect']>;
    try {
      kernel.processEvent({ type: 'turn.started', turnId: 'qualification-l1-restart-turn' });
      abandonedLease = kernel.beginEffect({ type: 'run_tools', toolCallIds: [] });
      kernel.processEventBatch([
        {
          type: 'capability.invocation_recorded',
          invocationId: 'qualification-l1-dispatched-invocation',
          toolCallId: 'qualification-l1-dispatched-tool',
          capabilityId: 'mcp:qualification/write',
          capabilityRevision: 'qualification-revision-v1',
          argumentsDigest: 'qualification-arguments-digest-v1',
          authorizationDigest: 'qualification-authorization-digest-v1',
          effectiveEffectsDigest: 'qualification-effects-digest-v1',
          effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
          recordedAt: L1_FIXED_CLOCK_START_V1,
        },
        {
          type: 'capability.execution_started',
          invocationId: 'qualification-l1-dispatched-invocation',
          startedAt: L1_FIXED_CLOCK_START_V1,
        },
      ]);
      kernel.processEventBatch(
        eventsForRunCancellation(kernel.getState(), 'fixture_cancel', 'error'),
      );
    } finally {
      kernel.close();
    }

    const restarted = createAgentKernel({
      threadId,
      userId: 'qualification',
      workspace: root,
      storePath,
      interactionMode: 'accept_edits',
    });
    try {
      const beforeReconciliation =
        restarted.getState().capabilities.invocations['qualification-l1-dispatched-invocation'];
      const lateApplied = restarted.applyEffectEvent(abandonedLease!, {
        type: 'tool.finished',
        toolCallId: 'qualification-l1-dispatched-tool',
        name: 'shell_execute',
        result: { ok: true, command: 'fixture', exitCode: 0, stdout: '', stderr: '' },
      });
      const reconciliation = restarted.applyAction({
        type: 'reconcile_invocation',
        invocationId: 'qualification-l1-dispatched-invocation',
        decision: 'confirmed_failure',
        reason: 'fixture_reconciliation',
      });
      const afterReconciliation =
        restarted.getState().capabilities.invocations['qualification-l1-dispatched-invocation'];
      return (
        beforeReconciliation?.status === 'unknown' &&
        !lateApplied &&
        reconciliation.status === 'applied' &&
        afterReconciliation?.status === 'failed' &&
        afterReconciliation.reconciliation === 'confirmed_failure'
      );
    } finally {
      restarted.close();
    }
  });
}

async function runRequiredVerificationBlocksFalseCompletionV1(): Promise<boolean> {
  return withSyntheticRootAsyncV1(async (root) => {
    const state = createInitialRuntimeState({
      threadId: 'qualification-l1-verification',
      userId: 'qualification',
      workspace: root,
    });
    state.transcript.final = 'claimed-complete';
    const requestedAt = L1_FIXED_CLOCK_START_V1;
    const verificationId = 'qualification-required-verification';
    const requested: RuntimeEvent = {
      type: 'verification.requested',
      verificationId,
      mode: 'required',
      spec: {
        schemaVersion: 1,
        verificationId,
        subject: 'qualification fixture',
        checks: [
          {
            checkId: 'fixture-review',
            type: 'reviewer',
            description: 'fixture review',
            instructions: 'fixture review',
          },
        ],
        repair: { maxAttempts: 0 },
      },
      requestedAt,
    };
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    try {
      kernel.processEvent(requested);
      if (decideNextEffect(kernel.getState()).type !== 'run_verification') return false;
      const events = await executeVerificationEffect(
        { type: 'run_verification', verificationId },
        kernel.getState(),
        { reviewer: async () => ({ outcome: 'failed', summary: 'fixture failure' }) },
      );
      kernel.processEventBatch(events);
      return (
        kernel.getState().verification.records[verificationId]?.status === 'budget_exhausted' &&
        decideNextEffect(kernel.getState()).type === 'request_verification_decision'
      );
    } finally {
      kernel.close();
    }
  });
}

async function runBoundedCleanupRetainsUnknownV1(): Promise<boolean> {
  return withSyntheticRootAsyncV1(async (root) => {
    const state = createInitialRuntimeState({
      threadId: 'qualification-l1-cleanup',
      userId: 'qualification',
      workspace: root,
    });
    state.tools.calls['running-tool'] = {
      toolCallId: 'running-tool',
      modelMessageId: 'qualification-model',
      name: 'shell_execute',
      args: { command: 'fixture' },
      status: 'running',
      createdAtTurnId: state.turn.turnId,
    };
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    try {
      const usage = createZeroResourceUsageV1('versioned_upper_bound', 'qualification-l1');
      usage.counters.toolInvocations = 1;
      usage.gauges.activeToolInvocations = 1;
      kernel.processEventBatch([
        {
          type: 'resource_budget.configured',
          runId: 'qualification-l1-run',
          startedAt: L1_FIXED_CLOCK_START_V1,
          deadlineAt: '2026-08-05T00:00:30.000Z',
          budget: LIMITED_RESOURCE_BUDGET_V1,
        },
        {
          type: 'resource_budget.reserved',
          reservation: {
            version: 1,
            reservationId: 'qualification-l1-dispatched',
            runId: 'qualification-l1-run',
            invocationId: 'tool:running-tool',
            resourceKind: 'tool',
            executableUpperBound: usage,
            state: 'reserved',
          },
        },
        { type: 'resource_budget.dispatch_started', reservationId: 'qualification-l1-dispatched' },
      ]);
      kernel.processEventBatch(
        eventsForRunCancellation(kernel.getState(), 'fixture_deadline', 'error'),
      );
      kernel.processEvent({
        type: 'runtime.cancellation_diagnostic',
        toolCallId: 'running-tool',
        failure: {
          kind: 'cancel_incomplete',
          message: 'fixture cleanup incomplete',
          retryable: false,
          modelFixable: false,
          needsUserIntervention: true,
          terminatesTurn: true,
          journal: true,
        },
        unconfirmedDescendantCount: 1,
      });
      return (
        kernel.getState().resourceBudget.status === 'active' &&
        kernel.getState().resourceBudget.reservations['qualification-l1-dispatched']?.state ===
          'unknown' &&
        kernel.getState().tools.calls['running-tool']?.status === 'cancelled' &&
        kernel.getState().turn.status === 'aborted'
      );
    } finally {
      kernel.close();
    }
  });
}

function adapterResult(
  adapterId: (typeof L1_TOOL_VERIFICATION_ADAPTERS_V1)[number]['adapterId'],
  passed: boolean,
): L1ToolVerificationAdapterResultV1 {
  const pair = L1_TOOL_VERIFICATION_ADAPTERS_V1.find((entry) => entry.adapterId === adapterId);
  if (!pair) throw new Error(`unregistered_l1_adapter:${adapterId}`);
  return { ...pair, outcome: passed ? 'passed' : 'failed' };
}

/** Execute every closed L1 slice and return only stable adapter outcome tokens. */
export async function runL1ToolVerificationAdaptersV1(): Promise<
  readonly L1ToolVerificationAdapterResultV1[]
> {
  const outcomes = [
    await runToolApprovalExecutionVerificationV1(),
    await runInvalidToolArgumentsCorrectedV1(),
    await runApprovalRejectionAbortsTurnV1(),
    await runApprovedParallelToolsV1(),
    await runUnknownDispatchAndLateTerminalV1(),
    await runRequiredVerificationBlocksFalseCompletionV1(),
    await runBoundedCleanupRetainsUnknownV1(),
  ] as const;
  return [
    adapterResult('runtime-tool-approval-verification-v1', outcomes[0]!),
    adapterResult('runtime-invalid-tool-correction-v1', outcomes[1]!),
    adapterResult('runtime-approval-rejection-v1', outcomes[2]!),
    adapterResult('runtime-approved-parallel-tools-v1', outcomes[3]!),
    adapterResult('runtime-unknown-late-terminal-v1', outcomes[4]!),
    adapterResult('runtime-required-verification-v1', outcomes[5]!),
    adapterResult('runtime-bounded-cleanup-v1', outcomes[6]!),
  ];
}

export function buildL1ToolVerificationEvaluatorV1(): L1ToolVerificationEvaluatorIdentityV1 {
  return buildL1ToolVerificationEvaluatorIdentityV1({
    oracle: { eventProjection: 'type-only-v1', stateProjection: 'status-only-v1' },
    verifier: { verifier: 'executeVerificationEffect', reviewer: 'in-memory-v1' },
    runner: {
      kernel: 'AgentKernel',
      runner: L1_TOOL_VERIFICATION_RUNNER_ID_V1,
      fixtureId: L1_TOOL_VERIFICATION_FIXTURE_ID_V1,
    },
    scheduler: { scheduler: 'decideNextEffect', clock: 'fixed-fixture-clock-v1' },
    faultInjection: {
      approval: 'rejection-v1',
      lateTerminal: 'stale-lease-v1',
      cleanup: 'cancel-incomplete-v1',
    },
  });
}

/**
 * Evaluate the immutable L1 corpus from a fresh, local execution. The report
 * contains only IDs, outcome tokens, and digests; it cannot carry model/tool
 * content, prompts, fixture paths, credentials, or an endpoint.
 */
export async function runL1ToolVerificationContractCorpusV1(
  input: { evaluator?: L1ToolVerificationEvaluatorIdentityV1 } = {},
): Promise<L1ToolVerificationReportV1> {
  const results = await runL1ToolVerificationAdaptersV1();
  const accepted = new Map(
    results.map((result) => [result.adapterId, result.outcome === 'passed']),
  );
  const observations: L1ToolVerificationCaseObservationV1[] = [
    l1ObservationForCaseV1(
      'l1-approval-rejection-aborts-turn-v1',
      accepted.get('runtime-approval-rejection-v1') === true,
    ),
    l1ObservationForCaseV1(
      'l1-approved-parallel-tools-v1',
      accepted.get('runtime-approved-parallel-tools-v1') === true,
    ),
    l1ObservationForCaseV1(
      'l1-bounded-cleanup-retains-unknown-v1',
      accepted.get('runtime-bounded-cleanup-v1') === true,
    ),
    l1ObservationForCaseV1(
      'l1-invalid-tool-arguments-corrected-v1',
      accepted.get('runtime-invalid-tool-correction-v1') === true,
    ),
    l1ObservationForCaseV1(
      'l1-required-verification-blocks-false-completion-v1',
      accepted.get('runtime-required-verification-v1') === true,
    ),
    l1ObservationForCaseV1(
      'l1-tool-approval-execution-verification-v1',
      accepted.get('runtime-tool-approval-verification-v1') === true,
    ),
    l1ObservationForCaseV1(
      'l1-unknown-dispatch-and-late-terminal-v1',
      accepted.get('runtime-unknown-late-terminal-v1') === true,
    ),
  ];
  return evaluateL1ToolVerificationCorpusV1({
    evaluator: input.evaluator ?? buildL1ToolVerificationEvaluatorV1(),
    observations,
  });
}
