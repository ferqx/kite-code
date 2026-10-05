import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquireProfileAccess as internalAcquire } from '../../../src/platform/profile';
import {
  acquireProfileAccess,
  acquireProfileDataLock,
  type ProfileAccess,
} from '../../../src/profile-access';

test.skipIf(process.platform === 'win32')(
  'fixed TUI data lock competes immediately, retains original shared authority and cannot be forged or rebound',
  () => {
    const root = mkdtempSync('/private/tmp/kite-profile-data-lock-'),
      options = { dataRoot: join(root, 'data'), profile: 'one' };
    const first = acquireProfileAccess(options),
      second = acquireProfileAccess(options),
      other = acquireProfileAccess({ ...options, profile: 'two' });
    try {
      const path = join(first.coordinationPath, 'tui-private.lock');
      expect(() => acquireProfileDataLock({ ...first } as ProfileAccess, 'tui_private')).toThrow(
        'profile_data_lock_authority_invalid',
      );
      expect(() => acquireProfileDataLock(first, 'arbitrary' as 'tui_private')).toThrow(
        'profile_data_lock_authority_invalid',
      );
      expect(existsSync(path)).toBe(false);
      const lock = acquireProfileDataLock(first, 'tui_private');
      expect(lock.path).toBe(path);
      expect(lock.mode).toBe('exclusive');
      expect(lstatSync(path).mode & 0o077).toBe(0);
      writeFileSync(path, 'keep original lock bytes', { mode: 0o600 });
      const original = readFileSync(path);
      expect(() => acquireProfileDataLock(second, 'tui_private')).toThrow('Lock is busy.');
      expect(readFileSync(path)).toEqual(original);
      expect(() => first.lock.release()).toThrow('profile_data_lock_in_use');
      expect(() => internalAcquire(options, 'exclusive')).toThrow('Lock is busy.');
      const independent = acquireProfileDataLock(other, 'tui_private');
      independent.release();
      lock.release();
      lock.release();
      const next = acquireProfileDataLock(second, 'tui_private');
      next.release();
      first.lock.release();
      expect(() => acquireProfileDataLock(first, 'tui_private')).toThrow(
        'Invalid or released lock authority.',
      );
      expect(readFileSync(path)).toEqual(original);
      second.lock.release();
      const maintenance = internalAcquire(options, 'exclusive');
      expect(() => acquireProfileDataLock(maintenance, 'tui_private')).toThrow(
        'Invalid or released lock authority.',
      );
      maintenance.lock.release();
    } finally {
      first.lock.release();
      second.lock.release();
      other.lock.release();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'TUI data lock rejects unsafe permissions, links, journal and changed coordination with zero target effects',
  () => {
    const root = mkdtempSync('/private/tmp/kite-profile-data-safety-'),
      options = { dataRoot: join(root, 'data'), profile: 'one' },
      access = acquireProfileAccess(options),
      path = join(access.coordinationPath, 'tui-private.lock');
    try {
      const lock = acquireProfileDataLock(access, 'tui_private');
      lock.release();
      writeFileSync(path, 'preserved', { mode: 0o600 });
      const bytes = readFileSync(path);
      chmodSync(path, 0o644);
      expect(() => acquireProfileDataLock(access, 'tui_private')).toThrow(
        'Lock is not a stable private regular file.',
      );
      expect(readFileSync(path)).toEqual(bytes);
      chmodSync(path, 0o600);
      const hard = join(root, 'alias');
      linkSync(path, hard);
      expect(() => acquireProfileDataLock(access, 'tui_private')).toThrow(
        'Lock is not a stable private regular file.',
      );
      expect(readFileSync(path)).toEqual(bytes);
      unlinkSync(hard);
      unlinkSync(path);
      const target = join(root, 'foreign');
      writeFileSync(target, 'foreign bytes', { mode: 0o600 });
      symlinkSync(target, path);
      expect(() => acquireProfileDataLock(access, 'tui_private')).toThrow();
      expect(readFileSync(target, 'utf8')).toBe('foreign bytes');
      unlinkSync(path);
      const journal = join(access.coordinationPath, 'restore-journal.json');
      writeFileSync(journal, '{}', { mode: 0o600 });
      expect(() => acquireProfileDataLock(access, 'tui_private')).toThrow(
        'restore_reconciliation_required',
      );
      expect(existsSync(path)).toBe(false);
      unlinkSync(journal);
      chmodSync(access.coordinationPath, 0o755);
      expect(() => acquireProfileDataLock(access, 'tui_private')).toThrow(
        'Profile coordination requires private owned directories.',
      );
      expect(existsSync(path)).toBe(false);
      chmodSync(access.coordinationPath, 0o700);
      const originalLock = join(access.coordinationPath, 'profile-use.lock'),
        alias = join(root, 'shared-alias');
      linkSync(originalLock, alias);
      expect(() => acquireProfileDataLock(access, 'tui_private')).toThrow(
        'Lock is not a stable private regular file.',
      );
      expect(existsSync(path)).toBe(false);
      unlinkSync(alias);
    } finally {
      access.lock.release();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
