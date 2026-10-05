import { ConfigurationError } from './types';
export interface CredentialReference {
  readonly id: string;
  readonly persistence: 'os' | 'temporary';
}
/** Host explicitly injects a reliable OS backend. Plain-file implementations are unsupported. */
export interface CredentialBackend {
  readonly kind: 'os' | 'temporary';
  put(id: string, secret: string): Promise<void>;
  resolve(id: string): Promise<string | null>;
  remove(id: string): Promise<void>;
}
export function createTemporaryCredentialBackend(): CredentialBackend {
  const values = new Map<string, string>();
  return {
    kind: 'temporary',
    async put(id, secret) {
      values.set(id, secret);
    },
    async resolve(id) {
      return values.get(id) ?? null;
    },
    async remove(id) {
      values.delete(id);
    },
  };
}
export function createCredentialVault(options: { backend?: CredentialBackend } = {}) {
  const revoked = new Set<string>();
  const backend = () => {
    if (!options.backend || !['os', 'temporary'].includes(options.backend.kind))
      throw new ConfigurationError('credential_unavailable');
    return options.backend;
  };
  const valid = (ref: CredentialReference) => {
    if (
      !/^credential:[0-9a-f-]{36}$/.test(ref.id) ||
      !['os', 'temporary'].includes(ref.persistence)
    )
      throw new ConfigurationError('credential_unavailable');
  };
  return {
    async put(secret: string): Promise<CredentialReference> {
      if (typeof secret !== 'string' || !secret || Buffer.byteLength(secret) > 65536)
        throw new ConfigurationError('invalid_credential');
      const selected = backend();
      const id = `credential:${crypto.randomUUID()}`;
      try {
        await selected.put(id, secret);
      } catch {
        throw new ConfigurationError('credential_unavailable');
      }
      return Object.freeze({ id, persistence: selected.kind });
    },
    async resolve(reference: CredentialReference | string): Promise<string> {
      const ref =
        typeof reference === 'string' ? { id: reference, persistence: backend().kind } : reference;
      valid(ref);
      if (revoked.has(ref.id)) throw new ConfigurationError('credential_revoked');
      const selected = backend();
      if (ref.persistence !== selected.kind) throw new ConfigurationError('credential_unavailable');
      let secret: string | null;
      try {
        secret = await selected.resolve(ref.id);
      } catch {
        throw new ConfigurationError('credential_unavailable');
      }
      if (revoked.has(ref.id)) throw new ConfigurationError('credential_revoked');
      if (typeof secret !== 'string' || !secret || Buffer.byteLength(secret) > 65536)
        throw new ConfigurationError('credential_unavailable');
      return secret;
    },
    async revoke(reference: CredentialReference | string): Promise<void> {
      const ref =
        typeof reference === 'string' ? { id: reference, persistence: backend().kind } : reference;
      valid(ref);
      revoked.add(ref.id); // Blocks new/in-flight lookups before backend deletion awaits.
      const selected = backend();
      if (selected.kind !== ref.persistence) throw new ConfigurationError('credential_unavailable');
      try {
        await selected.remove(ref.id);
      } catch {
        throw new ConfigurationError('credential_unavailable');
      }
    },
  };
}
