import { createHash } from 'node:crypto';
import { ConfigurationError } from './types';
export interface OwnedCredentialScope {
  readonly namespace: 'mcp.oauth';
  readonly ownerDigest: string;
}
export type OwnedCredentialStatus = 'available' | 'locked' | 'unavailable';
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
  status?(id: string): Promise<OwnedCredentialStatus>;
}
function ownedKey(scope: OwnedCredentialScope): string {
  if (
    !scope ||
    typeof scope !== 'object' ||
    Object.keys(scope).length !== 2 ||
    !Object.hasOwn(scope, 'namespace') ||
    !Object.hasOwn(scope, 'ownerDigest') ||
    scope.namespace !== 'mcp.oauth' ||
    typeof scope.ownerDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(scope.ownerDigest)
  )
    throw new ConfigurationError('credential_owned_scope_invalid');
  return `owned-credential:${createHash('sha256').update(`kite-owned-credential-v1\0${scope.namespace}\0${scope.ownerDigest}`).digest('hex')}`;
}
function ownedValue(value: string): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 65536 || !wellFormed(value))
    throw new ConfigurationError('credential_owned_material_invalid');
  return value;
}
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
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
  const selectedBackend = options.backend;
  const revoked = new Set<string>();
  const epochs = new Map<string, number>();
  const writes = new Map<string, Promise<void>>();
  const removedOwned = new Set<string>();
  const backend = () => {
    if (!selectedBackend || !['os', 'temporary'].includes(selectedBackend.kind))
      throw new ConfigurationError('credential_unavailable');
    return selectedBackend;
  };
  const valid = (ref: CredentialReference) => {
    if (
      !/^credential:[0-9a-f-]{36}$/.test(ref.id) ||
      !['os', 'temporary'].includes(ref.persistence)
    )
      throw new ConfigurationError('credential_unavailable');
  };
  const epoch = (key: string) => epochs.get(key) ?? 0;
  const checkEpoch = (key: string, observed: number) => {
    if (epoch(key) !== observed) throw new ConfigurationError('credential_owned_changed');
  };
  const mutateOwned = (key: string, operation: (selected: CredentialBackend) => Promise<void>) => {
    const observed = epoch(key) + 1;
    epochs.set(key, observed);
    const pending = (writes.get(key) ?? Promise.resolve()).then(async () => {
      checkEpoch(key, observed);
      try {
        await operation(backend());
      } catch {
        throw new ConfigurationError('credential_unavailable');
      }
      checkEpoch(key, observed);
    });
    const tail = pending.catch(() => {});
    writes.set(key, tail);
    void tail.then(() => {
      if (writes.get(key) === tail) writes.delete(key);
    });
    return pending;
  };
  return {
    async readOwned(scope: OwnedCredentialScope): Promise<string | null> {
      const key = ownedKey(scope),
        observed = epoch(key);
      await writes.get(key);
      checkEpoch(key, observed);
      if (removedOwned.has(key)) return null;
      let value: string | null;
      try {
        value = await backend().resolve(key);
      } catch {
        throw new ConfigurationError('credential_unavailable');
      }
      checkEpoch(key, observed);
      return value === null ? null : ownedValue(value);
    },
    async writeOwned(scope: OwnedCredentialScope, value: string): Promise<void> {
      const key = ownedKey(scope),
        captured = ownedValue(value);
      const observed = epoch(key) + 1;
      await mutateOwned(key, (selected) => selected.put(key, captured));
      checkEpoch(key, observed);
      removedOwned.delete(key);
    },
    async removeOwned(scope: OwnedCredentialScope): Promise<void> {
      const key = ownedKey(scope);
      removedOwned.add(key); // Blocks this authority before deletion; failed OS deletion is not success.
      await mutateOwned(key, (selected) => selected.remove(key));
    },
    async statusOwned(scope: OwnedCredentialScope): Promise<OwnedCredentialStatus> {
      const key = ownedKey(scope),
        observed = epoch(key);
      try {
        const selected = backend();
        let status: OwnedCredentialStatus = 'available';
        if (selected.status) status = await selected.status(key);
        else await selected.resolve(key);
        checkEpoch(key, observed);
        return ['available', 'locked', 'unavailable'].includes(status) ? status : 'unavailable';
      } catch {
        return 'unavailable';
      }
    },
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
