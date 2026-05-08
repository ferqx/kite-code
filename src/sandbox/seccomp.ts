import { existsSync } from "node:fs";
import { join } from "node:path";

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
    "..",
    "..",
    "vendor",
    "seccomp",
    arch,
    "apply-seccomp",
  );
  if (existsSync(path)) return path;

  return null;
}

function getArch(): string | null {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      return null;
  }
}
