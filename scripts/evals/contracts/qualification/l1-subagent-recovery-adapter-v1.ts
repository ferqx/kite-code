import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import type { AgentConfig } from '../../../../src/core/config';
import { executeRuntimeTools } from '../../../../src/core/controllers/tool-controller';
import { aiMessage } from '../../../../src/core/messages';
import { eventsForRunCancellation } from '../../../../src/core/runtime/actions';
import { createAgentKernel } from '../../../../src/core/runtime/kernel';
import { reduceRuntimeState } from '../../../../src/core/runtime/reducer';
import {
  createZeroResourceUsageV1,
  LIMITED_RESOURCE_BUDGET_V1,
} from '../../../../src/core/runtime/resource-budget';
import { createDescendantResourceAdmissionV1 } from '../../../../src/core/runtime/resource-budget-admission';
import { decideNextEffect } from '../../../../src/core/runtime/scheduler';
import { createInitialRuntimeState, type RuntimeState } from '../../../../src/core/runtime/state';
import { createRuntimeStore } from '../../../../src/core/runtime/store';
import { serializeSubagentContinuation } from '../../../../src/core/subagent/continuation-codec';
import { getRoleConfig } from '../../../../src/core/subagent/roles';
import {
  evaluateL1SubagentRecoveryCorpusV1,
  type L1SubagentRecoveryCaseObservationV1,
  type L1SubagentRecoveryReportV1,
  l1SubagentRecoveryObservationForCaseV1,
} from './l1-subagent-recovery-evaluator-v1';
import {
  buildL1SubagentRecoveryEvaluatorIdentityV1,
  L1_SUBAGENT_RECOVERY_ADAPTERS_V1,
  L1_SUBAGENT_RECOVERY_FIXTURE_ID_V1,
  L1_SUBAGENT_RECOVERY_RUNNER_ID_V1,
  type L1SubagentRecoveryAdapterIdV1,
  type L1SubagentRecoveryAdapterResultV1,
  type L1SubagentRecoveryEvaluatorIdentityV1,
} from './l1-subagent-recovery-schema-v1';

export {
  L1_SUBAGENT_RECOVERY_ADAPTER_IMPLEMENTATIONS_V1,
  L1_SUBAGENT_RECOVERY_FIXTURE_ID_V1,
  L1_SUBAGENT_RECOVERY_RUNNER_ID_V1,
} from './l1-subagent-recovery-schema-v1';

/**
 * Each sealed L1 run gets a fresh temporary root. The adapter retains only
 * status/event tokens; roots, continuation snapshots, task strings, tool
 * results, prompts, source text, and credentials never leave this scope.
 */
const L1_SUBAGENT_RECOVERY_SYNTHETIC_ROOT_PREFIX_V1 = 'kite-l1-subagent-recovery-';
const FIXTURE_THREAD_ID_V1 = 'qualification-subagent-thread';
const FIXTURE_TASK_CALL_ID_V1 = 'qualification-subagent-task';
const FIXTURE_PARENT_RESERVATION_ID_V1 = 'qualification-subagent-parent';
const FIXTURE_RESERVED_PARENT_RESERVATION_ID_V1 = 'qualification-subagent-parent-reserved';
const FIXTURE_CHILD_MODEL_RESERVATION_ID_V1 = 'qualification-subagent-child-model';
const FIXTURE_CHILD_RESERVATION_ID_V1 = 'qualification-subagent-child';
const FIXTURE_RUN_ID_V1 = 'qualification-subagent-run';
const FIXTURE_STARTED_AT_V1 = '2026-08-05T00:00:00.000Z';
const FIXTURE_DEADLINE_AT_V1 = '2026-08-05T00:30:00.000Z';

function fixtureConfigV1(): AgentConfig {
  return {
    apiKey: '',
    baseURL: '',
    modelName: 'qualification-scripted',
    providerName: 'qualification-scripted',
    providerType: 'openai-compatible',
    sandbox: { enabled: true },
    features: { resourceBudgetV1: true, boundedCancellationV1: true },
  };
}

