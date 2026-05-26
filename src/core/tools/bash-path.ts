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
  // 优先通过 git 定位 Git for Windows 带的 bash（最可靠）
  // Prefer deriving bash from Git for Windows installation (most reliable)
  const gitPath = Bun.which("git");
  if (gitPath) {
    // git.exe is at <Git>\cmd\git.exe or <Git>\bin\git.exe or <Git>\mingw64\bin\git.exe
    // bash.exe is at <Git>\bin\bash.exe or <Git>\usr\bin\bash.exe
    const gitDir = join(gitPath, "..");
    const candidates = [
      join(gitDir, "bash.exe"),
      join(gitDir, "..", "bin", "bash.exe"),
      join(gitDir, "..", "usr", "bin", "bash.exe"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }

  // Fallback: bash in PATH, skip WSL stub at C:\Windows\System32\bash.exe
  const bashPath = Bun.which("bash");
  if (bashPath) {
    const normalized = bashPath.replace(/\\/g, "/").toLowerCase();
    const windir = (process.env.SystemRoot || "C:\\Windows").replace(/\\/g, "/").toLowerCase();
    // Skip WSL stub — it requires Hyper-V and causes HCS_E_HYPERV_NOT_INSTALLED
    if (!normalized.startsWith(windir + "/")) {
      return bashPath;
    }
  }

  return null;
}
