import { describe, expect, test } from 'bun:test';
import {
  createMetricSample,
  MAX_METRIC_SAMPLE_BYTES_,
  METRIC_ATTRIBUTE_KEYS,
  METRIC_DEFINITIONS_,
  parseMetricSample,
} from '@kite/runtime-host';

const NOW = '2026-08-02T00:00:00.000Z';

describe('production metric schema v1', () => {
  test('covers every required low-content domain and resource signal', () => {
    const names = Object.keys(METRIC_DEFINITIONS_);
    for (const prefix of [
      'run_',
      'turn_',
      'model_',
      'tool_',
      'mcp_',
      'skill_',
      'plan_',
      'verification_',
      'compaction_',
      'runtime_',
      'resource_',
      'release_',
    ]) {
      expect(names.some((name) => name.startsWith(prefix))).toBeTrue();
    }
    for (const name of [
      'process_tree_high_water',
      'process_tree_limit_termination_total',
      'read_batch_size',
      'concurrency_wait_ms',
      'concurrency_saturation_total',
      'approval_sibling_total',
      'runtime_cancel_incomplete_total',
      'runtime_orphan_total',
      'runtime_late_terminal_rejection_total',
      'agent_task_stage_total',
      'artifact_bytes_total',
      'session_log_bytes_total',
      'runtime_rss_bytes',
      'runtime_event_loop_lag_ms',
      'runtime_fd_count',
      'runtime_listener_count',
      'runtime_handle_count',
    ]) {
      expect(names).toContain(name);
    }
  });

  test('every definition is versioned, bounded, owned, and classified as no-content', () => {
    for (const definition of Object.values(METRIC_DEFINITIONS_)) {
      expect(definition.version).toBe(1);
      expect(definition.cardinalityLimit).toBeGreaterThan(0);
      expect(definition.producer.length).toBeGreaterThan(0);
      expect(definition.consumers.length).toBeGreaterThan(0);
      expect(definition.privacy).toBe('non_content_low_cardinality');
      expect(definition.allowedAttributes.every((key) => METRIC_ATTRIBUTE_KEYS.includes(key))).toBe(
        true,
      );
    }
  });

  test('sample construction rejects content-bearing or undeclared labels', () => {
    expect(() =>
      createMetricSample({
        name: 'run_total',
        observedAt: NOW,
        attributes: { workspace: '/secret/path' } as never,
      }),
    ).toThrow('does not allow attribute workspace');
    expect(() =>
      createMetricSample({
        name: 'run_total',
        observedAt: NOW,
        attributes: { route: 'not-allowed-on-run' },
      }),
    ).toThrow('does not allow attribute route');
    expect(() =>
      createMetricSample({
        name: 'run_total',
        observedAt: NOW,
        attributes: { outcome: 'completed', reason: 'secret-error-message' },
      }),
    ).toThrow('unknown enum value');
    expect(() =>
      createMetricSample({
        name: 'model_request_total',
        observedAt: NOW,
        attributes: { outcome: 'success', route: 'SECRET_ROUTE' },
      }),
    ).toThrow('not a controlled alias');
  });

  test('reporter-boundary parsing rejects unknown fields and forged definition fields', () => {
    const sample = createMetricSample({ name: 'run_total', observedAt: NOW });
    expect(() => parseMetricSample({ ...sample, prompt: 'SECRET' })).toThrow('unknown fields');
    expect(() => parseMetricSample({ ...sample, kind: 'gauge' })).toThrow(
      'does not match its definition',
    );
  });

  test('reporter-boundary parsing folds lowercase content-bearing aliases without a release registry', () => {
    const sample = createMetricSample({
      name: 'model_request_total',
      observedAt: NOW,
      attributes: { outcome: 'success', route: 'secret-customer-acme-token' },
    });
    expect(parseMetricSample(sample).attributes.route).toBe('custom/unknown');
    expect(
      parseMetricSample(sample, { route: new Set(['secret-customer-acme-token']) }).attributes
        .route,
    ).toBe('secret-customer-acme-token');
  });

  test('sample construction rejects invalid numeric and temporal data', () => {
    expect(() =>
      createMetricSample({ name: 'read_batch_size', value: Number.NaN, observedAt: NOW }),
    ).toThrow('finite and non-negative');
    expect(() =>
      createMetricSample({ name: 'read_batch_size', value: -1, observedAt: NOW }),
    ).toThrow('finite and non-negative');
    expect(() =>
      createMetricSample({ name: 'read_batch_size', value: 1, observedAt: 'not-a-date' }),
    ).toThrow('ISO-8601');
  });

  test('the allowlisted sample shape has an explicit serialized size ceiling', () => {
    const sample = createMetricSample({
      name: 'release_rollout_total',
      observedAt: NOW,
      attributes: {
        profile: 'internal',
        cohort: 'general',
        outcome: 'resource_saturated',
      },
    });
    expect(new TextEncoder().encode(JSON.stringify(sample)).byteLength).toBeLessThanOrEqual(
      MAX_METRIC_SAMPLE_BYTES_,
    );
  });
});
