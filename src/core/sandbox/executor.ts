import type { ShellExecutor } from "@/core/tools/shell";
import { shellTool } from "@/core/tools/shell";
import { generateBwrapArgs } from "./bwrap";
import { detectSandboxBackend, type SandboxBackend } from "./platform";
import { findApplySeccomp, resolveSeccompPath } from "./seccomp";
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
      return shellTool;
  }
}

/** macOS Seatbelt executor（参照 Codex create_seatbelt_command_args 使用 -p 传 profile）*/
function createSeatbeltExecutor(options: SandboxOptions): ShellExecutor {
  const { workspace, resourceLimits } = options;
  const profile = generateSandboxProfile(workspace);

  return createWrappedExecutor(workspace, resourceLimits, (wrappedCommand) => ({
    cmd: [
      "/usr/bin/sandbox-exec",
      "-p",
      profile,
      "/bin/sh",
      "-c",
      wrappedCommand,
    ],
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
      ? [seccompPath, "/bin/sh", "-c", wrappedCommand]
      : ["/bin/sh", "-c", wrappedCommand];
    return { cmd: [bwrapPath, ...bwrapArgs, ...innerCmd] };
  });
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
        signal: input.signal,
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
      const isAbort = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        command: input.command,
        exitCode: isAbort ? 130 : -1,
        stdout: "",
        stderr: isAbort ? "Command cancelled by user." : (error instanceof Error ? error.message : String(error)),
      };
    }
  };
}

let sandboxWarned = false;

function warn(message: string): void {
  if (sandboxWarned) return;
  sandboxWarned = true;
  console.warn(`[sandbox] ${message}`);
}
