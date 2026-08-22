import { createHash } from 'node:crypto';
import type { RuntimePersistedAuthorityCodecV1 } from './storage';

type PersistedAuthoritySealInputV1 = Parameters<RuntimePersistedAuthorityCodecV1['seal']>[0];
type PersistedAuthorityVerifyInputV1 = Parameters<RuntimePersistedAuthorityCodecV1['verify']>[0];

const PERSISTED_RECORD_SCHEMA_V1 = 'kite.runtime-persisted-record.v1' as const;

interface PersistedIntegrityRecordV1 {
  readonly schema: typeof PERSISTED_RECORD_SCHEMA_V1;
  readonly kind: string;
  readonly domain: string;
  readonly issuer: string;
  readonly identityDigest: `sha256:${string}`;
  readonly payload: string;
  readonly integrityDigest: `sha256:${string}`;
}

/**
 * Keyless Store record integrity codec. This is a strict corruption and
 * identity-mixup guard; it deliberately makes no cryptographic authenticity
 * claim against a same-user writer that can recompute the digest.
 */
export function createRuntimePersistedAuthorityCodecV1(input: {
  readonly issuer: string;
}): RuntimePersistedAuthorityCodecV1 {
  if (!input.issuer) throw new Error('Persisted record issuer is required.');
  return Object.freeze({
    seal(record: PersistedAuthoritySealInputV1) {
      const identityDigest = digestIdentity(record.domain, record.identity);
      const unsigned = {
        schema: PERSISTED_RECORD_SCHEMA_V1,
        kind: record.kind,
        domain: record.domain,
        issuer: input.issuer,
        identityDigest,
        payload: record.payload,
      };
      return JSON.stringify({
        ...unsigned,
        integrityDigest: digestIntegrity(unsigned),
      } satisfies PersistedIntegrityRecordV1);
    },
    verify(record: PersistedAuthorityVerifyInputV1) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(record.serialized);
      } catch (error) {
        throw new Error('Persisted record is not JSON.', { cause: error });
      }
      if (JSON.stringify(parsed) !== record.serialized) {
        throw new Error('Persisted record is not in its exact serialized form.');
      }
      const sealed = parsePersistedIntegrityRecordV1(parsed);
      const unsigned = {
        schema: sealed.schema,
        kind: sealed.kind,
        domain: sealed.domain,
        issuer: sealed.issuer,
        identityDigest: sealed.identityDigest,
        payload: sealed.payload,
      };
      if (
        sealed.kind !== record.kind ||
        sealed.domain !== record.domain ||
        sealed.issuer !== input.issuer ||
        sealed.identityDigest !== digestIdentity(record.domain, record.identity) ||
        sealed.integrityDigest !== digestIntegrity(unsigned)
      ) {
        throw new Error('Persisted record integrity or identity mismatch.');
      }
      return sealed.payload;
    },
  });
}

function parsePersistedIntegrityRecordV1(value: unknown): PersistedIntegrityRecordV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRecord();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join('\0') !==
    ['domain', 'identityDigest', 'integrityDigest', 'issuer', 'kind', 'payload', 'schema'].join(
      '\0',
    )
  ) {
    invalidRecord();
  }
  if (
    record.schema !== PERSISTED_RECORD_SCHEMA_V1 ||
    typeof record.kind !== 'string' ||
    !record.kind ||
    typeof record.domain !== 'string' ||
    !record.domain ||
    typeof record.issuer !== 'string' ||
    !record.issuer ||
    typeof record.identityDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.identityDigest) ||
    typeof record.payload !== 'string' ||
    typeof record.integrityDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.integrityDigest)
  ) {
    invalidRecord();
  }
  return record as unknown as PersistedIntegrityRecordV1;
}

function digestIdentity(domain: string, identity: string): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update('kite-runtime-persisted-identity-v1\0')
    .update(domain)
    .update('\0')
    .update(identity)
    .digest('hex')}`;
}

function digestIntegrity(value: object): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update('kite-runtime-persisted-integrity-v1\0')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

function invalidRecord(): never {
  throw new Error('Persisted record has an invalid shape.');
}