async function withSyntheticRootV1<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), L1_SUBAGENT_RECOVERY_SYNTHETIC_ROOT_PREFIX_V1));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function parentUpperBoundV1() {
  const usage = createZeroResourceUsageV1('versioned_upper_bound', 'l1-subagent-recovery-v1');
  usage.gauges.activeSubagents = 1;
  return usage;
}

function reserveParentDispatchV1(kernel: ReturnType<typeof createAgentKernel>): void {
  kernel.processEvent({
    type: 'resource_budget.configured',
    runId: FIXTURE_RUN_ID_V1,
    startedAt: FIXTURE_STARTED_AT_V1,
    deadlineAt: FIXTURE_DEADLINE_AT_V1,
    budget: LIMITED_RESOURCE_BUDGET_V1,
  });
  kernel.processEvent({
    type: 'resource_budget.reserved',
    reservation: {
      version: 1,
      reservationId: FIXTURE_PARENT_RESERVATION_ID_V1,
      runId: FIXTURE_RUN_ID_V1,
      invocationId: `tool:${FIXTURE_TASK_CALL_ID_V1}`,
      resourceKind: 'subagent',
      executableUpperBound: parentUpperBoundV1(),
      state: 'reserved',
    },
  });
  kernel.processEvent({
    type: 'resource_budget.dispatch_started',
    reservationId: FIXTURE_PARENT_RESERVATION_ID_V1,
  });
}

function fixtureSuspendedStateV1(root: string): RuntimeState {
  const state = createInitialRuntimeState({
    threadId: FIXTURE_THREAD_ID_V1,
    userId: 'qualification',
    workspace: root,
  });
  state.tools.calls[FIXTURE_TASK_CALL_ID_V1] = {
    toolCallId: FIXTURE_TASK_CALL_ID_V1,
    modelMessageId: 'qualification-model',
    name: 'task',
    args: { subagent_type: 'code', task: 'sealed-fixture' },
    status: 'approved',
    approvalGrant: 'approve_once',
    sideEffect: true,
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.active.push(FIXTURE_TASK_CALL_ID_V1);
  state.suspendedSubagents[FIXTURE_TASK_CALL_ID_V1] = serializeSubagentContinuation(
    {
      id: 'qualification-child',
      role: getRoleConfig('code'),
      task: 'sealed-fixture',
      messages: [
        aiMessage({
          content: 'fixture',
          tool_calls: [
            { id: 'qualification-child-tool', name: 'shell_execute', args: { command: 'fixture' } },
          ],
        }),
      ],
      toolCallCount: 1,
      steps: [
        {
          toolName: 'shell_execute',
          toolArgs: { command: 'fixture' },
          status: 'awaiting_approval',
        },
      ],
    },
    {
      toolCallId: 'qualification-child-tool',
      toolName: 'shell_execute',
      args: { command: 'fixture' },
      command: 'fixture',
    },
  );
  return state;
}

/** Minimal in-process model; no route, endpoint, credential, or output capture. */
function finalScriptedModelV1(): {
  model: LanguageModel;
  capabilityMetadata: { streaming: false };
  setRetryListener: (_listener: unknown) => void;
} {
  const model = {
    specificationVersion: 'v4',
    provider: 'qualification-scripted',
    modelId: 'qualification-scripted',
    supportedUrls: {},
    async doGenerate(): Promise<unknown> {
      return {
        content: [],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1 },
          totalTokens: 2,
        },
      };
    },
    async doStream(): Promise<never> {
      throw new Error('L1 subagent/recovery scripted model does not stream');
    },
  };
  return {
    model: model as unknown as LanguageModel,
    capabilityMetadata: { streaming: false },
    setRetryListener: () => {},
  };
}

