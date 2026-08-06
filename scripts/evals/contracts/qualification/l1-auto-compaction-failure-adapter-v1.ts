import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import type { AgentConfig } from '../../../../src/core/config';
import { buildContextProjection } from '../../../../src/core/model/context-projection';
import type { SupportedChatModel } from '../../../../src/core/model/factory';
import type { RuntimeEvent } from '../../../../src/core/runtime/events';
import { createRuntimeEffectExecutor } from '../../../../src/core/runtime/executor';
import { AgentKernel } from '../../../../src/core/runtime/kernel';
import { type RuntimeActionProvider, runRuntimeLoop } from '../../../../src/core/runtime/runner';
import { decideNextEffect } from '../../../../src/core/runtime/scheduler';
import { createInitialRuntimeState, type RuntimeState } from '../../../../src/core/runtime/state';
import { createRuntimeStore } from '../../../../src/core/runtime/store';
import {
  evaluateL1AutoCompactionFailureCorpusV1,
  type L1AutoCompactionFailureCaseObservationV1,
  type L1AutoCompactionFailureReportV1,
  l1AutoCompactionFailureObservationForCaseV1,
} from './l1-auto-compaction-failure-evaluator-v1';
import {
  buildL1AutoCompactionFailureEvaluatorIdentityV1,
  L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1,
  type L1AutoCompactionFailureAdapterIdV1,
  type L1AutoCompactionFailureAdapterResultV1,
  type L1AutoCompactionFailureEvaluatorIdentityV1,
} from './l1-auto-compaction-failure-schema-v1';

export {
  L1_AUTO_COMPACTION_FAILURE_ADAPTER_IMPLEMENTATIONS_V1,
  L1_AUTO_COMPACTION_FAILURE_FIXTURE_ID_V1,
  L1_AUTO_COMPACTION_FAILURE_RUNNER_ID_V1,
} from './l1-auto-compaction-failure-schema-v1';

const L1_SYNTHETIC_ROOT_PREFIX_V1 = 'kite-l1-auto-compaction-';
const AUTO_COMPACTION_TOKEN_THRESHOLD_V1 = 8_192;
const SAFE_SYNTHETIC_MIN_TOKENS_V1 = 9_000;
const SAFE_SYNTHETIC_MAX_TOKENS_V1 = 12_000;
const SAFE_CONTEXT_CHUNK_V1 =
  'stable synthetic history records only non-sensitive qualification context and no instructions. ';

type FaultKindV1 = 'summary_failure' | 'provider_failure' | 'provider_network_failure';

interface ScriptedFailureModelV1 {
  model: SupportedChatModel;
  readonly calls: { count: number };
}

/**
 * A local AI-SDK compatible transport. It never has a route, credential,
 * endpoint, request capture, response capture, child process, or network path.
 */
function createScriptedFailureModelV1(fault: FaultKindV1): ScriptedFailureModelV1 {
  const calls = { count: 0 };
  const localModel = {
    specificationVersion: 'v4',
    provider: 'qualification-scripted',
    modelId: 'qualification-scripted',
    supportedUrls: {},
    async doGenerate(): Promise<unknown> {
      calls.count += 1;
      const error = new Error('l1_auto_compaction_transport_fault') as Error & { code?: string };
      if (fault === 'provider_failure') error.code = 'L1_PROVIDER_FAILURE';
      if (fault === 'provider_network_failure') error.code = 'ECONNRESET';
      throw error;
    },
    async doStream(): Promise<never> {
      throw new Error('l1_auto_compaction_stream_not_available');
    },
  };
  return {
    model: {
      model: localModel as unknown as LanguageModel,
      capabilityMetadata: { streaming: false },
      setRetryListener: () => {},
    },
    calls,
  };
}

function l1AutoCompactionConfigV1(): AgentConfig {
  return {
    apiKey: '',
    baseURL: '',
    modelName: 'qualification-scripted',
    providerName: 'qualification-scripted',
    providerType: 'openai-compatible',
    sandbox: { enabled: true },
    features: {
      contextCompactionV2: true,
      contextCompactionAutoV1: true,
    },
    compaction: {
      autoMode: 'live',
      compactAfterEstimatedTokens: AUTO_COMPACTION_TOKEN_THRESHOLD_V1,
      maxSummaryTokens: 600,
      maxNarrativeTokens: 800,
      maxSummaryInputTokens: 8_192,
    },
  };
}

