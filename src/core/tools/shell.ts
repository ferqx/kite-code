import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ShellInput, ShellResult } from "@/core/types";
import { findBashBinary, findSystemBash } from "./bash-path";
import { normalizeMsys2PathsInText } from "./path-utils";

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
        signal: input.signal,
      },
    );
    const stdout = await new Response(proc.stdout).text();
    const rawStderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return {
      ok: exitCode === 0,
      command: input.command,
      exitCode,
      stdout: normalizeMsys2PathsInText(stdout),
      stderr: cleanMsys2Noise(normalizeMsys2PathsInText(rawStderr)),
    };
  } catch (error) {
    // AbortError 表示用户主动取消，标记为非失败 / AbortError means user cancellation, mark as non-failure
    const isAbort = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      command: input.command,
      exitCode: isAbort ? 130 : -1,
      stdout: "",
      stderr: isAbort ? "Command cancelled by user." : (error instanceof Error ? error.message : String(error)),
    };
  }
}

/** 构建平台特定的 Shell 调用参数 / Build platform-specific shell invocation arguments */
function buildShellInvocation(command: string): string[] {
  if (process.platform === "win32") {
    // Prefer system bash (Git for Windows) — full MSYS2 env, no DLL issues
    // PATH fix: ensures GNU coreutils (find, grep, sort, etc.) take priority
    // over Windows System32 equivalents that shadow them on MSYS2 PATH
    const systemBash = findSystemBash();
    if (systemBash) {
      return [systemBash, "-c", `export PATH="/usr/bin:$PATH" && ${command}`];
    }

    // Fallback to vendored bash with PATH fix for coreutils
    const vendoredBash = findBashBinary();
    if (vendoredBash) {
      return [vendoredBash, "-c", `export PATH="/usr/bin:$PATH" && ${command}`];
    }

    // Last resort: cmd.exe
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    return [`${systemRoot}\\System32\\cmd.exe`, "/d", "/c", command];
  }

  return [process.env.SHELL || "/bin/sh", "-lc", command];
}

/** 过滤 MSYS2 启动时的无害噪音（/tmp 警告等） */
function cleanMsys2Noise(stderr: string): string {
  return stderr.replace(/^bash\.exe: warning: could not find \/tmp, please create!\r?\n/gm, "");
}
