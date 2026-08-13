import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  PROTECTED_WORKSPACE_DIRECTORIES_V1,
  PROTECTED_WORKSPACE_FILE_PREFIXES_V1,
  PROTECTED_WORKSPACE_FILES_V1,
} from '@/core/policies/protected-path';
import { canonicalPathForComparison, msys2ToWindowsPath } from '@/core/tools/path-utils';

/**
 * Paths that remain prohibited even when a user grants one invocation access
 * outside the Workspace. These are persistence, credential, and critical
 * system identities rather than ordinary external files or temp directories.
 */
const DANGEROUS_PATHS = [
  '.bashrc',
  '.bash_profile',
  '.bash_logout',
  '.zshrc',
  '.zprofile',
  '.zlogout',
  '.profile',
  '.cshrc',
  '.tcshrc',
  '.kshrc',
  '.config/fish/',
  '.git/config',
  '.git/hooks/',
  '.gitmodules',
  '.ssh/authorized_keys',
  '.ssh/authorized_keys2',
  '.ssh/config',
  '.ssh/id_',
  '.ssh/known_hosts',
  '.claude/settings.json',
  '.claude/commands/',
  '.claude/agents/',
  '.vscode/settings.json',
  '.vscode/tasks.json',
  '.vscode/launch.json',
  '.vscode/extensions.json',
  '.idea/',
  '.aws/credentials',
  '.aws/config',
  '.npmrc',
  '.yarnrc',
  '.netrc',
  '.git-credentials',
  '.gitconfig',
  '.env',
  '.env.local',
  '.env.production',
  '/etc/crontab',
  '/etc/cron.d/',
  '/etc/sudoers',
  '/etc/sudoers.d/',
  '/etc/passwd',
  '/etc/shadow',
  '/etc/group',
  '/etc/hosts',
  '/etc/resolv.conf',
  '/etc/ssh/sshd_config',
  '/etc/ssh/ssh_config',
  '/private/etc/crontab',
  '/private/etc/sudoers',
  '/private/etc/passwd',
  '/private/etc/shadow',
  '/private/etc/group',
  '/private/etc/hosts',
  '/private/etc/resolv.conf',
  '/private/etc/ssh/sshd_config',
  '/private/etc/ssh/ssh_config',
  'Windows/System32/drivers/etc/hosts',
  'Windows/System32/config/SAM',
  'Windows/System32/config/SECURITY',
  'Windows/System32/config/SYSTEM',
  'crontab',
  'Library/LaunchAgents/',
  'Library/LaunchDaemons/',
  '.config/systemd/user/',
  '/etc/systemd/system/',
  '.config/autostart/',
  '.docker/config.json',
  '.docker/daemon.json',
] as const;

const DANGEROUS_PATH_PATTERNS: RegExp[] = DANGEROUS_PATHS.map((path) => {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = `(?:\\s|>|>>|'|"|/|~|^)`;
  if (path.endsWith('/')) {
    return new RegExp(`${prefix}(${escaped})`, 'i');
  }
  return new RegExp(`${prefix}(${escaped})(?:\\s|'|"|$|/|>)`, 'i');
});

