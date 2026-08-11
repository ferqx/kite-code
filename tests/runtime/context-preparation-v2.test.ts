import { describe, expect, test } from 'bun:test';
import {
  admitAndDispatchPreparedContextRequestV2,
  PreparedContextPurposeErrorV2,
  PreparedContextStaleErrorV2,
  type PreparedPrimaryContextRequestV2,
} from '@/core/model/context-admission-v2';
import {
  type ContextPreparationPurposeV2,
  prepareContextRequestV2,
} from '@/core/model/context-preparation-v2';
import type { ContextProjectionEnvironment } from '@/core/model/context-projection';
import type { ResolvedModelCapabilities } from '@/core/model/model-capabilities';
import { createInitialRuntimeState } from '@/core/runtime/state';

function fixture() {
  const state = createInitialRuntimeState({
    threadId: 'prepare-v2',
    userId: 'u',
    workspace: '/workspace',
  });
  state.transcript.messages.push({
    kind: 'user',
    messageId: 'user-1',
    content: 'hello',
  });
  const environment: ContextProjectionEnvironment = {
    serializedTools: [
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
        schemaDigest: 'a'.repeat(64),
      },
    ],
    workflowSkills: [],
    promptContractVersion: 'legacy',
    sandboxBackend: 'unknown',
  };
  const capabilities: ResolvedModelCapabilities = {
    providerName: 'fixture',
    modelName: 'fixture',
    contextWindowTokens: 32_768,
    contextWindowSource: 'explicit_config',
    maxOutputTokens: 1_024,
    maxOutputTokensSource: 'explicit_config',
    streaming: true,
  };
  return { state, environment, capabilities };
}

function prepare(purpose: ContextPreparationPurposeV2 = 'normal') {
  const { state, environment, capabilities } = fixture();
  return prepareContextRequestV2({
    purpose,
    state,
    environment,
    capabilities,
    requestedMaxOutputTokens: 512,
    promptAffectingParameters: {
      temperature: 0,
      toolChoice: 'auto',
      maxOutputTokens: 512,
    },
    toolResultBudgetPolicyId: 'tool-result-compat:v1',
    reclaimPolicyId: 'context-reclaim:v1',
  });
}

function primary(): PreparedPrimaryContextRequestV2 {
  const prepared = prepare('normal');
  if (!('effectiveProjection' in prepared) || prepared.next.kind !== 'primary_ready')
    throw new Error('expected primary artifact');
  return prepared as PreparedPrimaryContextRequestV2;
}

