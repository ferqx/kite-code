import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ShellInput, ShellResult } from "../shared/types";

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
    const simpleReadFallback = trySimpleReadFallback(input, error);
    if (simpleReadFallback) {
      return simpleReadFallback;
    }
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
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const powershellPath =
      process.env.POWERSHELL ||
      `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    return [powershellPath, "-NoProfile", "-Command", command];
  }

  return [process.env.SHELL || "/bin/sh", "-lc", command];
}

/** Shell 不可用时的简单读回退（如 pwd）/ Simple read fallback when shell is unavailable (e.g. pwd) */
function trySimpleReadFallback(input: ShellInput, error: unknown): ShellResult | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("uv_spawn")) return null;
  if (input.command.trim() !== "pwd") return null;

  return {
    ok: true,
    command: input.command,
    exitCode: 0,
    stdout: `${resolve(input.workspace)}\n`,
    stderr: "",
  };
}
