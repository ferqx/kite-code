import { describe, expect, test } from 'bun:test';
import { createMetricSampleV1 } from '../../src/core/observability/metrics';
import {
  BoundedMetricQueueV1,
  BufferedMetricReporterV1,
  type MetricExporterV1,
  NoopMetricReporterV1,
} from '../../src/core/observability/reporter';

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
