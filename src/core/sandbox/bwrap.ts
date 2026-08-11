import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FilesystemScope } from './types';

/**
 * 生成 Bubblewrap 参数，创建最小化 Linux 容器
 * Generate Bubblewrap arguments to create a minimal Linux container
 *
 * 隔离策略：
 * - 系统路径只读绑定，工作区读写绑定
 * - tmpfs /tmp 临时目录
 * - --unshare-pid 进程隔离
 */
export function generateBwrapArgs(
  workspace: string,
  options?: {
    network?: 'disabled' | 'allow_all';
    sandboxRuntimeDir?: string;
    filesystemScope?: Exclude<FilesystemScope, 'full_access'>;
    gitMetadataDeny?: boolean;
  },
): string[] {
  const args: string[] = [];
  const networkMode = options?.network ?? 'disabled';
  const workspaceRoot = realpathSync.native(resolve(workspace));

  // 系统路径：只读绑定 / System paths: read-only bind
  for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/sys']) {
    if (dirExists(path)) {
      args.push('--ro-bind', path, path);
    }
  }

  // Mount the generic temp filesystem before any Workspace/runtime child bind.
  // A later /tmp mount would hide canonical paths located under the host tmpdir.
  args.push('--tmpfs', '/tmp');

  // Workspace bind follows the selected native filesystem ceiling.
  const workspaceBind = options?.filesystemScope === 'read_only' ? '--ro-bind' : '--bind';
  args.push(workspaceBind, workspaceRoot, workspaceRoot);
  if (options?.gitMetadataDeny) {
    const gitMarker = resolve(workspaceRoot, '.git');
    if (dirExists(gitMarker)) {
      args.push('--tmpfs', gitMarker, '--remount-ro', gitMarker);
    } else if (existsSync(gitMarker)) {
      args.push('--ro-bind', '/dev/null', gitMarker);
    }
  }

  // 沙箱运行时目录：读写绑定（存放 TMPDIR、bun cache 等）
  const runtimeDir = options?.sandboxRuntimeDir;
  if (runtimeDir && dirExists(runtimeDir)) {
    const runtimeRoot = realpathSync.native(resolve(runtimeDir));
    args.push('--bind', runtimeRoot, runtimeRoot);
  }

  // 最小设备节点和 proc
  args.push('--dev', '/dev');
  args.push('--proc', '/proc');

  // 进程隔离
  args.push('--unshare-pid');
  if (networkMode === 'disabled') {
    args.push('--unshare-net');
  }

  // 父进程退出时清理
  args.push('--die-with-parent');

  // 新建会话（脱离控制终端）
  args.push('--new-session');

  return args;
}

function dirExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
