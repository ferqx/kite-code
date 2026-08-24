import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_MODEL_OPERATION_BY_PURPOSE_,
  BuiltinModelEffectCoordinator,
  type BuiltinModelOperationAttempt,
  type BuiltinModelOperationExecutionPort,
  createChatModel,
  type ModelArtifactWriter,
  ModelInvocationGateway,
  type ModelInvocationPersistence,
  type ModelInvocationStateView,
  type ModelResponseSource,
  type ModelRuntimeConfig,
} from '@kite/builtin-runtime/model';
import {
  MODEL_ATTEMPT_OUTCOME_SCHEMA_,
  type ModelAttemptOutcome,
  type PrivateArtifactRef,
} from '@kite/runtime-spi';
import type {
  BuiltinContextTokenEstimateView,
  BuiltinRuntimeStateView,
} from '../src/model/runtime-view';

const CONFIG: ModelRuntimeConfig = Object.freeze({
  apiKey: 'coordinator-fixture-key',
  baseURL: 'https://coordinator-fixture.invalid/v1',
  modelName: 'coordinator-fixture',
  providerName: 'coordinator-fixture',
  providerType: 'openai-compatible',
  sandbox: Object.freeze({ enabled: false }),
});

const MODEL = createChatModel(CONFIG);
type ReviewState = ModelInvocationStateView & {
  readonly context: { readonly activeCheckpoint?: { readonly sourceDigest: string } };
};

function createPersistence(): ModelInvocationPersistence<ReviewState> {
  const state: ReviewState = Object.freeze({
    revision: 1,
    session: { threadId: 'coordinator-thread', projectId: 'project_coordinator_test' },
    turn: { turnId: 'coordinator-turn' },
    resourceBudget: { status: 'unconfigured' },
    context: { activeCheckpoint: { sourceDigest: 'checkpoint-fixture' } },
  });
  return {
    getState: () => state,
    persistEvents: async () => true,
  };
}

function artifactRef<K extends 'model_surface' | 'model_response'>(
  kind: K,
): PrivateArtifactRef & { kind: K } {
  return {
    artifactId: `coordinator-${kind}`,
    kind,
    integrityIdentifier: 'sha256:coordinator-fixture',
    byteLength: 1,
  };
}

function successfulOutcome(text: string): ModelAttemptOutcome {
  return {
    schema: MODEL_ATTEMPT_OUTCOME_SCHEMA_,
    kind: 'success',
    response: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null },
      providerMetadata: { responseId: 'coordinator-response', rawFinishReason: 'stop' },
    },
    nativeReplayState: null,
  };
}

function createGatewayFixture(input?: {
  invalidVerificationResponse?: boolean;
  autoReviewResponse?: string;
}) {
  let gatewayInvocations = 0;
  let sourceInvocations = 0;
  let invocationOrdinal = 0;
  let purpose: BuiltinModelOperationAttempt['purpose'] | undefined;
  const artifacts: ModelArtifactWriter = {
    writeSurface: () => artifactRef('model_surface'),
    writeResponse: () => artifactRef('model_response'),
  };
  const source: ModelResponseSource = Object.freeze({
    attempt: async () => {
      sourceInvocations += 1;
      const text =
        purpose === 'auto_review'
          ? (input?.autoReviewResponse ??
            '{"approved":true,"grant":"approve_once","reason":"fixture-approved"}')
          : purpose === 'context_compaction'
            ? '# Fixture Summary\n\nPreserve the accepted runtime facts.'
            : input?.invalidVerificationResponse
              ? '{"unexpected":true}'
              : '{"outcome":"passed","summary":"fixture-passed"}';
      return successfulOutcome(text);
    },
  });
  const operationExecution: BuiltinModelOperationExecutionPort = Object.freeze({
    execute: async (attempt: BuiltinModelOperationAttempt) => {
      gatewayInvocations += 1;
      purpose = attempt.purpose;
      expect(attempt.operationId).toBe(BUILTIN_MODEL_OPERATION_BY_PURPOSE_[attempt.purpose]);
      return attempt.attempt();
    },
  });
  const gateway = new ModelInvocationGateway({
    artifacts,
    source,
    operationExecution,
    runtimeIdSource: {
      next: () => `coordinator-invocation-${++invocationOrdinal}`,
      now: () => 1_000,
    },
    now: () => 1_000,
    sleep: async () => {},
  });
  return {
    gateway,
    counts: () => ({ gatewayInvocations, sourceInvocations }),
  };
}

const COMPACTION_ESTIMATE: BuiltinContextTokenEstimateView = {
  systemTokens: 100,
  toolSchemaTokens: 0,
  transcriptTokens: 20_000,
  summaryTokens: 0,
  dynamicRuntimeTokens: 100,
  framingTokens: 100,
  totalInputTokens: 20_300,
};

function contextStateWithHistory(
  turns = 6,
  content: string | ((index: number) => string) = 'historical context '.repeat(500),
  interactionKind = 'idle',
): BuiltinRuntimeStateView {
  return {
    activeTaskId: null,
    tasks: {},
    revision: 1,
    session: { workspace: '/workspace' },
    turn: { turnId: `turn-${turns - 1}`, turnIndex: turns - 1, status: 'completed' },
    transcript: {
      messages: Array.from({ length: turns }, (_, index) => ({
        kind: 'user' as const,
        messageId: `message-${index}`,
        turnId: `turn-${index}`,
        ordinal: index,
        createdAt: `2026-08-21T00:00:0${index}.000Z`,
        content: typeof content === 'string' ? content : content(index),
      })),
    },
    context: {
      autoGuard: {
        recentAutomaticCompactions: [],
        consecutiveLowGain: 0,
        disabledUntilManualAction: false,
        recoveryAttempted: false,
      },
    },
    interactions: { kind: interactionKind },
    tools: { calls: {} },
    authorization: { mode: 'default' },
    mode: 'accept_edits',
  };
}

