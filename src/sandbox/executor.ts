import { mkdirSync, copyFileSync, chmodSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ShellExecutor } from "../tools/shell";
import { shellTool } from "../tools/shell";
import { generateBwrapArgs } from "./bwrap";
import { detectSandboxBackend, type SandboxBackend } from "./platform";
import { findApplySeccomp } from "./seccomp";
import { generateSandboxProfile } from "./profile";
import {
  buildEnvStripSnippet,
  buildEnvExportSnippet,
  buildHardenedEnv,
  buildUlimitPreamble,
  checkDangerousPaths,
} from "./shell-wrapper";
import type { SandboxOptions } from "./types";

/** 创建沙箱化的 ShellExecutor / Create a sandboxed ShellExecutor */
export function createSandboxExecutor(options: SandboxOptions): ShellExecutor {
  const { enabled } = options;

  if (!enabled) {
    warn("Sandbox disabled by flag. Shell commands will run without isolation.");
    return shellTool;
  }

  const backend = detectSandboxBackend();

  switch (backend) {
    case "seatbelt":
      return createSeatbeltExecutor(options);
    case "bubblewrap":
      return createBwrapExecutor(options);
    default:
      warn(
        "No sandbox backend available on this platform. Falling back to unsandboxed shell execution.",
      );
      return shellTool;
  }
}

/** macOS Seatbelt executor */
function createSeatbeltExecutor(options: SandboxOptions): ShellExecutor {
  const { workspace, resourceLimits } = options;
  const profile = generateSandboxProfile(workspace);

  return createWrappedExecutor(workspace, resourceLimits, (wrappedCommand) => ({
    cmd: [
      "/usr/bin/sandbox-exec",
      "-f",
      "/dev/stdin",
      "/bin/sh",
      "-lc",
      wrappedCommand,
    ],
    stdin: profile,
  }));
}

/** Linux Bubblewrap executor */
function createBwrapExecutor(options: SandboxOptions): ShellExecutor {
  const { workspace, resourceLimits } = options;
  const bwrapArgs = generateBwrapArgs(workspace);
  const bwrapPath = Bun.which("bwrap")!;
  const seccompPath = resolveSeccompPath(findApplySeccomp(), workspace);

  return createWrappedExecutor(workspace, resourceLimits, (wrappedCommand) => {
    const innerCmd = seccompPath
      ? [seccompPath, "/bin/sh", "-lc", wrappedCommand]
      : ["/bin/sh", "-lc", wrappedCommand];
    return { cmd: [bwrapPath, ...bwrapArgs, ...innerCmd] };
  });
}

/**
 * 确保 apply-seccomp 二进制在 bwrap 挂载命名空间内可见。
 * bwrap 只 bind-mount 了系统路径和工作区，其他路径不可见。
 * 如果二进制不在工作区内，复制到 .sandbox-tmp/ 子目录。
 *
 * Ensure the apply-seccomp binary is visible within bwrap's mount namespace.
 * bwrap only bind-mounts system paths and the workspace — everything else is invisible.
 * If the binary is outside the workspace, copy it into .sandbox-tmp/.
 */
function resolveSeccompPath(binary: string | null, workspace: string): string | null {
  if (!binary) return null;

  const rel = relative(workspace, binary);
  // 在工作区内（不含 ../ 逃逸）= 直接可见 / Within workspace, directly visible
  if (!rel.startsWith("..") && !rel.startsWith(sep)) return binary;

  // 二进制在工作区外，复制到工作区内的 sandbox-tmp
  const dest = join(workspace, ".sandbox-tmp", "apply-seccomp");
  if (!existsSync(dest)) {
    mkdirSync(join(workspace, ".sandbox-tmp"), { recursive: true });
    copyFileSync(binary, dest);
    chmodSync(dest, 0o755);
  }
  return dest;
}

/**
 * 构建 wrapped command（ulimit + 环境硬化 + 用户命令）并执行
 * Build wrapped command (ulimit + env hardening + user command) and execute
 */
function createWrappedExecutor(
  workspace: string,
  resourceLimits: SandboxOptions["resourceLimits"],
  buildSpawn: (
    wrappedCommand: string,
  ) => { cmd: string[]; stdin?: string },
): ShellExecutor {
  return async (input) => {
    try {
      // 执行前检查命令是否引用危险文件路径 / Pre-execution dangerous path check
      const dangerous = checkDangerousPaths(input.command);
      if (dangerous) {
        return {
          ok: false,
          command: input.command,
          exitCode: -1,
          stdout: "",
          stderr: `Rejected: command references protected path '${dangerous}'`,
        };
      }

      const hardenedEnv = buildHardenedEnv(workspace);

      const preamble = [
        buildEnvStripSnippet(),
        buildUlimitPreamble(resourceLimits),
        buildEnvExportSnippet(hardenedEnv),
      ].join(" ");

      const wrappedCommand = `${preamble} ${input.command}`;
      const { cmd, stdin } = buildSpawn(wrappedCommand);

      const proc = Bun.spawn(cmd, {
        cwd: workspace,
        stdin: stdin !== undefined ? "pipe" : "inherit",
        stdout: "pipe",
        stderr: "pipe",
      });

      if (stdin !== undefined && proc.stdin) {
        proc.stdin.write(stdin);
        proc.stdin.end();
      }

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      return {
        ok: exitCode === 0,
        command: input.command,
        exitCode,
        stdout,
        stderr,
      };
    } catch (error) {
      return {
        ok: false,
        command: input.command,
        exitCode: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

function warn(message: string): void {
  console.warn(`[sandbox] ${message}`);
}
