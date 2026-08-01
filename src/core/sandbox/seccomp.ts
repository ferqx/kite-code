import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * 定位 vendored apply-seccomp 二进制
 * Locate the vendored apply-seccomp binary
 *
 * 二进制来自 @anthropic-ai/sandbox-runtime，静态链接，无运行时依赖。
 * vendor/ 目录下同时存放 x64 和 arm64 两个架构的预编译版本。
 * 在内核层面封堵 socket(AF_UNIX, ...) 和 io_uring 系列 syscall。
 */
export function findApplySeccomp(): string | null {
  const arch = getArch();
  if (!arch) return null;

  const path = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'vendor',
    'seccomp',
    arch,
    'apply-seccomp',
  );
  if (existsSync(path)) return path;

  return null;
}

/**
 * 确保 apply-seccomp 二进制在 bwrap 挂载命名空间内可见。
 * bwrap 只 bind-mount 了系统路径和工作区，其他路径不可见。
 * 如果二进制不在工作区内，复制到沙箱运行时目录。
 *
 * Ensure the apply-seccomp binary is visible within bwrap's mount namespace.
 * bwrap only bind-mounts system paths and the workspace — everything else is invisible.
 * If the binary is outside the workspace, copy it into the sandbox runtime dir.
 */
export function resolveSeccompPath(
  binary: string | null,
  workspace: string,
  runtimeDir: string,
): string | null {
  if (!binary) return null;

  const rel = relative(workspace, binary);
  // 在工作区内（不含 ../ 逃逸）= 直接可见 / Within workspace, directly visible
  if (!rel.startsWith('..') && !rel.startsWith(sep)) return binary;

  // 二进制在工作区外，复制到沙箱运行时目录
  const dest = join(runtimeDir, 'apply-seccomp');
  if (!existsSync(dest)) {
    mkdirSync(runtimeDir, { recursive: true });
    copyFileSync(binary, dest);
    chmodSync(dest, 0o755);
  }
  return dest;
}

function getArch(): string | null {
  switch (process.arch) {
    case 'x64':
      return 'x64';
    case 'arm64':
      return 'arm64';
    default:
      return null;
  }
}
