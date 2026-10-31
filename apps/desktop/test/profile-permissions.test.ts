import { expect, test } from 'bun:test';
import type { MessageBoxOptions } from 'electron';
import { ensureDesktopProfilePermissions } from '../electron/profile-permissions';
import type { WindowsProfilePermissionIssue } from '../electron/windows-access';

function fixture(options: { repairable?: boolean; failure?: string } = {}) {
  const trace: string[] = [];
  let current: WindowsProfilePermissionIssue | undefined = {
    path: 'C:\\owned\\data',
    backupPath: 'C:\\owned\\data\\permissions-backup-fixed.txt',
    repairable: options.repairable ?? true,
    repair() {
      trace.push('repair');
      if (options.failure) throw Error(options.failure);
      current = undefined;
    },
  };
  const dialogs: MessageBoxOptions[] = [];
  const responses: number[] = [];
  return {
    trace,
    dialogs,
    responses,
    clear: () => {
      current = undefined;
    },
    input: {
      dataRoot: 'C:\\owned\\data',
      inspect() {
        trace.push('inspect');
        return current;
      },
      async show(options: MessageBoxOptions) {
        trace.push('dialog');
        dialogs.push(options);
        const response = responses.shift();
        if (response === undefined) throw Error('unexpected_dialog');
        return { response, checkboxChecked: false };
      },
    },
  };
}
test('safe metadata proceeds without a dialog or repair', async () => {
  const f = fixture();
  f.clear();
  expect(await ensureDesktopProfilePermissions(f.input)).toBe(true);
  expect(f.trace).toEqual(['inspect']);
});
test('permission dialog defaults to exit and cancellation leaves the original permissions', async () => {
  const f = fixture();
  f.responses.push(0);
  expect(await ensureDesktopProfilePermissions(f.input)).toBe(false);
  expect(f.trace).toEqual(['inspect', 'dialog']);
  expect(f.dialogs[0]).toMatchObject({
    defaultId: 0,
    cancelId: 0,
    buttons: ['退出', '备份并修复权限', '重新检查'],
  });
  expect(f.dialogs[0]!.detail).toContain('C:\\owned\\data');
  expect(f.dialogs[0]!.detail).toContain('permissions-backup-fixed.txt');
});
test('explicit repair happens once after the dialog, then a fresh inspection gates startup', async () => {
  const f = fixture();
  f.responses.push(1);
  expect(await ensureDesktopProfilePermissions(f.input)).toBe(true);
  expect(f.trace).toEqual(['inspect', 'dialog', 'repair', 'inspect']);
});
test('recheck never submits repair and a still-invalid object remains blocked', async () => {
  const f = fixture();
  f.responses.push(2, 0);
  expect(await ensureDesktopProfilePermissions(f.input)).toBe(false);
  expect(f.trace).toEqual(['inspect', 'dialog', 'inspect', 'dialog']);
});
test('write exposure or unverified identity offers inspection only and never repair', async () => {
  const f = fixture({ repairable: false });
  f.responses.push(1, 0);
  expect(await ensureDesktopProfilePermissions(f.input)).toBe(false);
  expect(f.dialogs[0]!.buttons).toEqual(['退出', '重新检查']);
  expect(f.dialogs[0]!.detail).toContain('数据完整性');
  expect(f.trace).toEqual(['inspect', 'dialog', 'inspect', 'dialog']);
});
for (const code of [
  'owner_busy',
  'windows_profile_permission_repair_failed',
  'windows_profile_permission_repair_unknown',
]) {
  test(`${code} keeps startup blocked with the backup location and no automatic resubmission`, async () => {
    const f = fixture({ failure: code });
    f.responses.push(1, 0);
    expect(await ensureDesktopProfilePermissions(f.input)).toBe(false);
    expect(f.trace).toEqual(['inspect', 'dialog', 'repair', 'dialog']);
    expect(f.dialogs[1]!.detail).toContain('permissions-backup-fixed.txt');
    expect(f.dialogs[1]!.buttons).toEqual(['退出', '重新检查']);
    expect(f.dialogs[1]!.defaultId).toBe(0);
  });
}
test('inspection failure is actionable and cannot be treated as a valid empty directory', async () => {
  const f = fixture();
  f.responses.push(0);
  expect(
    await ensureDesktopProfilePermissions({
      ...f.input,
      inspect() {
        throw Error('denied');
      },
    }),
  ).toBe(false);
  expect(f.dialogs[0]!.message).toBe('无法核验数据目录的权限');
  expect(f.trace).toEqual(['dialog']);
});
test('unknown native close propagates without retry or replacement admission', async () => {
  const f = fixture({ failure: 'windows_access_close_unknown' });
  f.responses.push(1);
  await expect(ensureDesktopProfilePermissions(f.input)).rejects.toThrow(
    'windows_access_close_unknown',
  );
  expect(f.trace).toEqual(['inspect', 'dialog', 'repair']);
});
test('shutdown while the confirmation is open prevents a late permission write', async () => {
  const f = fixture();
  let active = true;
  expect(
    await ensureDesktopProfilePermissions({
      ...f.input,
      active: () => active,
      async show() {
        active = false;
        return { response: 1, checkboxChecked: false };
      },
    }),
  ).toBe(false);
  expect(f.trace).toEqual(['inspect']);
});