/** Build 9–12K safe history with the production projection/token estimator. */
function l1AutoCompactionStateV1(root: string): { state: RuntimeState; estimatedTokens: number } {
  const state = createInitialRuntimeState({
    threadId: 'l1-auto-compaction-thread',
    userId: 'qualification',
    workspace: root,
    interactionMode: 'accept_edits',
  });
  state.turn = { turnId: 'l1-auto-compaction-current-turn', turnIndex: 2, status: 'active' };
  state.transcript.messages = [
    {
      kind: 'user',
      messageId: 'l1-auto-compaction-history',
      turnId: 'l1-auto-compaction-history-turn',
      ordinal: 0,
      createdAt: '2026-08-05T00:00:00.000Z',
      content: SAFE_CONTEXT_CHUNK_V1,
    },
    {
      kind: 'user',
      messageId: 'l1-auto-compaction-current',
      turnId: 'l1-auto-compaction-current-turn',
      ordinal: 1,
      createdAt: '2026-08-05T00:00:01.000Z',
      content: 'Continue the synthetic qualification fixture.',
    },
  ];

  for (let iteration = 0; iteration < 128; iteration += 1) {
    const estimatedTokens = buildContextProjection({ role: 'agent', state }).estimate
      .totalInputTokens;
    if (estimatedTokens >= SAFE_SYNTHETIC_MIN_TOKENS_V1) {
      if (estimatedTokens > SAFE_SYNTHETIC_MAX_TOKENS_V1) {
        throw new Error('l1_auto_compaction_fixture_exceeds_safe_token_range');
      }
      return { state, estimatedTokens };
    }
    const history = state.transcript.messages[0];
    if (history?.kind !== 'user') {
      throw new Error('l1_auto_compaction_fixture_history_missing');
    }
    history.content += SAFE_CONTEXT_CHUNK_V1.repeat(32);
  }
  throw new Error('l1_auto_compaction_fixture_did_not_reach_token_threshold');
}

const noInteractionProviderV1: RuntimeActionProvider = {
  async requestAction() {
    throw new Error('l1_auto_compaction_unexpected_interaction');
  },
};

async function collectRuntimeEventsV1(
  kernel: AgentKernel,
  executor: ReturnType<typeof createRuntimeEffectExecutor>,
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of runRuntimeLoop(kernel, executor, noInteractionProviderV1, 16)) {
    events.push(event);
  }
  return events;
}

function hasOnlyAutoAdmissionEventsV1(events: readonly RuntimeEvent[]): boolean {
  return (
    events.some((event) => event.type === 'model.context_metrics') &&
    events.some((event) => event.type === 'context.compaction_requested') &&
    events.some(
      (event) =>
        event.type === 'context.compaction_failed' && event.errorKind === 'summary_model_failed',
    ) &&
    !events.some((event) => event.type === 'model.requested')
  );
}

function scriptedCallCountV1(input: ScriptedFailureModelV1): number {
  return input.calls.count;
}

function lateCompactionCompletionV1(input: {
  compactionId: string;
  sourceRevision: number;
}): Extract<RuntimeEvent, { type: 'context.compaction_completed' }> {
  return {
    type: 'context.compaction_completed',
    compactionId: input.compactionId,
    sourceRevision: input.sourceRevision,
    checkpoint: {
      compactionId: input.compactionId,
      version: 1,
      sourceRevision: input.sourceRevision,
      sourceDigest: 'l1-auto-compaction-late-source',
      coveredThroughMessageId: 'l1-auto-compaction-history',
      coveredThroughTurnId: 'l1-auto-compaction-history-turn',
      summary: 'Late synthetic summary is ignored.',
      inputTokensBefore: SAFE_SYNTHETIC_MIN_TOKENS_V1,
      inputTokensAfter: 1,
      reason: 'auto',
      createdAt: '2026-08-05T00:00:02.000Z',
    },
  };
}

/**
 * Runs the production composition path. The only synthetic component is the
 * local transport fault; no compactor is injected or called directly.
 */
