import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, descriptorRevision } from '@/core/capabilities/catalog';
import type { AgentConfig } from '@/core/config';
import { McpProviderError } from '@/core/mcp';
import { McpConnectionManager } from '@/core/mcp/manager';
import {
  type CompletionBlockerCode,
  isCompletionBlockerCode,
} from '@/core/runtime/completion-guard';
import type { RuntimeEvent } from '@/core/runtime/events';
import { createRuntimeEffectExecutor } from '@/core/runtime/executor';
import { type FailureKind, isFailureKind } from '@/core/runtime/failures';
import { AgentKernel, type RuntimeEffectExecutor } from '@/core/runtime/kernel';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { runRuntimeLoop } from '@/core/runtime/runner';
import {
  computePlanStructuralDigest,
  createInitialRuntimeState,
  getActivePlanning,
  type RuntimeState,
  setActivePlanning,
} from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import {
  isToolOutcomeDetailCodeV1,
  type ToolOutcomeDetailCodeV1,
  type ToolOutcomeV1,
} from '@/core/runtime/tool-outcome';
import {
  isToolRecoveryResolutionV1,
  type ToolRecoveryResolutionV1,
} from '@/core/runtime/tool-recovery-journal';
import type { ShellExecutor } from '@/core/tools/shell';
import { executeVerificationEffect } from '@/core/verification';
import {
  testCapabilityArtifactWriterV1,
  testWorkspaceFilesystemRuntimeV1,
} from '../helpers/runtime-model';
import { createSandboxExecutor } from '../helpers/sandbox-executor';

export const TOOL_JOURNEY_CASE_IDS_V1 = [
  'search_read',
  'read_edit_verify',
  'invalid_args_correct_once',
  'enoent_locate_success',
  'rg_no_match_stop',
  'approval_policy_rejection_no_retry',
  'safe_pre_dispatch_transient',
  'timeout_unknown_no_replay',
  'sandbox_permission_no_escalation',
  'repeated_failure_replan_finalize',
] as const;

type ToolJourneyCaseIdV1 = (typeof TOOL_JOURNEY_CASE_IDS_V1)[number];

interface CanonicalOutcomeReportV1 {
  status: 'success' | 'failed' | 'rejected' | 'cancelled' | 'timed_out' | 'exhausted' | 'unknown';
  failureKind?: FailureKind;
  detailCode?: ToolOutcomeDetailCodeV1;
  dispatchState: 'not_started' | 'started' | 'unknown';
  externalEffects: 'none' | 'known' | 'unknown';
  replaySafety: 'none' | 'pre_dispatch' | 'safe_read' | 'idempotency_receipt';
  recoveryDisposition: 'never' | 'correct_args' | 'retry_once' | 'alternative' | 'user_action';
  recoveryAttempt: 0 | 1;
  recoveryLinked: boolean;
  resolution?: ToolRecoveryResolutionV1;
  timingSource: 'runtime_boundary' | 'legacy_unknown';
}

export interface ToolJourneyCaseReportV1 {
  id: ToolJourneyCaseIdV1;
  passed: boolean;
  fullRuntimeLoop: boolean;
  productionController: boolean;
  directTerminalEvents: number;
  modelAttempts: number;
  toolDispatches: number;
  dispatchAttempts: number;
  typedTerminalCount: number;
  correctionCount: number;
  automaticRetryCount: number;
  trustedTimingObserved: boolean;
  environmentIsolated: boolean;
  providerDispatchAttempts: number;
  preDispatchBoundaryAttempts: number;
  sandboxBoundaryAttempts: number;
  underlyingCommandAttempts: number;
  sandboxSentinelTriggered: boolean;
  authorizationWideningEvents: number;
  canonicalOutcomes: CanonicalOutcomeReportV1[];
  completionBlock?: {
    code: CompletionBlockerCode;
    correctionAttempt: number;
    atomicTerminal: boolean;
  };
  terminal: 'completed' | 'blocked';
}

export interface ToolJourneyEvalReportV1 {
  schema: 'ToolJourneyEvalV1';
  cases: ToolJourneyCaseReportV1[];
  summary: { total: number; passed: number; failed: number };
  coverage: {
    typedOutcome: boolean;
    recoveryLineage: boolean;
    trustedTiming: boolean;
    completionGuard: boolean;
    metadataOnly: boolean;
  };
  kernelCloseCount: number;
  contentLogged: false;
}

