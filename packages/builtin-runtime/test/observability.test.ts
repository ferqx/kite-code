import { describe, expect, test } from 'bun:test';
import { OBSERVABILITY_METRIC_DRAFT_SCHEMA_ } from '@kite/runtime-contract';
import {
  createBuiltinObservabilityProjector,
  LowCardinalityAliasMapper,
} from '../src/observability';

const NOW = '2026-08-21T00:00:00.000Z';

describe('Builtin observability projector', () => {
  test('maps Kernel facts to Host-valid metric drafts without event authority', () => {
    const projector = createBuiltinObservabilityProjector({
      modelVisibleCapabilityAliases: ['shell_execute'],
    });
    const drafts = projector.mapRuntimeFact({
      schema: 'kite.observability-runtime-fact.v1',
      type: 'tool.finished',
      observedAt: NOW,
      capabilityAlias: 'shell_execute',
      outcome: { status: 'timed_out', totalActiveMs: 25 },
    });

    expect(drafts).toEqual([
      {
        schema: OBSERVABILITY_METRIC_DRAFT_SCHEMA_,
        name: 'tool_total',
        observedAt: NOW,
        attributes: { outcome: 'timed_out', capability: 'shell_execute' },
      },
      {
        schema: OBSERVABILITY_METRIC_DRAFT_SCHEMA_,
        name: 'tool_duration_ms',
        value: 25,
        observedAt: NOW,
        attributes: { outcome: 'timed_out', capability: 'shell_execute' },
      },
    ]);
    expect(drafts.every((draft) => Object.isFrozen(draft))).toBe(true);
    expect(JSON.stringify(drafts)).not.toContain('eventId');
    expect(JSON.stringify(drafts)).not.toContain('PRIVATE');
  });

  test('maps typed model, resource, release, task, failure and receipt facts', () => {
    const projector = createBuiltinObservabilityProjector({ releaseRouteAliases: ['route-a'] });
    expect(
      projector.mapModelObservation({ observedAt: NOW, routeAlias: 'route-a', outcome: 'success' }),
    ).toEqual([
      {
        schema: OBSERVABILITY_METRIC_DRAFT_SCHEMA_,
        name: 'model_request_total',
        observedAt: NOW,
        attributes: { outcome: 'success', route: 'route-a' },
      },
    ]);
    expect(projector.mapFailure({ kind: 'resource_saturated' }, NOW)[0]).toMatchObject({
      name: 'concurrency_saturation_total',
      attributes: { resource: 'unknown' },
    });
    expect(
      projector.mapExecutionReceipt({ status: 'succeeded', capabilityAlias: 'mcp:docs' }, NOW)[0],
    ).toMatchObject({
      name: 'mcp_total',
      attributes: { outcome: 'success', capability: 'custom/unknown' },
    });
    expect(projector.mapAppResource({ observedAt: NOW, activeToolInvocations: 2 })).toMatchObject([
      { name: 'resource_active_invocations', value: 2 },
    ]);
    expect(
      projector.mapReleaseProjection({
        observedAt: NOW,
        profile: 'canary',
        cohort: 'canary',
        outcome: 'admitted',
      })[0],
    ).toMatchObject({ name: 'release_rollout_total' });
    expect(
      projector.mapAgentTaskStage({
        observedAt: NOW,
        stage: 'integrated',
        outcome: 'completed',
      })[0],
    ).toMatchObject({ name: 'agent_task_stage_total' });
  });

  test('keeps arbitrary aliases bounded and rejects unsafe controlled aliases', () => {
    const aliases = new LowCardinalityAliasMapper(['route-a', 'route-b'], 1);
    expect(aliases.map('route-a')).toBe('route-a');
    expect(aliases.map('route-b')).toBe('other');
    expect(aliases.map('/private/path')).toBe('custom/unknown');
    expect(() => new LowCardinalityAliasMapper(['/private/path'], 1)).toThrow();
  });
});