async function runFaultCaseV1(fault: FaultKindV1): Promise<boolean> {
  const root = mkdtempSync(join(tmpdir(), L1_SYNTHETIC_ROOT_PREFIX_V1));
  const fixture = l1AutoCompactionStateV1(root);
  const scripted = createScriptedFailureModelV1(fault);
  const kernel = new AgentKernel({
    store: createRuntimeStore(':memory:'),
    initialState: fixture.state,
    interactionMode: 'accept_edits',
  });
  const executor = createRuntimeEffectExecutor({
    config: l1AutoCompactionConfigV1(),
    model: scripted.model,
  });
  try {
    if (
      fixture.estimatedTokens < SAFE_SYNTHETIC_MIN_TOKENS_V1 ||
      fixture.estimatedTokens > SAFE_SYNTHETIC_MAX_TOKENS_V1
    ) {
      return false;
    }

    const firstTurnId = kernel.getState().turn.turnId;
    const firstEvents = await collectRuntimeEventsV1(kernel, executor);
    const firstFailure = firstEvents.find(
      (event): event is Extract<RuntimeEvent, { type: 'context.compaction_failed' }> =>
        event.type === 'context.compaction_failed',
    );
    const firstRequested = firstEvents.find(
      (event): event is Extract<RuntimeEvent, { type: 'context.compaction_requested' }> =>
        event.type === 'context.compaction_requested',
    );
    if (
      !firstFailure ||
      !firstRequested ||
      firstFailure.errorKind !== 'summary_model_failed' ||
      firstFailure.requestedAtTurnId !== firstTurnId ||
      firstRequested.requestedAtTurnId !== firstTurnId ||
      scriptedCallCountV1(scripted) !== 1 ||
      !hasOnlyAutoAdmissionEventsV1(firstEvents) ||
      decideNextEffect(kernel.getState()).type !== 'stop'
    ) {
      return false;
    }

    // A delayed completion for the already failed lease cannot create a
    // checkpoint or revive normal dispatch in the failed turn.
    kernel.processEvent(
      lateCompactionCompletionV1({
        compactionId: firstFailure.compactionId,
        sourceRevision: firstFailure.sourceRevision,
      }),
    );
    const lateEvents = await collectRuntimeEventsV1(kernel, executor);
    if (
      kernel.getState().context.activeCheckpoint !== undefined ||
      kernel.getState().context.pendingCompaction !== undefined ||
      kernel.getState().context.lastFailure?.compactionId !== firstFailure.compactionId ||
      decideNextEffect(kernel.getState()).type !== 'stop' ||
      lateEvents.some((event) => event.type === 'model.requested') ||
      scriptedCallCountV1(scripted) !== 1
    ) {
      return false;
    }

    // The retry is only admitted after an actual new user message and a new
    // turn. It must re-run ModelController preflight before another summary
    // attempt; it may not fall through to an ordinary primary dispatch.
    kernel.processEvent({
      type: 'user.message_appended',
      messageId: 'l1-auto-compaction-next-user',
      content: 'Continue the safe synthetic fixture.',
    });
    kernel.processEvent({ type: 'turn.started', turnId: 'l1-auto-compaction-next-turn' });
    const secondEvents = await collectRuntimeEventsV1(kernel, executor);
    const secondRequested = secondEvents.find(
      (event): event is Extract<RuntimeEvent, { type: 'context.compaction_requested' }> =>
        event.type === 'context.compaction_requested',
    );
    const secondFailure = secondEvents.find(
      (event): event is Extract<RuntimeEvent, { type: 'context.compaction_failed' }> =>
        event.type === 'context.compaction_failed',
    );
    return (
      Boolean(secondRequested) &&
      Boolean(secondFailure) &&
      secondRequested?.requestedAtTurnId === 'l1-auto-compaction-next-turn' &&
      secondFailure?.requestedAtTurnId === 'l1-auto-compaction-next-turn' &&
      secondFailure?.errorKind === 'summary_model_failed' &&
      secondEvents.some((event) => event.type === 'model.context_metrics') &&
      !secondEvents.some((event) => event.type === 'model.requested') &&
      scriptedCallCountV1(scripted) === 2 &&
      decideNextEffect(kernel.getState()).type === 'stop'
    );
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function adapterResult(
  adapterId: L1AutoCompactionFailureAdapterIdV1,
  passed: boolean,
): L1AutoCompactionFailureAdapterResultV1 {
  const pair = L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1.find(
    (entry) => entry.adapterId === adapterId,
  );
  if (!pair) throw new Error(`unregistered_l1_auto_compaction_failure_adapter:${adapterId}`);
  return { ...pair, outcome: passed ? 'passed' : 'failed' };
}

/** Runs every closed AQ-9A fault case and retains only stable outcome tokens. */
export async function runL1AutoCompactionFailureAdaptersV1(): Promise<
  readonly L1AutoCompactionFailureAdapterResultV1[]
> {
  const outcomes = await Promise.all([
    runFaultCaseV1('provider_failure'),
    runFaultCaseV1('provider_network_failure'),
    runFaultCaseV1('summary_failure'),
  ]);
  return [
    adapterResult('auto-compaction-provider-failure-v1', outcomes[0]),
    adapterResult('auto-compaction-provider-network-failure-v1', outcomes[1]),
    adapterResult('auto-compaction-summary-failure-v1', outcomes[2]),
  ];
}

export function buildL1AutoCompactionFailureEvaluatorV1(): L1AutoCompactionFailureEvaluatorIdentityV1 {
  return buildL1AutoCompactionFailureEvaluatorIdentityV1();
}

/** Rebuild the closed AQ-9A corpus from fresh, zero-network local executions. */
export async function runL1AutoCompactionFailureContractCorpusV1(
  input: { evaluator?: L1AutoCompactionFailureEvaluatorIdentityV1 } = {},
): Promise<L1AutoCompactionFailureReportV1> {
  const results = await runL1AutoCompactionFailureAdaptersV1();
  const passed = new Map(results.map((result) => [result.adapterId, result.outcome === 'passed']));
  const observations: L1AutoCompactionFailureCaseObservationV1[] = [
    l1AutoCompactionFailureObservationForCaseV1(
      'l1-auto-compaction-provider-failure-v1',
      passed.get('auto-compaction-provider-failure-v1') === true,
    ),
    l1AutoCompactionFailureObservationForCaseV1(
      'l1-auto-compaction-provider-network-failure-v1',
      passed.get('auto-compaction-provider-network-failure-v1') === true,
    ),
    l1AutoCompactionFailureObservationForCaseV1(
      'l1-auto-compaction-summary-failure-v1',
      passed.get('auto-compaction-summary-failure-v1') === true,
    ),
  ];
  return evaluateL1AutoCompactionFailureCorpusV1({
    evaluator: input.evaluator ?? buildL1AutoCompactionFailureEvaluatorV1(),
    observations,
  });
}
