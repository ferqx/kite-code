import { createHash } from 'node:crypto';
import { AUTHORITY_ENVELOPE_SCHEMA_V1, type AuthorityEnvelopeV1 } from '@kite/runtime-spi';
import {
  type AuthorityKeyV1,
  sealAuthorityEnvelopeV1,
  verifyAuthorityEnvelopeV1,
} from './authority-boundary';
import type { RuntimePersistedAuthorityCodecV1 } from './storage';

type PersistedAuthoritySealInputV1 = Parameters<RuntimePersistedAuthorityCodecV1['seal']>[0];
type PersistedAuthorityVerifyInputV1 = Parameters<RuntimePersistedAuthorityCodecV1['verify']>[0];

const PERSISTED_EXPIRES_AT_V1 = '9999-12-31T23:59:59.999Z';

/**
 * Authenticated Store record codec. It is never used for trusted in-process
 * DTOs; App supplies installation custody and SQLite receives only this port.
 */
export function createRuntimePersistedAuthorityCodecV1(input: {
  readonly issuer: string;
  readonly currentKey: AuthorityKeyV1;
  readonly verificationKeys?: readonly AuthorityKeyV1[];
  readonly now?: () => Date;
}): RuntimePersistedAuthorityCodecV1 {
  if (!input.issuer) throw new Error('Persisted authority issuer is required.');
  const keys = new Map(
    [input.currentKey, ...(input.verificationKeys ?? [])].map((key) => [key.keyId, key]),
  );
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    seal(record: PersistedAuthoritySealInputV1) {
      const nonce = recordNonce(record.domain, record.identity, record.payload);
      return JSON.stringify(
        sealAuthorityEnvelopeV1({
          schema: AUTHORITY_ENVELOPE_SCHEMA_V1,
          kind: record.kind,
          domain: record.domain,
          issuer: input.issuer,
          keyId: input.currentKey.keyId,
          nonce,
          issuedAt: now().toISOString(),
          expiresAt: PERSISTED_EXPIRES_AT_V1,
          payload: record.payload,
          key: input.currentKey,
        }),
      );
    },
    verify(record: PersistedAuthorityVerifyInputV1) {
      let envelope: AuthorityEnvelopeV1<string>;
      try {
        envelope = JSON.parse(record.serialized) as AuthorityEnvelopeV1<string>;
      } catch (error) {
        throw new Error('Persisted authority envelope is not JSON.', { cause: error });
      }
      if (JSON.stringify(envelope) !== record.serialized) {
        throw new Error('Persisted authority envelope is not in its exact serialized form.');
      }
      const key = keys.get(envelope.keyId);
      if (!key) throw new Error('Persisted authority key is unavailable.');
      if (envelope.kind !== record.kind || typeof envelope.payload !== 'string') {
        throw new Error('Persisted authority envelope kind is invalid.');
      }
      const payload = verifyAuthorityEnvelopeV1({
        envelope,
        key,
        expectedDomain: record.domain,
        expectedIssuer: input.issuer,
        now: now(),
      });
      if (envelope.nonce !== recordNonce(record.domain, record.identity, payload)) {
        throw new Error('Persisted authority record identity mismatch.');
      }
      return payload;
    },
  });
}

function recordNonce(domain: string, identity: string, payload: string): string {
  return `sha256:${createHash('sha256')
    .update('kite-runtime-persisted-authority-v1\0')
    .update(domain)
    .update('\0')
    .update(identity)
    .update('\0')
    .update(payload)
    .digest('hex')}`;
}
