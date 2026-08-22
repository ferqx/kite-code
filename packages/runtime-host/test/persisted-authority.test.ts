import { expect, test } from 'bun:test';
import { createRuntimePersistedAuthorityCodecV1 } from '../src/persisted-authority';

const key = { keyId: 'key-current', key: new Uint8Array(32).fill(4) };

test('Store authority codec binds kind/domain/row identity and supports explicit prior-key verification', () => {
  const codec = createRuntimePersistedAuthorityCodecV1({ issuer: 'runtime-host', currentKey: key });
  const serialized = codec.seal({
    kind: 'event',
    domain: 'runtime-event-v1',
    identity: 'session-1/event-1',
    payload: '{"type":"event"}',
  });
  expect(
    codec.verify({
      kind: 'event',
      domain: 'runtime-event-v1',
      identity: 'session-1/event-1',
      serialized: JSON.parse(JSON.stringify(serialized)),
    }),
  ).toBe('{"type":"event"}');
  expect(() =>
    codec.verify({
      kind: 'event',
      domain: 'runtime-event-v1',
      identity: 'session-2/event-1',
      serialized,
    }),
  ).toThrow('identity');
  const envelope = JSON.parse(serialized) as Record<string, unknown>;
  expect(() =>
    codec.verify({
      kind: 'event',
      domain: 'runtime-event-v1',
      identity: 'session-1/event-1',
      serialized: JSON.stringify({ ...envelope, payload: '{"type":"forged"}' }),
    }),
  ).toThrow('authenticator');
  expect(() =>
    codec.verify({
      kind: 'event',
      domain: 'runtime-event-v1',
      identity: 'session-1/event-1',
      serialized: serialized.replace('{', '{"payload":"duplicate-forgery",'),
    }),
  ).toThrow('exact serialized form');
  expect(() =>
    codec.verify({
      kind: 'event',
      domain: 'runtime-event-v1',
      identity: 'session-1/event-1',
      serialized: `${serialized} `,
    }),
  ).toThrow('exact serialized form');
  expect(() =>
    codec.verify({
      kind: 'event',
      domain: 'wrong-domain-v1',
      identity: 'session-1/event-1',
      serialized,
    }),
  ).toThrow('identity mismatch');
  expect(() =>
    createRuntimePersistedAuthorityCodecV1({
      issuer: 'runtime-host',
      currentKey: { keyId: 'lost-key', key: new Uint8Array(32).fill(9) },
    }).verify({
      kind: 'event',
      domain: 'runtime-event-v1',
      identity: 'session-1/event-1',
      serialized,
    }),
  ).toThrow('key is unavailable');
});
