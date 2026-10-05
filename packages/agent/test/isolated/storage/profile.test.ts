import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '../../../src/profile';
import { openSqliteStore, resolveProfile } from '../../../src/sqlite';

test('readonly profile selection creates no paths and opening reuses the selected stable identity', async () => {
  const fixture = mkdtempSync('/private/tmp/kite-profile-selection-');
  chmodSync(fixture, 0o700);
  const missingRoot = join(fixture, 'missing', 'root');
  const before = readdirSync(fixture, { recursive: true });
  try {
    const selected = selectProfile({ dataRoot: missingRoot, profile: 'same' });
    expect(selected.dataRoot).toBe(missingRoot);
    expect(readdirSync(fixture, { recursive: true })).toEqual(before);
    expect(existsSync(missingRoot)).toBe(false);
    const second = selectProfile({ dataRoot: join(fixture, 'other'), profile: 'same' });
    expect(second.profileAccessKey).not.toBe(selected.profileAccessKey);
    const alias = join(fixture, 'alias');
    symlinkSync(fixture, alias);
    expect(selectProfile({ dataRoot: join(alias, 'missing', 'root'), profile: 'same' })).toEqual(
      selected,
    );
    const store = await openSqliteStore({ dataRoot: missingRoot, profile: 'same' });
    await store.close();
    expect(resolveProfile({ dataRoot: missingRoot, profile: 'same' })).toEqual(selected);
    expect(existsSync(selected.databasePath)).toBe(true);
    // Replacing only the profile data unit never changes its external stable identity.
    renameSync(selected.profilePath, join(missingRoot, 'archived'));
    expect(selectProfile({ dataRoot: missingRoot, profile: 'same' })).toEqual(selected);
    const replacement = await openSqliteStore({ dataRoot: missingRoot, profile: 'same' });
    await replacement.close();
    expect(selectProfile({ dataRoot: missingRoot, profile: 'same' })).toEqual(selected);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
test('profile selection preserves invalid-name, dangling-symlink and private opening restrictions', () => {
  const fixture = mkdtempSync('/private/tmp/kite-profile-safety-');
  chmodSync(fixture, 0o700);
  try {
    expect(() => selectProfile({ dataRoot: fixture, profile: '../escape' })).toThrow(
      'Invalid profile name',
    );
    symlinkSync(join(fixture, 'absent'), join(fixture, 'dangling'));
    expect(() =>
      selectProfile({ dataRoot: join(fixture, 'dangling', 'root'), profile: 'same' }),
    ).toThrow('Symlink');
    const unsafe = join(fixture, 'unsafe');
    mkdirSync(unsafe, { mode: 0o755 });
    chmodSync(unsafe, 0o755);
    const selected = selectProfile({ dataRoot: unsafe, profile: 'same' });
    expect(existsSync(selected.coordinationPath)).toBe(false);
    expect(() => resolveProfile({ dataRoot: unsafe, profile: 'same' })).toThrow('private owned');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
