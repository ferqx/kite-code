import { describe, expect, test } from 'bun:test';
import {
  LowCardinalityAliasMapperV1,
  ProductionMetricMapperV1,
} from '../../src/core/observability/mapper';
import type { ClassifiedFailure } from '../../src/core/runtime/failures';

const NOW = '2026-08-02T00:00:00.000Z';
const MARKERS = [
  'SECRET_TOKEN_X9',
  '/Users/private/workspace/file.ts',
  'rm --marker-sensitive-command',
  'source-body-marker-7a91',
];

describe('production metric allowlist mapper', () => {
  test('emits no prompt, path, command, source, or free error marker', () => {
    const mapper = new ProductionMetricMapperV1({
      releaseRouteAliases: ['approved-route'],
      modelVisibleCapabilityAliases: ['read_file'],
    });
    const failure: ClassifiedFailure = {
      kind: 'tool_runtime_error',
      message: MARKERS.join(' '),
      retryable: false,
      modelFixable: false,
      needsUserIntervention: false,
      terminatesTurn: true,
      journal: true,
    };
    const samples = [
      ...mapper.mapRuntimeEvent(
        { type: 'user.message_appended', messageId: 'm', content: MARKERS[0]! },
        NOW,
      ),
      ...mapper.mapRuntimeEvent(
        { type: 'user.command_invoked', commandId: 'c', command: MARKERS[2]! },
        NOW,
      ),
      ...mapper.mapRuntimeEvent(
        {
          type: 'tool.file_change',
          toolCallId: 't',
          path: MARKERS[1]!,
          kind: 'edit',
          preview: MARKERS[3]!,
        },
        NOW,
      ),
      ...mapper.mapRuntimeEvent(
        { type: 'run.error', message: MARKERS.join(' '), recoverable: false, failure },
        NOW,
      ),
      ...mapper.mapFailure(failure, NOW),
      ...mapper.mapModelObservation({ observedAt: NOW, routeAlias: MARKERS[0], outcome: 'failed' }),
    ];
    const payload = JSON.stringify(samples);
    for (const marker of MARKERS) expect(payload).not.toContain(marker);
    expect(payload).toContain('custom/unknown');
  });

  test('retains only controlled aliases and folds cardinality overflow', () => {
    const aliases = new LowCardinalityAliasMapperV1(['route-a', 'route-b', 'route-c'], 2);
    expect(aliases.map('route-a')).toBe('route-a');
    expect(aliases.map('route-b')).toBe('route-b');
    expect(aliases.map('route-a')).toBe('route-a');
    expect(aliases.map('route-c')).toBe('other');
    for (let index = 0; index < 1_000; index += 1) {
      expect(aliases.map(`attacker-${index}`)).toBe('custom/unknown');
    }
  });

  test('derives terminal tool metrics from the canonical outcome instead of legacy fields', () => {
    const mapper = new ProductionMetricMapperV1({
      modelVisibleCapabilityAliases: ['shell_execute'],
    });
    const samples = mapper.mapRuntimeEvent(
      {
        type: 'tool.finished',
        toolCallId: 'private-call',
        name: 'shell_execute',
        result: { ok: false, command: 'private', exitCode: 124, stdout: '', stderr: 'private' },
        outcomeV1: {
          schemaVersion: 1,
          status: 'timed_out',
          failure: { kind: 'tool_timeout', detailCode: 'timed_out' },
          dispatchState: 'started',
          externalEffects: 'unknown',
          recovery: {
            disposition: 'never',
            maximumAdditionalCalls: 0,
            requiresNewModelResponse: false,
            safeAutomaticRetry: false,
          },
          timing: { source: 'runtime_boundary', totalActiveMs: 25 },
        },
      },
      NOW,
    );
    expect(samples).toContainEqual(
      expect.objectContaining({
        name: 'tool_total',
        attributes: { outcome: 'timed_out', capability: 'shell_execute' },
      }),
    );
    expect(samples).toContainEqual(
      expect.objectContaining({
        name: 'tool_duration_ms',
        value: 25,
        attributes: { outcome: 'timed_out', capability: 'shell_execute' },
      }),
    );
    expect(JSON.stringify(samples)).not.toContain('private-call');
  });

  test('emits exactly one canonical tool metric pair for approval and auto-review rejection', () => {
    const mapper = new ProductionMetricMapperV1();
    const rejectionOutcome = {
      schemaVersion: 1 as const,
      status: 'rejected' as const,
      failure: { kind: 'approval_rejected' as const, detailCode: 'approval_rejected' as const },
      dispatchState: 'not_started' as const,
      externalEffects: 'none' as const,
      replaySafety: 'pre_dispatch' as const,
      recovery: {
        disposition: 'never' as const,
        maximumAdditionalCalls: 0 as const,
        requiresNewModelResponse: false,
        safeAutomaticRetry: false,
      },
      timing: { source: 'runtime_boundary' as const, totalActiveMs: 17 },
    };
    const approval = mapper.mapRuntimeEvent(
      {
        type: 'approval.rejected',
        interactionId: 'private-approval',
        toolCallId: 'private-tool',
        reason: 'private',
        outcomeV1: rejectionOutcome,
      },
      NOW,
    );
    const autoReview = mapper.mapRuntimeEvent(
      {
        type: 'auto_review.completed',
        reviewId: 'private-review',
        toolCallId: 'private-tool',
        result: { ok: true, approved: false, reviewerModelName: 'private', durationMs: 17 },
        outcomeV1: {
          ...rejectionOutcome,
          failure: {
            kind: 'auto_review_rejected' as const,
            detailCode: 'auto_review_rejected' as const,
          },
        },
      },
      NOW,
    );
    for (const samples of [approval, autoReview]) {
      expect(samples.filter((sample) => sample.name === 'tool_total')).toHaveLength(1);
      expect(samples.filter((sample) => sample.name === 'tool_duration_ms')).toHaveLength(1);
      expect(samples.filter((sample) => sample.name.startsWith('tool_'))).toHaveLength(2);
    }
  });

  test('maps Runtime, resource, failure, model, and receipt metadata without identities', () => {
    const mapper = new ProductionMetricMapperV1({
      releaseRouteAliases: ['route-a'],
      modelVisibleCapabilityAliases: ['mcp:docs'],
    });
    const samples = [
      ...mapper.mapRuntimeEvent(
        { type: 'turn.aborted', turnId: 'private-turn', reason: 'secret', cause: 'user' },
        NOW,
      ),
      ...mapper.mapRuntimeEvent(
        {
          type: 'runtime.cancellation_diagnostic',
          toolCallId: 'private-tool',
          failure: {
            kind: 'cancel_incomplete',
            message: 'secret',
            retryable: false,
            modelFixable: false,
            needsUserIntervention: true,
            terminatesTurn: true,
            journal: true,
          },
          unconfirmedDescendantCount: 2,
        },
        NOW,
      ),
      ...mapper.mapAppResource({
        observedAt: NOW,
        activeToolInvocations: 3,
        activeShellInvocations: 1,
        processTreeHighWater: 12,
        readBatchSize: 4,
        concurrencyWaitMs: 10,
        concurrencyResource: 'tool',
        concurrencyOutcome: 'timed_out',
        approvalSiblingOutcome: 'not_dispatched',
        rssBytes: 128_000_000,
        eventLoopLagMs: 4,
        listenerCount: 2,
        fileDescriptorCount: 12,
        handleCount: 14,
        artifactBytes: 1_024,
        sessionLogBytes: 2_048,
        budgetExhaustedResource: 'tool',
      }),
      ...mapper.mapModelObservation({
        observedAt: NOW,
        routeAlias: 'route-a',
        outcome: 'success',
        durationMs: 20,
        inputTokens: 100,
        outputTokens: 10,
      }),
      ...mapper.mapExecutionReceipt(
        {
          invocationId: 'private',
          toolCallId: 'private',
          capabilityId: 'mcp:docs',
          capabilityRevision: 'secret',
          argumentsDigest: 'secret',
          authorizationDigest: 'secret',
          effectiveEffectsDigest: 'secret',
          status: 'succeeded',
          recordedAt: NOW,
        },
        NOW,
      ),
      ...mapper.mapAgentTaskStage({
        observedAt: NOW,
        stage: 'integrated',
        outcome: 'completed',
      }),
    ];
    const payload = JSON.stringify(samples);
    expect(samples.length).toBeGreaterThan(10);
    expect(payload).not.toContain('private-turn');
    expect(payload).not.toContain('private-tool');
    expect(payload).not.toContain('capabilityRevision');
    expect(payload).toContain('route-a');
    expect(payload).toContain('mcp:docs');
  });
});