const CONFIG: AgentConfig = {
  apiKey: '',
  baseURL: 'http://localhost',
  modelName: 'test',
  providerName: 'test',
  providerType: 'openai-compatible',
  sandbox: { enabled: false },
  features: {
    promptContractV2: false,
    capabilityCatalogV1: true,
    mcpRuntimeBindingV1: true,
    verificationV1: true,
  },
};

function modelToolEvents(
  state: RuntimeState,
  messageId: string,
  calls: readonly {
    id: string;
    name: string;
    input: Record<string, unknown>;
    sideEffect?: boolean;
    bindingId?: string;
    capabilityId?: string;
    capabilityRevision?: string;
  }[],
): RuntimeEvent[] {
  return [
    {
      type: 'model.responded',
      messageId,
      toolCalls: calls.map((call) => ({ id: call.id, name: call.name, args: call.input })),
    },
    ...calls.map(
      (call, ordinal): RuntimeEvent => ({
        type: 'tool.queued',
        toolCallId: call.id,
        name: call.name,
        args: call.input,
        modelMessageId: messageId,
        ordinal,
        taskId: state.activeTaskId ?? undefined,
        effectClass: call.sideEffect ? 'workspace_write' : 'read_only',
        sideEffect: call.sideEffect ?? false,
        ...(call.bindingId ? { bindingId: call.bindingId } : {}),
        ...(call.capabilityId ? { capabilityId: call.capabilityId } : {}),
        ...(call.capabilityRevision ? { capabilityRevision: call.capabilityRevision } : {}),
      }),
    ),
  ];
}

function finalModelEvent(attempt: number): RuntimeEvent[] {
  return [{ type: 'model.responded', messageId: `final-${attempt}`, text: 'done' }];
}

function completionBlockedState(threadId: string, workspace: string): RuntimeState {
  let state = createInitialRuntimeState({ threadId, userId: 'eval', workspace });
  state = reduceRuntimeState(state, {
    type: 'task.started',
    taskId: 'task-v2',
    userGoal: 'Exercise CompletionGuard V2 through the production loop.',
    turnId: state.turn.turnId,
  });
  const plan = {
    title: 'CompletionGuard production journey',
    bodyMarkdown: 'Require Runtime-owned effect evidence before accepting the final response.',
    steps: [{ id: 'inspect', title: 'Inspect the fixture', status: 'completed' as const }],
  };
  const document = {
    planSchemaVersion: 2 as const,
    planId: 'plan-v2',
    version: 1,
    structuralDigest: computePlanStructuralDigest(plan),
    ...plan,
    createdAtTurnId: state.turn.turnId,
    updatedAtTurnId: state.turn.turnId,
    completionEvidence: {
      schemaVersion: 1 as const,
      verification: [],
      execution: [],
      skipped: [],
      unresolved: [],
    },
  };
  state = setActivePlanning(state, {
    kind: 'executing',
    document,
    executionMode: 'accept_edits',
    approvedAtTurnId: state.turn.turnId,
  });
  if (state.activeTaskId) {
    state = {
      ...state,
      tasks: {
        ...state.tasks,
        [state.activeTaskId]: { ...state.tasks[state.activeTaskId]!, sideEffectsStarted: true },
      },
    };
  }
  return state;
}

