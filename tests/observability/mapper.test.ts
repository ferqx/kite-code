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
