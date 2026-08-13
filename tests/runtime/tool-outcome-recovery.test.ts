import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalizeCapabilityArguments } from '@/core/capabilities/schema';
import { executeRuntimeTools } from '@/core/controllers/tool-controller';
import { McpProviderError } from '@/core/mcp';
import { McpConnectionManager } from '@/core/mcp/manager';
import { buildContextProjection } from '@/core/model/context-projection';
import { decideCompletionV2 } from '@/core/runtime/completion-guard';
import type { RuntimeEvent } from '@/core/runtime/events';
import { createRuntimeEffectExecutor } from '@/core/runtime/executor';
import { classifyFailure } from '@/core/runtime/failures';
import { AgentKernel, createAgentKernel } from '@/core/runtime/kernel';
import {
  planCompletionBlocker,
  projectPlanCompletionEvidenceV1,
} from '@/core/runtime/plan-evidence';
import { reduceRuntimeState, reduceRuntimeStateFromHistoricalSchema } from '@/core/runtime/reducer';
import { runRuntimeLoop } from '@/core/runtime/runner';
import { decideNextEffect } from '@/core/runtime/scheduler';
import { computePlanStructuralDigest, createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import {
  classifyToolOutcomeV1,
  isToolOutcomeV1,
  observeUnknownToolFieldsV1,
  type ToolOutcomeV1,
} from '@/core/runtime/tool-outcome';
import { decodeHistoricalToolOutcomeEventV1 } from '@/core/runtime/tool-outcome-events';
import {
  admitRecoveryAttemptV1,
  advanceToolRecoveryResponseV1,
  closeToolRecoveryScopeV1,
  createToolRecoveryJournalV1,
  isToolRecoveryQualityBlockedV1,
  normalizeToolRecoveryJournalV1,
  recordRecoveryExhaustionV1,
  recordRecoveryFailureV1,
  recordRecoveryInvocationV1,
  recordToolOwnedProgressV1,
  toolFailureInstanceIdV1,
  toolInvocationFingerprintV1,
} from '@/core/runtime/tool-recovery-journal';
import { taskSpec } from '@/core/tools/registry/builtins/task';
import { dispatchRegisteredTool } from '@/core/tools/registry/dispatch';
import { defineExecutableTool } from '@/core/tools/registry/spec';
import type { ShellExecutor } from '@/core/tools/shell';
import { shellTool } from '@/core/tools/shell';

const correctArgsOutcome = classifyToolOutcomeV1({
  status: 'failed',
  failure: classifyFailure('tool_invalid_args', 'private args'),
  authority: { dispatchState: 'not_started', externalEffects: 'none' },
});

function legacyFailedReplayOutcome(): ToolOutcomeV1 {
  const event = decodeHistoricalToolOutcomeEventV1({
    type: 'tool.failed',
    toolCallId: 'historical-call',
    error: 'historical failure text',
  });
  if (event.type !== 'tool.failed' || !event.outcomeV1) {
    throw new Error('Historical ToolOutcome decoder did not produce an outcome.');
  }
  return event.outcomeV1;
}

describe('ToolOutcomeV1', () => {
  test('rejects a non-canonical current terminal before reducer consumption', () => {
    const state = createInitialRuntimeState({
      threadId: 'non-canonical-current-terminal',
      userId: 'user',
      workspace: '/workspace',
    });
    expect(() =>
      reduceRuntimeState(state, {
        type: 'tool.failed',
        toolCallId: 'missing-outcome',
        error: 'legacy-only terminal',
      }),
    ).toThrow('tool.failed requires a canonical ToolOutcomeV1');
  });

  test('maps legacy failed replay to unclassified unknown certainty and never retry', () => {
    expect(legacyFailedReplayOutcome()).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        status: 'failed',
        failure: { kind: 'tool_runtime_error', detailCode: 'legacy_unclassified' },
        dispatchState: 'unknown',
        externalEffects: 'unknown',
        recovery: expect.objectContaining({
          disposition: 'never',
          maximumAdditionalCalls: 0,
          safeAutomaticRetry: false,
        }),
      }),
    );
  });

  test('policy and approval authority force zero-dispatch never regardless of tool advice', () => {
    for (const kind of ['policy_denied', 'approval_rejected'] as const) {
      const outcome = classifyToolOutcomeV1({
        status: 'rejected',
        failure: classifyFailure(kind, 'sensitive detail'),
        authority: { policyDenied: true, dispatchState: 'not_started', externalEffects: 'none' },
      });
      expect(outcome).toMatchObject({
        status: 'rejected',
        dispatchState: 'not_started',
        externalEffects: 'none',
        recovery: {
          disposition: 'never',
          maximumAdditionalCalls: 0,
          requiresNewModelResponse: false,
          safeAutomaticRetry: false,
        },
      });
    }
  });

  test('fails closed when globally valid ToolSpec detail advice belongs to another failure kind', () => {
    const outcome = classifyToolOutcomeV1({
      status: 'failed',
      failure: classifyFailure('tool_runtime_error', 'private runtime failure'),
      authority: { dispatchState: 'started', externalEffects: 'none', replaySafety: 'safe_read' },
      toolAdvice: { detailCode: 'invalid_arguments' },
    });

    expect(outcome).toMatchObject({
      status: 'unknown',
      failure: { kind: 'unknown', detailCode: 'classifier_conflict' },
      recovery: {
        disposition: 'never',
        maximumAdditionalCalls: 0,
        safeAutomaticRetry: false,
      },
      diagnosticCodes: ['classifier_conflict'],
    });
    expect(isToolOutcomeV1(outcome)).toBe(true);
  });

  test('classifier conflict and unknown detail fail closed', () => {
    const outcome = classifyToolOutcomeV1({
      status: 'failed',
      failure: classifyFailure('tool_runtime_error', 'raw error'),
      authority: { dispatchState: 'started', externalEffects: 'unknown' },
      toolAdvice: {
        detailCode: 'not_in_the_closed_set',
        disposition: 'retry_once',
        safeAutomaticRetry: true,
        maximumAdditionalCalls: 1,
      },
    });
    expect(outcome).toMatchObject({
      status: 'unknown',
      failure: { kind: 'unknown', detailCode: 'classifier_invalid' },
      recovery: { disposition: 'never', safeAutomaticRetry: false },
      diagnosticCodes: ['classifier_invalid'],
    });

    const conflicting = classifyToolOutcomeV1({
      status: 'failed',
      failure: classifyFailure('provider_unavailable', 'redacted'),
      authority: { dispatchState: 'started', externalEffects: 'unknown' },
      toolAdvice: {
        detailCode: 'provider_unavailable',
        disposition: 'retry_once',
        safeAutomaticRetry: true,
        maximumAdditionalCalls: 1,
      },
    });
    expect(conflicting).toMatchObject({
      status: 'unknown',
      failure: { kind: 'unknown', detailCode: 'classifier_conflict' },
      recovery: { disposition: 'never', safeAutomaticRetry: false },
      diagnosticCodes: ['classifier_conflict'],
    });
  });

  test('only a pre-dispatch or proven safe-read/idempotency receipt permits one auto retry', () => {
    const candidates: Array<[Partial<ToolOutcomeV1>, boolean]> = [
      [{ dispatchState: 'not_started', externalEffects: 'none' }, true],
      [{ dispatchState: 'started', externalEffects: 'none', replaySafety: 'safe_read' }, true],
      [
        { dispatchState: 'started', externalEffects: 'known', replaySafety: 'idempotency_receipt' },
        true,
      ],
      [{ dispatchState: 'started', externalEffects: 'unknown', replaySafety: 'safe_read' }, false],
      [{ dispatchState: 'unknown', externalEffects: 'unknown' }, false],
    ];
    for (const [candidate, expected] of candidates) {
      const outcome = classifyToolOutcomeV1({
        status: 'failed',
        failure: classifyFailure('provider_unavailable', 'not persisted'),
        authority: {
          dispatchState: candidate.dispatchState!,
          externalEffects: candidate.externalEffects!,
          replaySafety: candidate.replaySafety,
        },
        toolAdvice: {
          disposition: 'retry_once',
          safeAutomaticRetry: true,
          maximumAdditionalCalls: 1,
        },
      });
      expect(outcome.recovery.safeAutomaticRetry).toBe(expected);
      expect(outcome.recovery.maximumAdditionalCalls).toBe(expected ? 1 : 0);
    }
  });

  test('unknown-field observation is low cardinality and never retains names or values', () => {
    const observation = observeUnknownToolFieldsV1({
      toolName: 'read_file',
      args: { path: '/private/work.txt', unexpected_secret: 'hunter2', another: 1 },
      knownFields: ['path'],
      schemaRevision: 'builtin-v3',
    });
    expect(observation).toEqual({
      hasUnknown: true,
      count: 2,
      toolClass: 'builtin_read',
      schemaRevision: 'builtin-v3',
    });
    expect(JSON.stringify(observation)).not.toContain('unexpected_secret');
    expect(JSON.stringify(observation)).not.toContain('hunter2');
    expect(
      observeUnknownToolFieldsV1({
        toolName: 'mcp__private__send',
        args: { secret: 'value' },
        knownFields: [],
        schemaRevision: 'dynamic',
      }).toolClass,
    ).toBe('mcp_tool');
  });

  test('ToolSpec classifier exceptions become a closed diagnostic instead of escaping', async () => {
    const spec = defineExecutableTool({
      name: 'test_classifier',
      kind: 'computer',
      contract: {
        summary: 'Test classifier.',
        useWhen: 'Only in tests.',
        returns: { format: 'json', description: 'Test output.' },
        constraints: 'Accept only the declared value field.',
        recovery: 'Use Runtime fallback when the test classifier is invalid.',
      },
      inputSchema: z.object({ value: z.string() }),
      declaredEffects: {
        filesystem: 'none',
        network: 'none',
        externalState: 'none',
      },
      minimumApproval: 'none',
      effects: () => ({
        effectClass: 'read_only',
        sideEffect: false,
        classificationReason: 'test',
      }),
      execute: async () => ({ ok: false }),
      projectResult: () => ({
        ok: false,
        modelContent: 'private body',
        resultMeta: {},
        display: { verb: 'test' },
      }),
      classifyOutcomeV1: () => {
        throw new Error('private classifier exception');
      },
    });
    const dispatched = await dispatchRegisteredTool(
      spec,
      { value: 'private' },
      {
        workspace: '/workspace',
      },
    );
    expect(dispatched).toMatchObject({
      dispatched: true,
      projected: { classifierDiagnostic: 'classifier_threw' },
    });
    expect(JSON.stringify(dispatched)).not.toContain('private classifier exception');
  });

  test('rejects persisted envelopes whose recovery semantics conflict with status or certainty', () => {
    const failed = classifyToolOutcomeV1({
      status: 'failed',
      failure: classifyFailure('provider_unavailable', 'private'),
      authority: { dispatchState: 'started', externalEffects: 'none', replaySafety: 'safe_read' },
      toolAdvice: {
        disposition: 'retry_once',
        maximumAdditionalCalls: 1,
        safeAutomaticRetry: true,
      },
    });
    const contradictory: unknown[] = [
      { ...failed, externalEffects: 'unknown', replaySafety: 'safe_read' },
      {
        ...failed,
        status: 'success',
        failure: undefined,
        recovery: { ...failed.recovery, disposition: 'retry_once' },
      },
      {
        ...failed,
        recovery: { ...failed.recovery, disposition: 'never', maximumAdditionalCalls: 1 },
      },
      {
        ...failed,
        dispatchState: 'not_started',
        externalEffects: 'known',
        replaySafety: 'pre_dispatch',
      },
      {
        ...failed,
        recovery: {
          ...failed.recovery,
          disposition: 'correct_args',
          safeAutomaticRetry: true,
          requiresNewModelResponse: false,
        },
      },
    ];
    for (const candidate of contradictory) expect(isToolOutcomeV1(candidate)).toBe(false);
  });

  test('rejects rejected retry and kind/detail/recovery authority contradictions', () => {
    const rejectedRetry = classifyToolOutcomeV1({
      status: 'failed',
      failure: classifyFailure('provider_unavailable', 'redacted'),
      authority: { dispatchState: 'not_started', externalEffects: 'none' },
      toolAdvice: { disposition: 'retry_once', maximumAdditionalCalls: 1 },
    });
    expect(
      isToolOutcomeV1({
        ...rejectedRetry,
        status: 'rejected',
      }),
    ).toBe(false);
    expect(
      isToolOutcomeV1({
        ...correctArgsOutcome,
        failure: { kind: 'policy_denied', detailCode: 'invalid_arguments' },
      }),
    ).toBe(false);
    expect(
      isToolOutcomeV1({
        ...correctArgsOutcome,
        failure: { kind: 'policy_denied', detailCode: 'policy_denied' },
      }),
    ).toBe(false);
  });

  test('accepts Runtime-authoritative phase rejection envelopes without losing phase detail', () => {
    for (const kind of ['phase_deferred', 'phase_denied'] as const) {
      const outcome = classifyToolOutcomeV1({
        status: 'rejected',
        failure: classifyFailure(kind, 'redacted'),
        authority: {
          dispatchState: 'not_started',
          externalEffects: 'none',
          replaySafety: 'pre_dispatch',
        },
      });
      expect(outcome).toMatchObject({
        status: 'rejected',
        failure: { kind, detailCode: kind },
        recovery: { disposition: 'correct_args', maximumAdditionalCalls: 1 },
      });
      expect(isToolOutcomeV1(outcome)).toBe(true);
    }
  });

  test('validates the detail-code matrix for every FailureKind and rejects cross-kind detail reuse', () => {
    const kinds = [
      'model_invalid_tool_args',
      'model_refused',
      'model_timeout',
      'model_rate_limited',
      'model_server_error',
      'policy_denied',
      'phase_deferred',
      'phase_denied',
      'approval_rejected',
      'auto_review_rejected',
      'plan_revision_requested',
      'tool_runtime_error',
      'tool_timeout',
      'tool_invalid_args',
      'tool_not_found',
      'provider_auth_required',
      'provider_approval_required',
      'provider_unavailable',
      'provider_capability_changed',
      'user_input_cancelled',
      'user_input_timeout',
      'sandbox_error',
      'checkpoint_restore_error',
      'transcript_invariant_error',
      'loop_exhausted',
      'budget_exceeded',
      'artifact_invalid',
      'profile_invalid',
      'digest_invalid',
      'workspace_untrusted',
      'network_unavailable',
      'worktree_unavailable',
      'model_retry_exhausted',
      'mcp_unavailable',
      'persistence_unavailable',
      'resource_saturated',
      'process_limit_exceeded',
      'cancel_incomplete',
      'compaction_unqualified',
      'compaction_failed',
      'verification_failed',
      'verification_inconclusive',
      'mandatory_policy_unavailable',
      'unknown',
    ] as const satisfies readonly import('@/core/runtime/failures').FailureKind[];
    for (const kind of kinds) {
      const authoritativeDeny = [
        'policy_denied',
        'mandatory_policy_unavailable',
        'approval_rejected',
        'auto_review_rejected',
      ].includes(kind);
      const outcome = classifyToolOutcomeV1({
        status: authoritativeDeny ? 'rejected' : 'failed',
        failure: classifyFailure(kind, 'redacted'),
        authority: {
          dispatchState: 'not_started',
          externalEffects: 'none',
          replaySafety: 'pre_dispatch',
          policyDenied: kind === 'policy_denied' || kind === 'mandatory_policy_unavailable',
          approvalDenied: kind === 'approval_rejected' || kind === 'auto_review_rejected',
        },
      });
      expect(isToolOutcomeV1(outcome)).toBe(true);
      if (kind !== 'approval_rejected') {
        expect(
          isToolOutcomeV1({
            ...outcome,
            failure: { kind, detailCode: 'approval_rejected' },
          }),
        ).toBe(false);
      }
    }
  });
});

