/** RAV1-02 persisted and out-of-process authenticity contracts. */
export const AUTHORITY_ENVELOPE_SCHEMA_V1 = 'kite.runtime-authority-envelope.v1' as const;
export const AUTHORITY_FRAME_SCHEMA_V1 = 'kite.runtime-authority-frame.v1' as const;
export type AuthorityEnvelopeKindV1 =
  | 'grant'
  | 'receipt'
  | 'effect'
  | 'event'
  | 'snapshot'
  | 'origin';
export interface AuthorityEnvelopeUnsignedV1<T = unknown> {
  readonly schema: typeof AUTHORITY_ENVELOPE_SCHEMA_V1;
  readonly kind: AuthorityEnvelopeKindV1;
  readonly domain: string;
  readonly issuer: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly payload: T;
}
export interface AuthorityEnvelopeV1<T = unknown> extends AuthorityEnvelopeUnsignedV1<T> {
  readonly authenticator: `hmac-sha256:${string}`;
}
export interface AuthorityFrameUnsignedV1<T = unknown> {
  readonly schema: typeof AUTHORITY_FRAME_SCHEMA_V1;
  readonly domain: string;
  readonly peerId: string;
  readonly invocationId: string;
  readonly sequence: number;
  readonly payload: T;
}
export interface AuthorityFrameV1<T = unknown> extends AuthorityFrameUnsignedV1<T> {
  readonly authenticator: `hmac-sha256:${string}`;
}
export function isAuthorityFrameV1(value: unknown): value is AuthorityFrameV1<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  const keys = Object.keys(frame).sort();
  const expected = [
    'authenticator',
    'domain',
    'invocationId',
    'payload',
    'peerId',
    'schema',
    'sequence',
  ].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    frame.schema === AUTHORITY_FRAME_SCHEMA_V1 &&
    typeof frame.domain === 'string' &&
    frame.domain.length > 0 &&
    typeof frame.peerId === 'string' &&
    frame.peerId.length > 0 &&
    typeof frame.invocationId === 'string' &&
    frame.invocationId.length > 0 &&
    typeof frame.sequence === 'number' &&
    Number.isSafeInteger(frame.sequence) &&
    frame.sequence >= 0 &&
    typeof frame.authenticator === 'string' &&
    /^hmac-sha256:[0-9a-f]{64}$/u.test(frame.authenticator) &&
    Object.hasOwn(frame, 'payload')
  );
}
export function canonicalAuthorityJson(value: unknown): string {
  return JSON.stringify(sort(value));
}
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sort(v)]),
    );
  if (typeof value === 'undefined' || typeof value === 'bigint' || typeof value === 'function')
    throw new Error('Authority payload is not canonical JSON.');
  return value;
}
