import { existsSync } from "node:fs";
import { join } from "node:path";

function resolveProjectRoot(): string {
  return join(import.meta.dirname, "..", "..", "..");
}

/** 定位 vendored bash.exe / Locate the vendored bash.exe */
export function findBashBinary(): string | null {
  const path = join(resolveProjectRoot(), "vendor", "msys2", "usr", "bin", "bash.exe");
  if (existsSync(path)) return path;
  return null;
}

/** 定位系统自带 bash（Git for Windows / MSYS2）/ Locate system bash (Git for Windows / MSYS2) */
export function findSystemBash(): string | null {
  // Prefer bash directly in PATH (Git for Windows, MSYS2, Cygwin)
  const bashPath = Bun.which("bash");
  if (bashPath) return bashPath;

  // Fallback: find git.exe → derive bash path (Git for Windows layout)
  const gitPath = Bun.which("git");
  if (gitPath) {
    // git.exe is at <Git>\cmd\git.exe or <Git>\bin\git.exe
    // bash.exe is at <Git>\bin\bash.exe
    const gitDir = join(gitPath, "..");
    const candidates = [
      join(gitDir, "bash.exe"),
      join(gitDir, "..", "bin", "bash.exe"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}
