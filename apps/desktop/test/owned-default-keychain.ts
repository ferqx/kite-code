import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, statSync, symlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { privateDirectory } from '../../../tests/fixtures/test-filesystem';

/** Keep fixture configuration isolated while using this OS user's actual default vault. */
export function linkOwnedDefaultKeychain(home: string): void {
  if (process.platform !== 'darwin') throw Error('owned_keychain_platform_invalid');
  // Bun's userInfo/homedir can reflect the runner's isolated startup HOME.
  // Query Directory Services by the process UID instead of an environment-derived home.
  const uid = process.getuid?.();
  if (uid === undefined) throw Error('owned_keychain_uid_unavailable');
  const account = execFileSync('/usr/bin/dscacheutil', ['-q', 'user', '-a', 'uid', String(uid)], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    encoding: 'utf8',
    timeout: 5000,
  });
  const homes = [...account.matchAll(/^dir: (.+)$/gm)];
  const accountUids = [...account.matchAll(/^uid: (\d+)$/gm)];
  const osHome = homes[0]?.[1];
  if (
    homes.length !== 1 ||
    accountUids.length !== 1 ||
    Number(accountUids[0]?.[1]) !== uid ||
    !osHome ||
    !isAbsolute(osHome) ||
    !statSync(osHome).isDirectory()
  )
    throw Error('owned_keychain_os_home_invalid');
  const raw = execFileSync('/usr/bin/security', ['default-keychain', '-d', 'user'], {
    env: { HOME: osHome, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
  const keychain: unknown = JSON.parse(raw);
  if (typeof keychain !== 'string' || !isAbsolute(keychain) || !statSync(keychain).isFile())
    throw Error('owned_default_keychain_invalid');
  const directory = join(home, 'Library', 'Keychains');
  privateDirectory(directory);
  const target = join(directory, 'login.keychain-db');
  if (existsSync(target)) throw Error('owned_default_keychain_target_exists');
  try {
    lstatSync(target);
    throw Error('owned_default_keychain_target_exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  symlinkSync(keychain, target, 'file');
}
