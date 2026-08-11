import { describe, expect, test } from 'bun:test';
import {
  CONTEXT_RECLAIM_LIVE_POLICY_V2,
  type PreparedContextRequestReadyV2,
  prepareContextRequestV2,
} from '@/core/model/context-preparation-v2';
import type { ContextProjectionEnvironment } from '@/core/model/context-projection';
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
  },
): PreparedContextRequestReadyV2 {
  const base = fixture(options);
  const prepared = prepareContextRequestV2({
    purpose: 'normal',
    ...base,
    requestedMaxOutputTokens: 256,
    promptAffectingParameters: { temperature: 0 },
    toolResultBudgetPolicyId: 'tool-result-budget-registry:v2',
    reclaimPolicyId: CONTEXT_RECLAIM_LIVE_POLICY_V2.policyId,
    reclaimMode: mode,
    reclaimAfterEstimatedTokens: options?.reclaimAfterEstimatedTokens,
  });
  if (!('effectiveProjection' in prepared))
    throw new Error(`unexpected block: ${prepared.next.reason}`);
  return prepared;
}

describe('context reclaim live preparation', () => {
  test('applies a fixed positive-saving plan only in live mode', () => {
    const off = prepare('off', { contextWindowTokens: 8_000 });
    const live = prepare('live', { contextWindowTokens: 8_000 });
    expect(off.reclaimApplication.kind).toBe('off');
    expect(live.reclaimApplication.kind).toBe('applied_plan');
    expect(live.effectiveProjection.estimate.totalInputTokens).toBeLessThan(
      live.rawProjection.estimate.totalInputTokens -
        CONTEXT_RECLAIM_LIVE_POLICY_V2.minEstimatedSavedTokens,
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
});
