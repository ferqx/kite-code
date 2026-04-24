import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ApplyPatchInput,
  ApplyPatchResult,
  ShellInput,
  ShellResult,
} from "./types";

export type ShellExecutor = (input: ShellInput) => Promise<ShellResult>;

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

function trySimpleReadFallback(input: ShellInput, error: unknown): ShellResult | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("uv_spawn")) {
    return null;
  }

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

function tryGeneratedSetContentFallback(
  input: ShellInput,
  error: unknown,
): ShellResult | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("uv_spawn") || !input.command.includes("Set-Content")) {
    return null;
  }

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

export function buildApplyPatchCommand(target: string, content: string): string {
  const encoded = Buffer.from(content, "utf8").toString("base64");
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

  return [
    `$encoded = '${encoded}'`,
    "$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))",
    `Set-Content -LiteralPath '${escapePowerShellSingleQuoted(target)}' -Value $text -NoNewline -Encoding UTF8`,
  ].join("; ");
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function escapePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
