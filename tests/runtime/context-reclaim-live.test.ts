import { describe, expect, test } from 'bun:test';
import {
  CONTEXT_RECLAIM_LIVE_POLICY_V3,
  type PreparedContextRequestReadyV2,
  prepareContextRequestV2,
} from '@/core/model/context-preparation-v2';
import type { ContextProjectionEnvironment } from '@/core/model/context-projection';
import { proposeContextReclaimCommitV1 } from '@/core/model/context-reclaim-commit';
import type { ResolvedModelCapabilities } from '@/core/model/model-capabilities';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { projectedModelContentDigest } from '@/core/tools/registry/projection';
import type { ToolResultBudgetReceiptV2 } from '@/core/tools/result-budget-v2';

function receipt(
  content: string,
  projectionMode: 'compat_v1' | 'budget_v2' = 'budget_v2',
): ToolResultBudgetReceiptV2 {
  return {
    version: 2,
    projectionMode,
    policyId: 'read-file-lines:v2',
    toolIdentity: 'builtin:read_file',
    bindingDigest: 'b'.repeat(64),
    projectorId: 'read-line-window:v1',
    projectorRevision: 'line-window-projector:v2',
    validatorId: 'line-window-validator:v2',
    rawResultDigest: 'a'.repeat(64),
    modelContentDigest: projectedModelContentDigest(content),
    modelContentUtf8Bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function fixture(input?: {
  projectionMode?: 'compat_v1' | 'budget_v2';
  blocks?: number;
  charsPerBlock?: number;
  contextWindowTokens?: number;
}) {
  const state = createInitialRuntimeState({
    threadId: 'context-reclaim-live',
    userId: 'u',
    workspace: '/workspace',
  });
  const blocks = input?.blocks ?? 2;
  for (let index = 0; index < blocks; index++) {
    const callId = `read-${index}`;
    const assistantId = `assistant-${index}`;
    const turnId = `historical-${index}`;
    const path = `src/file-${index}.ts`;
    const content = `1|${'bounded historical source line '.repeat(
      Math.ceil((input?.charsPerBlock ?? 18_000) / 31),
    )}`;
    const resultMeta = {
      path,
      totalLines: 1,
      rawResultDigest: 'a'.repeat(64),
      modelContentDigest: projectedModelContentDigest(content),
      digestScope: 'raw' as const,
      toolResultReceipt: receipt(content, input?.projectionMode ?? 'budget_v2'),
    };
    state.transcript.messages.push(
      {
        kind: 'assistant',
        messageId: assistantId,
        turnId,
        content: '',
        toolCalls: [{ id: callId, name: 'read_file', args: { path, limit: 100 } }],
      },
      {
        kind: 'tool',
        messageId: `tool-${index}`,
        turnId,
        toolCallId: callId,
        name: 'read_file',
        content,
        ok: true,
        resultMeta,
      },
    );
    state.tools.calls[callId] = {
      toolCallId: callId,
      modelMessageId: assistantId,
      name: 'read_file',
      args: { path, limit: 100 },
      status: 'succeeded',
      createdAtTurnId: turnId,
      effectClass: 'read_only',
      sideEffect: false,
      result: { ok: true, summary: 'read', resultMeta },
    };
  }
  state.transcript.messages.push(
    {
      kind: 'user',
      messageId: 'recent-user-1',
      turnId: 'recent-turn-1',
      content: 'first recent settled turn',
    },
    {
      kind: 'user',
      messageId: 'recent-user-2',
      turnId: 'recent-turn-2',
      content: 'second recent settled turn',
    },
  );
  const environment: ContextProjectionEnvironment = {
    serializedTools: [],
    workflowSkills: [],
  };
  const capabilities: ResolvedModelCapabilities = {
    providerName: 'fixture',
    modelName: 'fixture',
    ...(input?.contextWindowTokens !== undefined
      ? {
          contextWindowTokens: input.contextWindowTokens,
          contextWindowSource: 'explicit_config' as const,
        }
      : {}),
    maxOutputTokens: 512,
    maxOutputTokensSource: 'explicit_config',
    streaming: true,
  };
  return { state, environment, capabilities };
}

function prepare(
  mode: 'off' | 'shadow' | 'live',
  options?: Parameters<typeof fixture>[0] & {
    reclaimAfterEstimatedTokens?: number;
    barrier?: 'interaction' | 'verification';
  },
): PreparedContextRequestReadyV2 {
  const base = fixture(options);
  if (options?.barrier === 'interaction') {
    base.state.interactions = {
      kind: 'awaiting_provider_admission',
      interactionId: 'pending-provider',
      providerId: 'provider',
      source: 'project',
      providerStatus: 'login_required',
      retryable: true,
    };
  }
  if (options?.barrier === 'verification') {
    base.state.verification.records.pending = {
      verificationId: 'pending',
      mode: 'required',
      status: 'pending',
      spec: { checks: [] },
      requestedAt: new Date(0).toISOString(),
      attempts: 0,
      repairAttempts: 0,
      checkResults: {},
    } as never;
  }
  return prepareBase(base, mode, options?.reclaimAfterEstimatedTokens);
}

function prepareBase(
  base: ReturnType<typeof fixture>,
  mode: 'off' | 'shadow' | 'live',
  reclaimAfterEstimatedTokens?: number,
): PreparedContextRequestReadyV2 {
  const prepared = prepareContextRequestV2({
    purpose: 'normal',
    ...base,
    requestedMaxOutputTokens: 256,
    promptAffectingParameters: { temperature: 0 },
    toolResultBudgetPolicyId: 'tool-result-budget-registry:v2',
    reclaimPolicyId: CONTEXT_RECLAIM_LIVE_POLICY_V3.policyId,
    reclaimMode: mode,
    reclaimAfterEstimatedTokens,
  });
  if (!('effectiveProjection' in prepared))
    throw new Error(`unexpected block: ${prepared.next.reason}`);
  return prepared;
}

function insertHistoricalRead(
  state: ReturnType<typeof fixture>['state'],
  index: number,
  charsPerBlock = 18_000,
): void {
  const callId = `read-extra-${index}`;
  const assistantId = `assistant-extra-${index}`;
  const turnId = `historical-extra-${index}`;
  const path = `src/extra-${index}.ts`;
  const content = `1|${'bounded historical source line '.repeat(Math.ceil(charsPerBlock / 31))}`;
  const resultMeta = {
    path,
    totalLines: 1,
    rawResultDigest: 'a'.repeat(64),
    modelContentDigest: projectedModelContentDigest(content),
    digestScope: 'raw' as const,
    toolResultReceipt: receipt(content),
  };
  state.transcript.messages.splice(
    -2,
    0,
    {
      kind: 'assistant',
      messageId: assistantId,
      turnId,
      content: '',
      toolCalls: [{ id: callId, name: 'read_file', args: { path, limit: 100 } }],
    },
    {
      kind: 'tool',
      messageId: `tool-extra-${index}`,
      turnId,
      toolCallId: callId,
      name: 'read_file',
      content,
      ok: true,
      resultMeta,
    },
  );
  state.tools.calls[callId] = {
    toolCallId: callId,
    modelMessageId: assistantId,
    name: 'read_file',
    args: { path, limit: 100 },
    status: 'succeeded',
    createdAtTurnId: turnId,
    effectClass: 'read_only',
    sideEffect: false,
    result: { ok: true, summary: 'read', resultMeta },
  };
}

describe('context reclaim live preparation', () => {
  test('applies a fixed positive-saving plan only in live mode', () => {
    const off = prepare('off', { contextWindowTokens: 8_000 });
    const live = prepare('live', { contextWindowTokens: 8_000 });
    expect(off.reclaimApplication.kind).toBe('off');
    expect(live.reclaimApplication.kind).toBe('applied_plan');
    expect(live.effectiveProjection.estimate.totalInputTokens).toBeLessThan(
      live.rawProjection.estimate.totalInputTokens -
        CONTEXT_RECLAIM_LIVE_POLICY_V3.minInitialEstimatedSavedTokens,
    );
    expect(live.effectiveProjection.providerMessages).not.toEqual(
      live.rawProjection.providerMessages,
    );
    expect(live.rawProjection.providerMessages).toEqual(off.rawProjection.providerMessages);
  });

  test('shadow produces purpose evidence but preserves exact raw provider bytes', () => {
    const off = prepare('off', { contextWindowTokens: 8_000 });
    const shadow = prepare('shadow', { contextWindowTokens: 8_000 });
    expect(shadow.reclaimApplication.kind).toBe('valid_noop_plan');
    expect(shadow.effectiveProjection.providerMessages).toEqual(
      off.effectiveProjection.providerMessages,
    );
  });

  test('unknown window needs an explicit absolute trigger', () => {
    const noTrigger = prepare('live');
    expect(noTrigger.reclaimApplication).toMatchObject({
      kind: 'raw_fallback',
      failure: 'ineligible',
    });
    const absolute = prepare('live', { reclaimAfterEstimatedTokens: 1 });
    expect(absolute.reclaimApplication.kind).toBe('applied_plan');
  });

  test('mixed compat provenance and insufficient hysteresis remain raw', () => {
    const compat = prepare('live', {
      projectionMode: 'compat_v1',
      contextWindowTokens: 8_000,
    });
    expect(compat.reclaimApplication).toMatchObject({
      kind: 'raw_fallback',
      failure: 'plan_rejected',
    });
    const single = prepare('live', {
      blocks: 1,
      contextWindowTokens: 4_000,
    });
    expect(single.reclaimApplication).toMatchObject({
      kind: 'raw_fallback',
      failure: 'plan_rejected',
    });
  });

  test('batches later prefix changes behind a cooldown and a larger incremental saving', () => {
    const base = fixture({ contextWindowTokens: 8_000 });
    const first = prepareBase(base, 'live');
    if (!first.proposedReclaimPlan) throw new Error('expected initial reclaim plan');
    const commit = proposeContextReclaimCommitV1({
      state: base.state,
      prepared: first,
      plan: first.proposedReclaimPlan,
    });
    base.state.context.reclaimCommit = commit;
    base.state.turn = {
      turnId: 'active-after-first-commit',
      turnIndex: commit.committedAtTurnIndex + 1,
      status: 'active',
    };
    const priorPolicy = prepareContextRequestV2({
      purpose: 'normal',
      ...base,
      requestedMaxOutputTokens: 256,
      promptAffectingParameters: { temperature: 0 },
      toolResultBudgetPolicyId: 'tool-result-budget-registry:v2',
      reclaimPolicyId: 'context-reclaim-live:v2',
      reclaimMode: 'live',
    });
    if (!('reclaimApplication' in priorPolicy)) throw new Error('expected prepared context');
    expect(priorPolicy.reclaimApplication.kind).not.toBe('applied_commit');

    insertHistoricalRead(base.state, 1, 60_000);

    const duringCooldown = prepareBase(base, 'live');
    expect(duringCooldown.reclaimApplication.kind).toBe('applied_commit');
    expect(duringCooldown.proposedReclaimPlan).toBeUndefined();

    base.state.turn = {
      ...base.state.turn,
      turnIndex:
        commit.committedAtTurnIndex + CONTEXT_RECLAIM_LIVE_POLICY_V3.minTurnsBetweenCommits,
    };
    const tooSmallAfterCooldown = prepareBase(base, 'live');
    expect(tooSmallAfterCooldown.reclaimApplication.kind).toBe('applied_commit');

    insertHistoricalRead(base.state, 2, 60_000);
    const batched = prepareBase(base, 'live');
    expect(batched.reclaimApplication.kind).toBe('applied_plan');
    expect(batched.proposedReclaimPlan?.estimatedSavedTokens).toBeGreaterThanOrEqual(
      CONTEXT_RECLAIM_LIVE_POLICY_V3.minIncrementalEstimatedSavedTokens,
    );
  });

  test('may bypass only the cooldown at hard pressure, never the batch qualification', () => {
    const base = fixture({ contextWindowTokens: 8_000 });
    const first = prepareBase(base, 'live');
    if (!first.proposedReclaimPlan) throw new Error('expected initial reclaim plan');
    const commit = proposeContextReclaimCommitV1({
      state: base.state,
      prepared: first,
      plan: first.proposedReclaimPlan,
    });
    base.state.context.reclaimCommit = commit;
    base.state.turn = {
      turnId: 'hard-pressure-turn',
      turnIndex: commit.committedAtTurnIndex + 1,
      status: 'active',
    };
    insertHistoricalRead(base.state, 3, 60_000);
    expect(prepareBase(base, 'live').reclaimApplication.kind).toBe('applied_commit');

    insertHistoricalRead(base.state, 4, 60_000);
    const emergency = prepareBase(base, 'live');
    expect(emergency.rawProjection.preflight.status).toBe('hard_limit');
    expect(emergency.reclaimApplication.kind).toBe('applied_plan');
  });

  test('pending interaction and verification are raw MicroCompact barriers', () => {
    for (const barrier of ['interaction', 'verification'] as const) {
      const prepared = prepare('live', { contextWindowTokens: 8_000, barrier });
      expect(prepared.reclaimApplication).toMatchObject({
        kind: 'raw_fallback',
        failure: 'ineligible',
      });
      expect(prepared.effectiveProjection.providerMessages).toEqual(
        prepared.rawProjection.providerMessages,
      );
    }
  });
});
