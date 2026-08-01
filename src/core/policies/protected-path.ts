import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ProtectedPathPolicy } from '@/core/sandbox/types';
import {
  canonicalPathForComparison,
  isPathInsideWorkspace,
  msys2ToWindowsPath,
} from '@/core/tools/path-utils';

export type ProtectedPathOperationV1 = 'read' | 'write' | 'execute';

export interface ProtectedPathAccessV1 {
  path: string;
  operation: ProtectedPathOperationV1;
}

export type ProtectedPathDecisionReasonV1 =
  | 'allowed_workspace_path'
  | 'outside_workspace'
  | 'protected_directory'
  | 'protected_file'
  | 'additional_deny'
  | 'outside_allowlist'
  | 'invalid_path';

export interface ProtectedPathDecisionV1 extends ProtectedPathAccessV1 {
  lexicalPath: string | null;
  lexicalRelativePath: string | null;
  canonicalPath: string | null;
  relativePath: string | null;
  outcome: 'allow' | 'deny' | 'prompt';
  reason: ProtectedPathDecisionReasonV1;
  matchedRule?: string;
}

export interface ProtectedPathEvaluatorV1 {
  readonly version: 1;
  readonly workspaceRoot: string;
  readonly mode: ProtectedPathPolicy;
  evaluate(access: ProtectedPathAccessV1): ProtectedPathDecisionV1;
}

export interface CreateProtectedPathEvaluatorV1Input {
  workspaceRoot: string;
  mode: ProtectedPathPolicy;
  /** Additional deny roots are unioned with the built-in protected set. */
  additionalDeniedPaths?: readonly string[];
  /** Optional tighter allow roots. Built-in and additional denies are evaluated first. */
  allowedPaths?: readonly string[];
}

/** Root-relative directories hidden from every model-driven filesystem operation. */
export const PROTECTED_WORKSPACE_DIRECTORIES_V1 = Object.freeze([
  '.git',
  '.ssh',
  '.aws',
  '.docker',
  '.claude',
  '.codex',
  '.kite-code',
  '.openpx',
  '.vscode',
  '.idea',
  '.config/openpx',
  '.config/mcp',
] as const);

/** Root-relative files hidden from every model-driven filesystem operation. */
export const PROTECTED_WORKSPACE_FILES_V1 = Object.freeze([
  '.bashrc',
  '.bash_profile',
  '.bash_logout',
  '.zshrc',
  '.zprofile',
  '.zlogout',
  '.profile',
  '.npmrc',
  '.yarnrc',
  '.netrc',
  '.git-credentials',
  '.gitmodules',
  '.env',
  '.env.local',
  '.env.production',
  '.mcp.json',
  'mcp.json',
] as const);

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

function isSameOrDescendant(relativePath: string, rule: string): boolean {
  return relativePath === rule || relativePath.startsWith(`${rule}/`);
}

function denyOutcome(mode: ProtectedPathPolicy): 'deny' | 'prompt' {
  return mode === 'deny' ? 'deny' : 'prompt';
}

/**
 * Compile the release-owned protected-path boundary once per run. Every
 * decision contains the canonical target and operation; deny roots are always
 * evaluated before optional allow roots, so an allow cannot reopen `.git` or
 * another protected identity.
 */
export function createProtectedPathEvaluatorV1(
  input: CreateProtectedPathEvaluatorV1Input,
): ProtectedPathEvaluatorV1 {
  const lexicalWorkspaceRoot = resolve(input.workspaceRoot);
  const workspaceRoot = canonicalPathForComparison(input.workspaceRoot);
  const additionalDeniedPaths = (input.additionalDeniedPaths ?? []).map((path) =>
    canonicalPathForComparison(pathFromWorkspace(workspaceRoot, path)),
  );
  const allowedPaths = (input.allowedPaths ?? []).map((path) =>
    canonicalPathForComparison(pathFromWorkspace(workspaceRoot, path)),
  );

  return Object.freeze({
    version: 1 as const,
    workspaceRoot,
    mode: input.mode,
    evaluate(access: ProtectedPathAccessV1): ProtectedPathDecisionV1 {
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

      if (relativePath === null) {
        return { ...base, outcome: denyOutcome(input.mode), reason: 'outside_workspace' };
      }

      const protectedDirectory = PROTECTED_WORKSPACE_DIRECTORIES_V1.find(
        (rule) =>
          isSameOrDescendant(relativePath, rule) ||
          (lexicalRelativePath !== null && isSameOrDescendant(lexicalRelativePath, rule)),
      );
      if (protectedDirectory) {
        return {
          ...base,
          outcome: denyOutcome(input.mode),
          reason: 'protected_directory',
          matchedRule: protectedDirectory,
        };
      }

      const protectedFile = PROTECTED_WORKSPACE_FILES_V1.find(
        (rule) => relativePath === rule || lexicalRelativePath === rule,
      );
      if (protectedFile) {
        return {
          ...base,
          outcome: denyOutcome(input.mode),
          reason: 'protected_file',
          matchedRule: protectedFile,
        };
      }

      const additionalDeny = additionalDeniedPaths.find((path) =>
        isPathInsideWorkspace(path, canonicalPath),
      );
      if (additionalDeny) {
        return {
          ...base,
          outcome: denyOutcome(input.mode),
          reason: 'additional_deny',
          matchedRule: additionalDeny,
        };
      }

      if (
        allowedPaths.length > 0 &&
        !allowedPaths.some((path) => isPathInsideWorkspace(path, canonicalPath))
      ) {
        return { ...base, outcome: denyOutcome(input.mode), reason: 'outside_allowlist' };
      }

      return { ...base, outcome: 'allow', reason: 'allowed_workspace_path' };
    },
  });
}
