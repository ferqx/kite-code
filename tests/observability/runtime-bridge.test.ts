import { describe, expect, test } from 'bun:test';
import { projectRuntimeEventToObservabilityFactV1 } from '@kite/agent-kernel';
import { createBuiltinObservabilityProjectorV1 } from '@kite/builtin-runtime';
import { BufferedMetricReporterV1 } from '@kite/runtime-host';
import { RuntimeMetricBridgeV1 } from '../../apps/kite/src/observability/runtime-bridge';

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
      projector: createBuiltinObservabilityProjectorV1(),
      reporter,
    });
    const turnFact = projectRuntimeEventToObservabilityFactV1(
      { type: 'turn.completed', turnId: 'turn-1' },
      '2026-08-03T00:00:00.000Z',
    );
    const retryFact = projectRuntimeEventToObservabilityFactV1(
      {
        eventId: 'event-1',
        threadId: 'thread-1',
        revision: 1,
        occurredAt: '2026-08-03T00:00:01.000Z',
        payload: { type: 'model.retry', attempt: 1, maxAttempts: 3, error: 'redacted', delayMs: 1 },
      },
      '1970-01-01T00:00:00.000Z',
    );
    expect(turnFact).toBeDefined();
    expect(retryFact).toBeDefined();
    if (turnFact) bridge.observeRuntimeFact(turnFact);
    if (retryFact) bridge.observeRuntimeFact(retryFact);
    await bridge.flush(100);
    expect(exported).toEqual(['turn_total', 'model_request_total']);
  });

  test('never lets projector or reporter failures change Runtime flow', () => {
    const bridge = new RuntimeMetricBridgeV1({
      projector: createBuiltinObservabilityProjectorV1(),
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
    const turnFact = projectRuntimeEventToObservabilityFactV1(
      { type: 'turn.completed', turnId: 'turn-1' },
      '2026-08-03T00:00:00.000Z',
    );
    expect(turnFact).toBeDefined();
    expect(() => turnFact && bridge.observeRuntimeFact(turnFact)).not.toThrow();
  });
});
