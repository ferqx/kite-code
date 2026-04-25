import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ApplyPatchInput,
  ApplyPatchResult,
  ShellInput,
  ShellResult,
} from "./types";

/** Shell 执行器函数签名 / Shell executor function signature */
export type ShellExecutor = (input: ShellInput) => Promise<ShellResult>;

/** 断言目标路径在工作区范围内，解析绝对路径，若逃逸则抛出异常 / Assert target path is inside workspace, resolve absolute path, throw if escaping */
export function assertInsideWorkspace(workspace: string, targetPath: string): string {
  // 解析工作区根目录 / Resolve workspace root
  const workspaceRoot = resolve(workspace);
  // 将目标路径规范化后解析为绝对路径 / Normalize target path and resolve to absolute
  const absoluteTarget = resolve(
    workspaceRoot,
    targetPath.replace(/[\\/]+/g, "/"),
  );
  // 计算相对路径用于逃逸检测 / Compute relative path for escape detection
  const relativeTarget = relative(workspaceRoot, absoluteTarget);

  // 检测路径逃逸：相对路径为 ".."、以 "../" 开头或仍是绝对路径 / Detect path escape: relative path is "..", starts with "../", or is still absolute
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

/** 执行文件补丁操作，创建父目录并通过 Shell 写入文件 / Execute file patch operation, create parent directories and write via shell */
export async function applyPatchTool(
  input: ApplyPatchInput,
): Promise<ApplyPatchResult> {
  const target = assertInsideWorkspace(input.workspace, input.path);
  mkdirSync(dirname(target), { recursive: true });
  const executor = input.shellExecutor ?? shellTool;
  const result = await executor({
    workspace: input.workspace,
    command: buildApplyPatchCommand(target, input.content),
  });
  return {
    ok: result.ok,
    path: target,
    message: result.ok ? `Wrote ${input.path}` : result.stderr || result.stdout,
  };
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
    // 回退链：先尝试简单读回退，再尝试 Set-Content 回退 / Fallback chain: try simple read fallback first, then Set-Content fallback
    const simpleReadFallback = trySimpleReadFallback(input, error);
    if (simpleReadFallback) {
      return simpleReadFallback;
    }
    const fallback = tryGeneratedSetContentFallback(input, error);
    if (fallback) {
      return fallback;
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
  // Windows 平台使用 PowerShell / Use PowerShell on Windows
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const powershellPath =
      process.env.POWERSHELL ||
      `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    return [powershellPath, "-NoProfile", "-Command", command];
  }

  // POSIX 平台使用 sh / Use sh on POSIX
  return [process.env.SHELL || "/bin/sh", "-lc", command];
}

/** Shell 不可用时的简单读回退（如 pwd）/ Simple read fallback when shell is unavailable (e.g. pwd) */
function trySimpleReadFallback(input: ShellInput, error: unknown): ShellResult | null {
  const message = error instanceof Error ? error.message : String(error);
  // 仅处理 uv_spawn 错误 / Only handle uv_spawn errors
  if (!message.includes("uv_spawn")) {
    return null;
  }

  // 仅回退 pwd 命令 / Only fallback for pwd command
  if (input.command.trim() !== "pwd") {
    return null;
  }

  return {
    ok: true,
    command: input.command,
    exitCode: 0,
    stdout: `${resolve(input.workspace)}\n`,
    stderr: "",
  };
}

/** Shell 不可用时生成 Set-Content 回退 / Generated Set-Content fallback when shell unavailable */
function tryGeneratedSetContentFallback(
  input: ShellInput,
  error: unknown,
): ShellResult | null {
  const message = error instanceof Error ? error.message : String(error);
  // 仅处理 uv_spawn 错误且命令包含 Set-Content / Only handle uv_spawn errors with Set-Content command
  if (!message.includes("uv_spawn") || !input.command.includes("Set-Content")) {
    return null;
  }

  // 从命令中提取 base64 编码内容和目标路径 / Extract base64-encoded content and target path from command
  const encoded = input.command.match(/\$encoded = '([^']+)'/)?.[1];
  const path = input.command.match(/Set-Content -LiteralPath '((?:''|[^'])+)'/)?.[1];
  if (!encoded || !path) {
    return null;
  }

  const target = path.replaceAll("''", "'");
  const content = Buffer.from(encoded, "base64").toString("utf8");
  return {
    ok: false,
    command: input.command,
    exitCode: -1,
    stdout: "",
    stderr: `Shell execution unavailable in this Bun sandbox: ${message}. Generated command targeted ${target} with ${content.length} bytes.`,
  };
}

/** 构建平台特定的补丁命令（POSIX 用 bun -e，Windows 用 PowerShell Set-Content）/ Build platform-specific patch command (bun -e for POSIX, PowerShell Set-Content for Windows) */
export function buildApplyPatchCommand(target: string, content: string): string {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  // POSIX 平台：使用 bun -e 执行内联 JS 脚本写入文件 / POSIX: use bun -e to run inline JS script that writes the file
  if (process.platform !== "win32") {
    const script = [
      "const fs = require('node:fs')",
      "const content = Buffer.from(process.argv[2], 'base64').toString('utf8')",
      "fs.writeFileSync(process.argv[1], content)",
    ].join("; ");
    return [
      "bun",
      "-e",
      escapePosixShellArg(script),
      "--",
      escapePosixShellArg(target),
      escapePosixShellArg(encoded),
    ].join(" ");
  }

  // Windows 平台：使用 PowerShell Set-Content 写入文件 / Windows: use PowerShell Set-Content to write file
  return [
    `$encoded = '${encoded}'`,
    "$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))",
    `Set-Content -LiteralPath '${escapePowerShellSingleQuoted(target)}' -Value $text -NoNewline -Encoding UTF8`,
  ].join("; ");
}

/** 转义 PowerShell 单引号字符串 / Escape PowerShell single-quoted string */
function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

/** 转义 POSIX Shell 参数 / Escape POSIX shell argument */
function escapePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