describe('ToolOutcome controller recovery integration', () => {
  test('persists safe-read retry evidence before the one authorized replay', async () => {
    const state = createInitialRuntimeState({
      threadId: 'tool-outcome-safe-read-retry',
      userId: 'user',
      workspace: process.cwd(),
    });
    const descriptor = {
      capabilityId: 'mcp:fixture/read',
      revision: 'safe-read-v1',
      kind: 'mcp_tool' as const,
      displayName: 'read',
      description: 'Read fixture metadata.',
      provider: { type: 'mcp' as const, id: 'fixture', provenance: 'project' as const },
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
      execution: { retry: 'safe_read' as const },
      availability: 'available' as const,
      diagnostics: [],
    };
    state.capabilities.bindings.binding = {
      bindingId: 'binding',
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      exposedToolName: 'mcp__fixture__read',
      schemaDigest: 'schema',
      issuedForTurnId: state.turn.turnId,
    };
    state.tools.calls.read = {
      toolCallId: 'read',
      modelMessageId: 'model',
      name: 'mcp__fixture__read',
      args: {},
      status: 'queued',
      bindingId: 'binding',
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('read');

    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(providerId: string, timeoutMs?: number): Promise<void>;
    };
    const order: string[] = [];
    let readinessChecks = 0;
    runtimeManager.ensureProviderReady = async () => {
      readinessChecks += 1;
      order.push(`pre-dispatch-${readinessChecks}`);
      if (readinessChecks === 1) {
        throw new McpProviderError({
          providerId: 'fixture',
          kind: 'provider_unavailable',
          message: 'redacted pre-dispatch outage',
          recoveryAction: 'retry',
          retryable: true,
        });
      }
    };
    manager.findCapability = () => descriptor;
    let calls = 0;
    const emitted: string[] = [];
    const persisted: string[] = [];
    manager.callCapability = async () => {
      calls += 1;
      order.push(`dispatch-${calls}`);
      return { content: [] };
    };

    await executeRuntimeTools({
      state,
      toolCallIds: ['read'],
      mcpManager: runtimeManager,
      emitRuntimeEvent: (event) => {
        order.push(event.type);
        emitted.push(event.type);
      },
      persistRuntimeEvent: async (event) => {
        order.push(`persist:${event.type}`);
        persisted.push(event.type);
        return true;
      },
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

    expect(readinessChecks).toBe(2);
    expect(calls).toBe(1);
    expect(order.indexOf('persist:tool.retry_recorded')).toBeGreaterThan(
      order.indexOf('pre-dispatch-1'),
    );
    expect(order.indexOf('persist:tool.retry_recorded')).toBeLessThan(
      order.indexOf('pre-dispatch-2'),
    );
    expect(order.indexOf('persist:tool.retry_recorded')).toBeLessThan(order.indexOf('dispatch-1'));
    expect(persisted).toEqual(['tool.retry_recorded']);
    expect(emitted).not.toContain('tool.retry_recorded');
    expect(emitted.filter((eventType) => eventType === 'tool.finished')).toHaveLength(1);
  });

  test('does not perform the second provider dispatch when retry evidence is not durably acked', async () => {
    const state = createInitialRuntimeState({
      threadId: 'tool-outcome-safe-read-persist-failure',
      userId: 'user',
      workspace: process.cwd(),
    });
    const descriptor = {
      capabilityId: 'mcp:fixture/read',
      revision: 'safe-read-v1',
      kind: 'mcp_tool' as const,
      displayName: 'read',
      description: 'Read fixture metadata.',
      provider: { type: 'mcp' as const, id: 'fixture', provenance: 'project' as const },
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
      execution: { retry: 'safe_read' as const },
      availability: 'available' as const,
      diagnostics: [],
    };
    state.capabilities.bindings.binding = {
      bindingId: 'binding',
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      exposedToolName: 'mcp__fixture__read',
      schemaDigest: 'schema',
      issuedForTurnId: state.turn.turnId,
    };
    state.tools.calls.read = {
      toolCallId: 'read',
      modelMessageId: 'model',
      name: 'mcp__fixture__read',
      args: {},
      status: 'queued',
      bindingId: 'binding',
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('read');
    const manager = new McpConnectionManager();
    const runtimeManager = manager as McpConnectionManager & {
      ensureProviderReady(): Promise<void>;
    };
    runtimeManager.ensureProviderReady = async () => {
      throw new McpProviderError({
        providerId: 'fixture',
        kind: 'provider_unavailable',
        message: 'private pre-dispatch outage',
        recoveryAction: 'retry',
        retryable: true,
      });
    };
    manager.findCapability = () => descriptor;
    let calls = 0;
    manager.callCapability = async () => {
      calls += 1;
      return { content: [] };
    };
    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['read'],
      mcpManager: runtimeManager,
      persistRuntimeEvent: async () => false,
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
    expect(calls).toBe(0);
    expect(events.some((event) => event.type === 'tool.failed')).toBe(true);
  });

  test('persists the running retry lineage before dispatch two and preserves its ceiling after a crash', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kite-safe-read-restart-'));
    const storePath = join(directory, 'runtime.db');
    const threadId = 'safe-read-restart';
    const descriptor = {
      capabilityId: 'mcp:fixture/read',
      revision: 'safe-read-v1',
      kind: 'mcp_tool' as const,
      displayName: 'read',
      description: 'Read fixture metadata.',
      provider: { type: 'mcp' as const, id: 'fixture', provenance: 'project' as const },
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
      execution: { retry: 'safe_read' as const },
      availability: 'available' as const,
      diagnostics: [],
    };
    const config = {
      apiKey: '',
      baseURL: 'http://localhost',
      modelName: 'test',
      providerName: 'test',
      providerType: 'openai-compatible' as const,
      sandbox: { enabled: false },
      features: { capabilityCatalogV1: true, mcpRuntimeBindingV1: true },
    };
    try {
      const state = createInitialRuntimeState({
        threadId,
        userId: 'user',
        workspace: directory,
      });
      state.capabilities.bindings.binding = {
        bindingId: 'binding',
        capabilityId: descriptor.capabilityId,
        capabilityRevision: descriptor.revision,
        exposedToolName: 'mcp__fixture__read',
        schemaDigest: 'schema',
        issuedForTurnId: state.turn.turnId,
      };
      state.tools.calls.read = {
        toolCallId: 'read',
        modelMessageId: 'model',
        name: 'mcp__fixture__read',
        args: {},
        status: 'queued',
        bindingId: 'binding',
        capabilityId: descriptor.capabilityId,
        capabilityRevision: descriptor.revision,
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue.push('read');
      const store = createRuntimeStore(storePath);
      const persistedBatches: string[][] = [];
      const append = store.appendEventsAndSnapshot.bind(store);
      let retryAcked = false;
      store.appendEventsAndSnapshot = (persistedThreadId, events, snapshot, metadata) => {
        const types = events.map((event) => event.type);
        if (retryAcked && types.includes('tool.failed')) {
          throw new Error('simulated process crash after retry acknowledgement');
        }
        append(persistedThreadId, events, snapshot, metadata);
        persistedBatches.push(types);
        if (types.includes('tool.retry_recorded')) retryAcked = true;
      };
      const kernel = new AgentKernel({
        store,
        initialState: state,
        interactionMode: 'accept_edits',
      });
      const manager = new McpConnectionManager();
      const runtimeManager = manager as McpConnectionManager & {
        ensureProviderReady(): Promise<void>;
      };
      runtimeManager.ensureProviderReady = async () => {};
      manager.findCapability = () => descriptor;
      let dispatches = 0;
      manager.callCapability = async () => {
        dispatches += 1;
        throw new McpProviderError({
          providerId: 'fixture',
          kind: 'provider_unavailable',
          message: 'redacted outage',
          recoveryAction: 'retry',
          retryable: dispatches === 1,
        });
      };
      const executor = createRuntimeEffectExecutor({
        config,
        model: {} as never,
        mcpManager: runtimeManager,
        runtimeStore: store,
      });
      let crashed = false;
      try {
        for await (const _event of runRuntimeLoop(kernel, executor, {
          requestAction: async () => ({ type: 'cancel', interactionId: 'none' }),
        })) {
          // Drain until the injected Store fault aborts the effect.
        }
      } catch (error) {
        crashed = String(error).includes('simulated process crash');
      }
      expect(crashed).toBe(true);
      expect(dispatches).toBe(2);
      expect(persistedBatches.flat().filter((type) => type === 'tool.started')).toHaveLength(1);
      expect(persistedBatches.some((batch) => batch.includes('tool.started'))).toBe(true);
      expect(persistedBatches.some((batch) => batch.includes('tool.retry_recorded'))).toBe(true);
      const retryFailureId = kernel.getState().tools.calls.read?.recoveryOf;
      expect(retryFailureId).toMatch(/^[a-f0-9]{64}$/);
      expect(kernel.getState().toolRecovery.failures[retryFailureId!]).toMatchObject({
        automaticRetryAttempts: 1,
      });
      kernel.close();

      const restored = createAgentKernel({
        threadId,
        userId: 'user',
        workspace: directory,
        storePath,
      });
      expect(restored.getState().toolRecovery.failures[retryFailureId!]).toMatchObject({
        automaticRetryAttempts: 1,
      });
      restored.processEvent({
        type: 'tool.queued',
        toolCallId: 'read-after-restart',
        name: 'mcp__fixture__read',
        args: {},
        modelMessageId: 'model-after-restart',
        bindingId: 'binding',
        capabilityId: descriptor.capabilityId,
        capabilityRevision: descriptor.revision,
        recoveryMode: 'automatic_retry',
      });
      const restoredState = restored.getState();
      expect(restoredState.tools.calls['read-after-restart']?.recoveryAdmission).toBe(
        'recovery_exhausted',
      );
      const blocked = await executeRuntimeTools({
        state: restoredState,
        toolCallIds: ['read-after-restart'],
        mcpManager: runtimeManager,
        taskConfig: config,
      });
      expect(blocked.some((event) => event.type === 'tool.rejected')).toBe(true);
      expect(dispatches).toBe(2);
      restored.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('durable recovery journal', () => {
  test('keeps journal_invalid absorbing across every recovery mutator', () => {
    const invalid = normalizeToolRecoveryJournalV1(undefined);
    const failureInput = {
      toolCallId: 'after-invalid',
      toolName: 'read_file',
      invocationFingerprint: 'e'.repeat(64),
      modelMessageId: 'model-after-invalid',
      outcome: correctArgsOutcome,
      taskId: 'invalid-task',
      turnId: 'invalid-turn',
    };
    const recorded = recordRecoveryFailureV1(invalid, failureInput);
    const failureId = recorded.order.at(-1)!;
    const progressed = recordToolOwnedProgressV1(recorded, {
      kind: 'receipt',
      referenceId: 'success-receipt',
      resolvesFailureIds: [failureId],
    });
    const closed = closeToolRecoveryScopeV1(progressed, {
      kind: 'failure',
      failureIds: [failureId],
      resolution: 'skipped',
    });
    const exhausted = recordRecoveryExhaustionV1(closed, {
      ...failureInput,
      toolCallId: 'exhaustion-after-invalid',
    });
    for (const journal of [recorded, progressed, closed, exhausted]) {
      expect(journal.qualityGuard).toMatchObject({
        blocked: true,
        reasonCode: 'journal_invalid',
      });
      expect(
        admitRecoveryAttemptV1(journal, {
          toolCallId: 'escape-after-invalid',
          toolName: 'write_plan',
          invocationFingerprint: 'f'.repeat(64),
          modelMessageId: 'escape-model',
          mode: 'model_correction',
          taskId: 'invalid-task',
          turnId: 'invalid-turn',
        }),
      ).toMatchObject({ admitted: false });
      expect(
        isToolRecoveryQualityBlockedV1(journal, {
          taskId: 'different-task',
          turnId: 'different-turn',
        }),
      ).toBe(true);
      expect(
        admitRecoveryAttemptV1(journal, {
          toolCallId: 'cross-turn-after-invalid',
          toolName: 'read_file',
          invocationFingerprint: '1'.repeat(64),
          modelMessageId: 'different-model',
          mode: 'model_correction',
          taskId: 'different-task',
          turnId: 'different-turn',
        }),
      ).toMatchObject({ admitted: false, detailCode: 'no_progress' });
    }
  });

  test('prunes the 129th record with its recovery lineage intact', () => {
    let journal = createToolRecoveryJournalV1();
    for (let index = 0; index < 127; index += 1) {
      journal = recordRecoveryFailureV1(journal, {
        toolCallId: `old-${index}`,
        toolName: 'read_file',
        invocationFingerprint: index.toString(16).padStart(64, '0'),
        modelMessageId: `old-model-${index}`,
        outcome: correctArgsOutcome,
        taskId: 'bounded-task',
        turnId: 'bounded-turn',
      });
    }
    journal = recordRecoveryFailureV1(journal, {
      toolCallId: 'lineage-parent',
      toolName: 'read_file',
      invocationFingerprint: 'a'.repeat(64),
      modelMessageId: 'lineage-parent-model',
      outcome: correctArgsOutcome,
      taskId: 'bounded-task',
      turnId: 'bounded-turn',
    });
    const parentId = journal.order.at(-1)!;
    journal = recordRecoveryFailureV1(journal, {
      toolCallId: 'lineage-child',
      toolName: 'read_file',
      invocationFingerprint: 'b'.repeat(64),
      modelMessageId: 'lineage-child-model',
      outcome: classifyToolOutcomeV1({
        status: 'failed',
        failure: classifyFailure('tool_invalid_args', 'redacted'),
        authority: { dispatchState: 'not_started', externalEffects: 'none' },
        lineage: { recoveryOf: parentId },
      }),
      taskId: 'bounded-task',
      turnId: 'bounded-turn',
    });
    const childId = journal.order.at(-1)!;

    expect(journal.order).toHaveLength(128);
    expect(journal.failures[parentId]).toBeDefined();
    expect(journal.failures[childId]?.outcome.lineage?.recoveryOf).toBe(parentId);
    expect(normalizeToolRecoveryJournalV1(JSON.parse(JSON.stringify(journal)))).toEqual(journal);
  });

  test('canonical identity preserves malformed raw equality and MCP schema defaults', () => {
    const key = 'a'.repeat(64);
    const malformedOne = toolInvocationFingerprintV1({
      key,
      toolName: 'read_file',
      parseCode: 'invalid_arguments',
      unparsedArgs: { path: 1 },
    });
    const malformedOneAgain = toolInvocationFingerprintV1({
      key,
      toolName: 'read_file',
      parseCode: 'invalid_arguments',
      unparsedArgs: { path: 1 },
    });
    const malformedTwo = toolInvocationFingerprintV1({
      key,
      toolName: 'read_file',
      parseCode: 'invalid_arguments',
      unparsedArgs: { path: 2 },
    });
    expect(malformedOneAgain).toBe(malformedOne);
    expect(malformedTwo).not.toBe(malformedOne);

    const schema = {
      type: 'object',
      properties: { limit: { type: 'integer', default: 10 } },
      additionalProperties: false,
    };
    expect(canonicalizeCapabilityArguments(schema, {})).toEqual({ ok: true, args: { limit: 10 } });
    expect(canonicalizeCapabilityArguments(schema, { limit: 10 })).toEqual({
      ok: true,
      args: { limit: 10 },
    });
  });

  test('fails closed instead of resetting the ceiling when persisted journal data is malformed', () => {
    expect(normalizeToolRecoveryJournalV1(undefined)).toMatchObject({
      schemaVersion: 1,
      failures: {},
      order: [],
      progressRevision: 0,
      qualityGuard: { blocked: true, reasonCode: 'journal_invalid', observedFailures: 0 },
    });
    const malformed = normalizeToolRecoveryJournalV1({
      schemaVersion: 1,
      identityKey: 'a'.repeat(64),
      failures: {},
      order: ['not-a-private-identity'],
      progressRevision: 1,
      qualityGuard: { blocked: false, observedFailures: 1 },
    });
    expect(malformed.qualityGuard).toEqual({
      blocked: true,
      reasonCode: 'journal_invalid',
      observedFailures: 1,
    });
    expect(
      admitRecoveryAttemptV1(malformed, {
        toolCallId: 'next',
        toolName: 'read_file',
        invocationFingerprint: 'b'.repeat(64),
        modelMessageId: 'model-next',
        mode: 'model_correction',
      }),
    ).toEqual({ admitted: false, detailCode: 'no_progress' });

    const scoped = recordRecoveryFailureV1(createToolRecoveryJournalV1(), {
      toolCallId: 'scoped',
      toolName: 'read_file',
      invocationFingerprint: 'c'.repeat(64),
      modelMessageId: 'model-scoped',
      outcome: correctArgsOutcome,
      taskId: 'task-scoped',
      turnId: 'turn-scoped',
    });
    const unknownTopLevel = { ...scoped, private_body: 'must not be accepted' };
    expect(normalizeToolRecoveryJournalV1(unknownTopLevel).qualityGuard).toMatchObject({
      blocked: true,
      taskId: 'task-scoped',
      turnId: 'turn-scoped',
    });
    const failureId = scoped.order[0]!;
    const contradictoryResolution = {
      ...scoped,
      failures: {
        ...scoped.failures,
        [failureId]: {
          ...scoped.failures[failureId]!,
          status: 'recovered',
          resolution: 'terminal',
        },
      },
    };
    expect(normalizeToolRecoveryJournalV1(contradictoryResolution).qualityGuard).toMatchObject({
      blocked: true,
      reasonCode: 'journal_invalid',
      taskId: 'task-scoped',
      turnId: 'turn-scoped',
    });

    const original = scoped.failures[failureId]!;
    const forgedId = 'b'.repeat(64);
    const forgedConsistentIds = {
      ...scoped,
      failures: {
        [forgedId]: {
          ...original,
          failureInstanceId: forgedId,
          outcome: {
            ...original.outcome,
            lineage: { ...original.outcome.lineage, failureInstanceId: forgedId },
          },
        },
      },
      order: [forgedId],
    };
    expect(normalizeToolRecoveryJournalV1(forgedConsistentIds).qualityGuard).toMatchObject({
      blocked: true,
      reasonCode: 'journal_invalid',
      taskId: 'task-scoped',
      turnId: 'turn-scoped',
    });

    expect(
      toolFailureInstanceIdV1({
        toolCallId: original.toolCallId,
        invocationFingerprint: original.invocationFingerprint,
        outcome: original.outcome,
      }),
    ).toBe(failureId);
    const danglingRecovery = {
      ...scoped,
      failures: {
        [failureId]: {
          ...original,
          outcome: {
            ...original.outcome,
            lineage: { ...original.outcome.lineage, recoveryOf: 'c'.repeat(64) },
          },
          modelCorrectionAttempts: 1,
        },
      },
    };
    expect(normalizeToolRecoveryJournalV1(danglingRecovery).qualityGuard).toMatchObject({
      blocked: true,
      reasonCode: 'journal_invalid',
    });
  });

  test('binds the next eligible model correction and enforces exactly one attempt after restore', () => {
    let journal = createToolRecoveryJournalV1();
    journal = recordRecoveryFailureV1(journal, {
      toolCallId: 'first',
      toolName: 'read_file',
      invocationFingerprint: 'private-fingerprint',
      modelMessageId: 'model-1',
      outcome: correctArgsOutcome,
    });
    const failureId = journal.order[0]!;
    journal = advanceToolRecoveryResponseV1(journal, {
      modelMessageId: 'model-2',
      toolCalls: [{ id: 'second', name: 'read_file' }],
    });
    const admitted = admitRecoveryAttemptV1(journal, {
      toolCallId: 'second',
      toolName: 'read_file',
      invocationFingerprint: 'changed-private-fingerprint',
      modelMessageId: 'model-2',
      mode: 'model_correction',
    });
    expect(admitted).toEqual({ admitted: true, recoveryOf: failureId });
    journal = recordRecoveryInvocationV1(journal, {
      toolCallId: 'second',
      recoveryOf: failureId,
      mode: 'model_correction',
    });
    journal = recordRecoveryFailureV1(journal, {
      toolCallId: 'second',
      toolName: 'read_file',
      invocationFingerprint: 'changed-private-fingerprint',
      modelMessageId: 'model-2',
      outcome: classifyToolOutcomeV1({
        status: 'failed',
        failure: classifyFailure('tool_invalid_args', 'still invalid'),
        authority: { dispatchState: 'not_started', externalEffects: 'none' },
        lineage: { recoveryOf: failureId },
      }),
    });
    const childFailureId = journal.order.at(-1)!;

    // JSON round-trip models a process restart; the ceiling must not reset.
    let restored = JSON.parse(JSON.stringify(journal)) as typeof journal;
    restored = advanceToolRecoveryResponseV1(restored, {
      modelMessageId: 'model-3',
      toolCalls: [{ id: 'third', name: 'read_file' }],
    });
    const exhaustedAdmission = admitRecoveryAttemptV1(restored, {
      toolCallId: 'third',
      toolName: 'read_file',
      invocationFingerprint: 'third-private-fingerprint',
      modelMessageId: 'model-3',
      mode: 'model_correction',
    });
    expect(exhaustedAdmission).toMatchObject({
      admitted: false,
      recoveryOf: childFailureId,
      detailCode: 'recovery_exhausted',
    });
    restored = recordRecoveryFailureV1(restored, {
      toolCallId: 'third',
      toolName: 'read_file',
      invocationFingerprint: 'third-private-fingerprint',
      modelMessageId: 'model-3',
      outcome: classifyToolOutcomeV1({
        status: 'exhausted',
        failure: classifyFailure('loop_exhausted', 'redacted'),
        authority: { dispatchState: 'not_started', externalEffects: 'none' },
        lineage: { recoveryOf: childFailureId },
        toolAdvice: {
          disposition: 'never',
          maximumAdditionalCalls: 0,
          detailCode: 'recovery_exhausted',
        },
      }),
    });
    const suppressionFailureId = restored.order.at(-1)!;
    restored = advanceToolRecoveryResponseV1(restored, {
      modelMessageId: 'model-4',
      toolCalls: [{ id: 'fourth', name: 'read_file' }],
    });
    expect(
      admitRecoveryAttemptV1(restored, {
        toolCallId: 'fourth',
        toolName: 'read_file',
        invocationFingerprint: 'fourth-different-private-fingerprint',
        modelMessageId: 'model-4',
        mode: 'model_correction',
      }),
    ).toMatchObject({
      admitted: false,
      recoveryOf: suppressionFailureId,
      detailCode: 'recovery_not_allowed',
    });
  });

  test('retains changed-argument deny suppression and blocks only the sixth same-tool failure', () => {
    const denied = classifyToolOutcomeV1({
      status: 'rejected',
      failure: classifyFailure('policy_denied', 'redacted'),
      authority: {
        dispatchState: 'not_started',
        externalEffects: 'none',
        replaySafety: 'pre_dispatch',
        policyDenied: true,
      },
    });
    let journal = recordRecoveryFailureV1(createToolRecoveryJournalV1(), {
      toolCallId: 'denied-1',
      toolName: 'shell_execute',
      invocationFingerprint: 'd'.repeat(64),
      modelMessageId: 'model-1',
      outcome: denied,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    journal = advanceToolRecoveryResponseV1(journal, {
      taskId: 'task-1',
      turnId: 'turn-1',
      modelMessageId: 'model-2',
      toolCalls: [{ id: 'denied-2', name: 'shell_execute' }],
    });
    const admission = admitRecoveryAttemptV1(journal, {
      toolCallId: 'denied-2',
      toolName: 'shell_execute',
      invocationFingerprint: 'd'.repeat(64),
      modelMessageId: 'model-2',
      mode: 'model_correction',
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    expect(admission).toMatchObject({
      admitted: false,
      recoveryOf: journal.order[0],
      detailCode: 'recovery_not_allowed',
    });
    let recoveryOf = journal.order[0]!;
    for (let index = 2; index <= 6; index += 1) {
      const fingerprint = index === 2 ? 'd'.repeat(64) : index.toString(16).padStart(64, '0');
      journal = advanceToolRecoveryResponseV1(journal, {
        taskId: 'task-1',
        turnId: 'turn-1',
        modelMessageId: `model-${index}`,
        toolCalls: [{ id: `denied-${index}`, name: 'shell_execute' }],
      });
      const repeatedAdmission = admitRecoveryAttemptV1(journal, {
        toolCallId: `denied-${index}`,
        toolName: 'shell_execute',
        invocationFingerprint: fingerprint,
        modelMessageId: `model-${index}`,
        mode: 'model_correction',
        taskId: 'task-1',
        turnId: 'turn-1',
      });
      expect(repeatedAdmission).toMatchObject({
        admitted: false,
        recoveryOf,
        detailCode: 'recovery_not_allowed',
      });
      journal = recordRecoveryFailureV1(journal, {
        toolCallId: `denied-${index}`,
        toolName: 'shell_execute',
        invocationFingerprint: fingerprint,
        modelMessageId: `model-${index}`,
        outcome: classifyToolOutcomeV1({
          status: 'exhausted',
          failure: classifyFailure('loop_exhausted', 'redacted'),
          authority: { dispatchState: 'not_started', externalEffects: 'none' },
          lineage: { recoveryOf },
          toolAdvice: {
            disposition: 'never',
            maximumAdditionalCalls: 0,
            detailCode: 'recovery_not_allowed',
          },
        }),
        taskId: 'task-1',
        turnId: 'turn-1',
      });
      recoveryOf = journal.order.at(-1)!;
      if (index === 2) {
        expect(journal.qualityGuard).toEqual({ blocked: false, observedFailures: 2 });
      }
    }
    expect(journal.qualityGuard).toMatchObject({
      blocked: true,
      reasonCode: 'no_progress',
      taskId: 'task-1',
      turnId: 'turn-1',
    });
  });

  test('admits one Runtime-owned alternative capability on the next eligible response', () => {
    const alternative = classifyToolOutcomeV1({
      status: 'failed',
      failure: classifyFailure('tool_invalid_args', 'redacted'),
      authority: { dispatchState: 'not_started', externalEffects: 'none' },
      toolAdvice: { disposition: 'alternative', capabilityIntent: 'workspace.search' },
    });
    expect(alternative.recovery).toMatchObject({
      disposition: 'alternative',
      maximumAdditionalCalls: 1,
      requiresNewModelResponse: true,
    });
    let journal = recordRecoveryFailureV1(createToolRecoveryJournalV1(), {
      toolCallId: 'failed-read',
      toolName: 'read_file',
      invocationFingerprint: 'e'.repeat(64),
      modelMessageId: 'model-1',
      outcome: alternative,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    journal = advanceToolRecoveryResponseV1(journal, {
      taskId: 'task-1',
      turnId: 'turn-1',
      modelMessageId: 'model-2',
      toolCalls: [{ id: 'alternative-search', name: 'search_files' }],
    });
    expect(
      admitRecoveryAttemptV1(journal, {
        toolCallId: 'alternative-search',
        toolName: 'search_files',
        invocationFingerprint: 'f'.repeat(64),
        modelMessageId: 'model-2',
        mode: 'model_correction',
        taskId: 'task-1',
        turnId: 'turn-1',
      }),
    ).toEqual({ admitted: true, recoveryOf: journal.order[0] });
  });

  test('binds one alternative call without consuming an unrelated sibling in the same response', () => {
    const alternative = classifyToolOutcomeV1({
      status: 'failed',
      failure: classifyFailure('tool_runtime_error', 'missing file'),
      authority: { dispatchState: 'started', externalEffects: 'none' },
      toolAdvice: { disposition: 'alternative', capabilityIntent: 'workspace.search' },
    });
    let journal = recordRecoveryFailureV1(createToolRecoveryJournalV1(), {
      toolCallId: 'failed-read',
      toolName: 'read_file',
      invocationFingerprint: 'a'.repeat(64),
      modelMessageId: 'model-1',
      outcome: alternative,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    const failureId = journal.order[0]!;
    journal = advanceToolRecoveryResponseV1(journal, {
      taskId: 'task-1',
      turnId: 'turn-1',
      modelMessageId: 'model-2',
      toolCalls: [
        { id: 'unrelated-read', name: 'read_file' },
        { id: 'alternative-search', name: 'search_files' },
      ],
    });

    expect(journal.failures[failureId]).toMatchObject({
      eligibleModelMessageId: 'model-2',
      eligibleToolCallId: 'alternative-search',
    });
    expect(
      admitRecoveryAttemptV1(journal, {
        toolCallId: 'alternative-search',
        toolName: 'search_files',
        invocationFingerprint: 'b'.repeat(64),
        modelMessageId: 'model-2',
        mode: 'model_correction',
        taskId: 'task-1',
        turnId: 'turn-1',
      }),
    ).toEqual({ admitted: true, recoveryOf: failureId });
    journal = recordRecoveryInvocationV1(journal, {
      toolCallId: 'alternative-search',
      recoveryOf: failureId,
      mode: 'model_correction',
    });
    expect(
      admitRecoveryAttemptV1(journal, {
        toolCallId: 'unrelated-read',
        toolName: 'read_file',
        invocationFingerprint: 'c'.repeat(64),
        modelMessageId: 'model-2',
        mode: 'model_correction',
        taskId: 'task-1',
        turnId: 'turn-1',
      }),
    ).toEqual({ admitted: true });
    expect(journal.qualityGuard).toEqual({ blocked: false, observedFailures: 1 });
  });

  test('safely expires a legacy eligible response that lacks a concrete call binding', () => {
    let current = recordRecoveryFailureV1(createToolRecoveryJournalV1(), {
      toolCallId: 'legacy-failure',
      toolName: 'read_file',
      invocationFingerprint: 'a'.repeat(64),
      modelMessageId: 'model-1',
      outcome: correctArgsOutcome,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    const failureId = current.order[0]!;
    current = advanceToolRecoveryResponseV1(current, {
      taskId: 'task-1',
      turnId: 'turn-1',
      modelMessageId: 'model-2',
      toolCalls: [{ id: 'corrected-read', name: 'read_file' }],
    });
    const legacy = structuredClone(current);
    delete legacy.failures[failureId]!.eligibleToolCallId;

    const normalized = normalizeToolRecoveryJournalV1(legacy);
    expect(normalized.qualityGuard).toEqual({ blocked: false, observedFailures: 1 });
    expect(normalized.failures[failureId]).toMatchObject({
      status: 'exhausted',
      resolution: 'next_response_elapsed',
    });
  });

  test('binds only one same-name correction sibling', () => {
    let journal = recordRecoveryFailureV1(createToolRecoveryJournalV1(), {
      toolCallId: 'failed-read',
      toolName: 'read_file',
      invocationFingerprint: 'a'.repeat(64),
      modelMessageId: 'model-1',
      outcome: correctArgsOutcome,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    const failureId = journal.order[0]!;
    journal = advanceToolRecoveryResponseV1(journal, {
      taskId: 'task-1',
      turnId: 'turn-1',
      modelMessageId: 'model-2',
      toolCalls: [
        { id: 'corrected-read', name: 'read_file' },
        { id: 'independent-read', name: 'read_file' },
      ],
    });

    expect(
      admitRecoveryAttemptV1(journal, {
        toolCallId: 'corrected-read',
        toolName: 'read_file',
        invocationFingerprint: 'b'.repeat(64),
        modelMessageId: 'model-2',
        mode: 'model_correction',
        taskId: 'task-1',
        turnId: 'turn-1',
      }),
    ).toEqual({ admitted: true, recoveryOf: failureId });
    expect(
      admitRecoveryAttemptV1(journal, {
        toolCallId: 'independent-read',
        toolName: 'read_file',
        invocationFingerprint: 'c'.repeat(64),
        modelMessageId: 'model-2',
        mode: 'model_correction',
        taskId: 'task-1',
        turnId: 'turn-1',
      }),
    ).toEqual({ admitted: true });
  });

  test('never outcomes are terminal records and cannot acquire retry lineage', () => {
    let journal = createToolRecoveryJournalV1();
    journal = recordRecoveryFailureV1(journal, {
      toolCallId: 'denied',
      toolName: 'shell_execute',
      invocationFingerprint: 'private-deny',
      modelMessageId: 'model-1',
      outcome: classifyToolOutcomeV1({
        status: 'rejected',
        failure: classifyFailure('policy_denied', 'private'),
        authority: { policyDenied: true, dispatchState: 'not_started', externalEffects: 'none' },
      }),
    });
    expect(journal.failures[journal.order[0]!]).toMatchObject({
      status: 'exhausted',
      resolution: 'terminal',
    });
    expect(
      admitRecoveryAttemptV1(journal, {
        toolCallId: 'retry',
        toolName: 'shell_execute',
        invocationFingerprint: 'private-deny',
        modelMessageId: 'model-2',
        mode: 'automatic_retry',
      }),
    ).toEqual({
      admitted: false,
      recoveryOf: journal.order[0],
      detailCode: 'recovery_not_allowed',
    });
  });

  test('tool-owned progress closes unresolved failures while unrelated revision does not', () => {
    let journal = createToolRecoveryJournalV1();
    journal = recordRecoveryFailureV1(journal, {
      toolCallId: 'failed',
      toolName: 'edit_file',
      invocationFingerprint: 'private-edit',
      modelMessageId: 'model-1',
      outcome: correctArgsOutcome,
    });
    const failureId = journal.order[0]!;
    const unchanged = JSON.parse(JSON.stringify(journal)) as typeof journal;
    expect(unchanged.failures[failureId]?.status).toBe('unresolved');
    journal = recordToolOwnedProgressV1(journal, {
      kind: 'content_revision',
      referenceId: 'content-revision-id',
      resolvesFailureIds: [failureId],
    });
    expect(journal.failures[failureId]?.status).toBe('recovered');
  });

  test('plan evidence excludes a recovered historical failure but retains its successful receipt', () => {
    const state = createInitialRuntimeState({
      threadId: 'recovered-plan-evidence',
      userId: 'user',
      workspace: '/workspace',
    });
    const failureOutcome = classifyToolOutcomeV1({
      status: 'failed',
      failure: classifyFailure('tool_invalid_args', 'private'),
      authority: { dispatchState: 'not_started', externalEffects: 'none' },
    });
    let journal = recordRecoveryFailureV1(state.toolRecovery, {
      toolCallId: 'failed-write',
      toolName: 'write_file',
      invocationFingerprint: 'c'.repeat(64),
      modelMessageId: 'model-1',
      outcome: failureOutcome,
    });
    const failureId = journal.order[0]!;
    journal = recordToolOwnedProgressV1(journal, {
      kind: 'receipt',
      referenceId: 'successful-write',
      resolvesFailureIds: [failureId],
    });
    state.toolRecovery = journal;
    state.tools.calls['failed-write'] = {
      toolCallId: 'failed-write',
      modelMessageId: 'model-1',
      name: 'write_file',
      args: {},
      status: 'failed',
      sideEffect: true,
      createdAtTurnId: state.turn.turnId,
      outcomeV1: journal.failures[failureId]!.outcome,
    };
    state.tools.calls['successful-write'] = {
      toolCallId: 'successful-write',
      modelMessageId: 'model-2',
      name: 'write_file',
      args: {},
      status: 'succeeded',
      sideEffect: true,
      createdAtTurnId: state.turn.turnId,
      result: { ok: true, summary: 'private' },
    };

    expect(projectPlanCompletionEvidenceV1(state, [])).toMatchObject({
      execution: [{ toolCallId: 'successful-write', outcome: 'succeeded' }],
      unresolved: [],
    });
  });

  test('quality guard counts one same-tool recovery chain, not independent identical calls', () => {
    let journal = createToolRecoveryJournalV1();
    let recoveryOf: string | undefined;
    for (let index = 0; index < 6; index += 1) {
      const outcome = classifyToolOutcomeV1({
        status: 'failed',
        failure: classifyFailure('tool_invalid_args', 'private args'),
        authority: { dispatchState: 'not_started', externalEffects: 'none' },
        ...(recoveryOf ? { lineage: { recoveryOf } } : {}),
      });
      journal = recordRecoveryFailureV1(journal, {
        toolCallId: `failure-${index}`,
        toolName: 'read_file',
        invocationFingerprint: index.toString(16).padStart(64, '0'),
        modelMessageId: `model-${index}`,
        outcome,
        taskId: 'quality-task',
        turnId: 'quality-turn',
      });
      recoveryOf = journal.order.at(-1)!;
      if (index === 4) {
        const beforeUnrelatedSuccess = journal;
        journal = recordToolOwnedProgressV1(journal, {
          kind: 'receipt',
          referenceId: 'unrelated-success',
        });
        expect(journal).toBe(beforeUnrelatedSuccess);
        expect(journal.progressRevision).toBe(0);
      }
    }
    expect(journal.qualityGuard).toMatchObject({ blocked: true, reasonCode: 'no_progress' });
    expect(journal.qualityGuard.observedFailures).toBeLessThan(250);
    expect(normalizeToolRecoveryJournalV1(structuredClone(journal)).qualityGuard).toEqual(
      journal.qualityGuard,
    );
    const persistedWithoutDerivedBlock = structuredClone(journal);
    persistedWithoutDerivedBlock.qualityGuard = { blocked: false, observedFailures: 6 };
    const restoredDerivedBlock = normalizeToolRecoveryJournalV1(persistedWithoutDerivedBlock);
    expect(restoredDerivedBlock.qualityGuard).toMatchObject({
      blocked: true,
      reasonCode: 'no_progress',
      taskId: 'quality-task',
      turnId: 'quality-turn',
    });
    expect(
      isToolRecoveryQualityBlockedV1(restoredDerivedBlock, {
        taskId: 'other-task',
        turnId: 'other-turn',
      }),
    ).toBe(false);

    let mixedTools = createToolRecoveryJournalV1();
    recoveryOf = undefined;
    for (let index = 0; index < 8; index += 1) {
      const outcome = classifyToolOutcomeV1({
        status: 'failed',
        failure: classifyFailure('tool_invalid_args', 'private args'),
        authority: { dispatchState: 'not_started', externalEffects: 'none' },
        ...(recoveryOf ? { lineage: { recoveryOf } } : {}),
      });
      mixedTools = recordRecoveryFailureV1(mixedTools, {
        toolCallId: `mixed-${index}`,
        toolName: index % 2 === 0 ? 'read_file' : 'search_files',
        invocationFingerprint: index.toString(16).padStart(64, '0'),
        modelMessageId: `mixed-model-${index}`,
        outcome,
        taskId: 'mixed-task',
        turnId: 'mixed-turn',
      });
      recoveryOf = mixedTools.order.at(-1)!;
    }
    expect(mixedTools.qualityGuard).toEqual({ blocked: false, observedFailures: 8 });

    let independent = createToolRecoveryJournalV1();
    for (let index = 0; index < 12; index += 1) {
      independent = recordRecoveryFailureV1(independent, {
        toolCallId: `independent-${index}`,
        toolName: 'read_file',
        invocationFingerprint: 'f'.repeat(64),
        modelMessageId: `independent-model-${index}`,
        outcome: correctArgsOutcome,
        taskId: 'independent-task',
        turnId: 'independent-turn',
      });
    }
    expect(independent.qualityGuard).toEqual({ blocked: false, observedFailures: 12 });

    expect(
      admitRecoveryAttemptV1(independent, {
        toolCallId: 'escape-replan',
        toolName: 'write_plan',
        invocationFingerprint: 'f'.repeat(64),
        modelMessageId: 'escape-model',
        mode: 'model_correction',
        taskId: 'independent-task',
        turnId: 'independent-turn',
      }),
    ).toEqual({ admitted: true });
  });
});

describe('ToolOutcome Runtime event integration', () => {
  test('keeps an unrelated sibling admitted after binding one alternative recovery call', () => {
    let state = createInitialRuntimeState({
      threadId: 'alternative-sibling',
      userId: 'user',
      workspace: '/workspace',
    });
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'user-1',
      content: 'inspect the workspace',
    });
    const taskId = state.activeTaskId!;
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'failed-read',
      name: 'read_file',
      args: { path: 'missing.ts' },
      modelMessageId: 'model-1',
      taskId,
    });
    const missingFileFailure = classifyFailure('tool_runtime_error', 'missing file');
    const alternativeOutcome = classifyToolOutcomeV1({
      status: 'failed',
      failure: missingFileFailure,
      authority: { dispatchState: 'started', externalEffects: 'none' },
      toolAdvice: { disposition: 'alternative', capabilityIntent: 'workspace.search' },
    });
    state = reduceRuntimeState(state, {
      type: 'tool.failed',
      toolCallId: 'failed-read',
      failure: missingFileFailure,
      outcomeV1: alternativeOutcome,
    });
    state = reduceRuntimeState(state, {
      type: 'model.responded',
      messageId: 'model-2',
      toolCalls: [
        { id: 'alternative-search', name: 'search_files', args: { pattern: 'missing.ts' } },
        { id: 'unrelated-read', name: 'read_file', args: { path: 'README.md' } },
      ],
    });
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'alternative-search',
      name: 'search_files',
      args: { pattern: 'missing.ts' },
      modelMessageId: 'model-2',
      taskId,
    });
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'unrelated-read',
      name: 'read_file',
      args: { path: 'README.md' },
      modelMessageId: 'model-2',
      taskId,
    });

    expect(state.tools.calls['alternative-search']).toMatchObject({
      recoveryAdmission: 'admitted',
      recoveryOf: expect.any(String),
    });
    expect(state.tools.calls['unrelated-read']).toMatchObject({ recoveryAdmission: 'admitted' });
    expect(state.tools.calls['unrelated-read']?.recoveryOf).toBeUndefined();
    expect(state.toolRecovery.qualityGuard).toEqual({ blocked: false, observedFailures: 1 });
  });

  test('prioritizes a foreign child journal block over queued siblings, verification, and compaction', async () => {
    const state = createInitialRuntimeState({
      threadId: 'invalid-child-priority',
      userId: 'user',
      workspace: '/workspace',
    });
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    kernel.processEvent({
      type: 'user.message_appended',
      messageId: 'priority-user',
      content: 'run siblings',
    });
    const taskId = kernel.getState().activeTaskId!;
    const turnId = kernel.getState().turn.turnId;
    kernel.processEventBatch([
      {
        type: 'tool.queued',
        toolCallId: 'queued-read',
        name: 'read_file',
        args: { path: 'README.md' },
        modelMessageId: 'priority-model',
        taskId,
      },
      {
        type: 'tool.queued',
        toolCallId: 'queued-write',
        name: 'write_file',
        args: { path: 'blocked.txt', content: 'blocked' },
        modelMessageId: 'priority-model',
        taskId,
      },
      {
        type: 'tool.queued',
        toolCallId: 'queued-mcp',
        name: 'mcp__fixture__read',
        args: {},
        modelMessageId: 'priority-model',
        taskId,
      },
      {
        type: 'tool.queued',
        toolCallId: 'task-child',
        name: 'task',
        args: { subagent_type: 'code', task: 'resume child' },
        modelMessageId: 'priority-model',
        taskId,
      },
      { type: 'tool.started', toolCallId: 'task-child' },
      {
        type: 'verification.requested',
        verificationId: 'blocked-verification',
        taskId,
        mode: 'required',
        spec: {
          schemaVersion: 1,
          verificationId: 'blocked-verification',
          taskId,
          subject: 'blocked verification',
          checks: [
            {
              checkId: 'blocked-file-check',
              type: 'file_assertion',
              description: 'must not execute',
              path: 'README.md',
              assertion: 'exists',
            },
          ],
          repair: { maxAttempts: 0 },
        },
        requestedAt: '2026-08-10T00:00:00.000Z',
      },
      {
        type: 'context.compaction_requested',
        compactionId: 'blocked-compaction',
        reason: 'manual',
        requestedAtRevision: kernel.getState().revision,
        requestedAtTurnId: turnId,
        force: false,
        estimate: {
          systemTokens: 10,
          toolSchemaTokens: 10,
          transcriptTokens: 10,
          summaryTokens: 0,
          dynamicRuntimeTokens: 10,
          framingTokens: 10,
          totalInputTokens: 50,
        },
      },
      {
        type: 'subagent.recovery_journal_merged',
        toolCallId: 'task-child',
        journal: createToolRecoveryJournalV1(),
      },
    ]);

    expect(decideNextEffect(kernel.getState())).toMatchObject({
      type: 'recovery_blocked',
      failureKind: 'persistence_unavailable',
      recoveryCause: 'journal_invalid',
    });
    let dispatches = 0;
    await expect(
      kernel.run(async () => {
        dispatches += 1;
        return [];
      }),
    ).resolves.toMatchObject({
      type: 'recovery_blocked',
      failureKind: 'persistence_unavailable',
    });
    expect(dispatches).toBe(0);
    kernel.close();
  });

  test('rechecks journal_invalid after Runner preparation before using a stale tool effect lease', async () => {
    const state = createInitialRuntimeState({
      threadId: 'invalid-after-prepare',
      userId: 'user',
      workspace: '/workspace',
    });
    state.tools.calls.read = {
      toolCallId: 'read',
      modelMessageId: 'prepared-model',
      name: 'read_file',
      args: { path: 'README.md' },
      status: 'queued',
      effectClass: 'read_only',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue.push('read');
    state.tools.calls.task = {
      toolCallId: 'task',
      modelMessageId: 'prepared-model',
      name: 'task',
      args: { subagent_type: 'code', task: 'resume child' },
      status: 'running',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.active.push('task');
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    let dispatches = 0;
    let prepared = false;
    const emitted: RuntimeEvent[] = [];
    for await (const event of runRuntimeLoop(
      kernel,
      async () => {
        dispatches += 1;
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'none' }) },
      10,
      async (effect) => {
        if (!prepared) {
          prepared = true;
          kernel.processEvent({
            type: 'subagent.recovery_journal_merged',
            toolCallId: 'task',
            journal: createToolRecoveryJournalV1(),
          });
        }
        return effect;
      },
    )) {
      emitted.push(event);
    }
    expect(dispatches).toBe(0);
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'run.error',
        failure: expect.objectContaining({ kind: 'persistence_unavailable' }),
      }),
    );
    kernel.close();
  });

  test('rechecks scoped no_progress after Runner preparation before using a stale tool effect lease', async () => {
    let state = createInitialRuntimeState({
      threadId: 'no-progress-after-prepare',
      userId: 'user',
      workspace: '/workspace',
    });
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'user-1',
      content: 'continue',
    });
    state.tools.calls.task = {
      toolCallId: 'task',
      modelMessageId: 'prepared-model',
      name: 'task',
      args: { subagent_type: 'code', task: 'resume child' },
      status: 'succeeded',
      taskId: state.activeTaskId!,
      createdAtTurnId: state.turn.turnId,
    };
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    const childJournal = createToolRecoveryJournalV1(state.toolRecovery.identityKey);
    childJournal.qualityGuard = {
      blocked: true,
      reasonCode: 'no_progress',
      observedFailures: 6,
      taskId: state.activeTaskId!,
      turnId: state.turn.turnId,
    };
    let dispatches = 0;
    let prepared = false;
    const emitted: RuntimeEvent[] = [];
    for await (const event of runRuntimeLoop(
      kernel,
      async () => {
        dispatches += 1;
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'none' }) },
      10,
      async (effect) => {
        if (!prepared) {
          prepared = true;
          kernel.processEvent({
            type: 'subagent.recovery_journal_merged',
            toolCallId: 'task',
            journal: childJournal,
          });
        }
        return effect;
      },
    )) {
      emitted.push(event);
    }
    expect(dispatches).toBe(0);
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'run.error',
        failure: expect.objectContaining({ kind: 'loop_exhausted' }),
      }),
    );
    kernel.close();
  });

  test('defensively rejects direct and stale leased Controller execution when the journal is invalid', async () => {
    const valid = createInitialRuntimeState({
      threadId: 'invalid-controller-entry',
      userId: 'user',
      workspace: '/workspace',
    });
    valid.tools.calls.shell = {
      toolCallId: 'shell',
      modelMessageId: 'controller-model',
      name: 'shell_execute',
      args: { command: 'printf blocked' },
      status: 'approved',
      createdAtTurnId: valid.turn.turnId,
    };
    valid.tools.queue.push('shell');
    const invalid = structuredClone(valid);
    invalid.toolRecovery = normalizeToolRecoveryJournalV1(undefined);
    let dispatches = 0;
    const shellExecutor: ShellExecutor = async (input) => {
      dispatches += 1;
      return {
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
    };
    const direct = await executeRuntimeTools({
      state: invalid,
      toolCallIds: ['shell'],
      shellExecutor,
    });
    expect(dispatches).toBe(0);
    expect(direct).toContainEqual(
      expect.objectContaining({
        type: 'tool.rejected',
        toolCallId: 'shell',
        failure: expect.objectContaining({ kind: 'persistence_unavailable' }),
      }),
    );

    const executor = createRuntimeEffectExecutor({
      config: {
        apiKey: '',
        baseURL: 'http://localhost',
        modelName: 'test',
        providerName: 'test',
        providerType: 'openai-compatible',
        sandbox: { enabled: false },
      },
      model: {} as never,
      shellExecutor,
    });
    const stale = await executor({ type: 'run_tools', toolCallIds: ['shell'] }, valid, undefined, {
      reservationIds: [],
      getState: () => invalid,
      persistEvent: async () => false,
      persistEvents: async () => false,
    });
    expect(dispatches).toBe(0);
    expect(stale).toContainEqual(
      expect.objectContaining({
        type: 'tool.rejected',
        toolCallId: 'shell',
        failure: expect.objectContaining({ kind: 'persistence_unavailable' }),
      }),
    );
  });

  test('keeps ordinary no_progress scoped so a different task and turn can call the model', () => {
    const state = createInitialRuntimeState({
      threadId: 'scoped-no-progress',
      userId: 'user',
      workspace: '/workspace',
    });
    state.toolRecovery.qualityGuard = {
      blocked: true,
      reasonCode: 'no_progress',
      observedFailures: 6,
      taskId: 'old-task',
      turnId: 'old-turn',
    };
    expect(decideNextEffect(state)).toEqual({ type: 'call_model' });
  });

  test('keeps a foreign child merge globally blocked after task close, next turn, and a new task', async () => {
    const state = createInitialRuntimeState({
      threadId: 'invalid-child-next-task',
      userId: 'user',
      workspace: '/workspace',
    });
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({ store, initialState: state, interactionMode: 'accept_edits' });
    kernel.processEvent({
      type: 'user.message_appended',
      messageId: 'old-user',
      content: 'old task',
    });
    const oldTaskId = kernel.getState().activeTaskId!;
    const oldTurnId = kernel.getState().turn.turnId;
    kernel.processEventBatch([
      {
        type: 'tool.queued',
        toolCallId: 'task-child',
        name: 'task',
        args: { subagent_type: 'code', task: 'resume child' },
        modelMessageId: 'parent-model',
        taskId: oldTaskId,
      },
      { type: 'tool.started', toolCallId: 'task-child' },
      {
        type: 'subagent.recovery_journal_merged',
        toolCallId: 'task-child',
        journal: createToolRecoveryJournalV1(),
      },
      {
        type: 'tool.finished',
        toolCallId: 'task-child',
        name: 'task',
        result: {
          ok: true,
          command: 'task',
          exitCode: 0,
          stdout: '{"ok":true,"summary":"done","toolCallCount":1,"durationMs":1}',
          stderr: '',
          resultMeta: {},
          status: 'success',
        },
      },
      { type: 'task.completed', taskId: oldTaskId, turnId: oldTurnId },
      { type: 'turn.started', turnId: 'next-turn' },
      {
        type: 'user.message_appended',
        messageId: 'new-user',
        content: 'new task',
      },
    ]);

    expect(kernel.getState().activeTaskId).not.toBe(oldTaskId);
    expect(kernel.getState().toolRecovery.qualityGuard).toMatchObject({
      blocked: true,
      reasonCode: 'journal_invalid',
    });
    expect(decideNextEffect(kernel.getState())).toMatchObject({
      type: 'recovery_blocked',
      failureKind: 'persistence_unavailable',
      recoveryCause: 'journal_invalid',
    });
    let dispatches = 0;
    await expect(
      kernel.run(async () => {
        dispatches += 1;
        return [];
      }),
    ).resolves.toMatchObject({
      type: 'recovery_blocked',
      failureKind: 'persistence_unavailable',
      recoveryCause: 'journal_invalid',
    });
    expect(dispatches).toBe(0);
    kernel.close();
  });

  test('restores a foreign child journal block from SQLite globally in the next turn', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kite-invalid-child-restore-'));
    const storePath = join(directory, 'runtime.db');
    const threadId = 'invalid-child-sqlite-next-turn';
    try {
      const kernel = createAgentKernel({
        threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      kernel.processEvent({
        type: 'user.message_appended',
        messageId: 'old-user',
        content: 'old task',
      });
      const oldTaskId = kernel.getState().activeTaskId!;
      const oldTurnId = kernel.getState().turn.turnId;
      kernel.processEventBatch([
        {
          type: 'tool.queued',
          toolCallId: 'task-child',
          name: 'task',
          args: { subagent_type: 'code', task: 'resume child' },
          modelMessageId: 'parent-model',
          taskId: oldTaskId,
        },
        { type: 'tool.started', toolCallId: 'task-child' },
        {
          type: 'subagent.recovery_journal_merged',
          toolCallId: 'task-child',
          journal: createToolRecoveryJournalV1(),
        },
        {
          type: 'tool.finished',
          toolCallId: 'task-child',
          name: 'task',
          result: {
            ok: true,
            command: 'task',
            exitCode: 0,
            stdout: '{"ok":true,"summary":"done","toolCallCount":1,"durationMs":1}',
            stderr: '',
            resultMeta: {},
            status: 'success',
          },
        },
        { type: 'task.completed', taskId: oldTaskId, turnId: oldTurnId },
        { type: 'turn.started', turnId: 'restored-next-turn' },
      ]);
      kernel.close();

      const restored = createAgentKernel({
        threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(decideNextEffect(restored.getState())).toMatchObject({
        type: 'recovery_blocked',
        failureKind: 'persistence_unavailable',
        recoveryCause: 'journal_invalid',
      });
      let dispatches = 0;
      await expect(
        restored.run(async () => {
          dispatches += 1;
          return [];
        }),
      ).resolves.toMatchObject({
        type: 'recovery_blocked',
        failureKind: 'persistence_unavailable',
        recoveryCause: 'journal_invalid',
      });
      expect(dispatches).toBe(0);
      restored.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('keeps a corrupt resumed child merge blocked after the same Kernel batch succeeds the task', () => {
    const state = createInitialRuntimeState({
      threadId: 'resume-invalid-child-batch',
      userId: 'user',
      workspace: '/workspace',
    });
    state.tools.calls.task = {
      toolCallId: 'task',
      modelMessageId: 'parent-model',
      name: 'task',
      args: { subagent_type: 'code', task: 'resume child' },
      status: 'running',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.active.push('task');
    const foreign = createToolRecoveryJournalV1();
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({ store, initialState: state, interactionMode: 'accept_edits' });

    kernel.processEventBatch([
      {
        type: 'subagent.recovery_journal_merged',
        toolCallId: 'task',
        journal: foreign,
      },
      {
        type: 'tool.finished',
        toolCallId: 'task',
        name: 'task',
        result: {
          ok: true,
          command: 'task',
          exitCode: 0,
          stdout: '{"ok":true,"summary":"done","toolCallCount":1,"durationMs":1}',
          stderr: '',
          resultMeta: {},
          status: 'success',
        },
      },
    ]);

    expect(kernel.getState().tools.calls.task?.status).toBe('succeeded');
    expect(kernel.getState().toolRecovery.qualityGuard).toMatchObject({
      blocked: true,
      reasonCode: 'journal_invalid',
    });
    expect(decideNextEffect(kernel.getState())).toMatchObject({
      type: 'recovery_blocked',
      recoveryCause: 'journal_invalid',
    });
    kernel.close();
  });

  test('merges an overflowed child lineage without dropping its retained parent or crashing Kernel', () => {
    const state = createInitialRuntimeState({
      threadId: 'merge-lineage-overflow',
      userId: 'user',
      workspace: '/workspace',
    });
    const lineageParentInput = {
      toolCallId: 'shared-lineage-parent',
      toolName: 'read_file',
      invocationFingerprint: 'a'.repeat(64),
      modelMessageId: 'shared-parent-model',
      outcome: correctArgsOutcome,
      taskId: 'merge-task',
      turnId: state.turn.turnId,
    };
    state.toolRecovery = recordRecoveryFailureV1(state.toolRecovery, lineageParentInput);
    const parentId = state.toolRecovery.order[0]!;
    for (let index = 0; index < 127; index += 1) {
      state.toolRecovery = recordRecoveryFailureV1(state.toolRecovery, {
        toolCallId: `parent-old-${index}`,
        toolName: 'read_file',
        invocationFingerprint: (index + 1).toString(16).padStart(64, '0'),
        modelMessageId: `parent-old-model-${index}`,
        outcome: correctArgsOutcome,
        taskId: 'merge-task',
        turnId: state.turn.turnId,
      });
    }
    expect(state.toolRecovery.order).toHaveLength(128);
    expect(state.toolRecovery.order[0]).toBe(parentId);
    const historicalRecoveryOf = state.toolRecovery.order[1]!;
    let child = createToolRecoveryJournalV1(state.toolRecovery.identityKey);
    child = recordRecoveryFailureV1(child, lineageParentInput);
    child = recordRecoveryFailureV1(child, {
      toolCallId: 'merged-lineage-child',
      toolName: 'read_file',
      invocationFingerprint: 'b'.repeat(64),
      modelMessageId: 'merged-child-model',
      outcome: classifyToolOutcomeV1({
        status: 'failed',
        failure: classifyFailure('tool_invalid_args', 'redacted'),
        authority: { dispatchState: 'not_started', externalEffects: 'none' },
        lineage: { recoveryOf: parentId },
      }),
      taskId: 'merge-task',
      turnId: state.turn.turnId,
    });
    const childId = child.order.at(-1)!;
    state.tools.calls.task = {
      toolCallId: 'task',
      modelMessageId: 'parent-model',
      name: 'task',
      args: { subagent_type: 'code', task: 'merge child' },
      status: 'running',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.active.push('task');
    state.tools.calls.historical = {
      toolCallId: 'historical',
      modelMessageId: 'historical-model',
      name: 'read_file',
      args: {},
      status: 'succeeded',
      recoveryOf: historicalRecoveryOf,
      recoveryMode: 'model_correction',
      createdAtTurnId: state.turn.turnId,
      result: { ok: true, summary: 'historical success' },
    };
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({ store, initialState: state, interactionMode: 'accept_edits' });

    expect(() =>
      kernel.processEvent({
        type: 'subagent.recovery_journal_merged',
        toolCallId: 'task',
        journal: child,
      }),
    ).not.toThrow();
    expect(kernel.getState().toolRecovery.order).toHaveLength(128);
    expect(kernel.getState().toolRecovery.failures[historicalRecoveryOf]).toBeUndefined();
    expect(kernel.getState().toolRecovery.failures[parentId]).toBeDefined();
    expect(kernel.getState().toolRecovery.failures[childId]?.outcome.lineage?.recoveryOf).toBe(
      parentId,
    );
    kernel.close();
  });

  test('keeps delegated recovery internals private while merging them into parent state', () => {
    let state = createInitialRuntimeState({
      threadId: 'task-result-privacy',
      userId: 'user',
      workspace: '/workspace',
    });
    state = reduceRuntimeState(state, {
      type: 'model.responded',
      messageId: 'parent-model',
      toolCalls: [
        {
          id: 'task-private',
          name: 'task',
          args: { subagent_type: 'explore', task: 'inspect metadata' },
        },
      ],
    });
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'task-private',
      name: 'task',
      args: { subagent_type: 'explore', task: 'inspect metadata' },
      modelMessageId: 'parent-model',
    });
    state = reduceRuntimeState(state, { type: 'tool.started', toolCallId: 'task-private' });
    const child = recordRecoveryFailureV1(
      createToolRecoveryJournalV1(state.toolRecovery.identityKey),
      {
        toolCallId: 'child-private',
        toolName: 'read_file',
        invocationFingerprint: 'd'.repeat(64),
        modelMessageId: 'child-model',
        outcome: correctArgsOutcome,
        turnId: state.turn.turnId,
      },
    );
    const projected = taskSpec.projectResult(
      {
        available: true,
        result: {
          ok: false,
          summary: 'Child needs a corrected read.',
          error: 'Child did not complete.',
          toolCallCount: 1,
          durationMs: 7,
          toolRecovery: child,
          executionJournal: [{ fingerprint: 'private-execution-journal' }],
          exhaustedFingerprints: { 'private-exhausted': true },
          blocked: { continuation: { id: 'private-continuation' } },
        } as never,
      },
      {
        workspace: '/workspace',
        invocationInput: { subagent_type: 'explore', task: 'inspect metadata' },
      },
    );
    state = reduceRuntimeState(state, {
      type: 'subagent.recovery_journal_merged',
      toolCallId: 'task-private',
      journal: child,
    });
    state = reduceRuntimeState(state, {
      type: 'tool.finished',
      toolCallId: 'task-private',
      name: 'task',
      result: {
        ok: projected.ok,
        command: 'task',
        exitCode: projected.ok ? 0 : 1,
        stdout: projected.ok ? projected.modelContent : '',
        stderr: projected.ok ? '' : projected.modelContent,
        resultMeta: projected.resultMeta,
        status: projected.ok ? 'success' : 'error',
      },
      outcomeV1: projected.ok
        ? classifyToolOutcomeV1({
            status: 'success',
            authority: { dispatchState: 'started', externalEffects: 'unknown' },
          })
        : classifyToolOutcomeV1({
            status: 'failed',
            failure: classifyFailure('tool_runtime_error', 'redacted'),
            authority: { dispatchState: 'started', externalEffects: 'unknown' },
          }),
    });

    expect(state.toolRecovery.order).toHaveLength(2);
    const transcriptJson = JSON.stringify(state.transcript);
    const providerJson = JSON.stringify(
      buildContextProjection({ role: 'agent', state, serializedTools: [] }).providerMessages,
    );
    for (const privateValue of [
      'private-execution-journal',
      'private-exhausted',
      'private-continuation',
      state.toolRecovery.identityKey,
      'd'.repeat(64),
    ]) {
      expect(transcriptJson).not.toContain(privateValue);
      expect(providerJson).not.toContain(privateValue);
    }
    expect(providerJson).toContain('Child needs a corrected read.');
  });

  test('controller keeps a same-scope deny suppressed without prematurely hard-blocking', async () => {
    let state = createInitialRuntimeState({
      threadId: 'deny-controller-suppression',
      userId: 'user',
      workspace: '/workspace',
    });
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'denied-1',
      name: 'shell_execute',
      args: { command: 'private' },
      modelMessageId: 'model-1',
    });
    state = reduceRuntimeState(state, {
      type: 'tool.rejected',
      toolCallId: 'denied-1',
      reason: 'redacted',
      failure: classifyFailure('policy_denied', 'redacted'),
      outcomeV1: classifyToolOutcomeV1({
        status: 'rejected',
        failure: classifyFailure('policy_denied', 'redacted'),
        authority: {
          dispatchState: 'not_started',
          externalEffects: 'none',
          replaySafety: 'pre_dispatch',
          policyDenied: true,
        },
      }),
    });
    state = reduceRuntimeState(state, {
      type: 'model.responded',
      messageId: 'model-2',
      toolCalls: [{ id: 'denied-2', name: 'shell_execute', args: { command: 'private' } }],
    });
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'denied-2',
      name: 'shell_execute',
      args: { command: 'private' },
      modelMessageId: 'model-2',
    });
    expect(state.tools.calls['denied-2']).toMatchObject({
      recoveryAdmission: 'recovery_not_allowed',
    });
    state.tools.calls['denied-2']!.status = 'approved';

    let dispatches = 0;
    const events = await executeRuntimeTools({
      state,
      toolCallIds: ['denied-2'],
      shellExecutor: async (input) => {
        dispatches += 1;
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: '',
          stderr: '',
        };
      },
    });
    expect(dispatches).toBe(0);
    const rejected = events.find((event) => event.type === 'tool.rejected');
    expect(rejected).toBeDefined();
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: state,
      interactionMode: 'accept_edits',
    });
    kernel.processEvent(rejected!);
    expect(kernel.getState().toolRecovery.qualityGuard).toEqual({
      blocked: false,
      observedFailures: 2,
    });
    kernel.close();
  });

  test('appends exactly one auto-review rejection ToolMessage and preserves next-model pairing', () => {
    let state = createInitialRuntimeState({
      threadId: 'auto-review-pairing',
      userId: 'user',
      workspace: '/workspace',
    });
    state = reduceRuntimeState(state, {
      type: 'model.responded',
      messageId: 'model-auto-review',
      toolCalls: [{ id: 'auto-review-call', name: 'shell_execute', args: { command: 'private' } }],
    });
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'auto-review-call',
      name: 'shell_execute',
      args: { command: 'private' },
      modelMessageId: 'model-auto-review',
    });
    state = reduceRuntimeState(state, {
      type: 'auto_review.requested',
      reviewId: 'auto-review',
      toolCallId: 'auto-review-call',
      toolName: 'shell_execute',
      reason: 'redacted',
      approval: {} as never,
    });
    const terminal = {
      type: 'auto_review.completed' as const,
      reviewId: 'auto-review',
      toolCallId: 'auto-review-call',
      result: {
        ok: true as const,
        approved: false,
        reviewerModelName: 'test',
        durationMs: 1,
      },
      outcomeV1: classifyToolOutcomeV1({
        status: 'rejected',
        failure: classifyFailure('auto_review_rejected', 'redacted'),
        authority: {
          dispatchState: 'not_started',
          externalEffects: 'none',
          replaySafety: 'pre_dispatch',
          approvalDenied: true,
        },
      }),
    };
    state = reduceRuntimeState(state, terminal);
    state = reduceRuntimeState(state, terminal);
    const toolMessages = state.transcript.messages.filter(
      (message) => message.kind === 'tool' && message.toolCallId === 'auto-review-call',
    );
    expect(toolMessages).toHaveLength(1);
    const projection = buildContextProjection({ role: 'agent', state, serializedTools: [] });
    const paired = projection.providerMessages.filter(
      (message) =>
        (message.type === 'ai' &&
          (message as import('@/core/messages').AIMessage).tool_calls?.some(
            (call) => call.id === 'auto-review-call',
          )) ||
        (message.type === 'tool' &&
          (message as import('@/core/messages').ToolMessage).tool_call_id === 'auto-review-call'),
    );
    expect(paired.map((message) => message.type)).toEqual(['ai', 'tool']);
  });

  test('keeps exhausted deny/timeout/cancel/unknown failures in plan evidence until explicit resolution', () => {
    let state = createInitialRuntimeState({
      threadId: 'exhausted-evidence',
      userId: 'user',
      workspace: '/workspace',
    });
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'denied-effect',
      name: 'shell_execute',
      args: { command: 'private' },
      modelMessageId: 'model-1',
      effectClass: 'external_side_effect',
      sideEffect: true,
    });
    state = reduceRuntimeState(state, {
      type: 'tool.rejected',
      toolCallId: 'denied-effect',
      reason: 'redacted',
      failure: classifyFailure('policy_denied', 'redacted'),
      outcomeV1: classifyToolOutcomeV1({
        status: 'rejected',
        failure: classifyFailure('policy_denied', 'redacted'),
        authority: {
          dispatchState: 'not_started',
          externalEffects: 'none',
          replaySafety: 'pre_dispatch',
          policyDenied: true,
        },
      }),
    });
    const failureId = state.toolRecovery.order[0]!;
    expect(state.toolRecovery.failures[failureId]?.status).toBe('exhausted');
    state.tools.calls['denied-effect']!.outcomeV1 = state.toolRecovery.failures[failureId]!.outcome;
    const evidence = projectPlanCompletionEvidenceV1(state, []);
    expect(evidence.unresolved).toContainEqual({
      kind: 'failure',
      referenceId: 'denied-effect',
    });
    expect(planCompletionBlocker(state, evidence)).toBe('plan_unresolved_blocker');
  });

  test('current terminal event persists one canonical outcome and projects one ToolMessage', () => {
    const path = join(tmpdir(), `kite-tool-outcome-${crypto.randomUUID()}.db`);
    const kernel = createAgentKernel({
      threadId: 'tool-outcome-current',
      userId: 'user',
      workspace: '/workspace',
      storePath: path,
    });
    try {
      kernel.processEvent({
        type: 'tool.queued',
        toolCallId: 'call-1',
        name: 'read_file',
        args: { path: 'missing.txt' },
        modelMessageId: 'model-1',
      });
      const canonical = kernel.processEventBatch([
        {
          type: 'tool.failed',
          toolCallId: 'call-1',
          failure: classifyFailure('tool_invalid_args', 'private diagnostic'),
        },
      ]);
      expect(canonical[0]).toMatchObject({
        type: 'tool.failed',
        outcomeV1: { schemaVersion: 1, failure: { detailCode: 'invalid_arguments' } },
      });
      const state = kernel.getState();
      expect(state.tools.calls['call-1']?.outcomeV1).toMatchObject({
        schemaVersion: 1,
        status: 'failed',
        failure: { kind: 'tool_invalid_args', detailCode: 'invalid_arguments' },
        dispatchState: 'not_started',
        externalEffects: 'none',
        lineage: { failureInstanceId: expect.any(String) },
      });
      expect(
        state.transcript.messages.filter(
          (message) => message.kind === 'tool' && message.toolCallId === 'call-1',
        ),
      ).toHaveLength(1);
      expect(state.toolRecovery.order).toHaveLength(1);
    } finally {
      kernel.close();
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`, { force: true });
      }
    }
  });

  test('Runner publishes the canonical event returned by Kernel persistence', async () => {
    const kernel = new AgentKernel({
      store: createRuntimeStore(':memory:'),
      initialState: createInitialRuntimeState({
        threadId: 'canonical-runner-stream',
        userId: 'user',
        workspace: '/workspace',
      }),
      interactionMode: 'accept_edits',
    });
    kernel.processEvent({
      type: 'tool.queued',
      toolCallId: 'streamed-read',
      name: 'read_file',
      args: { path: 'README.md' },
      modelMessageId: 'model-before-tool',
      effectClass: 'read_only',
      sideEffect: false,
    });
    const emitted: RuntimeEvent[] = [];
    for await (const event of runRuntimeLoop(
      kernel,
      async (effect) => {
        if (effect.type === 'run_tools') {
          return [
            { type: 'tool.started', toolCallId: 'streamed-read' },
            {
              type: 'tool.finished',
              toolCallId: 'streamed-read',
              name: 'read_file',
              result: {
                ok: true,
                command: 'read_file',
                exitCode: 0,
                stdout: 'bounded result',
                stderr: '',
              },
            },
          ];
        }
        if (effect.type === 'call_model') {
          return [
            {
              type: 'model.responded',
              messageId: 'model-after-tool',
              text: 'Done.',
              toolCalls: [],
            },
          ];
        }
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      emitted.push(event);
    }
    const terminal = emitted.find(
      (event): event is Extract<RuntimeEvent, { type: 'tool.finished' }> =>
        event.type === 'tool.finished',
    );
    expect(terminal?.outcomeV1).toMatchObject({
      status: 'success',
      dispatchState: 'started',
      externalEffects: 'none',
    });
    kernel.close();
  });

  test('persists a strict Registry tool_unavailable outcome through Controller and Kernel replay', async () => {
    const path = join(tmpdir(), `kite-tool-unavailable-${crypto.randomUUID()}.db`);
    let kernel = createAgentKernel({
      threadId: 'registry-tool-unavailable',
      userId: 'user',
      workspace: '/workspace',
      storePath: path,
    });
    try {
      kernel.processEvent({
        type: 'tool.queued',
        toolCallId: 'search-disabled',
        name: 'tool_search',
        args: { query: 'database capability' },
        modelMessageId: 'model-search-disabled',
      });
      const controllerEvents = await executeRuntimeTools({
        state: kernel.getState(),
        toolCallIds: ['search-disabled'],
      });
      expect(controllerEvents).toContainEqual(
        expect.objectContaining({
          type: 'tool.failed',
          toolCallId: 'search-disabled',
          failure: expect.objectContaining({
            kind: 'tool_not_found',
            parseFailureCode: 'tool_unavailable',
          }),
        }),
      );

      const persisted = kernel.processEventBatch(controllerEvents);
      const terminal = persisted.find((event) => event.type === 'tool.failed');
      expect(terminal?.type).toBe('tool.failed');
      expect(terminal?.type === 'tool.failed' && isToolOutcomeV1(terminal.outcomeV1)).toBe(true);
      expect(terminal).toMatchObject({
        type: 'tool.failed',
        outcomeV1: {
          status: 'failed',
          failure: { kind: 'tool_not_found', detailCode: 'tool_unavailable' },
          dispatchState: 'not_started',
          externalEffects: 'none',
          recovery: {
            disposition: 'user_action',
            maximumAdditionalCalls: 0,
            safeAutomaticRetry: false,
          },
        },
      });

      kernel.close();
      kernel = createAgentKernel({
        threadId: 'registry-tool-unavailable',
        userId: 'user',
        workspace: '/workspace',
        storePath: path,
      });
      const restored = kernel.getState().tools.calls['search-disabled']?.outcomeV1;
      expect(isToolOutcomeV1(restored)).toBe(true);
      expect(restored).toMatchObject({
        failure: { kind: 'tool_not_found', detailCode: 'tool_unavailable' },
        recovery: { disposition: 'user_action', maximumAdditionalCalls: 0 },
      });
    } finally {
      kernel.close();
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`, { force: true });
      }
    }
  });

  test('model recovery guidance is projected from the canonical outcome rather than legacy flags', () => {
    let state = createInitialRuntimeState({
      threadId: 'tool-model-parity',
      userId: 'user',
      workspace: '/workspace',
    });
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'parity',
      name: 'read_file',
      args: { path: 1 },
      modelMessageId: 'model-parity',
    });
    state = reduceRuntimeState(state, {
      type: 'tool.failed',
      toolCallId: 'parity',
      failure: classifyFailure('policy_denied', 'legacy flags say never'),
      outcomeV1: correctArgsOutcome,
    });
    const projection = JSON.parse(String(state.transcript.messages.at(-1)?.content));
    expect(projection).toMatchObject({
      error: {
        retryable: false,
        model_fixable: true,
        recovery_disposition: 'correct_args',
        maximum_additional_calls: 1,
      },
    });
    expect(projection.next_step).toContain('correct the arguments once');
  });

  test('normalizes each terminal in an atomic batch against the preceding next state', () => {
    const path = join(tmpdir(), `kite-tool-batch-outcome-${crypto.randomUUID()}.db`);
    const kernel = createAgentKernel({
      threadId: 'tool-batch-next-state',
      userId: 'user',
      workspace: '/workspace',
      storePath: path,
    });
    try {
      kernel.processEvent({
        type: 'tool.queued',
        toolCallId: 'batch-call',
        name: 'read_file',
        args: { path: 'fixture.txt' },
        modelMessageId: 'model-batch',
      });
      const events = kernel.processEventBatch([
        { type: 'tool.started', toolCallId: 'batch-call', createdAt: '2026-08-10T00:00:00.000Z' },
        {
          type: 'tool.finished',
          toolCallId: 'batch-call',
          name: 'read_file',
          createdAt: '2026-08-10T00:00:00.010Z',
          result: { ok: true, command: 'read_file', exitCode: 0, stdout: 'private', stderr: '' },
        },
      ]);
      expect(events[1]).toMatchObject({
        type: 'tool.finished',
        outcomeV1: { status: 'success', dispatchState: 'started', externalEffects: 'none' },
      });
    } finally {
      kernel.close();
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`, { force: true });
      }
    }
  });

  test('records human approval wait and production shell timeout as canonical outcome facts', async () => {
    const timed = await shellTool({
      workspace: process.cwd(),
      command: 'sleep 0.05',
      timeoutMs: 5,
    });
    expect(timed).toMatchObject({ ok: false, terminationReason: 'timed_out' });

    const path = join(tmpdir(), `kite-tool-timing-${crypto.randomUUID()}.db`);
    const kernel = createAgentKernel({
      threadId: 'tool-timing',
      userId: 'user',
      workspace: '/workspace',
      storePath: path,
    });
    try {
      kernel.processEvent({
        type: 'tool.queued',
        toolCallId: 'approval-call',
        name: 'shell_execute',
        args: { command: 'private' },
        modelMessageId: 'model',
        createdAt: '2026-08-10T00:00:00.000Z',
      });
      kernel.processEvent({
        type: 'approval.requested',
        interactionId: 'approval',
        toolCallId: 'approval-call',
        createdAt: '2026-08-10T00:00:00.010Z',
        approval: {
          scope: 'once',
          cwd: '/workspace',
          threadId: 'tool-timing',
          tool: 'shell_execute',
          command: 'private',
          risk: 'execute_code',
          approvalHash: 'hash',
          summary: 'private',
          reason: 'private',
          expectedEffects: [],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
        },
      } as never);
      const rejected = kernel.processEventBatch([
        {
          type: 'approval.rejected',
          interactionId: 'approval',
          toolCallId: 'approval-call',
          reason: 'private',
          createdAt: '2026-08-10T00:00:00.035Z',
        },
      ]);
      expect(rejected[0]).toMatchObject({
        outcomeV1: { timing: { approvalWaitMs: 25, totalActiveMs: 35 } },
      });

      kernel.processEvent({
        type: 'tool.queued',
        toolCallId: 'approval-success',
        name: 'shell_execute',
        args: { command: 'true' },
        modelMessageId: 'model-success',
        createdAt: '2026-08-10T00:01:00.000Z',
      });
      kernel.processEvent({
        type: 'approval.requested',
        interactionId: 'approval-success-interaction',
        toolCallId: 'approval-success',
        createdAt: '2026-08-10T00:01:00.010Z',
        approval: {
          scope: 'once',
          cwd: '/workspace',
          threadId: 'tool-timing',
          tool: 'shell_execute',
          command: 'true',
          risk: 'execute_code',
          approvalHash: 'hash-success',
          summary: 'private',
          reason: 'private',
          expectedEffects: [],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
        },
      } as never);
      kernel.processEvent({
        type: 'approval.granted',
        interactionId: 'approval-success-interaction',
        toolCallId: 'approval-success',
        grant: 'approve_once',
        createdAt: '2026-08-10T00:01:00.035Z',
      } as never);
      kernel.processEvent({
        type: 'tool.started',
        toolCallId: 'approval-success',
        createdAt: '2026-08-10T00:01:00.040Z',
      });
      const approvedTerminal = kernel.processEventBatch([
        {
          type: 'tool.finished',
          toolCallId: 'approval-success',
          name: 'shell_execute',
          createdAt: '2026-08-10T00:01:00.060Z',
          result: { ok: true, command: 'true', exitCode: 0, stdout: '', stderr: '' },
        },
      ]);
      expect(approvedTerminal[0]).toMatchObject({
        outcomeV1: {
          status: 'success',
          timing: {
            queueMs: 40,
            executionMs: 20,
            approvalWaitMs: 25,
            totalActiveMs: 60,
          },
        },
      });

      kernel.processEvent({
        type: 'tool.queued',
        toolCallId: 'auto-review-success',
        name: 'shell_execute',
        args: { command: 'pwd' },
        modelMessageId: 'model-auto-review',
        createdAt: '2026-08-10T00:02:00.000Z',
      });
      kernel.processEvent({
        type: 'auto_review.requested',
        reviewId: 'auto-review-success-interaction',
        toolCallId: 'auto-review-success',
        toolName: 'shell_execute',
        reason: 'private',
        approval: {
          scope: 'once',
          cwd: '/workspace',
          threadId: 'tool-timing',
          tool: 'shell_execute',
          command: 'pwd',
          risk: 'execute_code',
          approvalHash: 'hash-auto-success',
          summary: 'private',
          reason: 'private',
          expectedEffects: [],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
        },
      });
      kernel.processEvent({
        type: 'auto_review.completed',
        reviewId: 'auto-review-success-interaction',
        toolCallId: 'auto-review-success',
        result: {
          ok: true,
          approved: true,
          reviewerModelName: 'test',
          durationMs: 20,
        },
      });
      kernel.processEvent({
        type: 'tool.started',
        toolCallId: 'auto-review-success',
        createdAt: '2026-08-10T00:02:00.030Z',
      });
      const autoApprovedTerminal = kernel.processEventBatch([
        {
          type: 'tool.finished',
          toolCallId: 'auto-review-success',
          name: 'shell_execute',
          createdAt: '2026-08-10T00:02:00.050Z',
          result: { ok: true, command: 'pwd', exitCode: 0, stdout: '', stderr: '' },
        },
      ]);
      expect(autoApprovedTerminal[0]).toMatchObject({
        outcomeV1: {
          status: 'success',
          timing: { approvalWaitMs: 20, totalActiveMs: 50 },
        },
      });

      kernel.processEvent({
        type: 'tool.queued',
        toolCallId: 'timeout-call',
        name: 'shell_execute',
        args: { command: 'sleep' },
        modelMessageId: 'model-timeout',
      });
      kernel.processEvent({ type: 'tool.started', toolCallId: 'timeout-call' });
      const terminal = kernel.processEventBatch([
        {
          type: 'tool.finished',
          toolCallId: 'timeout-call',
          name: 'shell_execute',
          result: {
            ok: false,
            command: 'sleep',
            exitCode: 124,
            stdout: '',
            stderr: 'private',
            terminationReason: 'timed_out',
          },
        } as never,
      ]);
      expect(terminal[0]).toMatchObject({
        outcomeV1: {
          status: 'timed_out',
          failure: { kind: 'tool_timeout', detailCode: 'timed_out' },
        },
      });
      expect(kernel.getState().tools.calls['timeout-call']).toMatchObject({
        status: 'failed',
        outcomeV1: { status: 'timed_out' },
      });
    } finally {
      kernel.close();
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`, { force: true });
      }
    }
  });

  test('historical terminal event replays as legacy_unclassified without text inference', () => {
    let state = createInitialRuntimeState({
      threadId: 'historical-tool-outcome',
      userId: 'user',
      workspace: '/workspace',
    });
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'legacy',
      name: 'shell_execute',
      args: { command: 'private command' },
      modelMessageId: 'legacy-model',
    });
    state = reduceRuntimeStateFromHistoricalSchema(
      state,
      {
        type: 'tool.failed',
        toolCallId: 'legacy',
        error: 'permission denied timeout ENOENT',
      },
      22,
    );
    expect(state.tools.calls.legacy?.outcomeV1).toMatchObject({
      failure: { detailCode: 'legacy_unclassified' },
      dispatchState: 'unknown',
      externalEffects: 'unknown',
      recovery: { disposition: 'never', safeAutomaticRetry: false },
    });
    expect(state.transcript.messages.filter((message) => message.kind === 'tool')).toHaveLength(1);
  });

  test('persisted outcome with unknown JSON fails closed instead of widening recovery', () => {
    let state = createInitialRuntimeState({
      threadId: 'invalid-persisted-tool-outcome',
      userId: 'user',
      workspace: '/workspace',
    });
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'invalid-outcome',
      name: 'read_file',
      args: { path: 'private' },
      modelMessageId: 'legacy-model',
    });
    state = reduceRuntimeStateFromHistoricalSchema(
      state,
      {
        type: 'tool.failed',
        toolCallId: 'invalid-outcome',
        error: 'private',
        outcomeV1: {
          schemaVersion: 1,
          status: 'failed',
          unexpected: 'retry_forever',
        },
      } as never,
      22,
    );
    expect(state.tools.calls['invalid-outcome']?.outcomeV1).toMatchObject({
      status: 'unknown',
      failure: { detailCode: 'classifier_invalid' },
      recovery: { disposition: 'never', safeAutomaticRetry: false },
    });
  });

  test('tool-returned failure without a ToolSpec classifier fails closed', () => {
    const path = join(tmpdir(), `kite-tool-classifier-${crypto.randomUUID()}.db`);
    const kernel = createAgentKernel({
      threadId: 'tool-classifier-missing',
      userId: 'user',
      workspace: '/workspace',
      storePath: path,
    });
    try {
      kernel.processEvent({
        type: 'tool.queued',
        toolCallId: 'call',
        name: 'shell_execute',
        args: { command: 'private' },
        modelMessageId: 'model',
      });
      kernel.processEvent({ type: 'tool.started', toolCallId: 'call' });
      kernel.processEvent({
        type: 'tool.finished',
        toolCallId: 'call',
        name: 'shell_execute',
        result: {
          ok: false,
          command: 'private',
          exitCode: 1,
          stdout: '',
          stderr: 'private failure body',
        },
      });
      expect(kernel.getState().tools.calls.call?.outcomeV1).toMatchObject({
        status: 'unknown',
        failure: { kind: 'unknown', detailCode: 'classifier_missing' },
        recovery: { disposition: 'never', safeAutomaticRetry: false },
        diagnosticCodes: ['classifier_missing'],
      });
    } finally {
      kernel.close();
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`, { force: true });
      }
    }
  });

  test('restart preserves a concrete correction binding without charging a sibling call', () => {
    const path = join(tmpdir(), `kite-tool-recovery-restart-${crypto.randomUUID()}.db`);
    try {
      const first = createAgentKernel({
        threadId: 'tool-recovery-restart',
        userId: 'user',
        workspace: '/workspace',
        storePath: path,
      });
      first.processEvent({
        type: 'tool.queued',
        toolCallId: 'first',
        name: 'read_file',
        args: { path: 123 },
        modelMessageId: 'model-1',
      });
      first.processEvent({
        type: 'tool.failed',
        toolCallId: 'first',
        failure: classifyFailure('tool_invalid_args', 'invalid argument'),
      });
      first.close();

      const second = createAgentKernel({
        threadId: 'tool-recovery-restart',
        userId: 'user',
        workspace: '/workspace',
        storePath: path,
      });
      second.processEvent({
        type: 'model.responded',
        messageId: 'model-2',
        toolCalls: [{ id: 'second', name: 'read_file', args: { path: 'fixed.txt' } }],
      });
      second.processEvent({
        type: 'tool.queued',
        toolCallId: 'second',
        name: 'read_file',
        args: { path: 'fixed.txt' },
        modelMessageId: 'model-2',
      });
      expect(second.getState().tools.calls.second).toMatchObject({
        recoveryAdmission: 'admitted',
        recoveryOf: expect.any(String),
      });
      second.close();

      const third = createAgentKernel({
        threadId: 'tool-recovery-restart',
        userId: 'user',
        workspace: '/workspace',
        storePath: path,
      });
      third.processEvent({
        type: 'model.responded',
        messageId: 'model-3',
        toolCalls: [{ id: 'third', name: 'read_file', args: { path: 'another.txt' } }],
      });
      third.processEvent({
        type: 'tool.queued',
        toolCallId: 'third',
        name: 'read_file',
        args: { path: 'another.txt' },
        modelMessageId: 'model-3',
      });
      expect(third.getState().tools.calls.third).toMatchObject({ recoveryAdmission: 'admitted' });
      expect(third.getState().tools.calls.third?.recoveryOf).toBeUndefined();
      third.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`, { force: true });
      }
    }
  });

  test('scopes correction lineage to the owning task, turn, and immediately next model response', () => {
    let state = createInitialRuntimeState({
      threadId: 'tool-recovery-scope',
      userId: 'user',
      workspace: '/workspace',
    });
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'user-old',
      content: 'old task',
    });
    const oldTaskId = state.activeTaskId!;
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'old-failure',
      name: 'read_file',
      args: { path: 1 },
      modelMessageId: 'model-old',
      taskId: oldTaskId,
    });
    state = reduceRuntimeState(state, {
      type: 'tool.failed',
      toolCallId: 'old-failure',
      failure: classifyFailure('tool_invalid_args', 'private'),
      outcomeV1: correctArgsOutcome,
    });
    const oldFailureId = state.toolRecovery.order.at(-1)!;
    expect(state.toolRecovery.failures[oldFailureId]).toMatchObject({
      taskId: oldTaskId,
      turnId: state.turn.turnId,
      eligibleAfterModelMessageId: 'model-old',
      status: 'unresolved',
    });

    state = reduceRuntimeState(state, {
      type: 'model.responded',
      messageId: 'model-next',
      text: 'skip and continue',
      toolCalls: [],
    });
    expect(state.toolRecovery.failures[oldFailureId]).toMatchObject({
      status: 'exhausted',
      resolution: 'next_response_elapsed',
    });

    state = reduceRuntimeState(state, {
      type: 'task.completed',
      taskId: oldTaskId,
      turnId: state.turn.turnId,
    });
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'user-new',
      content: 'new task',
    });
    const newTaskId = state.activeTaskId!;
    expect(newTaskId).not.toBe(oldTaskId);
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'new-call',
      name: 'read_file',
      args: { path: 1 },
      modelMessageId: 'new-model',
      taskId: newTaskId,
    });
    expect(state.tools.calls['new-call']).toMatchObject({ recoveryAdmission: 'admitted' });
    expect(state.tools.calls['new-call']?.recoveryOf).toBeUndefined();

    let unrelated = recordRecoveryFailureV1(createToolRecoveryJournalV1(), {
      toolCallId: 'needs-read',
      toolName: 'read_file',
      invocationFingerprint: 'f'.repeat(64),
      modelMessageId: 'model-before',
      taskId: newTaskId,
      turnId: state.turn.turnId,
      outcome: correctArgsOutcome,
    });
    const unrelatedId = unrelated.order[0]!;
    unrelated = advanceToolRecoveryResponseV1(unrelated, {
      taskId: newTaskId,
      turnId: state.turn.turnId,
      modelMessageId: 'model-unrelated',
      toolCalls: [{ id: 'unrelated-plan', name: 'write_plan' }],
    });
    expect(unrelated.failures[unrelatedId]).toMatchObject({
      status: 'exhausted',
      resolution: 'next_response_elapsed',
    });
  });

  test('never and explicit plan/provider progress terminally resolve instead of blocking completion forever', () => {
    let journal = createToolRecoveryJournalV1();
    journal = recordRecoveryFailureV1(journal, {
      toolCallId: 'deny',
      toolName: 'shell_execute',
      invocationFingerprint: 'd'.repeat(64),
      modelMessageId: 'model-deny',
      taskId: 'task',
      turnId: 'turn',
      outcome: classifyToolOutcomeV1({
        status: 'rejected',
        failure: classifyFailure('approval_rejected', 'private'),
        authority: { approvalDenied: true, dispatchState: 'not_started', externalEffects: 'none' },
      }),
    } as never);
    const denyId = journal.order.at(-1)!;
    expect(journal.failures[denyId]).toMatchObject({ status: 'exhausted', resolution: 'terminal' });

    journal = recordRecoveryFailureV1(journal, {
      toolCallId: 'provider',
      toolName: 'mcp__fixture__read',
      invocationFingerprint: 'e'.repeat(64),
      modelMessageId: 'model-provider',
      taskId: 'task',
      turnId: 'turn',
      outcome: classifyToolOutcomeV1({
        status: 'failed',
        failure: classifyFailure('provider_unavailable', 'private'),
        authority: { dispatchState: 'started', externalEffects: 'none', replaySafety: 'safe_read' },
      }),
    } as never);
    const providerId = journal.order.at(-1)!;
    journal = recordToolOwnedProgressV1(journal, {
      kind: 'provider_revision',
      referenceId: 'provider-revision-2',
      resolvesFailureIds: [providerId],
    } as never);
    expect(journal.failures[providerId]).toMatchObject({
      status: 'recovered',
      resolution: 'provider_revision',
    });
  });

  test('merges a delegated child journal into the same canonical parent state', () => {
    let state = createInitialRuntimeState({
      threadId: 'parent-child-journal',
      userId: 'user',
      workspace: '/workspace',
    });
    state = reduceRuntimeState(state, {
      type: 'user.message_appended',
      messageId: 'parent-user',
      content: 'delegate',
    });
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'task-call',
      name: 'task',
      args: { subagent_type: 'explore', task: 'inspect' },
      modelMessageId: 'parent-model',
    });
    const parentIdentityKey = state.toolRecovery.identityKey;
    const childArgs = { command: 'private-child-command' };
    const childFingerprint = toolInvocationFingerprintV1({
      key: parentIdentityKey,
      toolName: 'shell_execute',
      parsedArgs: childArgs,
    });
    const child = recordRecoveryFailureV1(createToolRecoveryJournalV1(parentIdentityKey), {
      toolCallId: 'child-failure',
      toolName: 'shell_execute',
      invocationFingerprint: childFingerprint,
      modelMessageId: 'child-model',
      outcome: classifyToolOutcomeV1({
        status: 'rejected',
        failure: classifyFailure('policy_denied', 'redacted'),
        authority: {
          dispatchState: 'not_started',
          externalEffects: 'none',
          replaySafety: 'pre_dispatch',
          policyDenied: true,
        },
      }),
    });
    state = reduceRuntimeState(state, {
      type: 'subagent.recovery_journal_merged',
      toolCallId: 'task-call',
      journal: child,
    });
    expect(state.toolRecovery.order).toEqual(child.order);
    expect(state.toolRecovery.identityKey).toBe(parentIdentityKey);
    expect(state.toolRecovery.failures[child.order[0]!]).toMatchObject({
      taskId: state.tools.calls['task-call']?.taskId,
      turnId: state.tools.calls['task-call']?.createdAtTurnId,
    });

    state = reduceRuntimeState(state, {
      type: 'model.responded',
      messageId: 'parent-model-next',
      toolCalls: [{ id: 'parent-repeat', name: 'shell_execute', args: childArgs }],
    });
    state = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'parent-repeat',
      name: 'shell_execute',
      args: childArgs,
      invocationFingerprint: childFingerprint,
      modelMessageId: 'parent-model-next',
    });
    expect(state.tools.calls['parent-repeat']?.recoveryAdmission).toBe('recovery_not_allowed');
    expect(JSON.stringify(state.toolRecovery)).not.toContain('private-child-command');

    const foreign = recordRecoveryFailureV1(createToolRecoveryJournalV1(), {
      toolCallId: 'foreign-child',
      toolName: 'read_file',
      invocationFingerprint: 'f'.repeat(64),
      modelMessageId: 'foreign-model',
      outcome: legacyFailedReplayOutcome(),
    });
    const beforeForeignOrder = [...state.toolRecovery.order];
    state = reduceRuntimeState(state, {
      type: 'subagent.recovery_journal_merged',
      toolCallId: 'task-call',
      journal: foreign,
    });
    expect(state.toolRecovery.order).toEqual(beforeForeignOrder);
    expect(state.toolRecovery.qualityGuard).toMatchObject({
      blocked: true,
      reasonCode: 'journal_invalid',
    });
    expect(JSON.stringify(state.toolRecovery)).not.toContain('f'.repeat(64));
  });

  test('CompletionGuard V2 rejects a completed plan while typed failures remain unresolved', () => {
    const state = createInitialRuntimeState({
      threadId: 'guard-unresolved-tool',
      userId: 'user',
      workspace: '/workspace',
    });
    const structural = {
      title: 'Finish guarded work',
      bodyMarkdown: 'Complete the guarded implementation and verify all evidence.',
      steps: [{ id: 'finish', title: 'Finish implementation', status: 'completed' as const }],
    };
    const document = {
      planSchemaVersion: 2 as const,
      planId: 'plan-tool-guard',
      version: 1,
      ...structural,
      structuralDigest: computePlanStructuralDigest(structural),
      createdAtTurnId: state.turn.turnId,
      updatedAtTurnId: state.turn.turnId,
      completionEvidence: {
        schemaVersion: 1 as const,
        verification: [],
        execution: [],
        skipped: [],
        unresolved: [],
      },
      artifact: {
        artifactId: 'a'.repeat(64),
        taskId: 'task',
        planId: 'plan-tool-guard',
        version: 1,
        fileName: 'plan.md',
        relativePath: 'plans/plan.md',
        displayPath: '/workspace/plans/plan.md',
        structuralDigest: computePlanStructuralDigest(structural),
        byteLength: 100,
      },
    };
    state.activeTaskId = 'task';
    state.tasks.task = {
      taskId: 'task',
      userGoal: 'finish',
      status: 'active',
      startedAtTurnId: state.turn.turnId,
      sideEffectsStarted: false,
      planning: { kind: 'completed', document, completedAtTurnId: state.turn.turnId },
      planHistory: [],
    };
    state.planning = state.tasks.task.planning;
    state.toolRecovery = recordRecoveryFailureV1(state.toolRecovery, {
      toolCallId: 'failed',
      toolName: 'read_file',
      invocationFingerprint: 'private',
      modelMessageId: 'model',
      outcome: correctArgsOutcome,
      taskId: 'task',
      turnId: state.turn.turnId,
    });
    expect(decideCompletionV2(state)).toMatchObject({
      status: 'blocked',
      code: 'plan_evidence_unresolved',
      nextAction: 'resolve_plan_evidence',
    });
  });
});