describe('PreparedContextRequestV2', () => {
  test('is deterministic, deeply frozen, and owns no mutable input aliases', () => {
    const firstFixture = fixture();
    const input = {
      purpose: 'normal' as const,
      ...firstFixture,
      requestedMaxOutputTokens: 512,
      promptAffectingParameters: { temperature: 0 },
      toolResultBudgetPolicyId: 'tool-result-compat:v1',
      reclaimPolicyId: 'context-reclaim:v1',
    };
    const first = prepareContextRequestV2(input);
    const second = prepareContextRequestV2(input);
    expect(first).toEqual(second);
    expect(first.preparedDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    if (!('effectiveProjection' in first) || !('effectiveProjection' in second))
      throw new Error('expected artifact');
    expect(Object.isFrozen(first.effectiveProjection.providerMessages)).toBe(true);
    expect(Object.isFrozen(first.effectiveProjection.providerMessages[0])).toBe(true);
    firstFixture.environment.serializedTools[0]!.name = 'mutated';
    firstFixture.state.transcript.messages[0]!.content = 'mutated';
    expect(first.requestIdentity.toolSetSchemaDigest).toBe(
      second.requestIdentity.toolSetSchemaDigest,
    );
    expect(first.effectiveProjection.providerMessages).toEqual(
      second.effectiveProjection.providerMessages,
    );
  });

  test('separates source identity from purpose-specific request identity', () => {
    const shared = fixture();
    const preparePurpose = (purpose: ContextPreparationPurposeV2) =>
      prepareContextRequestV2({
        purpose,
        ...shared,
        requestedMaxOutputTokens: 512,
        promptAffectingParameters: { temperature: 0 },
        toolResultBudgetPolicyId: 'tool-result-compat:v1',
        reclaimPolicyId: 'context-reclaim:v1',
      });
    const normal = preparePurpose('normal');
    const diagnostic = preparePurpose('context_inspection');
    if (!('requestIdentity' in normal) || !('requestIdentity' in diagnostic))
      throw new Error('expected artifacts');
    expect(normal.sourceIdentity).toEqual(diagnostic.sourceIdentity);
    expect(normal.requestIdentity.purpose).toBe('normal');
    expect(diagnostic.requestIdentity.purpose).toBe('context_inspection');
    expect(normal.requestIdentity).not.toEqual(diagnostic.requestIdentity);
    expect(normal.next).toEqual({ kind: 'primary_ready' });
    expect(diagnostic.next).toEqual({ kind: 'diagnostic_only' });
  });

  test('keeps candidate, diagnostic, and summary-source preparation pure', () => {
    expect(prepare('candidate_validation').next).toEqual({
      kind: 'candidate_ready',
    });
    expect(prepare('restore_debug').next).toEqual({
      kind: 'diagnostic_only',
    });
    expect(prepare('summary_source').next).toEqual({
      kind: 'summary_ready',
    });
  });

  test('binds ToolSet, prompt parameters, output reservation, and payload independently', () => {
    const base = fixture();
    const build = (input: {
      environment?: ContextProjectionEnvironment;
      prompt?: Record<string, unknown>;
      output?: number;
    }) =>
      prepareContextRequestV2({
        purpose: 'normal',
        ...base,
        environment: input.environment ?? base.environment,
        requestedMaxOutputTokens: input.output ?? 512,
        promptAffectingParameters: input.prompt ?? { temperature: 0 },
        toolResultBudgetPolicyId: 'tool-result-compat:v1',
        reclaimPolicyId: 'context-reclaim:v1',
      });
    const original = build({});
    const changedTool = structuredClone(base.environment);
    changedTool.serializedTools[0]!.inputSchema = { type: 'string' };
    const variants = [
      build({ environment: changedTool }),
      build({ prompt: { temperature: 1 } }),
      build({ output: 256 }),
    ];
    if (!('requestIdentity' in original)) throw new Error('expected artifact');
    for (const variant of variants) {
      if (!('requestIdentity' in variant)) throw new Error('expected artifact');
      expect(variant.requestIdentity).not.toEqual(original.requestIdentity);
      expect(variant.preparedDigest).not.toBe(original.preparedDigest);
    }
  });

  test('returns a typed correctness block for an invalid output reservation', () => {
    const { state, environment, capabilities } = fixture();
    const blocked = prepareContextRequestV2({
      purpose: 'normal',
      state,
      environment,
      capabilities,
      requestedMaxOutputTokens: 0,
      promptAffectingParameters: {},
      toolResultBudgetPolicyId: 'tool-result-compat:v1',
      reclaimPolicyId: 'context-reclaim:v1',
    });
    expect(blocked.next).toEqual({
      kind: 'correctness_blocked',
      reason: 'invalid_requested_max_output_tokens',
    });
    expect('effectiveProjection' in blocked).toBe(false);
  });

  test('allows an explicit zero output reservation only for read-only inspection', () => {
    const { state, environment, capabilities } = fixture();
    const prepared = prepareContextRequestV2({
      purpose: 'context_inspection',
      state,
      environment,
      capabilities: { ...capabilities, maxOutputTokens: undefined },
      requestedMaxOutputTokens: 0,
      promptAffectingParameters: {},
      toolResultBudgetPolicyId: 'tool-result-compat:v1',
      reclaimPolicyId: 'context-reclaim:v1',
    });
    expect(prepared.next.kind).toBe('diagnostic_only');
    if (!('effectiveProjection' in prepared)) throw new Error('expected inspection artifact');
    expect(prepared.requestIdentity.requestedMaxOutputTokens).toBe(0);
    expect(prepared.effectiveProjection.preflight.reservedOutputTokens).toBeUndefined();
  });

  test('starts once, admits the exact immutable payload, and dispatches once', async () => {
    const prepared = primary();
    const order: string[] = [];
    const seenPayloads: string[] = [];
    const result = await admitAndDispatchPreparedContextRequestV2({
      prepared,
      requestId: 'request-1',
      providerDataPolicyRequired: true,
      providerDataAdmission: (payload) => {
        order.push('provider-admission');
        seenPayloads.push(payload.map((part) => part.text).join('\n'));
        return { admitted: true, reason: 'admitted', routeAlias: 'fixture' };
      },
      resolveCurrentIdentity: () => {
        order.push('identity-check');
        return prepared;
      },
      startEffect: () => {
        order.push('start');
        return { effectLeaseId: 'lease-1', reservationIds: ['reservation-1'] };
      },
      markLocalProviderAdmissionDenied: () => {
        throw new Error('unexpected admission denial');
      },
      markUnknownExternalOutcome: () => {
        throw new Error('unexpected unknown outcome');
      },
      dispatch: async (admitted) => {
        order.push('dispatch');
        expect(admitted.providerMessages).toBe(prepared.effectiveProjection.providerMessages);
        expect(admitted.admittedRequestDigest).toMatch(/^[a-f0-9]{64}$/);
        return 'ok';
      },
    });
    expect(result).toBe('ok');
    expect(order).toEqual([
      'identity-check',
      'start',
      'identity-check',
      'provider-admission',
      'dispatch',
    ]);
    expect(seenPayloads.join('\n')).toContain('hello');
  });

  test('never starts a stale or non-primary artifact', async () => {
    const prepared = primary();
    let starts = 0;
    const stale = {
      ...prepared.requestIdentity,
      requestedMaxOutputTokens: prepared.requestIdentity.requestedMaxOutputTokens + 1,
    };
    await expect(
      admitAndDispatchPreparedContextRequestV2({
        prepared,
        requestId: 'stale',
        providerDataPolicyRequired: false,
        resolveCurrentIdentity: () => ({
          sourceIdentity: prepared.sourceIdentity,
          requestIdentity: stale,
        }),
        startEffect: () => {
          starts += 1;
          return { effectLeaseId: 'never', reservationIds: [] };
        },
        markLocalProviderAdmissionDenied: () => {},
        markUnknownExternalOutcome: () => {},
        dispatch: async () => 'never',
      }),
    ).rejects.toBeInstanceOf(PreparedContextStaleErrorV2);
    expect(starts).toBe(0);

    const diagnostic = prepare('context_inspection');
    await expect(
      admitAndDispatchPreparedContextRequestV2({
        prepared: diagnostic as unknown as PreparedPrimaryContextRequestV2,
        requestId: 'diagnostic',
        providerDataPolicyRequired: false,
        resolveCurrentIdentity: () => prepared,
        startEffect: () => ({ effectLeaseId: 'never', reservationIds: [] }),
        markLocalProviderAdmissionDenied: () => {},
        markUnknownExternalOutcome: () => {},
        dispatch: async () => 'never',
      }),
    ).rejects.toBeInstanceOf(PreparedContextPurposeErrorV2);
  });

  test('releases only a proven local admission denial and fences dispatch errors', async () => {
    const prepared = primary();
    let denied = 0;
    let unknown = 0;
    const base = {
      prepared,
      requestId: 'request-2',
      resolveCurrentIdentity: () => prepared,
      startEffect: () => ({ effectLeaseId: 'lease-2', reservationIds: ['r'] }),
      markLocalProviderAdmissionDenied: () => {
        denied += 1;
      },
      markUnknownExternalOutcome: () => {
        unknown += 1;
      },
    };
    await expect(
      admitAndDispatchPreparedContextRequestV2({
        ...base,
        providerDataPolicyRequired: true,
        providerDataAdmission: () => ({
          admitted: false,
          reason: 'provider_policy_missing',
          routeAlias: 'fixture',
        }),
        dispatch: async () => 'never',
      }),
    ).rejects.toThrow();
    expect({ denied, unknown }).toEqual({ denied: 1, unknown: 0 });

    await expect(
      admitAndDispatchPreparedContextRequestV2({
        ...base,
        providerDataPolicyRequired: false,
        dispatch: async () => {
          throw new Error('socket outcome unknown');
        },
      }),
    ).rejects.toThrow('socket outcome unknown');
    expect({ denied, unknown }).toEqual({ denied: 1, unknown: 1 });
  });
});
