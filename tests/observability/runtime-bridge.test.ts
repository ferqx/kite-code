import { describe, expect, test } from 'bun:test';
import { RuntimeMetricBridgeV1 } from '../../src/app/observability/runtime-bridge';
import { ProductionMetricMapperV1 } from '../../src/core/observability/mapper';
import { BufferedMetricReporterV1 } from '../../src/core/observability/reporter';

describe('Runtime metric bridge', () => {
  test('maps the public Runtime stream into the shared bounded reporter', async () => {
    const exported: string[] = [];
    const reporter = new BufferedMetricReporterV1({
      enabled: true,
      capacity: 8,
      exporter: {
        export: async (samples) => {
          exported.push(...samples.map((sample) => sample.name));
        },
      },
    });
    const bridge = new RuntimeMetricBridgeV1({
      mapper: new ProductionMetricMapperV1(),
      reporter,
    });
    bridge.observeRuntimeEvent(
      { type: 'turn.completed', turnId: 'turn-1' },
      '2026-08-03T00:00:00.000Z',
    );
    bridge.observeRuntimeEvent(
      {
        eventId: 'event-1',
        threadId: 'thread-1',
        revision: 1,
        occurredAt: '2026-08-03T00:00:01.000Z',
        payload: { type: 'model.retry', attempt: 1, maxAttempts: 3, error: 'redacted', delayMs: 1 },
      },
      '1970-01-01T00:00:00.000Z',
    );
    await bridge.flush(100);
    expect(exported).toEqual(['turn_total', 'model_request_total']);
  });

  test('never lets mapper or reporter failures change Runtime flow', () => {
    const bridge = new RuntimeMetricBridgeV1({
      mapper: new ProductionMetricMapperV1(),
      reporter: {
        report: () => {
          throw new Error('exporter detail');
        },
        reportMany: () => {
          throw new Error('exporter detail');
        },
        withdrawConsent: () => {},
        flush: async () => {},
        shutdown: async () => {},
        status: () => ({
          enabled: true,
          queued: 0,
          capacity: 1,
          dropped: 0,
          exporterFailures: 1,
          diskSpool: false,
        }),
      },
    });
    expect(() =>
      bridge.observeRuntimeEvent(
        { type: 'turn.completed', turnId: 'turn-1' },
        '2026-08-03T00:00:00.000Z',
      ),
    ).not.toThrow();
  });
});
