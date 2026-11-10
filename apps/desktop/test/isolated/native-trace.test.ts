import { expect, test } from 'bun:test';
import { decodeNativeRequest } from '../../electron/native-ipc';
import { decodeNativeTraceOperation } from '../../electron/trace-extensions';

test('Trace management IPC permits only named operations and generated closed consent bodies', () => {
  const id = 'c0bdcb12-b7bb-48fe-891b-4398a94af713';
  expect(
    decodeNativeRequest({ method: 'trace.manage', generation: 1, operation: { kind: 'list' } }),
  ).toEqual({ method: 'trace.manage', generation: 1, operation: { kind: 'list' } });
  expect(
    decodeNativeTraceOperation({
      kind: 'installOpenTelemetry',
      input: { endpoint: 'https://collector.example/v1/traces', sampleRate: 1 },
    }),
  ).toMatchObject({ kind: 'installOpenTelemetry' });
  expect(
    decodeNativeTraceOperation({
      kind: 'grant',
      installationId: id,
      input: {
        scopes: [{ storeId: 'store', sessionId: 's' }],
        eventKinds: ['run'],
        metadata: [],
        evidenceKinds: [],
        origins: [],
        originalIdentity: false,
        allowHistory: false,
      },
    }),
  ).toMatchObject({ kind: 'grant' });
  for (const value of [
    { kind: 'request', path: '/business/mutate' },
    { kind: 'list', subjectId: 'foreign' },
    {
      kind: 'installOpenTelemetry',
      input: {
        endpoint: 'https://collector.example/v1/traces',
        sampleRate: 1,
        credentialHandle: id,
      },
    },
    {
      kind: 'grant',
      installationId: id,
      input: {
        scopes: [{ storeId: 'store', sessionId: 's' }],
        eventKinds: ['run'],
        metadata: [],
        evidenceKinds: [],
        origins: [],
        originalIdentity: false,
        allowHistory: false,
        fullMode: true,
      },
    },
    {
      kind: 'bindCredential',
      installationId: id,
      input: { origin: 'https://collector.example', secret: 'synthetic', resolve: true },
    },
    { kind: 'resume', installationId: id, partitionId: '', upperCursor: '9223372036854775807' },
  ])
    expect(() => decodeNativeTraceOperation(value)).toThrow();
  expect(() =>
    decodeNativeRequest({ method: 'trace.manage', generation: 0, operation: { kind: 'list' } }),
  ).toThrow('invalid_native_request');
});
