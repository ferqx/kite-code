import { ConfigurationError, createOsCredentialBackend } from '@kite-ai/agent/config';
import { createEncryptedModelCredentialBackend } from './encrypted-model-credentials';
import {
  createLinuxModelKeyring,
  readLinuxModelKeyring,
  removeLinuxModelKeyring,
} from './linux-model-keyring';
import {
  createMacosModelKeychain,
  readMacosModelKeychain,
  removeMacosModelKeychain,
} from './macos-model-keychain';

const service = 'kite-agent';
const vaultAccount = (keyId: string) => `model-vault/credential:${keyId}`;
const legacyAccount = (ref: string) => `user-models/${ref}`;

function fromSecret(bytes: Buffer | null): string | null {
  if (!bytes) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

async function readMacosKeyForSettings(account: string): Promise<Buffer | null> {
  try {
    return await readMacosModelKeychain(service, account);
  } catch (error) {
    if (!(error instanceof ConfigurationError) || error.code !== 'model_credentials_locked')
      throw error;
    return readMacosModelKeychain(service, account, true);
  }
}

export function createModelCredentialBackend(configurationPath: string) {
  if (process.platform === 'darwin')
    return createEncryptedModelCredentialBackend({
      configurationPath,
      wrappingKey: {
        read: (keyId) => readMacosModelKeychain(service, vaultAccount(keyId)),
        create: (keyId, key) => createMacosModelKeychain(service, vaultAccount(keyId), key),
        async authorize(keyId) {
          const key = await readMacosKeyForSettings(vaultAccount(keyId));
          key?.fill(0);
          return key !== null;
        },
      },
      legacy: {
        async resolve(ref) {
          return fromSecret(await readMacosModelKeychain(service, legacyAccount(ref)));
        },
        async authorize(ref) {
          return fromSecret(await readMacosKeyForSettings(legacyAccount(ref)));
        },
        remove: (ref) => removeMacosModelKeychain(service, legacyAccount(ref)),
      },
    });
  if (process.platform === 'linux')
    return createEncryptedModelCredentialBackend({
      configurationPath,
      wrappingKey: {
        read: (keyId) => readLinuxModelKeyring(service, vaultAccount(keyId)),
        create: (keyId, key) => createLinuxModelKeyring(service, vaultAccount(keyId), key),
      },
      legacy: {
        async resolve(ref) {
          return fromSecret(await readLinuxModelKeyring(service, legacyAccount(ref)));
        },
        remove: (ref) => removeLinuxModelKeyring(service, legacyAccount(ref)),
      },
    });
  if (process.platform !== 'win32') throw new ConfigurationError('credential_unavailable');
  const windowsKey = createOsCredentialBackend({ service, accountNamespace: 'model-vault' });
  const windowsRef = (keyId: string) => `credential:${keyId}`;
  return createEncryptedModelCredentialBackend({
    configurationPath,
    wrappingKey: {
      async read(keyId) {
        const key = await windowsKey.resolve(windowsRef(keyId));
        if (key === null) return null;
        if (!/^[A-Za-z0-9+/]{43}=$/u.test(key))
          throw new ConfigurationError('credential_unavailable');
        const bytes = Buffer.from(key, 'base64');
        if (bytes.length !== 32 || bytes.toString('base64') !== key)
          throw new ConfigurationError('credential_unavailable');
        return bytes;
      },
      async create(keyId, key) {
        const ref = windowsRef(keyId);
        // The caller holds the vault's cross-process lock during key creation.
        if ((await windowsKey.resolve(ref)) !== null)
          throw new ConfigurationError('credential_already_exists');
        await windowsKey.put(ref, key.toString('base64'));
      },
    },
    legacy: createOsCredentialBackend({ service, accountNamespace: 'user-models' }),
  });
}
