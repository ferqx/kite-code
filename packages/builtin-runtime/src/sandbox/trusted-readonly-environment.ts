import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export const POLICY_PROVEN_READ_ONLY_EXECUTION = 'policy_proven_read_only' as const;

const POSIX_ENV_KEYS = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'TERM',
  'TMP',
  'TMPDIR',
  'TEMP',
  'USER',
] as const;

const WINDOWS_ENV_KEYS = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMPUTERNAME',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'SESSIONNAME',
  'SystemDrive',
  'SystemRoot',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TEMP',
  'TMP',
] as const;

export interface WorkspaceExcludedPathOptions {
  platform?: NodeJS.Platform;
  pathValue?: string;
  canonicalize?: (path: string) => string;
  systemRoot?: string;
}

export function isCanonicalPathOutsideWorkspace(
  workspace: string,
  candidate: string,
  options: Pick<WorkspaceExcludedPathOptions, 'platform' | 'canonicalize'> = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const canonicalize = options.canonicalize ?? realpathSync.native;
  try {
    const workspaceRoot = canonicalize(paths.resolve(workspace));
    const canonicalCandidate = canonicalize(paths.resolve(candidate));
    const relative = paths.relative(workspaceRoot, canonicalCandidate);
    return (
      relative !== '' &&
      (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))
    );
  } catch {
    return false;
  }
}

function stripPathEntryQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/**
 * Canonicalize PATH directories and remove relative entries plus every entry
 * whose real identity is the Workspace or one of its descendants.
 */
export function buildWorkspaceExcludedPath(
  workspace: string,
  options: WorkspaceExcludedPathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const canonicalize = options.canonicalize ?? realpathSync.native;
  const workspaceRoot = canonicalize(paths.resolve(workspace));
  const entries = (options.pathValue ?? process.env.PATH ?? '').split(delimiter);
  const accepted: string[] = [];
  const seen = new Set<string>();

  for (const rawEntry of entries) {
    const entry = stripPathEntryQuotes(rawEntry.trim());
    if (!entry || !paths.isAbsolute(entry)) continue;
    let canonical: string;
    try {
      canonical = canonicalize(paths.resolve(entry));
    } catch {
      continue;
    }
    const relative = paths.relative(workspaceRoot, canonical);
    if (
      relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
    ) {
      continue;
    }
    const identity = platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (seen.has(identity)) continue;
    seen.add(identity);
    accepted.push(canonical);
  }

  if (accepted.length > 0) return accepted.join(delimiter);

  const fallbacks =
    platform === 'win32'
      ? [win32.join(options.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows', 'System32')]
      : ['/usr/bin', '/bin'];
  for (const fallback of fallbacks) {
    try {
      const canonical = canonicalize(fallback);
      const relative = paths.relative(workspaceRoot, canonical);
      if (
        relative !== '' &&
        (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))
      ) {
        accepted.push(canonical);
      }
    } catch {
      // A missing fallback is omitted. An empty PATH fails command lookup closed.
    }
  }
  return accepted.join(delimiter);
}

/** Build the minimal process environment used by policy-proven read-only Shell. */
export function buildPolicyProvenReadOnlyEnv(
  workspace: string,
  options: WorkspaceExcludedPathOptions & { env?: NodeJS.ProcessEnv } = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const source = options.env ?? process.env;
  const keys = platform === 'win32' ? WINDOWS_ENV_KEYS : POSIX_ENV_KEYS;
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.PATH = buildWorkspaceExcludedPath(workspace, {
    ...options,
    pathValue: options.pathValue ?? source.PATH,
  });
  return env;
}
