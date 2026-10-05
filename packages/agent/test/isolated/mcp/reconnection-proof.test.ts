import { expect, test } from 'bun:test';
import { decimal64, decodeReconnectionInput } from '../../../src/mcp/reconnection-proof';

const original = () => ({
  serverId: 'local',
  key: 'new',
  target: {
    carrierExecutionId: 'warm_b',
    carrierKey: 'b',
    operationRef: {
      commandId: 'original',
      sessionId: 's',
      originStoreId: 'store',
      extensionId: 'builtin.mcp' as const,
      key: 'connection/local/a',
      executionId: 'job_a',
    },
    connectionExecutionId: 'job_a',
    configDigest: 'a'.repeat(64),
    currentGeneration: 1,
  },
  replacement: {
    kind: 'source' as const,
    expectedConfigDigest: 'b'.repeat(64),
    expectedReadSet: {
      scopeDigest: 'c'.repeat(64),
      user: {
        identity: {
          kind: 'user' as const,
          pathDigest: 'd'.repeat(64),
          rootIdentity: 'physical-user',
        },
        etag: null,
        error: 'bounded only by the whole request'.repeat(2048),
      },
      workspace: null,
      approvalEtag: null,
      bindingEtag: null,
      variablesDigest: 'e'.repeat(64),
    },
  },
});

test('warm carrier key and underlying operation key are distinct; complete read-set error remains unchanged', () => {
  const input = original();
  const decoded = decodeReconnectionInput(input);
  expect(decoded.target.carrierKey).toBe('b');
  expect(decoded.target.operationRef.key).toBe('connection/local/a');
  expect(decoded).toEqual(input);
  input.target.configDigest = 'f'.repeat(64);
  expect(decoded.target.configDigest).toBe('a'.repeat(64));
});
test('closed original observations reject injected authority, child ref, wrong identity and non-safe generation', () => {
  const cases: unknown[] = [
    { ...original(), permit: 'injected' },
    { ...original(), target: { ...original().target, recordRevision: '2' } },
    {
      ...original(),
      target: {
        ...original().target,
        operationRef: { ...original().target.operationRef, childSessionId: 'child' },
      },
    },
    { ...original(), target: { ...original().target, connectionExecutionId: 'other' } },
    {
      ...original(),
      target: { ...original().target, currentGeneration: Number.MAX_SAFE_INTEGER + 1 },
    },
    {
      ...original(),
      replacement: {
        ...original().replacement,
        expectedReadSet: {
          ...original().replacement.expectedReadSet,
          user: {
            ...original().replacement.expectedReadSet.user,
            identity: {
              ...original().replacement.expectedReadSet.user.identity,
              kind: 'workspace',
            },
          },
        },
      },
    },
    { ...original(), replacement: { ...original().replacement, kind: ['source'] } },
    {
      ...original(),
      replacement: {
        kind: 'static',
        expectedConfigDigest: 'a'.repeat(64),
        transport: { type: 'http' },
      },
    },
  ];
  for (const input of cases) expect(() => decodeReconnectionInput(input)).toThrow();
});
test('actual result revisions allow canonical zero and Decimal64 max, reject aliases and overflow', () => {
  expect(decimal64('0')).toBe(true);
  expect(decimal64('9223372036854775807')).toBe(true);
  for (const value of ['00', '01', '-1', '1.0', '9223372036854775808', 1, ['1'], null])
    expect(decimal64(value)).toBe(false);
});