/** Parent and descendant reservations are independently persisted and linked. */
async function runParentChildReservationV1(): Promise<boolean> {
  return withSyntheticRootV1(async (root) => {
    const kernel = createAgentKernel({
      threadId: `${FIXTURE_THREAD_ID_V1}-reservation`,
      userId: 'qualification',
      workspace: root,
      storePath: join(root, 'runtime.db'),
    });
    try {
      reserveParentDispatchV1(kernel);
      const admission = createDescendantResourceAdmissionV1({
        state: kernel.getState(),
        parentReservationId: FIXTURE_PARENT_RESERVATION_ID_V1,
        getState: () => kernel.getState(),
        persistEvent: async (event) => {
          kernel.processEvent(event);
          return true;
        },
        persistEvents: async (events) => {
          kernel.processEventBatch(events);
          return true;
        },
        now: () => new Date(FIXTURE_STARTED_AT_V1),
      });
      const model = await admission.reserveModel({
        invocationKey: 'model:sealed',
        inputTokens: 1,
        requestedMaxOutputTokens: 8,
      });
      const tool = await admission.reserveTool({
        invocationKey: 'tool:sealed',
        toolKind: 'read_file',
        shell: false,
      });
      await admission.reconcileModel({
        reservationId: model.reservationId,
        inputTokens: 1,
        outputTokens: 1,
      });
      await admission.reconcileTool({ reservationId: tool.reservationId });
      const budget = kernel.getState().resourceBudget;
      if (budget.status !== 'active') return false;
      const children = [
        budget.reservations[model.reservationId],
        budget.reservations[tool.reservationId],
      ];
      return (
        budget.reservations[FIXTURE_PARENT_RESERVATION_ID_V1]?.state === 'dispatch_started' &&
        children.every(
          (reservation) =>
            reservation?.parentReservationId === FIXTURE_PARENT_RESERVATION_ID_V1 &&
            reservation.state === 'reconciled',
        )
      );
    } finally {
      kernel.close();
    }
  });
}

/** A durable claim must commit before the child tool begins its in-process dispatch. */
async function runApprovalResumeClaimV1(): Promise<boolean> {
  return withSyntheticRootV1(async (root) => {
    let state = fixtureSuspendedStateV1(root);
    const order: string[] = [];
    let claimEvent:
      | Extract<
          import('../../../../src/core/runtime/events').RuntimeEvent,
          { type: 'subagent.resume_claimed' }
        >
      | undefined;
    const events = await executeRuntimeTools({
      state,
      toolCallIds: [FIXTURE_TASK_CALL_ID_V1],
      taskConfig: fixtureConfigV1(),
      taskModel: finalScriptedModelV1(),
      subagentEventSink: () => {},
      shellExecutor: async ({ command }) => {
        order.push('child-tool-dispatch');
        return { ok: true, command, exitCode: 0, stdout: '', stderr: '' };
      },
      persistSubagentResumeClaim: async (event) => {
        order.push('claim-persisted');
        claimEvent = event;
        state = reduceRuntimeState(state, event);
        return true;
      },
      getRuntimeState: () => state,
    });
    if (!claimEvent) return false;
    const duplicate = reduceRuntimeState(state, claimEvent);
    return (
      order[0] === 'claim-persisted' &&
      order.includes('child-tool-dispatch') &&
      state.tools.calls[FIXTURE_TASK_CALL_ID_V1]?.status === 'running' &&
      Boolean(state.subagentResumeClaims[FIXTURE_TASK_CALL_ID_V1]) &&
      duplicate === state &&
      events.some(
        (event) => event.type === 'tool.finished' && event.toolCallId === FIXTURE_TASK_CALL_ID_V1,
      )
    );
  });
}

