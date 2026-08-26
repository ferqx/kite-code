import { isAbsolute, resolve } from 'node:path';

export type WorkspaceDigest = `sha256:${string}`;

export interface AdmittedWorkspace {
  readonly canonicalPath: string;
  readonly projectId: string;
  readonly workspaceDigest: WorkspaceDigest;
}

export interface RuntimeWorkspaceAdmission {
  admitForCreate(workspace: string): Promise<AdmittedWorkspace>;
  resolveForSession(sessionId: string): Promise<AdmittedWorkspace | undefined>;
}

export type RuntimeWorkspaceAdmissionErrorCode =
  | 'invalid_workspace_identity'
  | 'workspace_unavailable'
  | 'workspace_untrusted'
  | 'session_not_found';

export class RuntimeWorkspaceAdmissionError extends Error {
  readonly code: RuntimeWorkspaceAdmissionErrorCode;

  constructor(code: RuntimeWorkspaceAdmissionErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeWorkspaceAdmissionError';
    this.code = code;
  }
}

export interface RuntimeWorkspaceAdmissionDependencies {
  /** Native realpath, trust and project identity checks belong to this injected owner. */
  readonly admitForCreate: (workspace: string) => Promise<AdmittedWorkspace>;
  /** Reads the persisted Session identity; it must not use a caller-supplied display path. */
  readonly resolveForSession: (sessionId: string) => Promise<AdmittedWorkspace | undefined>;
}

const WORKSPACE_DIGEST = /^sha256:[a-f0-9]{64}$/u;

function noControlCharacters(value: string): boolean {
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

export function freezeAdmittedWorkspace(value: AdmittedWorkspace): AdmittedWorkspace {
  if (
    typeof value.canonicalPath !== 'string' ||
    !isAbsolute(value.canonicalPath) ||
    resolve(value.canonicalPath) !== value.canonicalPath ||
    !noControlCharacters(value.canonicalPath) ||
    typeof value.projectId !== 'string' ||
    value.projectId.length === 0 ||
    value.projectId.length > 512 ||
    !noControlCharacters(value.projectId) ||
    typeof value.workspaceDigest !== 'string' ||
    !WORKSPACE_DIGEST.test(value.workspaceDigest)
  ) {
    throw new RuntimeWorkspaceAdmissionError(
      'invalid_workspace_identity',
      'Admitted Workspace must contain a canonical absolute path, project ID, and sha256 digest.',
    );
  }
  return Object.freeze({
    canonicalPath: value.canonicalPath,
    projectId: value.projectId,
    workspaceDigest: value.workspaceDigest,
  });
}

/**
 * App-local admission seam. It validates and freezes the injected result but deliberately does
 * not canonicalize the filesystem itself: that authority remains with the Service owner.
 */
export function createRuntimeWorkspaceAdmission(
  dependencies: RuntimeWorkspaceAdmissionDependencies,
): RuntimeWorkspaceAdmission {
  return Object.freeze({
    admitForCreate: async (workspace: string) => {
      const admitted = await dependencies.admitForCreate(workspace);
      return freezeAdmittedWorkspace(admitted);
    },
    resolveForSession: async (sessionId: string) => {
      const admitted = await dependencies.resolveForSession(sessionId);
      return admitted === undefined ? undefined : freezeAdmittedWorkspace(admitted);
    },
  });
}
