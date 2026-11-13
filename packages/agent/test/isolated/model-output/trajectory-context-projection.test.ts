import { expect, test } from '#kite-test';
import type { CompressionRecord, Json } from '../../../src/storage/types';
import { contextEvidence } from '../../../src/trajectory/evidence-projection';

const record = (publishedSeq = '9007199254740995'): CompressionRecord => ({
  id: 'compression-original',
  originSessionId: 'original-session',
  originCompressionId: 'original-compression',
  sessionId: 'session',
  contextSelectionId: 'selection',
  originStoreId: 'PRIVATE_STORE',
  modelExecutionId: 'PRIVATE_MODEL',
  runId: 'PRIVATE_RUN',
  coveredThroughSeq: '9007199254740993',
  publishedSeq,
  previousCompressionId: 'PRIVATE_PREVIOUS',
  compressor: { id: 'PRIVATE_COMPRESSOR', version: '1', snapshot: { secret: 'PRIVATE_SNAPSHOT' } },
  trigger: 'automatic',
});

test('real saved CompressionRecord shape exposes exact boundaries without copying private request fields', () => {
  const saved = {
    snapshotId: 'snapshot',
    kind: 'compression',
    selectionId: 'selection',
    request: record(),
    sources: [{ permissions: 'PRIVATE_SOURCE' }],
    permissions: 'PRIVATE_PERMISSION',
  };
  const before = structuredClone(saved);
  const projected = contextEvidence(saved as unknown as Json);
  expect(projected).toEqual({
    snapshotId: 'snapshot',
    kind: 'compression',
    selectionId: 'selection',
    selection: { id: 'compression-original', sessionId: 'session' },
    compression: { coveredThroughSeq: '9007199254740993', publishedSeq: '9007199254740995' },
  });
  expect(JSON.stringify(projected)).not.toContain('PRIVATE');
  expect(projected).not.toHaveProperty('request');
  expect(projected).not.toHaveProperty('compressor');
  expect(saved).toEqual(before);
});

test('pending compression retains original zero publication sentinel instead of inferring a published message', () => {
  expect(
    contextEvidence({ kind: 'compression_pending', request: record('0') } as unknown as Json),
  ).toMatchObject({
    kind: 'compression_pending',
    compression: { coveredThroughSeq: '9007199254740993', publishedSeq: '0' },
  });
  expect(contextEvidence({ kind: 'compression', request: {} })).toEqual({
    kind: 'compression',
    selection: {},
  });
});

test('compression boundary projection requires an exact saved kind and each valid Decimal64 string', () => {
  for (const kind of ['selection', 'compression_reset', 'future_compression'])
    expect(
      contextEvidence({ kind, request: { coveredThroughSeq: '12', publishedSeq: '13' } }),
    ).not.toHaveProperty('compression');
  for (const value of [null, 0, 12, false, '', '-1', '01', '1.0', '9223372036854775808']) {
    expect(
      contextEvidence({
        kind: 'compression',
        request: { coveredThroughSeq: value, publishedSeq: value },
      }),
    ).not.toHaveProperty('compression');
    expect(
      contextEvidence({
        kind: 'compression_pending',
        request: { coveredThroughSeq: '9223372036854775807', publishedSeq: value },
      }),
    ).toMatchObject({ compression: { coveredThroughSeq: '9223372036854775807' } });
  }
  expect(contextEvidence({ kind: 'compression', request: { publishedSeq: '0' } })).toMatchObject({
    compression: { publishedSeq: '0' },
  });
});

test('original selection boundaries and ranges remain compatible without inferred compression ranges', () => {
  expect(
    contextEvidence({
      snapshotId: 'snapshot',
      kind: 'selection',
      selectionId: 'selection',
      request: {
        id: 'selection',
        sessionId: 'session',
        previousSelectionId: 'previous',
        boundaryMessageId: 'message',
        boundarySeq: '50',
        tailFromSeq: '31',
        ranges: [{ afterSeq: '10', throughSeq: '30', privateProof: 'PRIVATE' }],
        permissions: 'PRIVATE',
      },
    }),
  ).toEqual({
    snapshotId: 'snapshot',
    kind: 'selection',
    selectionId: 'selection',
    selection: {
      id: 'selection',
      sessionId: 'session',
      previousSelectionId: 'previous',
      boundaryMessageId: 'message',
      boundarySeq: '50',
      tailFromSeq: '31',
      ranges: [{ afterSeq: '10', throughSeq: '30' }],
    },
  });
});