/** A terminal task result is locally consumed once; later payloads cannot rewrite it. */
function runTerminalConsumptionV1(): boolean {
  let state = createInitialRuntimeState({
    threadId: `${FIXTURE_THREAD_ID_V1}-terminal`,
    userId: 'qualification',
    workspace: 'qualification-synthetic',
  });
  state.tools.calls[FIXTURE_TASK_CALL_ID_V1] = {
    toolCallId: FIXTURE_TASK_CALL_ID_V1,
    modelMessageId: 'qualification-model',
    name: 'task',
    args: {},
    status: 'running',
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.active.push(FIXTURE_TASK_CALL_ID_V1);
  state = reduceRuntimeState(state, {
    type: 'tool.finished',
    toolCallId: FIXTURE_TASK_CALL_ID_V1,
    name: 'task',
    result: { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' },
  });
  const afterFirst = state;
  state = reduceRuntimeState(state, {
    type: 'tool.finished',
    toolCallId: FIXTURE_TASK_CALL_ID_V1,
    name: 'task',
    result: { ok: false, command: '', exitCode: -1, stdout: '', stderr: 'late' },
  });
  return (
    state === afterFirst &&
    state.tools.calls[FIXTURE_TASK_CALL_ID_V1]?.status === 'succeeded' &&
    state.transcript.messages.filter(
      (message) => message.kind === 'tool' && message.toolCallId === FIXTURE_TASK_CALL_ID_V1,
    ).length === 1
  );
}

/** A recovered claim plus dispatch-started child reservations remains unavailable/unknown. */
async function runRestartUnknownV1(): Promise<boolean> {
  return withSyntheticRootV1(async (root) => {
    const storePath = join(root, 'runtime.db');
    const store = createRuntimeStore(storePath);
    try {
      const state = fixtureSuspendedStateV1(root);
      state.resourceBudget = {
        status: 'active',
        runId: FIXTURE_RUN_ID_V1,
        startedAt: FIXTURE_STARTED_AT_V1,
        deadlineAt: FIXTURE_DEADLINE_AT_V1,
        budget: LIMITED_RESOURCE_BUDGET_V1,
        reconciledUsage: createZeroResourceUsageV1(),
        reservations: {
          [FIXTURE_RESERVED_PARENT_RESERVATION_ID_V1]: {
            version: 1,
            reservationId: FIXTURE_RESERVED_PARENT_RESERVATION_ID_V1,
            runId: FIXTURE_RUN_ID_V1,
            invocationId: 'tool:qualification-not-dispatched',
            resourceKind: 'subagent',
            executableUpperBound: parentUpperBoundV1(),
            state: 'reserved',
          },
          [FIXTURE_PARENT_RESERVATION_ID_V1]: {
            version: 1,
            reservationId: FIXTURE_PARENT_RESERVATION_ID_V1,
            runId: FIXTURE_RUN_ID_V1,
            invocationId: `tool:${FIXTURE_TASK_CALL_ID_V1}`,
            resourceKind: 'subagent',
            executableUpperBound: parentUpperBoundV1(),
            state: 'dispatch_started',
          },
          [FIXTURE_CHILD_MODEL_RESERVATION_ID_V1]: {
            version: 1,
            reservationId: FIXTURE_CHILD_MODEL_RESERVATION_ID_V1,
            runId: FIXTURE_RUN_ID_V1,
            invocationId: `descendant:tool:${FIXTURE_TASK_CALL_ID_V1}:model:sealed`,
            parentReservationId: FIXTURE_PARENT_RESERVATION_ID_V1,
            resourceKind: 'model',
            executableUpperBound: createZeroResourceUsageV1(
              'versioned_upper_bound',
              'l1-subagent-recovery-v1',
            ),
            state: 'dispatch_started',
          },
          [FIXTURE_CHILD_RESERVATION_ID_V1]: {
            version: 1,
            reservationId: FIXTURE_CHILD_RESERVATION_ID_V1,
            runId: FIXTURE_RUN_ID_V1,
            invocationId: `descendant:tool:${FIXTURE_TASK_CALL_ID_V1}:tool:sealed`,
            parentReservationId: FIXTURE_PARENT_RESERVATION_ID_V1,
            resourceKind: 'tool',
            executableUpperBound: createZeroResourceUsageV1(
              'versioned_upper_bound',
              'l1-subagent-recovery-v1',
            ),
            state: 'dispatch_started',
          },
        },
        waiters: {},
        nextWaiterSequence: 1,
      };
      state.tools.calls[FIXTURE_TASK_CALL_ID_V1] = {
        ...state.tools.calls[FIXTURE_TASK_CALL_ID_V1]!,
        status: 'running',
      };
      state.subagentResumeClaims[FIXTURE_TASK_CALL_ID_V1] = {
        claimId: 'qualification-claim',
        subagentId: 'qualification-child',
        childToolCallId: 'qualification-child-tool',
        claimedAt: FIXTURE_STARTED_AT_V1,
      };
      store.saveSnapshot(FIXTURE_THREAD_ID_V1, state);
    } finally {
      store.close();
    }
    const recovered = createAgentKernel({
      threadId: FIXTURE_THREAD_ID_V1,
      userId: 'qualification',
      workspace: root,
      storePath,
    });
    try {
      const state = recovered.getState();
      const budget = state.resourceBudget;
      return (
        Boolean(state.legacyUnrecoverableSubagentApproval) &&
        decideNextEffect(state).type === 'subagent.recovery_unavailable' &&
        budget.status === 'active' &&
        budget.reservations[FIXTURE_RESERVED_PARENT_RESERVATION_ID_V1]?.state === 'released' &&
        budget.reservations[FIXTURE_PARENT_RESERVATION_ID_V1]?.state === 'unknown' &&
        budget.reservations[FIXTURE_CHILD_MODEL_RESERVATION_ID_V1]?.state === 'unknown' &&
        budget.reservations[FIXTURE_CHILD_RESERVATION_ID_V1]?.state === 'unknown'
      );
    } finally {
      recovered.close();
    }
  });
}

/** Late terminal events after cancellation are reducer no-ops; only resource reconciliation may persist. */
function runLateTerminalConvergenceV1(): boolean {
  let state = createInitialRuntimeState({
    threadId: `${FIXTURE_THREAD_ID_V1}-late`,
    userId: 'qualification',
    workspace: 'qualification-synthetic',
  });
  state.tools.calls[FIXTURE_TASK_CALL_ID_V1] = {
    toolCallId: FIXTURE_TASK_CALL_ID_V1,
    modelMessageId: 'qualification-model',
    name: 'task',
    args: {},
    status: 'running',
    createdAtTurnId: state.turn.turnId,
  };
  state = reduceRuntimeState(state, {
    type: 'tool.cancelled',
    toolCallId: FIXTURE_TASK_CALL_ID_V1,
    reason: 'fixture-cancelled',
  });
  const cancelled = state;
  state = reduceRuntimeState(state, {
    type: 'tool.failed',
    toolCallId: FIXTURE_TASK_CALL_ID_V1,
    error: 'late-terminal',
  });
  return state === cancelled && state.tools.calls[FIXTURE_TASK_CALL_ID_V1]?.status === 'cancelled';
}

/** Parent/child cancellation clears queues and preserves dispatched uncertainty. */
async function runParallelCancelConvergenceV1(): Promise<boolean> {
  return withSyntheticRootV1(async (root) => {
    const kernel = createAgentKernel({
      threadId: `${FIXTURE_THREAD_ID_V1}-cancel`,
      userId: 'qualification',
      workspace: root,
      storePath: join(root, 'runtime.db'),
    });
    try {
      reserveParentDispatchV1(kernel);
      const state = kernel.getState();
      state.tools.calls.parent = {
        toolCallId: 'parent',
        modelMessageId: 'qualification-model',
        name: 'task',
        args: {},
        status: 'running',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.calls.sibling = {
        toolCallId: 'sibling',
        modelMessageId: 'qualification-model',
        name: 'read_file',
        args: {},
        status: 'queued',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.active.push('parent');
      state.tools.queue.push('sibling');
      kernel.processEventBatch(eventsForRunCancellation(state, 'fixture-cancel', 'user'));
      const after = kernel.getState();
      const late = reduceRuntimeState(after, {
        type: 'tool.finished',
        toolCallId: 'parent',
        name: 'task',
        result: { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' },
      });
      return (
        after.turn.status === 'aborted' &&
        after.tools.calls.parent?.status === 'cancelled' &&
        after.tools.calls.sibling?.status === 'cancelled' &&
        after.tools.queue.length === 0 &&
        after.tools.active.length === 0 &&
        after.resourceBudget.status === 'active' &&
        after.resourceBudget.reservations[FIXTURE_PARENT_RESERVATION_ID_V1]?.state === 'unknown' &&
        late === after
      );
    } finally {
      kernel.close();
    }
  });
}

/** Forking a recovered conversation rebinds authority and removes pending child state. */
async function runRewindForkTighteningV1(): Promise<boolean> {
  return withSyntheticRootV1(async (root) => {
    const store = createRuntimeStore(join(root, 'runtime.db'));
    try {
      store.saveNamedSnapshot('source', 'checkpoint', {
        session: { threadId: 'source' },
        authorization: {
          mode: 'full_access',
          modeSource: 'user',
          modeGrantedAt: FIXTURE_STARTED_AT_V1,
          commandGrants: { inherited: { grant: 'fixture' } },
        },
        mode: 'full',
        interactions: { kind: 'awaiting_tool_approval' },
        tools: { calls: {}, queue: ['pending'], active: ['active'] },
        capabilities: {
          catalogRevision: 'fixture',
          bindings: { inherited: { bindingId: 'fixture' } },
          disclosures: { inherited: { capabilityId: 'fixture' } },
        },
        providerAdmission: { pending: [{ providerId: 'fixture' }], waivers: { inherited: {} } },
        suspendedSubagents: { pending: { subagentId: 'fixture' } },
        subagentResumeClaims: { pending: { claimId: 'fixture' } },
      });
      if (!store.forkSession('source', 'checkpoint', 'fork')) return false;
      const fork = store.loadSnapshot<Record<string, unknown>>('fork');
      const authorization = fork?.authorization as Record<string, unknown> | undefined;
      const capabilities = fork?.capabilities as Record<string, unknown> | undefined;
      const providerAdmission = fork?.providerAdmission as Record<string, unknown> | undefined;
      const tools = fork?.tools as Record<string, unknown> | undefined;
      return (
        (fork?.session as { threadId?: string } | undefined)?.threadId === 'fork' &&
        authorization?.mode === 'default' &&
        JSON.stringify(authorization?.commandGrants) === '{}' &&
        JSON.stringify(capabilities?.bindings) === '{}' &&
        JSON.stringify(capabilities?.disclosures) === '{}' &&
        JSON.stringify(providerAdmission?.pending) === '[]' &&
        JSON.stringify(providerAdmission?.waivers) === '{}' &&
        JSON.stringify(tools?.queue) === '[]' &&
        JSON.stringify(tools?.active) === '[]' &&
        JSON.stringify(fork?.suspendedSubagents) === '{}' &&
        JSON.stringify(fork?.subagentResumeClaims) === '{}'
      );
    } finally {
      store.close();
    }
  });
}

function adapterResult(
  adapterId: L1SubagentRecoveryAdapterIdV1,
  passed: boolean,
): L1SubagentRecoveryAdapterResultV1 {
  const pair = L1_SUBAGENT_RECOVERY_ADAPTERS_V1.find((entry) => entry.adapterId === adapterId);
  if (!pair) throw new Error(`unregistered_l1_subagent_recovery_adapter:${adapterId}`);
  return { ...pair, outcome: passed ? 'passed' : 'failed' };
}

/** Runs every sealed AQ-6 slice and returns only registered IDs plus outcome tokens. */
export async function runL1SubagentRecoveryAdaptersV1(): Promise<
  readonly L1SubagentRecoveryAdapterResultV1[]
> {
  const outcomes = [
    await runParentChildReservationV1(),
    await runApprovalResumeClaimV1(),
    runTerminalConsumptionV1(),
    await runRestartUnknownV1(),
    runLateTerminalConvergenceV1(),
    await runParallelCancelConvergenceV1(),
    await runRewindForkTighteningV1(),
  ] as const;
  return [
    adapterResult('subagent-parent-child-reservation-v1', outcomes[0]),
    adapterResult('subagent-approval-resume-claim-v1', outcomes[1]),
    adapterResult('runtime-subagent-terminal-consumption-v1', outcomes[2]),
    adapterResult('runtime-subagent-restart-unknown-v1', outcomes[3]),
    adapterResult('runtime-late-terminal-convergence-v1', outcomes[4]),
    adapterResult('runtime-parallel-cancel-convergence-v1', outcomes[5]),
    adapterResult('runtime-rewind-fork-tightening-v1', outcomes[6]),
  ];
}

export function buildL1SubagentRecoveryEvaluatorV1(): L1SubagentRecoveryEvaluatorIdentityV1 {
  return buildL1SubagentRecoveryEvaluatorIdentityV1({
    oracle: { eventAndStateTokens: 'no-payload-retention-v1' },
    verifier: { inventory: 'closed-cut-point-inventory-v1', output: 'metadata-only-v1' },
    runner: {
      runner: L1_SUBAGENT_RECOVERY_RUNNER_ID_V1,
      fixtureId: L1_SUBAGENT_RECOVERY_FIXTURE_ID_V1,
      fixtureRoot: 'new-temp-root-per-run-v1',
    },
    scheduler: {
      kernel: 'AgentKernel',
      resourceBudget: 'descendant-linked-reservations-v1',
      rewind: 'fork-rebind-v1',
    },
    faultInjection: {
      restart: 'claim-and-dispatch-unknown-v1',
      terminal: 'duplicate-late-noop-v1',
      cancellation: 'parallel-convergence-v1',
    },
  });
}

/** Freshly evaluates the immutable AQ-6 corpus from local synthetic executions only. */
export async function runL1SubagentRecoveryContractCorpusV1(
  input: { evaluator?: L1SubagentRecoveryEvaluatorIdentityV1 } = {},
): Promise<L1SubagentRecoveryReportV1> {
  const results = await runL1SubagentRecoveryAdaptersV1();
  const passed = new Map(results.map((result) => [result.adapterId, result.outcome === 'passed']));
  const observations: L1SubagentRecoveryCaseObservationV1[] = [
    l1SubagentRecoveryObservationForCaseV1(
      'l1-runtime-late-terminal-convergence-v1',
      passed.get('runtime-late-terminal-convergence-v1') === true,
    ),
    l1SubagentRecoveryObservationForCaseV1(
      'l1-runtime-parallel-cancel-convergence-v1',
      passed.get('runtime-parallel-cancel-convergence-v1') === true,
    ),
    l1SubagentRecoveryObservationForCaseV1(
      'l1-runtime-rewind-fork-tightening-v1',
      passed.get('runtime-rewind-fork-tightening-v1') === true,
    ),
    l1SubagentRecoveryObservationForCaseV1(
      'l1-runtime-subagent-restart-unknown-v1',
      passed.get('runtime-subagent-restart-unknown-v1') === true,
    ),
    l1SubagentRecoveryObservationForCaseV1(
      'l1-runtime-subagent-terminal-consumption-v1',
      passed.get('runtime-subagent-terminal-consumption-v1') === true,
    ),
    l1SubagentRecoveryObservationForCaseV1(
      'l1-subagent-approval-resume-claim-v1',
      passed.get('subagent-approval-resume-claim-v1') === true,
    ),
    l1SubagentRecoveryObservationForCaseV1(
      'l1-subagent-parent-child-reservation-v1',
      passed.get('subagent-parent-child-reservation-v1') === true,
    ),
  ];
  return evaluateL1SubagentRecoveryCorpusV1({
    evaluator: input.evaluator ?? buildL1SubagentRecoveryEvaluatorV1(),
    observations,
  });
}