DANGEROUS_PATH_PATTERNS.push(
  /(?:\s|>|>>|'|"|\/|~|^)(\.ssh\/id_[^\s'"/>]*)(?=\s|'|"|$|\/|>)/i,
  /(?:\s|>|>>|'|"|\/|~|^)(\.env(?:\.[A-Za-z0-9_-]+)+)(?=\s|'|"|$|\/|>)/i,
);

/** Return the protected identity referenced by command/path text, if any. */
export function checkDangerousPaths(value: string): string | null {
  const slashNormalized = value.replace(/\\/g, '/');
  const candidates = [slashNormalized, slashNormalized.replace(/["']/g, '')];
  for (const candidate of candidates) {
    for (const pattern of DANGEROUS_PATH_PATTERNS) {
      const match = candidate.match(pattern);
      if (match) return match[1]!;
    }
  }
  return null;
}

export interface FixedDangerousPathIdentityV1 {
  path: string;
  kind: 'directory' | 'file' | 'prefix';
  access: 'read_write' | 'write_only';
}

const HOME_PROTECTED_DIRECTORIES = [
  '.ssh',
  '.aws',
  '.docker',
  '.gnupg',
  '.kube',
  '.agents',
  '.claude',
  '.codex',
  '.kite-code',
  '.vscode',
  '.idea',
  '.config/fish',
  '.config/gh',
  '.config/gcloud',
  '.config/mcp',
  '.config/systemd/user',
  '.config/autostart',
  'Library/LaunchAgents',
  'Library/LaunchDaemons',
] as const;

const HOME_PROTECTED_FILES = [
  '.bashrc',
  '.bash_profile',
  '.bash_logout',
  '.zshrc',
  '.zprofile',
  '.zlogout',
  '.profile',
  '.cshrc',
  '.tcshrc',
  '.kshrc',
  '.envrc',
  '.npmrc',
  '.yarnrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.env',
  '.env.local',
  '.env.production',
] as const;

const UNIX_PROTECTED_FILES = [
  '/etc/crontab',
  '/etc/sudoers',
  '/etc/passwd',
  '/etc/shadow',
  '/etc/group',
  '/etc/hosts',
  '/etc/resolv.conf',
  '/etc/ssh/sshd_config',
  '/etc/ssh/ssh_config',
  '/private/etc/crontab',
  '/private/etc/sudoers',
  '/private/etc/passwd',
  '/private/etc/shadow',
  '/private/etc/group',
  '/private/etc/hosts',
  '/private/etc/resolv.conf',
  '/private/etc/ssh/sshd_config',
  '/private/etc/ssh/ssh_config',
] as const;

const UNIX_PROTECTED_DIRECTORIES = [
  '/etc/cron.d',
  '/etc/sudoers.d',
  '/etc/systemd/system',
] as const;

/**
 * Canonical fixed identities that stay unavailable even when one invocation
 * receives broad external-filesystem authority.
 */
export function resolveFixedDangerousPathIdentitiesV1(input: {
  workspace: string;
  home?: string;
}): FixedDangerousPathIdentityV1[] {
  const home = resolve(input.home ?? homedir());
  const workspace = resolve(input.workspace);
  const identities: FixedDangerousPathIdentityV1[] = [];
  const push = (
    path: string,
    kind: FixedDangerousPathIdentityV1['kind'],
    access: FixedDangerousPathIdentityV1['access'] = 'read_write',
  ) => {
    identities.push({ path: resolve(path), kind, access });
    if (existsSync(path)) {
      try {
        identities.push({ path: realpathSync.native(path), kind, access });
      } catch {
        // Keep the lexical identity; native setup will fail closed if needed.
      }
    }
  };

  for (const path of PROTECTED_WORKSPACE_DIRECTORIES_V1) {
    push(resolve(workspace, path), 'directory');
  }
  for (const path of PROTECTED_WORKSPACE_FILES_V1) push(resolve(workspace, path), 'file');
  for (const path of PROTECTED_WORKSPACE_FILE_PREFIXES_V1) {
    push(resolve(workspace, path), 'prefix');
  }
  for (const path of HOME_PROTECTED_DIRECTORIES) push(resolve(home, path), 'directory');
  for (const path of HOME_PROTECTED_FILES) push(resolve(home, path), 'file');
  push(resolve(home, '.gitconfig'), 'file', 'write_only');
  push(resolve(home, '.env.'), 'prefix');

  if (process.platform !== 'win32') {
    for (const path of UNIX_PROTECTED_DIRECTORIES) push(path, 'directory', 'write_only');
    for (const path of UNIX_PROTECTED_FILES) push(path, 'file', 'write_only');
  }

  const unique = new Map<string, FixedDangerousPathIdentityV1>();
  for (const identity of identities) {
    const key = `${process.platform === 'win32' ? identity.path.toLowerCase() : identity.path}\0${identity.kind}\0${identity.access}`;
    unique.set(key, identity);
  }
  return [...unique.values()];
}

/** Resolve aliases before applying fixed-path policy to built-in file tools. */
export function checkDangerousCanonicalPathV1(value: string, workspace: string): string | null {
  try {
    const normalized = msys2ToWindowsPath(value);
    const expanded =
      normalized === '~'
        ? homedir()
        : normalized.startsWith('~/') || normalized.startsWith(`~${sep}`)
          ? resolve(homedir(), normalized.slice(2))
          : isAbsolute(normalized)
            ? normalized
            : resolve(workspace, normalized);
    const candidate = canonicalPathForComparison(expanded);
    for (const identity of resolveFixedDangerousPathIdentitiesV1({ workspace })) {
      const protectedPath = canonicalPathForComparison(identity.path);
      const rel = relative(protectedPath, candidate);
      const same = rel === '';
      const descendant = !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      if (
        (identity.kind === 'file' && same) ||
        (identity.kind === 'directory' && (same || descendant)) ||
        (identity.kind === 'prefix' && candidate.startsWith(protectedPath))
      ) {
        return identity.path;
      }
    }
  } catch {
    // Invalid paths are handled by the ordinary path-policy fail-closed path.
  }
  return null;
}
