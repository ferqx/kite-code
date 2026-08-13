import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { resolveFixedDangerousPathIdentitiesV1 } from '@/core/policies/dangerous-paths';
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
    filesystemScope?: FilesystemScope;
    gitMetadataDeny?: boolean;
  },
): string[] {
  const args: string[] = [];
  const networkMode = options?.network ?? 'disabled';
  const workspaceRoot = realpathSync.native(resolve(workspace));

  if (options?.filesystemScope === 'full_access') {
    // Keep the process/PID/network namespace while projecting the approved
    // approved filesystem into this invocation's mount namespace.
    args.push('--bind', '/', '/');
    for (const protectedPath of resolveExistingProtectedMounts(
      workspaceRoot,
      options?.gitMetadataDeny !== true,
    )) {
      if (protectedPath.access === 'write_only') {
        args.push('--ro-bind', protectedPath.path, protectedPath.path);
      } else if (protectedPath.directory) {
        args.push('--tmpfs', protectedPath.path, '--remount-ro', protectedPath.path);
      } else {
        args.push('--ro-bind', '/dev/null', protectedPath.path);
      }
    }
  } else {
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
  }
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

function resolveExistingProtectedMounts(
  workspace: string,
  allowWorkspaceGit: boolean,
): Array<{
  path: string;
  directory: boolean;
  access: 'read_write' | 'write_only';
}> {
  const candidates: Array<{ path: string; access: 'read_write' | 'write_only' }> = [];
  const workspaceGit = resolve(workspace, '.git');
  for (const identity of resolveFixedDangerousPathIdentitiesV1({ workspace })) {
    if (allowWorkspaceGit && realpathOrSelf(identity.path) === realpathOrSelf(workspaceGit)) {
      continue;
    }
    if (identity.kind === 'prefix') {
      const parent = dirname(identity.path);
      const prefix = basename(identity.path).toLowerCase();
      if (!dirExists(parent)) continue;
      try {
        for (const entry of readdirSync(parent)) {
          if (entry.toLowerCase().startsWith(prefix)) {
            candidates.push({ path: resolve(parent, entry), access: identity.access });
          }
        }
      } catch {
        // Ignore a raced or unreadable directory; direct command policy still
        // rejects fixed identities and existing canonical targets are masked.
      }
    } else {
      candidates.push({ path: identity.path, access: identity.access });
    }
  }

  const mounts = new Map<
    string,
    { path: string; directory: boolean; access: 'read_write' | 'write_only' }
  >();
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    try {
      const path = realpathSync.native(candidate.path);
      mounts.set(path, { path, directory: statSync(path).isDirectory(), access: candidate.access });
    } catch {
      // Ignore a raced-away identity; command policy still denies direct text,
      // and a later invocation will re-resolve the fixed mount set.
    }
  }
  return [...mounts.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function dirExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
