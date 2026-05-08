import type { ShellResult } from "../shared/types";
import type { ShellExecutor } from "../tools/shell";
import { shellTool } from "../tools/shell";
import { isSandboxAvailable } from "./platform";
import { generateSandboxProfile } from "./profile";
import {
  buildEnvStripSnippet,
  buildEnvExportSnippet,
  buildHardenedEnv,
  buildUlimitPreamble,
} from "./shell-wrapper";
import type { SandboxOptions } from "./types";

/** 创建沙箱化的 ShellExecutor / Create a sandboxed ShellExecutor */
export function createSandboxExecutor(options: SandboxOptions): ShellExecutor {
  const { enabled, workspace, resourceLimits } = options;

  if (!enabled) {
    warn("Sandbox disabled by flag. Shell commands will run without isolation.");
    return shellTool;
  }

  if (!isSandboxAvailable()) {
    warn("sandbox-exec not available on this platform. Falling back to unsandboxed shell execution.");
    return shellTool;
  }

  const profile = generateSandboxProfile(workspace);

  return async (input) => {
    try {
      // 每次执行前刷新硬化环境变量（处理目录被外部删除的情况）
      const hardenedEnv = buildHardenedEnv(workspace);

      const preamble = [
        buildEnvStripSnippet(),
        buildUlimitPreamble(resourceLimits),
        buildEnvExportSnippet(hardenedEnv),
      ].join(" ");

      const wrappedCommand = `${preamble} ${input.command}`;

      const proc = Bun.spawn(
        [
          "/usr/bin/sandbox-exec",
          "-f",
          "/dev/stdin",
          "/bin/sh",
          "-lc",
          wrappedCommand,
        ],
        {
          cwd: workspace,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      // 将 profile 写入 sandbox-exec 的 stdin / Pipe profile to sandbox-exec stdin
      proc.stdin.write(profile);
      proc.stdin.end();

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