function safeReadManager() {
  const descriptorWithoutRevision = {
    capabilityId: 'mcp:fixture/read',
    kind: 'mcp_tool' as const,
    displayName: 'read',
    description: 'Read fixture metadata.',
    provider: { type: 'mcp' as const, id: 'fixture', provenance: 'project' as const },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
  const descriptor = {
    ...descriptorWithoutRevision,
    revision: descriptorRevision(descriptorWithoutRevision),
  };
  const manager = new McpConnectionManager();
  const runtimeManager = manager as McpConnectionManager & {
    ensureProviderReady(providerId: string, timeoutMs?: number): Promise<void>;
  };
  let boundaryCalls = 0;
  runtimeManager.ensureProviderReady = async () => {
    boundaryCalls += 1;
    if (boundaryCalls === 1) {
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
  let capabilityCalls = 0;
  manager.callCapability = async () => {
    capabilityCalls += 1;
    return { content: [] };
  };
  return {
    manager: runtimeManager,
    descriptor,
    boundaryCalls: () => boundaryCalls,
    capabilityCalls: () => capabilityCalls,
  };
}

function scriptedEvents(
  id: ToolJourneyCaseIdV1,
  state: RuntimeState,
  attempt: number,
): RuntimeEvent[] {
  switch (id) {
    case 'search_read':
      if (attempt === 1)
        return modelToolEvents(state, 'search-model', [
          { id: 'search', name: 'search_content', input: { pattern: 'needle' } },
        ]);
      if (attempt === 2)
        return modelToolEvents(state, 'read-model', [
          { id: 'read', name: 'read_file', input: { path: 'needle.ts' } },
        ]);
      return finalModelEvent(attempt);
    case 'read_edit_verify':
      if (attempt === 1)
        return modelToolEvents(state, 'read-before-edit', [
          { id: 'read-edit', name: 'read_file', input: { path: 'edit.ts' } },
        ]);
      if (attempt === 2)
        return modelToolEvents(state, 'edit-model', [
          {
            id: 'edit',
            name: 'edit_file',
            input: { path: 'edit.ts', old_string: 'a', new_string: 'b' },
            sideEffect: true,
          },
        ]);
      return finalModelEvent(attempt);
    case 'invalid_args_correct_once':
      if (attempt === 1)
        return modelToolEvents(state, 'invalid-model', [
          { id: 'invalid-read', name: 'read_file', input: { path: 1 } },
        ]);
      if (attempt === 2)
        return modelToolEvents(state, 'corrected-model', [
          { id: 'corrected-read', name: 'read_file', input: { path: 'fixed.ts' } },
        ]);
      return finalModelEvent(attempt);
    case 'enoent_locate_success':
      if (attempt === 1)
        return modelToolEvents(state, 'missing-model', [
          { id: 'missing-read', name: 'read_file', input: { path: 'missing.ts' } },
        ]);
      if (attempt === 2)
        return modelToolEvents(state, 'locate-model', [
          { id: 'locate', name: 'search_files', input: { pattern: 'found.ts' } },
        ]);
      if (attempt === 3)
        return modelToolEvents(state, 'found-read-model', [
          { id: 'found-read', name: 'read_file', input: { path: 'found.ts' } },
        ]);
      return finalModelEvent(attempt);
    case 'rg_no_match_stop':
      return attempt === 1
        ? modelToolEvents(state, 'no-match-model', [
            { id: 'no-match', name: 'search_content', input: { pattern: 'absent' } },
          ])
        : finalModelEvent(attempt);
    case 'approval_policy_rejection_no_retry':
      return attempt === 1
        ? modelToolEvents(state, 'approval-model', [
            {
              id: 'approval-write',
              name: 'write_file',
              input: { path: '/etc/kite-code-eval-approval', content: 'rejected' },
              sideEffect: true,
            },
          ])
        : finalModelEvent(attempt);
    case 'safe_pre_dispatch_transient':
      if (attempt === 1) {
        const binding = Object.values(state.capabilities.bindings).find(
          (candidate) => candidate.exposedToolName === 'mcp__fixture__read',
        );
        if (!binding) throw new Error('safe-read journey binding is missing');
        return modelToolEvents(state, 'retry-model', [
          {
            id: 'retry-read',
            name: 'mcp__fixture__read',
            input: {},
            bindingId: binding.bindingId,
            capabilityId: binding.capabilityId,
            capabilityRevision: binding.capabilityRevision,
          },
        ]);
      }
      return finalModelEvent(attempt);
    case 'timeout_unknown_no_replay':
      return attempt === 1
        ? modelToolEvents(state, 'timeout-model', [
            { id: 'timeout', name: 'shell_execute', input: { command: 'pwd' } },
          ])
        : finalModelEvent(attempt);
    case 'sandbox_permission_no_escalation':
      return attempt === 1
        ? modelToolEvents(state, 'sandbox-model', [
            {
              id: 'sandbox',
              name: 'shell_execute',
              input: { command: 'pwd' },
            },
          ])
        : finalModelEvent(attempt);
    case 'repeated_failure_replan_finalize': {
      if (attempt === 1)
        return modelToolEvents(state, 'first-failure-model', [
          { id: 'first-missing', name: 'read_file', input: { path: 'missing-first.ts' } },
        ]);
      if (attempt === 2)
        return modelToolEvents(state, 'second-failure-model', [
          {
            id: 'second-search',
            name: 'search_files',
            input: { pattern: '*', path: 'missing-search-root' },
          },
        ]);
      const planning = getActivePlanning(state);
      if (attempt === 3 && planning.kind === 'executing')
        return modelToolEvents(state, 'replan-model', [
          {
            id: 'real-replan',
            name: 'write_plan',
            input: {
              action: 'save',
              plan_id: planning.document.planId,
              version: planning.document.version,
              structural_digest: planning.document.structuralDigest,
              replan_reason: 'two_real_failures',
              title: 'Finalize after bounded recovery',
              body_markdown:
                'Record the bounded recovery result and finalize without another retry.',
              steps: [{ id: 'finalize', title: 'Finalize the bounded recovery' }],
            },
          },
        ]);
      if (attempt === 4 && planning.kind === 'replanning_draft')
        return modelToolEvents(state, 'submit-replan-model', [
          {
            id: 'submit-replan',
            name: 'write_plan',
            input: {
              action: 'submit',
              plan_id: planning.document.planId,
              version: planning.document.version,
              structural_digest: planning.document.structuralDigest,
            },
          },
        ]);
      if (attempt === 5 && planning.kind === 'executing')
        return modelToolEvents(state, 'complete-replan-model', [
          {
            id: 'complete-replan',
            name: 'update_plan',
            input: {
              plan_id: planning.document.planId,
              version: planning.document.version,
              structural_digest: planning.document.structuralDigest,
              updates: [{ step_id: 'finalize', status: 'completed' }],
              complete_plan: true,
            },
          },
        ]);
      return finalModelEvent(attempt);
    }
  }
}

const FORBIDDEN_SCRIPTED_TERMINALS = new Set([
  'tool.finished',
  'tool.failed',
  'tool.rejected',
  'tool.cancelled',
  'tool.retry_recorded',
  'approval.rejected',
  'run.error',
  'turn.aborted',
]);

async function runCase(
  id: ToolJourneyCaseIdV1,
  onKernelClosed: () => void,
): Promise<ToolJourneyCaseReportV1> {
  const workspace = mkdtempSync(join(tmpdir(), `kite-tool-journey-${id}-`));
  const isolatedHome = join(workspace, '.isolated-home');
  const isolatedKiteHome = join(workspace, '.isolated-kite-data');
  const previousHome = process.env.HOME;
  const previousKiteHome = process.env.KITE_CODE_HOME;
  try {
    mkdirSync(isolatedHome);
    mkdirSync(isolatedKiteHome);
    process.env.HOME = isolatedHome;
    process.env.KITE_CODE_HOME = isolatedKiteHome;
    return await runIsolatedCase(
      id,
      onKernelClosed,
      workspace,
      process.env.HOME === isolatedHome && process.env.KITE_CODE_HOME === isolatedKiteHome,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousKiteHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousKiteHome;
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function runIsolatedCase(
  id: ToolJourneyCaseIdV1,
  onKernelClosed: () => void,
  workspace: string,
  environmentIsolated: boolean,
): Promise<ToolJourneyCaseReportV1> {
  writeFileSync(join(workspace, 'needle.ts'), 'export const needle = true;\n');
  writeFileSync(join(workspace, 'edit.ts'), 'a\n');
  writeFileSync(join(workspace, 'fixed.ts'), 'fixed\n');
  writeFileSync(join(workspace, 'found.ts'), 'found\n');
  let initial =
    id === 'repeated_failure_replan_finalize' || id === 'timeout_unknown_no_replay'
      ? completionBlockedState(`tool-journey-${id}`, workspace)
      : createInitialRuntimeState({
          threadId: `tool-journey-${id}`,
          userId: 'eval',
          workspace,
        });
  if (id === 'repeated_failure_replan_finalize' && initial.activeTaskId) {
    initial = {
      ...initial,
      tasks: {
        ...initial.tasks,
        [initial.activeTaskId]: {
          ...initial.tasks[initial.activeTaskId]!,
          sideEffectsStarted: false,
        },
      },
    };
  }
  const safeRead = id === 'safe_pre_dispatch_transient' ? safeReadManager() : undefined;
  if (safeRead) {
    const binding = createBinding({
      descriptor: safeRead.descriptor,
      exposedToolName: 'mcp__fixture__read',
      turnId: initial.turn.turnId,
    });
    initial.capabilities.bindings[binding.bindingId] = binding;
  }
  const store = createRuntimeStore(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: initial,
    interactionMode: id === 'approval_policy_rejection_no_retry' ? 'auto' : 'accept_edits',
  });
  let modelAttempts = 0;
  let controllerEffects = 0;
  let directTerminalEvents = 0;
  let sandboxBoundaryAttempts = 0;
  let underlyingCommandAttempts = 0;
  const emitted: RuntimeEvent[] = [];
  const sandboxSentinelMarker = join(workspace, '.unexpected-sandbox-fallback');
  const controlledUnderlyingExecutor: ShellExecutor = async ({ command }) => {
    underlyingCommandAttempts += 1;
    writeFileSync(sandboxSentinelMarker, 'invoked');
    return {
      ok: true,
      command,
      exitCode: 0,
      stdout: 'unexpected fallback execution',
      stderr: '',
    };
  };
  const unavailableSandbox = createSandboxExecutor(
    {
      enabled: false,
      workspace,
      unavailableFallback: 'fail',
    },
    controlledUnderlyingExecutor,
  );
  const capabilityArtifactStore = testCapabilityArtifactWriterV1();
  const production = createRuntimeEffectExecutor({
    config: CONFIG,
    model: {} as never,
    runtimeStore: store,
    mcpManager: safeRead?.manager,
    capabilityArtifactStore,
    workspaceFilesystemRuntime: testWorkspaceFilesystemRuntimeV1(
      workspace,
      capabilityArtifactStore,
    ),
    shellExecutor:
      id === 'timeout_unknown_no_replay'
        ? async ({ command }) => ({
            ok: false,
            command,
            exitCode: -1,
            stdout: '',
            stderr: 'timed out',
            terminationReason: 'timed_out',
          })
        : id === 'repeated_failure_replan_finalize'
          ? async ({ command }) => ({
              ok: false,
              command,
              exitCode: 2,
              stdout: '',
              stderr: 'fixture search provider failed',
            })
          : id === 'sandbox_permission_no_escalation'
            ? async ({ command }) => {
                sandboxBoundaryAttempts += 1;
                return unavailableSandbox({ workspace, command });
              }
            : undefined,
  });
  const executor: RuntimeEffectExecutor = async (effect, readonlyState, emit, context) => {
    if (effect.type === 'call_model') {
      modelAttempts += 1;
      const events = scriptedEvents(id, readonlyState as RuntimeState, modelAttempts);
      directTerminalEvents += events.filter((event) =>
        FORBIDDEN_SCRIPTED_TERMINALS.has(event.type),
      ).length;
      return events;
    }
    if (id === 'read_edit_verify' && effect.type === 'run_verification') {
      return executeVerificationEffect(effect, readonlyState, {
        artifactStore: capabilityArtifactStore,
        reviewer: async () => ({
          outcome: 'passed',
          summary: 'The deterministic Workspace filesystem receipt is internally consistent.',
        }),
      });
    }
    if (effect.type === 'run_tools') controllerEffects += 1;
    return production(effect, readonlyState, emit, context);
  };

  try {
    kernel.processEvent({
      type: 'user.message_appended',
      messageId: 'user-eval',
      content: 'Run the bounded evaluation journey.',
    });
    for await (const event of runRuntimeLoop(
      kernel,
      executor,
      {
        requestAction: async (effect) =>
          id === 'approval_policy_rejection_no_retry'
            ? { type: 'reject', interactionId: effect.interactionId }
            : effect.type === 'request_plan_review' &&
                kernel.getState().interactions.kind === 'awaiting_review'
              ? (() => {
                  const interaction = kernel.getState().interactions;
                  if (interaction.kind !== 'awaiting_review') {
                    return { type: 'cancel' as const, interactionId: effect.interactionId };
                  }
                  return {
                    type: 'plan_review_decision' as const,
                    interactionId: effect.interactionId,
                    planId: interaction.planId,
                    version: interaction.version,
                    structuralDigest: interaction.structuralDigest,
                    decision: {
                      kind: 'approve' as const,
                      nextMode: 'auto' as const,
                    },
                  };
                })()
              : { type: 'cancel', interactionId: effect.interactionId },
      },
      40,
    )) {
      emitted.push(event);
    }

    const state = kernel.getState();
    const calls = Object.values(state.tools.calls);
    const persistedEvents = store
      .loadEventsStrict(state.session.threadId)
      .map((entry) => entry.event);
    const authorizationWideningEvents = persistedEvents.filter(
      (event) =>
        event.type === 'approval.granted' ||
        event.type === 'authorization.changed' ||
        event.type === 'interaction_mode.changed',
    ).length;
    const sandboxSentinelTriggered = existsSync(sandboxSentinelMarker);
    const persistedOutcomes = persistedEvents.filter(
      (event): event is RuntimeEvent & { outcomeV1: ToolOutcomeV1 } =>
        'outcomeV1' in event &&
        (event as RuntimeEvent & { outcomeV1?: ToolOutcomeV1 }).outcomeV1 !== undefined,
    );
    const canonicalOutcomes: CanonicalOutcomeReportV1[] = persistedOutcomes.flatMap((event) => {
      const outcome = event.outcomeV1;
      if (!outcome) return [];
      const failureId = outcome.lineage?.failureInstanceId;
      const resolution = failureId ? state.toolRecovery.failures[failureId]?.resolution : undefined;
      return [
        {
          status: outcome.status,
          ...(outcome.failure ? { failureKind: outcome.failure.kind } : {}),
          ...(outcome.failure ? { detailCode: outcome.failure.detailCode } : {}),
          dispatchState: outcome.dispatchState,
          externalEffects: outcome.externalEffects,
          replaySafety: outcome.replaySafety ?? 'none',
          recoveryDisposition: outcome.recovery.disposition,
          recoveryAttempt: outcome.lineage?.recoveryOf ? 1 : 0,
          recoveryLinked: Boolean(outcome.lineage?.recoveryOf),
          ...(resolution ? { resolution } : {}),
          timingSource: outcome.timing.source,
        },
      ];
    });
    const typedTerminalCount = canonicalOutcomes.length;
    const correctionCount = calls.filter((call) => call.recoveryMode === 'model_correction').length;
    const automaticRetryCount = calls.filter(
      (call) => call.recoveryMode === 'automatic_retry',
    ).length;
    const started = emitted.filter((event) => event.type === 'tool.started').length;
    const dispatchAttempts = started + automaticRetryCount;
    const completed = emitted.some((event) => event.type === 'run.completed');
    const blocked = emitted.some(
      (event) => event.type === 'run.error' || event.type === 'turn.aborted',
    );
    const lastBlock = [...emitted].reverse().find((event) => event.type === 'completion.blocked');
    const lastBatch = kernel.getLastAppliedEvents().map((event) => event.type);
    const completionBlock =
      lastBlock?.type === 'completion.blocked'
        ? {
            code: lastBlock.code,
            correctionAttempt: lastBlock.correctionAttempt,
            atomicTerminal:
              lastBatch.length === 3 &&
              lastBatch[0] === 'completion.blocked' &&
              lastBatch[1] === 'turn.aborted' &&
              lastBatch[2] === 'run.error',
          }
        : undefined;
    const fullRuntimeLoop =
      emitted.some((event) => event.type === 'model.responded') && (completed || blocked);
    const expected = (() => {
      switch (id) {
        case 'search_read':
          return completed && dispatchAttempts === 2;
        case 'read_edit_verify':
          return completed && emitted.some((event) => event.type === 'verification.completed');
        case 'invalid_args_correct_once':
          return completed && correctionCount === 1 && dispatchAttempts === 1;
        case 'enoent_locate_success':
          return completed && dispatchAttempts === 3 && correctionCount >= 1;
        case 'rg_no_match_stop':
          return completed && dispatchAttempts === 1;
        case 'approval_policy_rejection_no_retry':
          return blocked && dispatchAttempts === 0 && modelAttempts === 1;
        case 'safe_pre_dispatch_transient':
          return (
            completed &&
            automaticRetryCount === 1 &&
            safeRead?.boundaryCalls() === 2 &&
            safeRead.capabilityCalls() === 1
          );
        case 'timeout_unknown_no_replay':
          return (
            blocked &&
            !completed &&
            dispatchAttempts === 1 &&
            modelAttempts === 3 &&
            completionBlock?.atomicTerminal === true
          );
        case 'sandbox_permission_no_escalation':
          return (
            completed &&
            dispatchAttempts === 1 &&
            sandboxBoundaryAttempts === 1 &&
            underlyingCommandAttempts === 0 &&
            !sandboxSentinelTriggered &&
            authorizationWideningEvents === 0
          );
        case 'repeated_failure_replan_finalize':
          return completed && dispatchAttempts === 5 && modelAttempts >= 6;
      }
    })();

    return {
      id,
      passed: Boolean(
        expected &&
          fullRuntimeLoop &&
          controllerEffects > 0 &&
          directTerminalEvents === 0 &&
          typedTerminalCount > 0 &&
          canonicalOutcomes.every((outcome) => outcome.timingSource === 'runtime_boundary'),
      ),
      fullRuntimeLoop,
      productionController: controllerEffects > 0,
      directTerminalEvents,
      modelAttempts,
      toolDispatches: dispatchAttempts,
      dispatchAttempts,
      typedTerminalCount,
      correctionCount,
      automaticRetryCount,
      trustedTimingObserved: canonicalOutcomes.some(
        (outcome) => outcome.timingSource === 'runtime_boundary',
      ),
      environmentIsolated,
      providerDispatchAttempts: safeRead?.capabilityCalls() ?? 0,
      preDispatchBoundaryAttempts: safeRead?.boundaryCalls() ?? 0,
      sandboxBoundaryAttempts,
      underlyingCommandAttempts,
      sandboxSentinelTriggered,
      authorizationWideningEvents,
      canonicalOutcomes,
      ...(completionBlock ? { completionBlock } : {}),
      terminal: completed ? 'completed' : 'blocked',
    };
  } finally {
    kernel.close();
    onKernelClosed();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function isCount(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function validateCanonicalOutcome(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = [
    'status',
    'failureKind',
    'detailCode',
    'dispatchState',
    'externalEffects',
    'replaySafety',
    'recoveryDisposition',
    'recoveryAttempt',
    'recoveryLinked',
    'resolution',
    'timingSource',
  ];
  if (!Object.keys(value).every((key) => allowed.includes(key))) return false;
  const status = [
    'success',
    'failed',
    'rejected',
    'cancelled',
    'timed_out',
    'exhausted',
    'unknown',
  ];
  const dispatch = ['not_started', 'started', 'unknown'];
  const effects = ['none', 'known', 'unknown'];
  const replaySafety = ['none', 'pre_dispatch', 'safe_read', 'idempotency_receipt'];
  const recovery = ['never', 'correct_args', 'retry_once', 'alternative', 'user_action'];
  return (
    typeof value.status === 'string' &&
    status.includes(value.status) &&
    (value.failureKind === undefined || isFailureKind(value.failureKind)) &&
    typeof value.dispatchState === 'string' &&
    dispatch.includes(value.dispatchState) &&
    typeof value.externalEffects === 'string' &&
    effects.includes(value.externalEffects) &&
    typeof value.replaySafety === 'string' &&
    replaySafety.includes(value.replaySafety) &&
    typeof value.recoveryDisposition === 'string' &&
    recovery.includes(value.recoveryDisposition) &&
    (value.recoveryAttempt === 0 || value.recoveryAttempt === 1) &&
    typeof value.recoveryLinked === 'boolean' &&
    (value.timingSource === 'runtime_boundary' || value.timingSource === 'legacy_unknown') &&
    (value.detailCode === undefined || isToolOutcomeDetailCodeV1(value.detailCode)) &&
    (value.resolution === undefined || isToolRecoveryResolutionV1(value.resolution))
  );
}

/** Exact, recursive allowlist validation for the persisted metadata-only report schema. */
export function validateToolJourneyEvalReportV1(value: unknown): value is ToolJourneyEvalReportV1 {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      'schema',
      'cases',
      'summary',
      'coverage',
      'kernelCloseCount',
      'contentLogged',
    ]) ||
    value.schema !== 'ToolJourneyEvalV1' ||
    value.contentLogged !== false ||
    !isCount(value.kernelCloseCount) ||
    !Array.isArray(value.cases) ||
    !isRecord(value.summary) ||
    !hasExactKeys(value.summary, ['total', 'passed', 'failed']) ||
    !Object.values(value.summary).every(isCount) ||
    !isRecord(value.coverage) ||
    !hasExactKeys(value.coverage, [
      'typedOutcome',
      'recoveryLineage',
      'trustedTiming',
      'completionGuard',
      'metadataOnly',
    ]) ||
    !Object.values(value.coverage).every((entry) => typeof entry === 'boolean') ||
    value.coverage.metadataOnly !== true
  ) {
    return false;
  }
  const requiredCaseKeys = [
    'id',
    'passed',
    'fullRuntimeLoop',
    'productionController',
    'directTerminalEvents',
    'modelAttempts',
    'toolDispatches',
    'dispatchAttempts',
    'typedTerminalCount',
    'correctionCount',
    'automaticRetryCount',
    'trustedTimingObserved',
    'environmentIsolated',
    'providerDispatchAttempts',
    'preDispatchBoundaryAttempts',
    'sandboxBoundaryAttempts',
    'underlyingCommandAttempts',
    'sandboxSentinelTriggered',
    'authorizationWideningEvents',
    'canonicalOutcomes',
    'terminal',
  ];
  const valid = value.cases.every((candidate) => {
    if (!isRecord(candidate)) return false;
    const keys = Object.keys(candidate);
    if (
      !keys.every((key) => [...requiredCaseKeys, 'completionBlock'].includes(key)) ||
      !requiredCaseKeys.every((key) => key in candidate) ||
      !TOOL_JOURNEY_CASE_IDS_V1.includes(candidate.id as ToolJourneyCaseIdV1) ||
      typeof candidate.passed !== 'boolean' ||
      typeof candidate.fullRuntimeLoop !== 'boolean' ||
      typeof candidate.productionController !== 'boolean' ||
      typeof candidate.trustedTimingObserved !== 'boolean' ||
      typeof candidate.environmentIsolated !== 'boolean' ||
      typeof candidate.sandboxSentinelTriggered !== 'boolean' ||
      ![
        'directTerminalEvents',
        'modelAttempts',
        'toolDispatches',
        'dispatchAttempts',
        'typedTerminalCount',
        'correctionCount',
        'automaticRetryCount',
        'providerDispatchAttempts',
        'preDispatchBoundaryAttempts',
        'sandboxBoundaryAttempts',
        'underlyingCommandAttempts',
        'authorizationWideningEvents',
      ].every((key) => isCount(candidate[key])) ||
      (candidate.terminal !== 'completed' && candidate.terminal !== 'blocked') ||
      !Array.isArray(candidate.canonicalOutcomes) ||
      !candidate.canonicalOutcomes.every(validateCanonicalOutcome)
    ) {
      return false;
    }
    if (candidate.completionBlock !== undefined) {
      if (
        !isRecord(candidate.completionBlock) ||
        !hasExactKeys(candidate.completionBlock, ['code', 'correctionAttempt', 'atomicTerminal']) ||
        !isCompletionBlockerCode(candidate.completionBlock.code) ||
        !isCount(candidate.completionBlock.correctionAttempt) ||
        typeof candidate.completionBlock.atomicTerminal !== 'boolean'
      ) {
        return false;
      }
    }
    return true;
  });
  if (!valid) return false;
  const passed = value.cases.filter(
    (candidate) => isRecord(candidate) && candidate.passed === true,
  ).length;
  return (
    value.summary.total === value.cases.length &&
    value.summary.passed === passed &&
    value.summary.failed === value.cases.length - passed &&
    value.kernelCloseCount === value.cases.length
  );
}

export async function runToolJourneySuiteUncachedV1(): Promise<ToolJourneyEvalReportV1> {
  const cases: ToolJourneyCaseReportV1[] = [];
  let kernelCloseCount = 0;
  for (const id of TOOL_JOURNEY_CASE_IDS_V1) {
    try {
      cases.push(
        await runCase(id, () => {
          kernelCloseCount += 1;
        }),
      );
    } catch (error) {
      throw new Error(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const passed = cases.filter((entry) => entry.passed).length;
  const base = {
    schema: 'ToolJourneyEvalV1' as const,
    cases,
    summary: { total: cases.length, passed, failed: cases.length - passed },
    coverage: {
      typedOutcome: cases.every((entry) => entry.typedTerminalCount > 0),
      recoveryLineage: cases.some(
        (entry) => entry.correctionCount > 0 || entry.automaticRetryCount > 0,
      ),
      trustedTiming: cases.every((entry) => entry.trustedTimingObserved),
      completionGuard: cases.some((entry) => entry.completionBlock?.atomicTerminal === true),
      metadataOnly: false,
    },
    kernelCloseCount,
    contentLogged: false as const,
  };
  const metadataOnly = validateToolJourneyEvalReportV1({
    ...base,
    coverage: { ...base.coverage, metadataOnly: true },
  });
  return { ...base, coverage: { ...base.coverage, metadataOnly } };
}

let cachedSuite: Promise<ToolJourneyEvalReportV1> | undefined;

export async function runToolJourneySuiteV1(): Promise<ToolJourneyEvalReportV1> {
  cachedSuite ??= runToolJourneySuiteUncachedV1();
  return cachedSuite;
}
