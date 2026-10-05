import type { CredentialBackend } from './credentials';
import { ConfigurationError } from './types';
export interface NativeCredentialEntry {
  setPassword(secret: string): Promise<void>;
  getPassword(): Promise<string | undefined | null>;
  deleteCredential(): Promise<boolean>;
}
export type NativeCredentialFactory = (
  service: string,
  account: string,
) => NativeCredentialEntry | Promise<NativeCredentialEntry>;
/** Native dependency and entry creation are delayed until an explicit credential operation. */
export function createOsCredentialBackend(options: {
  service: string;
  accountNamespace: string;
  nativeFactory?: NativeCredentialFactory;
}): CredentialBackend {
  for (const namespace of [options.service, options.accountNamespace])
    if (typeof namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(namespace))
      throw new ConfigurationError('invalid_credential_namespace');
  const factory: NativeCredentialFactory =
    options.nativeFactory ??
    (async (service, account) => {
      const { AsyncEntry } = await import('@napi-rs/keyring');
      return new AsyncEntry(service, account);
    });
  const rawEntry = async (id: string) => {
    if (!/^credential:[0-9a-f-]{36}$/.test(id) && !/^owned-credential:[a-f0-9]{64}$/.test(id))
      throw new ConfigurationError('credential_unavailable');
    return factory(options.service, `${options.accountNamespace}/${id}`);
  };
  const entry = async (id: string) => {
    try {
      return await rawEntry(id);
    } catch {
      throw new ConfigurationError('credential_unavailable');
    }
  };
  return {
    kind: 'os',
    async status(id) {
      // Read-only availability probe of the same account; never writes probe material.
      try {
        await (await rawEntry(id)).getPassword();
        return 'available';
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
        return code === 'locked' ||
          code === 'LOCKED' ||
          code === 'EACCES' ||
          code === 'EPERM' ||
          code === -25308
          ? 'locked'
          : 'unavailable';
      }
    },
    async put(id, secret) {
      try {
        await (await entry(id)).setPassword(secret);
      } catch {
        throw new ConfigurationError('credential_unavailable');
      }
    },
    async resolve(id) {
      try {
        return (await (await entry(id)).getPassword()) ?? null;
      } catch {
        throw new ConfigurationError('credential_unavailable');
      }
    },
    async remove(id) {
      try {
        const target = await entry(id);
        if (!(await target.deleteCredential()) && (await target.getPassword()) != null)
          throw new ConfigurationError('credential_unavailable');
      } catch {
        throw new ConfigurationError('credential_unavailable');
      }
    },
  };
}
