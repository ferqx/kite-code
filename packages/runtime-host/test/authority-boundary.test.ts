import { describe, expect, test } from 'bun:test';
import {
  AuthorityNonceRegistryV1,
  deriveAuthorityFrameKeyV1,
  sealAuthorityEnvelopeV1,
  sealAuthorityFrameV1,
  verifyAuthorityEnvelopeV1,
  verifyAuthorityFrameV1,
} from '../src/authority-boundary';
import {
  createPosixAuthorityKeyPipeV1,
  readPosixAuthorityFrameKeyV1,
} from '../src/authority-key-bootstrap';

const key = { keyId: 'installation:1', key: new Uint8Array(32).fill(9) };
describe('RAV1-02 authority boundary', () => {
  test('authenticates persisted grant and rejects tamper, wrong domain and revoke', () => {
    const envelope = sealAuthorityEnvelopeV1({
      schema: 'kite.runtime-authority-envelope.v1',
      kind: 'grant',
      domain: 'grant-v1',
      issuer: 'host',
      keyId: key.keyId,
      nonce: 'n1',
      issuedAt: '2026-08-22T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      payload: { grantId: 'g1' },
      key,
    });
    expect(
      verifyAuthorityEnvelopeV1({
        envelope,
        key,
        expectedDomain: 'grant-v1',
        expectedIssuer: 'host',
      }),
    ).toEqual({ grantId: 'g1' });
    expect(() =>
      verifyAuthorityEnvelopeV1({
        envelope: { ...envelope, payload: { grantId: 'evil' } },
        key,
        expectedDomain: 'grant-v1',
        expectedIssuer: 'host',
      }),
    ).toThrow('authenticator');
    expect(() =>
      verifyAuthorityEnvelopeV1({ envelope, key, expectedDomain: 'other', expectedIssuer: 'host' }),
    ).toThrow('identity');
    const registry = new AuthorityNonceRegistryV1();
    registry.revoke({ issuer: 'host', nonce: 'n1', revision: 1 });
    expect(() =>
      verifyAuthorityEnvelopeV1({
        envelope,
        key,
        expectedDomain: 'grant-v1',
        expectedIssuer: 'host',
        revoked: registry.revocation('host', 'n1'),
      }),
    ).toThrow('revoked');
    const expired = sealAuthorityEnvelopeV1({
      ...envelope,
      issuedAt: '2020-01-01T00:00:00Z',
      expiresAt: '2020-01-02T00:00:00Z',
      key,
    });
    expect(() =>
      verifyAuthorityEnvelopeV1({
        envelope: expired,
        key,
        expectedDomain: 'grant-v1',
        expectedIssuer: 'host',
      }),
    ).toThrow('expired');
    const malformedTime = sealAuthorityEnvelopeV1({
      ...envelope,
      issuedAt: 'not-a-time',
      key,
    });
    expect(() =>
      verifyAuthorityEnvelopeV1({
        envelope: malformedTime,
        key,
        expectedDomain: 'grant-v1',
        expectedIssuer: 'host',
      }),
    ).toThrow('timestamp');
  });
  test('authenticates child frames and rejects replay/cross-invocation', () => {
    const frame = sealAuthorityFrameV1({
      schema: 'kite.runtime-authority-frame.v1',
      domain: 'sandbox-posix-v1',
      peerId: 'child:1',
      invocationId: 'i1',
      sequence: 1,
      payload: { status: 'attempted' },
      key,
    });
    expect(
      verifyAuthorityFrameV1({
        frame,
        key,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
      }),
    ).toEqual({ status: 'attempted' });
    expect(() =>
      verifyAuthorityFrameV1({
        frame,
        key,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
        lastSequence: 1,
      }),
    ).toThrow('replay');
    expect(() =>
      verifyAuthorityFrameV1({
        frame,
        key,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i2',
      }),
    ).toThrow('identity');
    expect(() =>
      verifyAuthorityFrameV1({
        frame: { ...frame, payload: { status: 'attempted' }, extra: true } as typeof frame,
        key,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
      }),
    ).toThrow('identity');
    expect(() =>
      verifyAuthorityFrameV1({
        frame: { ...frame, sequence: 1.5 } as typeof frame,
        key,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
      }),
    ).toThrow('sequence');
  });
  test('round-trips serialized frames and derives distinct invocation keys', () => {
    const frame = sealAuthorityFrameV1({
      schema: 'kite.runtime-authority-frame.v1',
      domain: 'sandbox-posix-v1',
      peerId: 'child:1',
      invocationId: 'i1',
      sequence: 0,
      payload: { status: 'ready' },
      key,
    });
    expect(
      verifyAuthorityFrameV1<{ status: string }>({
        frame: JSON.parse(JSON.stringify(frame)) as typeof frame,
        key,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
      }),
    ).toEqual({ status: 'ready' });
    const first = deriveAuthorityFrameKeyV1({
      installationKey: key,
      domain: 'sandbox-posix-v1',
      invocationId: 'i1',
      supervisorNonce: 'n1',
    });
    const second = deriveAuthorityFrameKeyV1({
      installationKey: key,
      domain: 'sandbox-posix-v1',
      invocationId: 'i2',
      supervisorNonce: 'n1',
    });
    expect(Buffer.from(first.key)).not.toEqual(Buffer.from(key.key));
    expect(Buffer.from(first.key)).not.toEqual(Buffer.from(second.key));
    expect(first.keyId).not.toBe(second.keyId);
  });
  test.skipIf(process.platform === 'win32')(
    'transfers only the bounded binary FD key record',
    () => {
      const pipe = createPosixAuthorityKeyPipeV1();
      pipe.write(key);
      pipe.closeWrite();
      const transferred = readPosixAuthorityFrameKeyV1(pipe.readFd);
      expect(transferred?.keyId).toBe(key.keyId);
      expect(Buffer.from(transferred?.key ?? [])).toEqual(Buffer.from(key.key));
    },
  );
  test('claims a nonce once', () => {
    const registry = new AuthorityNonceRegistryV1();
    registry.claim('host', 'n');
    expect(() => registry.claim('host', 'n')).toThrow('consumed');
  });
});
