import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { expect, test } from '#kite-test';
import {
  createLinuxModelKeyring,
  readLinuxModelKeyring,
  removeLinuxModelKeyring,
} from '../../src/linux-model-keyring';

const isolatedSecretService =
  process.platform === 'linux' &&
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.KITE_RUN_UNIFIED_KEYRING_SMOKE === '1' &&
  isAbsolute(process.env.KITE_LINUX_MODEL_KEYRING_FIXTURE ?? '') &&
  process.env.XDG_DATA_HOME === process.env.KITE_LINUX_MODEL_KEYRING_FIXTURE &&
  !!process.env.DBUS_SESSION_BUS_ADDRESS;

function lockFixtureKeyring() {
  const result = execFileSync(
    '/usr/bin/gdbus',
    [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.secrets',
      '--object-path',
      '/org/freedesktop/secrets',
      '--method',
      'org.freedesktop.Secret.Service.Lock',
      "['/org/freedesktop/secrets/collection/login']",
    ],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  expect(result).toContain("objectpath '/org/freedesktop/secrets/collection/login'");
  expect(result).toContain("objectpath '/'");
}

function unlockFixtureKeyring() {
  execFileSync('/usr/bin/gnome-keyring-daemon', ['--unlock', '--components=secrets'], {
    input: 'ci-keyring',
    timeout: 5000,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

test.skipIf(process.platform === 'linux')(
  'Linux keyring subprocess reports an unavailable backend without reading a credential on another OS',
  async () => {
    await expect(readLinuxModelKeyring('kite-test', 'model-vault/test')).rejects.toMatchObject({
      code: 'model_credentials_backend_unavailable',
    });
  },
);

test.skipIf(!isolatedSecretService)(
  'Linux model keyring survives independent readers and refuses to overwrite an existing key',
  async () => {
    const service = `kite-test-${randomUUID()}`;
    const account = `model-vault/${randomUUID()}`;
    const key = randomBytes(32);
    const competing = randomBytes(32);
    let observed: Buffer | null | undefined;
    try {
      expect(await readLinuxModelKeyring(service, account)).toBeNull();
      await createLinuxModelKeyring(service, account, key);
      await expect(createLinuxModelKeyring(service, account, competing)).rejects.toMatchObject({
        code: 'credential_already_exists',
      });
      observed = await readLinuxModelKeyring(service, account);
      expect(observed?.equals(key)).toBe(true);
      // The test gate requires the workflow's separate daemon, bus and keyring files.
      try {
        lockFixtureKeyring();
        await expect(readLinuxModelKeyring(service, account)).rejects.toMatchObject({
          code: 'model_credentials_locked',
        });
      } finally {
        unlockFixtureKeyring();
      }
      await removeLinuxModelKeyring(service, account);
      await removeLinuxModelKeyring(service, account);
      expect(await readLinuxModelKeyring(service, account)).toBeNull();
    } finally {
      key.fill(0);
      competing.fill(0);
      observed?.fill(0);
      await removeLinuxModelKeyring(service, account);
    }
  },
  25_000,
);
