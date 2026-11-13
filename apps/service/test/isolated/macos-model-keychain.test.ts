import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '#kite-test';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import {
  createMacosModelKeychain,
  modelKeyringOperation,
  readMacosModelKeychain,
  removeMacosModelKeychain,
} from '../../src/macos-model-keychain';

test('macOS model keychain refuses invalid lookup attributes before opening a keychain', () => {
  const service = `kite-model-keychain-test-${randomUUID()}`;
  const account = `model-vault/credential:${randomUUID()}`;
  expect(() => modelKeyringOperation({ operation: 'read', service: '', account })).toThrow(
    'credential_unavailable',
  );
  expect(() =>
    modelKeyringOperation({ operation: 'read', service, account: `${account}\0` }),
  ).toThrow('credential_unavailable');
});

const nativeKeychainTest =
  process.platform === 'darwin' && process.env.KITE_RUN_UNIFIED_KEYRING_SMOKE === '1';

test.skipIf(!nativeKeychainTest)(
  'macOS model keychain child reads only the user default and fails immediately on an ACL that requires confirmation',
  async () => {
    const home = temporaryDirectory('kite-model-keychain-');
    const directory = join(home, 'Library', 'Keychains');
    const keychain = join(directory, 'login.keychain-db');
    const originalHome = process.env.HOME;
    const service = `kite-model-keychain-test-${randomUUID()}`;
    const account = `model-vault/credential:${randomUUID()}`;
    const legacy = `user-models/credential:${randomUUID()}`;
    const secret = randomBytes(32);
    const security = (args: string[]) =>
      execFileSync('/usr/bin/security', args, {
        env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();
    let created = false;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      security(['create-keychain', '-p', randomUUID(), keychain]);
      created = true;
      expect(JSON.parse(security(['default-keychain', '-d', 'user']))).toBe(realpathSync(keychain));
      process.env.HOME = home;

      expect(await readMacosModelKeychain(service, account)).toBeNull();
      await createMacosModelKeychain(service, account, secret);
      await expect(createMacosModelKeychain(service, account, randomBytes(32))).rejects.toThrow(
        'credential_already_exists',
      );
      expect((await readMacosModelKeychain(service, account))?.equals(secret)).toBe(true);
      expect((await readMacosModelKeychain(service, account, true))?.equals(secret)).toBe(true);

      // Empty trusted-application list forces confirmation to decrypt this synthetic legacy item.
      security([
        'add-generic-password',
        '-s',
        service,
        '-a',
        legacy,
        '-w',
        'synthetic-denied-test-fixture',
        '-T',
        '',
        keychain,
      ]);
      await expect(readMacosModelKeychain(service, legacy)).rejects.toThrow(
        'model_credentials_locked',
      );
      expect((await readMacosModelKeychain(service, account))?.equals(secret)).toBe(true);

      await removeMacosModelKeychain(service, account);
      await removeMacosModelKeychain(service, account);
      expect(await readMacosModelKeychain(service, account)).toBeNull();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      try {
        if (created) security(['delete-keychain', keychain]);
      } finally {
        removeTemporaryDirectory(home);
      }
    }
  },
  20000,
);
