import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { type TraceEventBatch, validateDeliveryResult } from '@kite-ai/trajectory';
import { expect, test } from '#kite-test';
import { buildTraceBundle } from '../src/bundle';

test('public template builds one restricted IIFE and explicitly returns the exact batch lease ACK', async () => {
  const bundle = await buildTraceBundle(
    fileURLToPath(new URL('../examples/metadata.ts', import.meta.url)),
  );
  expect(bundle.sha256).toBe(createHash('sha256').update(bundle.source).digest('hex'));
  expect(bundle.source).not.toContain('node:');
  expect(bundle.source).not.toContain('@kite-ai/agent');
  const calls: { method: string; input: unknown }[] = [];
  let registered:
    | {
        initialize(input: { installationId: string; apiVersion: 1 }): Promise<void>;
        onEvents(batch: TraceEventBatch): Promise<unknown>;
      }
    | undefined;
  runInNewContext(bundle.source, {
    defineTraceExtension(value: NonNullable<typeof registered>) {
      registered = value;
    },
    trace: {
      async request(method: string, input: unknown) {
        calls.push({ method, input });
        return null;
      },
    },
  });
  const batch: TraceEventBatch = {
    source: 'live',
    batchId: 'b',
    leaseToken: 'l',
    processGeneration: '7',
    partition: {
      installationId: 'installation',
      storeRef: 'store',
      sessionRef: 'session',
      subscriptionEpoch: '2',
      lane: { kind: 'live' },
    },
    grantRevision: '3',
    filterRevision: '3',
    upperCursor: '9007199254740993',
    fromCursor: '0',
    scannedThrough: '9007199254740993',
    events: [],
    integrity: { facts: 'complete', identityConfidence: 'verified_origin', reasons: [] },
  };
  await registered!.initialize({ installationId: 'installation', apiVersion: 1 });
  const result = validateDeliveryResult(await registered!.onEvents(batch), batch);
  expect(result.processGeneration).toBe('7');
  expect(result.subscriptionEpoch).toBe('2');
  expect(result.acknowledgedEventIds).toEqual([]);
  expect(calls).toEqual([{ method: 'log.emit', input: { code: 'delivery_started' } }]);
});
