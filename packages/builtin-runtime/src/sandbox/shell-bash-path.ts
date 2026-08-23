import { existsSync } from 'node:fs';
import { join } from 'node:path';

function resolveProjectRoot(): string {
  return join(import.meta.dirname, '..', '..', '..', '..');
}

/** Locate the vendored Bash runtime without accepting a Workspace path. */
export function findBashBinary(): string | null {
  const path = join(resolveProjectRoot(), 'vendor', 'msys2', 'usr', 'bin', 'bash.exe');
  return existsSync(path) ? path : null;
}

export interface SystemBashCandidates {
  /** Paths derived from git installation, if git is found. */
  gitDerived: string[];
  /** Bash found directly in PATH (may include a WSL stub). */
  pathBash: string | null;
}

/** Gather candidate Bash paths from the system; kept pure for deterministic tests. */
export function gatherSystemBashCandidates(
  which: (name: string) => string | null,
  _systemRoot: string,
): SystemBashCandidates {
  const gitDerived: string[] = [];
  const gitPath = which('git');
  if (gitPath) {
    const gitDir = join(gitPath, '..');
    for (const rel of [
      'bash.exe',
      join('..', 'bin', 'bash.exe'),
      join('..', 'usr', 'bin', 'bash.exe'),
    ]) {
      gitDerived.push(join(gitDir, rel));
    }
  }
  return { gitDerived, pathBash: which('bash') };
}

/** Check if a path is a WSL stub under SystemRoot. */
export function isWslStubPath(path: string, systemRoot: string): boolean {
  return path
    .replace(/\\/g, '/')
    .toLowerCase()
    .startsWith(`${systemRoot.replace(/\\/g, '/').toLowerCase()}/`);
}

/** Locate system Bash while excluding the Windows WSL launcher stub. */
export function findSystemBash(): string | null {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const { gitDerived, pathBash } = gatherSystemBashCandidates(
    (name) => Bun.which(name),
    systemRoot,
  );

  for (const candidate of gitDerived) {
    if (existsSync(candidate)) return candidate;
  }
  if (pathBash && !isWslStubPath(pathBash, systemRoot)) return pathBash;
  return null;
}
