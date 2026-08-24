import { describe, expect, test } from 'bun:test';
import { projectRuntimeEventToObservabilityFact } from '@kite/agent-kernel';
import {
  createBuiltinObservabilityProjector,
  LowCardinalityAliasMapper,
} from '@kite/builtin-runtime';
import type { ClassifiedFailure } from '#app/bootstrap/runtime/failures';

const NOW = '2026-08-02T00:00:00.000Z';
const MARKERS = [
  'SECRET_TOKEN_X9',
  '/Users/private/workspace/file.ts',
  'rm --marker-sensitive-command',
  'source-body-marker-7a91',
];

function runtimeSamples(
  input: unknown,
  observedAt: string,
  projector = createBuiltinObservabilityProjector(),
) {
  const fact = projectRuntimeEventToObservabilityFact(input, observedAt);
  return fact ? projector.mapRuntimeFact(fact) : [];
}

describe('Builtin observability allowlist projector', () => {
  test('emits no prompt, path, command, source, or free error marker', () => {
    const projector = createBuiltinObservabilityProjector({
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
      ...runtimeSamples(
        { type: 'user.message_appended', messageId: 'm', content: MARKERS[0]! },
        NOW,
        projector,
      ),
      ...runtimeSamples(
        { type: 'user.command_invoked', commandId: 'c', command: MARKERS[2]! },
        NOW,
        projector,
      ),
      ...runtimeSamples(
        {
          type: 'tool.file_change',
          toolCallId: 't',
          path: MARKERS[1]!,
          kind: 'edit',
          preview: MARKERS[3]!,
        },
        NOW,
        projector,
      ),
      ...runtimeSamples(
        { type: 'run.error', message: MARKERS.join(' '), recoverable: false, failure },
        NOW,
        projector,
      ),
      ...projector.mapFailure({ kind: 'resource_saturated' }, NOW),
      ...projector.mapModelObservation({
        observedAt: NOW,
        routeAlias: MARKERS[0],
        outcome: 'failed',
      }),
    ];
    const payload = JSON.stringify(samples);
    for (const marker of MARKERS) expect(payload).not.toContain(marker);
    expect(payload).toContain('custom/unknown');
  });

  test('retains only controlled aliases and folds cardinality overflow', () => {
    const aliases = new LowCardinalityAliasMapper(['route-a', 'route-b', 'route-c'], 2);
    expect(aliases.map('route-a')).toBe('route-a');
    expect(aliases.map('route-b')).toBe('route-b');
    expect(aliases.map('route-a')).toBe('route-a');
    expect(aliases.map('route-c')).toBe('other');
    for (let index = 0; index < 1_000; index += 1) {
      expect(aliases.map(`attacker-${index}`)).toBe('custom/unknown');
    }
  });

  test('derives terminal tool metrics from the canonical outcome instead of legacy fields', () => {
    const projector = createBuiltinObservabilityProjector({
      modelVisibleCapabilityAliases: ['shell_execute'],
    });
    const samples = runtimeSamples(
      {
        type: 'tool.finished',
        toolCallId: 'private-call',
        name: 'shell_execute',
        result: { ok: false, command: 'private', exitCode: 124, stdout: '', stderr: 'private' },
        outcome: {
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
      projector,
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
    const projector = createBuiltinObservabilityProjector();
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
    const approval = runtimeSamples(
      {
        type: 'approval.rejected',
        interactionId: 'private-approval',
        toolCallId: 'private-tool',
        generation: 0,
        reason: 'private',
        createdAt: NOW,
        outcome: rejectionOutcome,
      },
      NOW,
      projector,
    );
    const autoReview = runtimeSamples(
      {
        type: 'auto_review.completed',
        reviewId: 'private-review',
        toolCallId: 'private-tool',
        result: { ok: true, approved: false, reviewerModelName: 'private', durationMs: 17 },
        outcome: {
          ...rejectionOutcome,
          failure: {
            kind: 'auto_review_rejected' as const,
            detailCode: 'auto_review_rejected' as const,
          },
        },
      },
      NOW,
      projector,
    );
    for (const samples of [approval, autoReview]) {
      expect(samples.filter((sample) => sample.name === 'tool_total')).toHaveLength(1);
      expect(samples.filter((sample) => sample.name === 'tool_duration_ms')).toHaveLength(1);
      expect(samples.filter((sample) => sample.name.startsWith('tool_'))).toHaveLength(2);
    }
  });

  test('maps Runtime, resource, failure, model, and receipt metadata without identities', () => {
    const projector = createBuiltinObservabilityProjector({
      releaseRouteAliases: ['route-a'],
      modelVisibleCapabilityAliases: ['mcp:docs'],
    });
    const samples = [
      ...runtimeSamples(
        { type: 'turn.aborted', turnId: 'private-turn', reason: 'secret', cause: 'user' },
        NOW,
        projector,
      ),
      ...runtimeSamples(
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
        projector,
      ),
      ...projector.mapAppResource({
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
      ...projector.mapModelObservation({
        observedAt: NOW,
        routeAlias: 'route-a',
        outcome: 'success',
        durationMs: 20,
        inputTokens: 100,
        outputTokens: 10,
      }),
      ...projector.mapExecutionReceipt({ capabilityAlias: 'mcp:docs', status: 'succeeded' }, NOW),
      ...projector.mapAgentTaskStage({
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
