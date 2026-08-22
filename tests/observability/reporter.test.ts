import { describe, expect, test } from 'bun:test';
import {
  BoundedMetricQueueV1,
  BufferedMetricReporterV1,
  createMetricSampleV1,
  type MetricExporterV1,
  NoopMetricReporterV1,
} from '@kite/runtime-host';

const NOW = '2026-08-02T00:00:00.000Z';
const sample = (name: 'read_batch_size' | 'run_total' | 'runtime_hard_block_total') =>
  createMetricSampleV1({
    name,
    observedAt: NOW,
    ...(name === 'run_total' ? { attributes: { outcome: 'completed', reason: 'completed' } } : {}),
    ...(name === 'runtime_hard_block_total' ? { attributes: { reason: 'unknown' } } : {}),
  });

describe('bounded metric reporter', () => {
  test('evicts the oldest lowest-priority sample and records a local drop', () => {
    const queue = new BoundedMetricQueueV1(2);
    queue.enqueue(sample('read_batch_size'));
    queue.enqueue(sample('runtime_hard_block_total'));
    queue.enqueue(sample('run_total'));
    expect(queue.snapshot().map((entry) => entry.name)).toEqual([
      'runtime_hard_block_total',
      'run_total',
    ]);
    expect(queue.dropped).toBe(1);
  });

  test('exporter rejection and timeout never propagate to Runtime callers', async () => {
    const rejecting: MetricExporterV1 = {
      export: async () => Promise.reject(new Error('network secret')),
    };
    const reporter = new BufferedMetricReporterV1({
      enabled: true,
      capacity: 4,
      exporter: rejecting,
    });
    reporter.report(sample('run_total'));
    await expect(reporter.flush(10)).resolves.toBeUndefined();
    expect(reporter.status()).toMatchObject({
      queued: 0,
      dropped: 1,
      exporterFailures: 1,
      diskSpool: false,
    });
    expect(reporter.localDropMetric(NOW)?.attributes.reason).toBe('exporter_failure');

    const hanging = new BufferedMetricReporterV1({
      enabled: true,
      capacity: 4,
      exporter: { export: () => new Promise(() => {}) },
    });
    hanging.report(sample('run_total'));
    await expect(hanging.flush(1)).resolves.toBeUndefined();
    expect(hanging.status().exporterFailures).toBe(1);
  });

  test('consent withdrawal clears memory and permanently stops new samples', async () => {
    const exported: string[] = [];
    const reporter = new BufferedMetricReporterV1({
      enabled: true,
      capacity: 4,
      exporter: {
        export: async (samples) => {
          exported.push(...samples.map((entry) => entry.name));
        },
      },
    });
    reporter.report(sample('run_total'));
    reporter.withdrawConsent();
    reporter.report(sample('runtime_hard_block_total'));
    await reporter.flush(10);
    expect(reporter.status()).toMatchObject({ enabled: false, queued: 0 });
    expect(exported).toEqual([]);
  });

  test('folds unknown aliases and enforces the per-metric series budget at export', async () => {
    const exported: Array<ReturnType<typeof createMetricSampleV1>> = [];
    const aliases = Array.from({ length: 65 }, (_, index) => `route-${index}`);
    const reporter = new BufferedMetricReporterV1({
      enabled: true,
      capacity: 128,
      exporter: {
        export: async (samples) => {
          exported.push(...samples);
        },
      },
      controlledAliases: { route: new Set(aliases) },
    });
    for (const route of aliases) {
      reporter.report(
        createMetricSampleV1({
          name: 'model_request_total',
          observedAt: NOW,
          attributes: { outcome: 'success', route },
        }),
      );
    }
    for (let index = 0; index < 1_000; index += 1) {
      reporter.report(
        createMetricSampleV1({
          name: 'model_request_total',
          observedAt: NOW,
          attributes: { outcome: 'failed', route: `secret-customer-${index}` },
        }),
      );
    }
    await reporter.flush(100);
    expect(exported).toHaveLength(64);
    expect(exported.some((entry) => entry.attributes.route === 'secret-customer-0')).toBeFalse();
    expect(reporter.status().dropped).toBe(1_001);
  });

  test('no-op reporter has no storage, exporter, or failure path', async () => {
    const reporter = new NoopMetricReporterV1();
    reporter.report(sample('runtime_hard_block_total'));
    await reporter.shutdown(1);
    expect(reporter.status()).toEqual({
      enabled: false,
      queued: 0,
      capacity: 0,
      dropped: 0,
      exporterFailures: 0,
      diskSpool: false,
    });
  });
});
