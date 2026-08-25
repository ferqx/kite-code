import { describe, expect, test } from 'bun:test';
import { createMetricSample } from '@kite/runtime-host';
import { GovernedMetricExporter } from '../../apps/kite/src/observability/governed-exporter';

const sample = createMetricSample({
  name: 'run_total',
  observedAt: '2026-08-03T00:00:00.000Z',
  attributes: { outcome: 'completed', reason: 'completed' },
});

describe('governed metric exporter', () => {
  test('exports canonical metadata only through an approved transport alias', async () => {
    const sent: Array<{ endpointAlias: string; contentType: string; body: Uint8Array }> = [];
    const exporter = new GovernedMetricExporter({
      endpointAlias: 'kite-operations-v1',
      approvedEndpointAliases: new Set(['kite-operations-v1']),
      transport: {
        send: async (input) => {
          sent.push(input);
        },
      },
    });
    await exporter.export([sample]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      endpointAlias: 'kite-operations-v1',
      contentType: 'application/vnd.kite.metrics.v1+json',
    });
    const payload = JSON.parse(new TextDecoder().decode(sent[0]!.body));
    expect(payload).toMatchObject({
      schema: 'GovernedMetricExportEnvelope',
      sequence: 1,
      sampleCount: 1,
      samples: [sample],
    });
    expect(JSON.stringify(payload)).not.toContain('prompt');
    expect(JSON.stringify(payload)).not.toContain('content');
  });

  test('rejects unapproved aliases and bounded payload violations before transport', async () => {
    expect(
      () =>
        new GovernedMetricExporter({
          endpointAlias: 'caller-supplied',
          approvedEndpointAliases: new Set(),
          transport: { send: async () => {} },
        }),
    ).toThrow('not approved');

    let calls = 0;
    const exporter = new GovernedMetricExporter({
      endpointAlias: 'kite-operations-v1',
      approvedEndpointAliases: new Set(['kite-operations-v1']),
      maximumBatchSamples: 1,
      maximumPayloadBytes: 1,
      transport: {
        send: async () => {
          calls += 1;
        },
      },
    });
    await expect(exporter.export([sample, sample])).rejects.toThrow('sample bound');
    await expect(exporter.export([sample])).rejects.toThrow('byte bound');
    expect(calls).toBe(0);
  });

  test('shutdown is idempotent and prevents later export', async () => {
    let shutdowns = 0;
    const exporter = new GovernedMetricExporter({
      endpointAlias: 'kite-operations-v1',
      approvedEndpointAliases: new Set(['kite-operations-v1']),
      transport: {
        send: async () => {},
        shutdown: async () => {
          shutdowns += 1;
        },
      },
    });
    await exporter.shutdown();
    await exporter.shutdown();
    expect(shutdowns).toBe(1);
    await expect(exporter.export([sample])).rejects.toThrow('shut down');
  });
});
