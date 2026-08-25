import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { WorkspaceFilesystemProtectedBoundary } from '@kite-ai/runtime-spi';
import {
  canonicalPathForComparison,
  isPathInsideWorkspace,
  msys2ToWindowsPath,
} from './path-utils';
import type { ProtectedPathPolicy } from './types';

export type ProtectedPathOperation = 'read' | 'write' | 'execute';

export interface ProtectedPathAccess {
  path: string;
  operation: ProtectedPathOperation;
}

export type ProtectedPathDecisionReason =
  | 'allowed_workspace_path'
  | 'allowed_read_path'
  | 'outside_workspace'
  | 'protected_directory'
  | 'protected_file'
  | 'additional_deny'
  | 'outside_allowlist'
  | 'invalid_path';

export interface ProtectedPathDecision extends ProtectedPathAccess {
  lexicalPath: string | null;
  lexicalRelativePath: string | null;
  canonicalPath: string | null;
  relativePath: string | null;
  outcome: 'allow' | 'deny' | 'prompt';
  reason: ProtectedPathDecisionReason;
  matchedRule?: string;
}

export interface ProtectedPathEvaluator {
  readonly version: 1;
  readonly workspaceRoot: string;
  readonly mode: ProtectedPathPolicy;
  evaluate(access: ProtectedPathAccess): ProtectedPathDecision;
  /** Complete JSON-safe policy projection; Provider never receives this evaluator. */
  projectFilesystemBoundary(): Readonly<
    Omit<WorkspaceFilesystemProtectedBoundary, 'schema' | 'boundaryDigest'>
  >;
}

export interface CreateProtectedPathEvaluatorInput {
  workspaceRoot: string;
  mode: ProtectedPathPolicy;
  /** Retained for protocol compatibility; Workspace members are never denied by name. */
  additionalDeniedPaths?: readonly string[];
  /** Retained for protocol compatibility; the canonical Workspace remains wholly admitted. */
  allowedPaths?: readonly string[];
}

/** Legacy protected names used only when their canonical identity is outside Workspace. */
export const PROTECTED_WORKSPACE_DIRECTORIES_ = Object.freeze([
  '.git',
  '.ssh',
  '.aws',
  '.docker',
  '.gnupg',
  '.kube',
  '.direnv',
  '.agents',
  '.claude',
  '.codex',
  '.kite-code',
  '.openpx',
  '.vscode',
  '.idea',
  '.config/fish',
  '.config/gh',
  '.config/gcloud',
  '.config/openpx',
  '.config/mcp',
  '.config/systemd/user',
  '.config/autostart',
  'Library/LaunchAgents',
  'Library/LaunchDaemons',
] as const);

/** Legacy protected filenames used only outside the canonical Workspace. */
export const PROTECTED_WORKSPACE_FILES_ = Object.freeze([
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
  '.gitmodules',
  '.env',
  '.env.local',
  '.env.production',
  '.mcp.json',
  'mcp.json',
] as const);

/** Legacy protected filename prefixes used only outside the canonical Workspace. */
export const PROTECTED_WORKSPACE_FILE_PREFIXES_ = Object.freeze(['.env.'] as const);

function pathFromWorkspace(workspaceRoot: string, candidate: string): string {
  if (candidate.includes('\0')) throw new Error('Path contains a NUL byte.');
  const normalized = msys2ToWindowsPath(candidate);
  if (normalized === '~') return homedir();
  if (normalized.startsWith(`~${sep}`) || normalized.startsWith('~/')) {
    return resolve(homedir(), normalized.slice(2));
  }
  return isAbsolute(normalized) ? resolve(normalized) : resolve(workspaceRoot, normalized || '.');
}

function toPolicyRelativePath(workspaceRoot: string, canonicalPath: string): string | null {
  if (!isPathInsideWorkspace(workspaceRoot, canonicalPath)) return null;
  return relative(workspaceRoot, canonicalPath).split(sep).join('/');
}

function toLexicalRelativePath(workspaceRoot: string, targetPath: string): string | null {
  const rel = relative(workspaceRoot, targetPath);
  if (rel === '') return '';
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

function denyOutcome(mode: ProtectedPathPolicy): 'deny' | 'prompt' {
  return mode === 'deny' ? 'deny' : 'prompt';
}

/**
 * Compile the release-owned path boundary once per run. File reads are
 * unrestricted, the canonical Workspace is admitted as one complete identity
 * for read/write/execute regardless of path name, and external mutations remain
 * pending until the Tool Pipeline supplies an exact approval grant.
 */
export function createProtectedPathEvaluator(
  input: CreateProtectedPathEvaluatorInput,
): ProtectedPathEvaluator {
  const lexicalWorkspaceRoot = resolve(input.workspaceRoot);
  const workspaceRoot = canonicalPathForComparison(input.workspaceRoot);

  return Object.freeze({
    version: 1 as const,
    workspaceRoot,
    mode: input.mode,
    projectFilesystemBoundary() {
      return deepFreeze({
        canonicalWorkspace: workspaceRoot,
        policyMode: input.mode,
        excludedSubtrees: [],
        excludedFiles: [],
        excludedFilePrefixes: [],
        additionalDeniedCanonicalPaths: [],
        allowedCanonicalPaths: [],
      });
    },
    evaluate(access: ProtectedPathAccess): ProtectedPathDecision {
      let lexicalPath: string;
      let canonicalPath: string;
      try {
        lexicalPath = pathFromWorkspace(workspaceRoot, access.path);
        canonicalPath = canonicalPathForComparison(lexicalPath);
      } catch {
        return {
          ...access,
          lexicalPath: null,
          lexicalRelativePath: null,
          canonicalPath: null,
          relativePath: null,
          outcome: denyOutcome(input.mode),
          reason: 'invalid_path',
        };
      }
      const relativePath = toPolicyRelativePath(workspaceRoot, canonicalPath);
      const lexicalRelativePath =
        toLexicalRelativePath(workspaceRoot, lexicalPath) ??
        toLexicalRelativePath(lexicalWorkspaceRoot, lexicalPath);
      const base = { ...access, lexicalPath, lexicalRelativePath, canonicalPath, relativePath };

      if (access.operation === 'read') {
        return { ...base, outcome: 'allow', reason: 'allowed_read_path' };
      }

      if (access.operation === 'write') {
        return relativePath === null
          ? { ...base, outcome: 'prompt', reason: 'outside_workspace' }
          : { ...base, outcome: 'allow', reason: 'allowed_workspace_path' };
      }

      if (relativePath === null) {
        return { ...base, outcome: denyOutcome(input.mode), reason: 'outside_workspace' };
      }

      return { ...base, outcome: 'allow', reason: 'allowed_workspace_path' };
    },
  });
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
