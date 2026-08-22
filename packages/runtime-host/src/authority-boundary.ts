import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  AUTHORITY_ENVELOPE_SCHEMA_V1,
  AUTHORITY_FRAME_SCHEMA_V1,
  type AuthorityEnvelopeUnsignedV1,
  type AuthorityEnvelopeV1,
  type AuthorityFrameUnsignedV1,
  type AuthorityFrameV1,
  canonicalAuthorityJson,
} from '@kite/runtime-spi';

export interface AuthorityKeyV1 {
  readonly keyId: string;
  readonly key: Uint8Array;
}
export interface AuthorityRevocationV1 {
  readonly issuer: string;
  readonly nonce: string;
  readonly revision: number;
}

/**
 * Derives an invocation-scoped frame key from installation custody. The
 * installation key never crosses the process boundary; only this derived key
 * is eligible for the short-lived supervisor bootstrap.
 */
export function deriveAuthorityFrameKeyV1(input: {
  installationKey: AuthorityKeyV1;
  domain: string;
  invocationId: string;
  supervisorNonce: string;
}): AuthorityKeyV1 {
  assertKey(input.installationKey);
  const key = createHmac('sha256', input.installationKey.key)
    .update('kite-runtime-authority-v1:frame-key\0')
    .update(input.domain)
    .update('\0')
    .update(input.invocationId)
    .update('\0')
    .update(input.supervisorNonce)
    .digest();
  const keyId = `sha256:${createHash('sha256').update(key).digest('hex')}`;
  return Object.freeze({ keyId, key });
}

export function sealAuthorityEnvelopeV1<T>(
  input: AuthorityEnvelopeUnsignedV1<T> & { key: AuthorityKeyV1 },
): AuthorityEnvelopeV1<T> {
  assertKey(input.key);
  const { key, ...unsigned } = input;
  if (unsigned.keyId !== key.keyId) throw new Error('Authority key identity mismatch.');
  return Object.freeze({ ...unsigned, authenticator: mac(unsigned, key.key, 'envelope') });
}
export function verifyAuthorityEnvelopeV1<T>(input: {
  envelope: AuthorityEnvelopeV1<T>;
  key: AuthorityKeyV1;
  expectedDomain: string;
  expectedIssuer: string;
  now?: Date;
  revoked?: AuthorityRevocationV1;
}): T {
  const { envelope, key, now = new Date(), revoked } = input;
  assertKey(key);
  if (
    !hasExactEnvelopeShape(envelope) ||
    envelope.domain !== input.expectedDomain ||
    envelope.issuer !== input.expectedIssuer ||
    envelope.keyId !== key.keyId
  )
    throw new Error('Authority envelope identity mismatch.');
  if (
    revoked &&
    revoked.issuer === envelope.issuer &&
    revoked.nonce === envelope.nonce &&
    revoked.revision > 0
  )
    throw new Error('Authority envelope revoked.');
  const issuedAt = Date.parse(envelope.issuedAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt)
    throw new Error('Authority envelope timestamp is invalid.');
  if (expiresAt <= now.getTime()) throw new Error('Authority envelope expired.');
  verifyMac(envelope, key.key, 'envelope');
  return envelope.payload;
}
export function sealAuthorityFrameV1<T>(
  input: AuthorityFrameUnsignedV1<T> & { key: AuthorityKeyV1 },
): AuthorityFrameV1<T> {
  assertKey(input.key);
  const { key, ...unsigned } = input;
  return Object.freeze({ ...unsigned, authenticator: mac(unsigned, key.key, 'frame') });
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
  )
    throw new Error('Authority frame identity mismatch.');
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0)
    throw new Error('Authority frame sequence is invalid.');
  if (frame.sequence <= (input.lastSequence ?? -1))
    throw new Error('Authority frame replay detected.');
  verifyMac(frame, key.key, 'frame');
  return frame.payload;
}
export class AuthorityNonceRegistryV1 {
  readonly #claimed = new Set<string>();
  readonly #revoked = new Map<string, AuthorityRevocationV1>();
  claim(issuer: string, nonce: string): void {
    const id = `${issuer}\0${nonce}`;
    if (this.#claimed.has(id)) throw new Error('Authority nonce already consumed.');
    this.#claimed.add(id);
  }
  revoke(input: AuthorityRevocationV1): void {
    this.#revoked.set(`${input.issuer}\0${input.nonce}`, input);
  }
  revocation(issuer: string, nonce: string): AuthorityRevocationV1 | undefined {
    return this.#revoked.get(`${issuer}\0${nonce}`);
  }
}
function assertKey(key: AuthorityKeyV1): void {
  if (!key.keyId || key.key.length < 32)
    throw new Error('Authority key must be at least 256 bits.');
}
function mac(
  value: unknown,
  key: Uint8Array,
  domain: 'envelope' | 'frame',
): `hmac-sha256:${string}` {
  return `hmac-sha256:${createHmac('sha256', key).update(`kite-runtime-authority-v1:${domain}\0`).update(canonicalAuthorityJson(value)).digest('hex')}`;
}
function verifyMac(
  value: { readonly authenticator: string },
  key: Uint8Array,
  domain: 'envelope' | 'frame',
): void {
  if (!/^hmac-sha256:[0-9a-f]{64}$/u.test(value.authenticator)) {
    throw new Error('Authority authenticator format is invalid.');
  }
  const actual = Buffer.from(value.authenticator.slice('hmac-sha256:'.length), 'hex');
  const unsigned = Object.fromEntries(
    Object.entries(value).filter(([name]) => name !== 'authenticator'),
  );
  const expected = Buffer.from(mac(unsigned, key, domain).slice('hmac-sha256:'.length), 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('Authority authenticator mismatch.');
}
function hasExactEnvelopeShape(value: AuthorityEnvelopeV1): boolean {
  return (
    value.schema === AUTHORITY_ENVELOPE_SCHEMA_V1 &&
    exactKeys(value, [
      'authenticator',
      'domain',
      'expiresAt',
      'issuedAt',
      'issuer',
      'keyId',
      'kind',
      'nonce',
      'payload',
      'schema',
    ])
  );
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
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}
