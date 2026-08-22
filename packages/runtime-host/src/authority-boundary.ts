import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AUTHORITY_FRAME_SCHEMA_V1,
  type AuthorityFrameUnsignedV1,
  type AuthorityFrameV1,
  canonicalAuthorityJson,
} from '@kite/runtime-spi';

/** Short-lived material for one real child-process frame boundary. */
export interface AuthorityKeyV1 {
  readonly keyId: string;
  readonly key: Uint8Array;
}

export function sealAuthorityFrameV1<T>(
  input: AuthorityFrameUnsignedV1<T> & { key: AuthorityKeyV1 },
): AuthorityFrameV1<T> {
  assertKey(input.key);
  const { key, ...unsigned } = input;
  return Object.freeze({ ...unsigned, authenticator: mac(unsigned, key.key) });
}

export function verifyAuthorityFrameV1<T>(input: {
  frame: AuthorityFrameV1<T>;
  key: AuthorityKeyV1;
  expectedDomain: string;
  expectedPeerId: string;
  expectedInvocationId: string;
  lastSequence?: number;
}): T {
  const { frame, key } = input;
  assertKey(key);
  if (
    !hasExactFrameShape(frame) ||
    frame.domain !== input.expectedDomain ||
    frame.peerId !== input.expectedPeerId ||
    frame.invocationId !== input.expectedInvocationId
  ) {
    throw new Error('Authority frame identity mismatch.');
  }
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) {
    throw new Error('Authority frame sequence is invalid.');
  }
  if (frame.sequence <= (input.lastSequence ?? -1)) {
    throw new Error('Authority frame replay detected.');
  }
  verifyMac(frame, key.key);
  return frame.payload;
}

function assertKey(key: AuthorityKeyV1): void {
  if (!key.keyId || key.key.length < 32) {
    throw new Error('Authority frame material must be at least 256 bits.');
  }
}

function mac(value: unknown, key: Uint8Array): `hmac-sha256:${string}` {
  return `hmac-sha256:${createHmac('sha256', key)
    .update('kite-runtime-authority-v1:frame\0')
    .update(canonicalAuthorityJson(value))
    .digest('hex')}`;
}

function verifyMac(value: { readonly authenticator: string }, key: Uint8Array): void {
  if (!/^hmac-sha256:[0-9a-f]{64}$/u.test(value.authenticator)) {
    throw new Error('Authority authenticator format is invalid.');
  }
  const actual = Buffer.from(value.authenticator.slice('hmac-sha256:'.length), 'hex');
  const unsigned = Object.fromEntries(
    Object.entries(value).filter(([name]) => name !== 'authenticator'),
  );
  const expected = Buffer.from(mac(unsigned, key).slice('hmac-sha256:'.length), 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Authority authenticator mismatch.');
  }
}

function hasExactFrameShape(value: AuthorityFrameV1): boolean {
  return (
    value.schema === AUTHORITY_FRAME_SCHEMA_V1 &&
    exactKeys(value, [
      'authenticator',
      'domain',
      'invocationId',
      'peerId',
      'payload',
      'schema',
      'sequence',
    ])
  );
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