function pendingCompaction(state: BuiltinRuntimeStateView) {
  return {
    compactionId: 'coordinator-compaction',
    reason: 'manual' as const,
    requestedAtRevision: state.revision,
    requestedAtTurnId: state.turn.turnId,
    force: false,
    estimate: COMPACTION_ESTIMATE,
  };
}

describe('BuiltinModelEffectCoordinator', () => {
  test.each([
    [
      'approve',
      '{"decision":"approve","grant":"approve_once","reason":"safe"}',
      { ok: true, suggestion: { approved: true, reason: 'safe' } },
    ],
    [
      'reject',
      '{"decision":"reject","grant":"approve_once","reason":"unsafe"}',
      { ok: true, suggestion: { approved: false, reason: 'unsafe' } },
    ],
    [
      'ask_user',
      '{"decision":"ask_user","grant":"approve_once","reason":"intent required"}',
      {
        ok: true,
        suggestion: {
          approved: false,
          requiresUserApproval: true,
          reason: 'intent required',
        },
      },
    ],
    [
      'legacy rejection',
      '{"approved":false,"grant":"approve_once","reason":"legacy risk"}',
      {
        ok: true,
        suggestion: {
          approved: false,
          requiresUserApproval: true,
          reason: 'legacy risk',
        },
      },
    ],
  ] as const)('parses the %s auto-review disposition', async (_label, response, expected) => {
    const fixture = createGatewayFixture({ autoReviewResponse: response });
    const coordinator = new BuiltinModelEffectCoordinator(fixture.gateway);
    const result = await coordinator.reviewToolApproval({
      config: CONFIG,
      model: MODEL,
      persistence: createPersistence(),
      payload: {
        risk: 'read',
        expectedEffects: ['Reads a sensitive external path'],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
        summary: 'Review sensitive external access',
        reason: 'Mode-aware auto review is required.',
      },
      request: { id: 'reviewed-tool', name: 'read_file', args: { path: '~/.ssh/config' } },
    });

    expect(result).toMatchObject(expected);
    expect(fixture.counts()).toEqual({ gatewayInvocations: 1, sourceInvocations: 1 });
  });

  test.each([
    [
      'unknown fields',
      '{"decision":"approve","grant":"approve_once","reason":"safe","extra":true}',
      'auto review returned unknown fields',
    ],
    [
      'contradictory fields',
      '{"decision":"reject","approved":true,"grant":"approve_once","reason":"conflict"}',
      'auto review returned contradictory decision fields',
    ],
  ] as const)('fails closed for auto-review %s', async (_label, response, reason) => {
    const fixture = createGatewayFixture({ autoReviewResponse: response });
    const result = await new BuiltinModelEffectCoordinator(fixture.gateway).reviewToolApproval({
      config: CONFIG,
      model: MODEL,
      persistence: createPersistence(),
      payload: {
        risk: 'read',
        expectedEffects: ['Reads a sensitive external path'],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
        summary: 'Review sensitive external access',
        reason: 'Mode-aware auto review is required.',
      },
      request: { id: 'reviewed-tool', name: 'read_file', args: { path: '~/.ssh/config' } },
    });

    expect(result).toMatchObject({ ok: false, failureType: 'invalid_response', reason });
  });

  test('creates one context compactor that uses the injected Gateway once', async () => {
    const fixture = createGatewayFixture();
    const coordinator = new BuiltinModelEffectCoordinator(fixture.gateway);
    const state = contextStateWithHistory();
    const compact = coordinator.createContextCompactor({
      config: CONFIG,
      model: MODEL,
      persistence: createPersistence(),
      state,
      projectionEnvironmentDigest: 'coordinator-compaction-environment',
      maxSummaryTokens: 600,
      maxNarrativeTokens: 600,
    });

    const checkpoint = await compact({
      state,
      pending: pendingCompaction(state),
      sourceRevision: state.revision,
    });

    expect(checkpoint.summary).toContain('Fixture Summary');
    expect(fixture.counts()).toEqual({ gatewayInvocations: 1, sourceInvocations: 1 });
  });

  test('rejects low-gain and unsafe boundaries before invoking the summary source', async () => {
    const fixture = createGatewayFixture();
    const coordinator = new BuiltinModelEffectCoordinator(fixture.gateway);
    const makeCompactor = () =>
      coordinator.createContextCompactor({
        config: CONFIG,
        model: MODEL,
        persistence: createPersistence(),
        state: contextStateWithHistory(),
        projectionEnvironmentDigest: 'coordinator-compaction-environment',
      });

    const lowGainState = contextStateWithHistory(2, 'hello');
    await expect(
      makeCompactor()({
        state: lowGainState,
        pending: pendingCompaction(lowGainState),
        sourceRevision: lowGainState.revision,
      }),
    ).rejects.toMatchObject({ kind: 'insufficient_reduction' });
    expect(fixture.counts()).toEqual({ gatewayInvocations: 0, sourceInvocations: 0 });

    const unsafeState = contextStateWithHistory(
      6,
      'historical context '.repeat(500),
      'awaiting_auto_review',
    );
    await expect(
      makeCompactor()({
        state: unsafeState,
        pending: pendingCompaction(unsafeState),
        sourceRevision: unsafeState.revision,
      }),
    ).rejects.toMatchObject({ kind: 'unsafe_boundary' });
    expect(fixture.counts()).toEqual({ gatewayInvocations: 0, sourceInvocations: 0 });
  });
});
