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

export interface SystemBashCandidates {
  /** Paths derived from git installation, if git is found */
  gitDerived: string[];
  /** bash found directly in PATH (may include WSL stub) */
  pathBash: string | null;
}

/** Gather candidate bash paths from the system (pure logic, testable) */
export function gatherSystemBashCandidates(
  which: (name: string) => string | null,
  systemRoot: string,
): SystemBashCandidates {
  const gitDerived: string[] = [];
  const gitPath = which("git");
  if (gitPath) {
    const gitDir = join(gitPath, "..");
    for (const rel of ["bash.exe", join("..", "bin", "bash.exe"), join("..", "usr", "bin", "bash.exe")]) {
      gitDerived.push(join(gitDir, rel));
    }
  }
  return { gitDerived, pathBash: which("bash") };
}

/** Check if a path is a WSL stub (under SystemRoot like C:\Windows) */
export function isWslStubPath(p: string, systemRoot: string): boolean {
  return p.replace(/\\/g, "/").toLowerCase().startsWith(
    systemRoot.replace(/\\/g, "/").toLowerCase() + "/",
  );
}

/** 定位系统自带 bash（Git for Windows / MSYS2）/ Locate system bash (Git for Windows / MSYS2) */
export function findSystemBash(): string | null {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const { gitDerived, pathBash } = gatherSystemBashCandidates(
    (name) => Bun.which(name),
    systemRoot,
  );

  // 优先通过 git 定位 Git for Windows 带的 bash（最可靠）
  for (const candidate of gitDerived) {
    if (existsSync(candidate)) return candidate;
  }

  // Fallback: bash in PATH, skip WSL stub
  if (pathBash && !isWslStubPath(pathBash, systemRoot)) {
    return pathBash;
  }

  return null;
}
