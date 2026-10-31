import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import type { WindowsProfilePermissionIssue } from './windows-access';

type PermissionDialogs = (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;

/** Trusted startup only. No renderer request, recursive ACL reset or business I/O. */
export async function ensureDesktopProfilePermissions(input: {
  readonly dataRoot: string;
  readonly inspect: () => WindowsProfilePermissionIssue | undefined;
  readonly show: PermissionDialogs;
  readonly active?: () => boolean;
}): Promise<boolean> {
  for (;;) {
    if (input.active?.() === false) return false;
    let issue: WindowsProfilePermissionIssue | undefined;
    try {
      issue = input.inspect();
    } catch (error) {
      if (errorCode(error) === 'windows_access_close_unknown') throw error;
      const result = await input.show({
        type: 'error',
        title: 'Kite 无法安全访问数据',
        message: '无法核验数据目录的权限',
        detail: `数据目录：${input.dataRoot}\n\n请关闭使用该目录的 Kite 客户端，并检查当前用户的访问权限和目录路径。此时未启动服务或打开数据库，也未修改权限。处理后可重新检查。`,
        buttons: ['退出', '重新检查'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (input.active?.() === false || result.response !== 1) return false;
      continue;
    }
    if (!issue) return true;
    const result = await input.show({
      type: 'warning',
      title: 'Kite 数据权限异常',
      message: '数据目录权限不符合安全要求',
      detail: `受影响路径：${issue.path}\n\nKite 要求数据仅供当前用户访问。此时未启动服务或打开数据库。\n\n${
        issue.repairable
          ? `检测到额外的读取权限。选择修复将先备份原权限，再仅移除这个对象上的额外读取权限；不递归修改子项，也不删除数据。修复后会重新检查，全部通过才继续启动。\n\n权限备份：${issue.backupPath}`
          : '无法确认此对象仅多出读取权限，可能存在其他用户可写、所有者不符、链接或访问受限。Kite 不会自动重置权限。请核对权限及数据完整性，必要时联系管理员；处理后可重新检查。'
      }`,
      buttons: issue.repairable ? ['退出', '备份并修复权限', '重新检查'] : ['退出', '重新检查'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (input.active?.() === false || result.response === 0) return false;
    if (result.response === (issue.repairable ? 2 : 1)) continue;
    if (!issue.repairable || result.response !== 1) return false;
    try {
      issue.repair();
    } catch (error) {
      // Unknown close keeps the native owner. Never admit a replacement startup.
      if (errorCode(error) === 'windows_access_close_unknown') throw error;
      const code = errorCode(error);
      const result = await input.show({
        type: 'error',
        title: 'Kite 权限修复未完成',
        message:
          code === 'owner_busy'
            ? '数据目录正在使用，无法修复权限'
            : code === 'windows_profile_permission_repair_unknown'
              ? '权限修改结果尚未核实'
              : '无法完成权限备份或修复',
        detail: `受影响路径：${issue.path}\n\n请关闭使用该目录的所有 Kite 客户端，检查当前用户是否有修改权限的权利。Kite 不会自动重试修复或删除数据；重新检查不会再次提交原修复。\n\n如已生成，请保留权限备份：${issue.backupPath}`,
        buttons: ['退出', '重新检查'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (input.active?.() === false || result.response !== 1) return false;
    }
  }
}
function errorCode(error: unknown): string {
  return error instanceof Error ? String(Reflect.get(error, 'code') ?? error.message) : '';
}
