import { describe, expect, test } from 'bun:test';
import { projectRuntimeEventToObservabilityFact } from '@kite/agent-kernel';
import { createBuiltinObservabilityProjector } from '@kite/builtin-runtime';
import { BufferedMetricReporter } from '@kite/runtime-host';
import { RuntimeMetricBridge } from '../../apps/kite/src/observability/runtime-bridge';

describe('Runtime metric bridge', () => {
  test('maps the public Runtime stream into the shared bounded reporter', async () => {
    const exported: string[] = [];
    const reporter = new BufferedMetricReporter({
      enabled: true,
      capacity: 8,
      exporter: {
        export: async (samples) => {
          exported.push(...samples.map((sample) => sample.name));
        },
      },
    });
    const bridge = new RuntimeMetricBridge({
      projector: createBuiltinObservabilityProjector(),
      reporter,
    });
    const turnFact = projectRuntimeEventToObservabilityFact(
      { type: 'turn.completed', turnId: 'turn-1' },
      '2026-08-03T00:00:00.000Z',
    );
    const retryFact = projectRuntimeEventToObservabilityFact(
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
    const bridge = new RuntimeMetricBridge({
      projector: createBuiltinObservabilityProjector(),
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
    const turnFact = projectRuntimeEventToObservabilityFact(
      { type: 'turn.completed', turnId: 'turn-1' },
      '2026-08-03T00:00:00.000Z',
    );
    expect(turnFact).toBeDefined();
    expect(() => turnFact && bridge.observeRuntimeFact(turnFact)).not.toThrow();
  });
});
