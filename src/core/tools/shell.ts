import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ShellInput, ShellResult } from "@/core/types";
import { findBashBinary } from "./bash-path";

/** Shell 执行器函数签名 / Shell executor function signature */
export type ShellExecutor = (input: ShellInput) => Promise<ShellResult>;

/** 断言目标路径在工作区范围内 / Assert target path is inside workspace */
export function assertInsideWorkspace(workspace: string, targetPath: string): string {
  const workspaceRoot = resolve(workspace);
  const absoluteTarget = resolve(
    workspaceRoot,
    targetPath.replace(/[\\/]+/g, "/"),
  );
  const relativeTarget = relative(workspaceRoot, absoluteTarget);

  if (
    relativeTarget &&
    (relativeTarget === ".." ||
      relativeTarget.startsWith(`..${sep}`) ||
      isAbsolute(relativeTarget))
  ) {
    throw new Error(`Refusing path outside workspace: ${targetPath}`);
  }

  return absoluteTarget;
}

/** 通过 Bun.spawn 执行 Shell 命令，返回结构化结果 / Execute shell command via Bun.spawn, return structured result */
export async function shellTool(input: ShellInput): Promise<ShellResult> {
  try {
    const proc = Bun.spawn(
      buildShellInvocation(input.command),
      {
        cwd: input.workspace,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(proc.stdout).text();
    const rawStderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return {
      ok: exitCode === 0,
      command: input.command,
      exitCode,
      stdout,
      stderr: cleanMsys2Noise(rawStderr),
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
}

/** 构建平台特定的 Shell 调用参数 / Build platform-specific shell invocation arguments */
function buildShellInvocation(command: string): string[] {
  if (process.platform === "win32") {
    const bashPath = findBashBinary();
    if (bashPath) {
      // Prepend vendored /usr/bin to PATH inside bash so that coreutils
      // (ls, grep, find, etc.) are found regardless of the parent process PATH.
      // Don't override env in Bun.spawn — that breaks MSYS2 DLL path conversion
      // and causes commands to fail with exit code 127.
      return [bashPath, "-c", `export PATH="/usr/bin:$PATH" && ${command}`];
    }
    // fallback to cmd.exe if vendored bash is missing
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    return [`${systemRoot}\\System32\\cmd.exe`, "/d", "/c", command];
  }

  return [process.env.SHELL || "/bin/sh", "-lc", command];
}

/** 过滤 MSYS2 启动时的无害噪音（/tmp 警告等） */
function cleanMsys2Noise(stderr: string): string {
  return stderr.replace(/^bash\.exe: warning: could not find \/tmp, please create!\r?\n/gm, "");
}
