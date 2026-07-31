import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { z } from 'zod';
import type {
  ExecutionBackendCapabilitiesV1,
  ExecutionBoundaryAdmissionReasonV1,
  ExecutionBoundaryAdmissionV1,
  ExecutionBoundaryV1,
  ExecutionCapabilitySurfaceV1,
  FilesystemScope,
  ProductionExecutionEntrypointV1,
  ProductionExecutionQualificationRegistryV1,
  ProductionExecutionQualificationV1,
} from '@/core/sandbox/types';
import {
  loadApprovedProductionExecutionQualificationRegistryV1,
  parseProductionExecutionQualificationV1,
  resolveProductionExecutionQualificationFromRegistryV1,
} from './execution-qualification';
import { canonicalWorkspaceKey } from './mcp-project-approvals';

const HOST_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const networkHostSchema = z
  .string()
  .trim()
  .min(1)
  .transform((host) => host.toLowerCase().replace(/\.$/, ''))
  .pipe(
    z
      .string()
      .regex(HOST_PATTERN, 'networkAllowlist entries must be exact DNS hostnames')
      .refine((host) => isIP(host) === 0, 'networkAllowlist does not accept IP literals'),
  );

const executionBoundaryObjectV1Schema = z
  .object({
    filesystemScope: z.enum(['read_only', 'workspace_write', 'full_access']),
    workspaceRoot: z.string().trim().min(1),
    networkMode: z.enum(['off', 'allowlist']),
    networkAllowlist: z.array(networkHostSchema),
    allowLocalAndPrivateNetwork: z.literal(false),
    protectedPathPolicy: z.enum(['deny', 'prompt']),
    maxProcessTreeSizePerShellInvocation: z.number().int().positive().finite(),
    sandboxRequired: z.boolean(),
    sandboxUnavailable: z.enum(['fail', 'verified_in_process_read_only']),
  })
  .strict()
  .superRefine((boundary, context) => {
    if (boundary.networkMode === 'off' && boundary.networkAllowlist.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['networkAllowlist'],
        message: 'networkAllowlist must be empty when networkMode is off',
      });
    }
    if (boundary.networkMode === 'allowlist' && boundary.networkAllowlist.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['networkAllowlist'],
        message: 'networkAllowlist must contain at least one exact host in allowlist mode',
      });
    }
    try {
      const workspaceRoot = realpathSync.native(resolve(boundary.workspaceRoot));
      if (!statSync(workspaceRoot).isDirectory()) throw new Error('not a directory');
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['workspaceRoot'],
        message: 'workspaceRoot must resolve to an existing canonical workspace',
      });
    }
  })
  .transform(
    (boundary): ExecutionBoundaryV1 => ({
      ...boundary,
      workspaceRoot: realpathSync.native(resolve(boundary.workspaceRoot)),
      networkAllowlist: [...new Set(boundary.networkAllowlist)].sort(),
    }),
  );

/** Strict parser for the release-owned execution boundary. */
export const executionBoundaryV1Schema = executionBoundaryObjectV1Schema;

export { executionBackendCapabilitiesV1Schema } from './execution-qualification';

export interface TightenExecutionBoundaryInputV1 {
  ceiling: unknown;
  tightening: unknown;
}

export interface ExecutionBoundaryAdmissionInputV1 {
  featureEnabled: boolean;
  boundary?: unknown;
  workspaceRoot: string;
  entrypoint: ProductionExecutionEntrypointV1;
  sandboxEnabled: boolean;
}

export interface ExecutionBoundaryQualificationEvaluationInputV1 {
  featureEnabled: boolean;
  boundary?: unknown;
  workspaceRoot: string;
  qualification?: unknown;
}

const NO_CAPABILITIES: Readonly<ExecutionCapabilitySurfaceV1> = Object.freeze({
  inProcessReadOnlyTools: null,
  network: false,
  process: false,
  write: false,
  workspaceWrite: false,
  shell: false,
  skillChild: false,
  localStdioMcp: false,
});

function denied(reason: ExecutionBoundaryAdmissionReasonV1): ExecutionBoundaryAdmissionV1 {
  return { allowed: false, admissionKind: 'denied', reason, surface: { ...NO_CAPABILITIES } };
}

export function parseExecutionBoundaryV1(value: unknown): ExecutionBoundaryV1 {
  return executionBoundaryV1Schema.parse(value);
}

function tighterFilesystemScope(left: FilesystemScope, right: FilesystemScope): FilesystemScope {
  const rank: Readonly<Record<FilesystemScope, number>> = {
    read_only: 0,
    workspace_write: 1,
    full_access: 2,
  };
  return rank[left] <= rank[right] ? left : right;
}

/**
 * Apply a second boundary as a tightening only: scope/min limits shrink,
 * allowlists intersect, deny wins, and unavailable fallback can only close.
 */
export function tightenExecutionBoundaryV1(
  input: TightenExecutionBoundaryInputV1,
): ExecutionBoundaryV1 {
  const ceiling = parseExecutionBoundaryV1(input.ceiling);
  const tightening = parseExecutionBoundaryV1(input.tightening);
  if (
    canonicalWorkspaceKey(ceiling.workspaceRoot) !== canonicalWorkspaceKey(tightening.workspaceRoot)
  ) {
    throw new Error('Execution boundaries for different canonical workspaces cannot be composed.');
  }

  const networkMode =
    ceiling.networkMode === 'off' || tightening.networkMode === 'off' ? 'off' : 'allowlist';
  const tighteningHosts = new Set(tightening.networkAllowlist);
  const networkAllowlist =
    networkMode === 'off'
      ? []
      : ceiling.networkAllowlist.filter((host) => tighteningHosts.has(host));
  if (networkMode === 'allowlist' && networkAllowlist.length === 0) {
    // An empty host intersection is semantically network-off, not an ambiguous
    // allowlist that another layer could reinterpret as unrestricted.
    return parseExecutionBoundaryV1({
      ...ceiling,
      filesystemScope: tighterFilesystemScope(ceiling.filesystemScope, tightening.filesystemScope),
      networkMode: 'off',
      networkAllowlist: [],
      protectedPathPolicy:
        ceiling.protectedPathPolicy === 'deny' || tightening.protectedPathPolicy === 'deny'
          ? 'deny'
          : 'prompt',
      maxProcessTreeSizePerShellInvocation: Math.min(
        ceiling.maxProcessTreeSizePerShellInvocation,
        tightening.maxProcessTreeSizePerShellInvocation,
      ),
      sandboxRequired: ceiling.sandboxRequired || tightening.sandboxRequired,
      sandboxUnavailable:
        ceiling.sandboxUnavailable === 'fail' || tightening.sandboxUnavailable === 'fail'
          ? 'fail'
          : 'verified_in_process_read_only',
    });
  }

  return parseExecutionBoundaryV1({
    ...ceiling,
    filesystemScope: tighterFilesystemScope(ceiling.filesystemScope, tightening.filesystemScope),
    networkMode,
    networkAllowlist,
    protectedPathPolicy:
      ceiling.protectedPathPolicy === 'deny' || tightening.protectedPathPolicy === 'deny'
        ? 'deny'
        : 'prompt',
    maxProcessTreeSizePerShellInvocation: Math.min(
      ceiling.maxProcessTreeSizePerShellInvocation,
      tightening.maxProcessTreeSizePerShellInvocation,
    ),
    sandboxRequired: ceiling.sandboxRequired || tightening.sandboxRequired,
    sandboxUnavailable:
      ceiling.sandboxUnavailable === 'fail' || tightening.sandboxUnavailable === 'fail'
        ? 'fail'
        : 'verified_in_process_read_only',
  });
}

export function computeExecutionBoundaryDigestV1(value: unknown): string {
  const boundary = parseExecutionBoundaryV1(value);
  const canonical = JSON.stringify({
    filesystemScope: boundary.filesystemScope,
    workspaceRoot: boundary.workspaceRoot,
    networkMode: boundary.networkMode,
    networkAllowlist: boundary.networkAllowlist,
    allowLocalAndPrivateNetwork: boundary.allowLocalAndPrivateNetwork,
    protectedPathPolicy: boundary.protectedPathPolicy,
    maxProcessTreeSizePerShellInvocation: boundary.maxProcessTreeSizePerShellInvocation,
    sandboxRequired: boundary.sandboxRequired,
    sandboxUnavailable: boundary.sandboxUnavailable,
  });
  return `sha256:${createHash('sha256')
    .update('kite.execution-boundary.v1\0')
    .update(canonical)
    .digest('hex')}`;
}

/**
 * Composition-root admission for a production execution surface. Current TUI
 * and CLI development runs do not call this until a 2A release profile exists;
 * any future production root must pass this gate before starting processes.
 */
export function admitProductionExecutionBoundaryV1(
  input: ExecutionBoundaryAdmissionInputV1,
): ExecutionBoundaryAdmissionV1 {
  if (!input.featureEnabled) return denied('feature_disabled');
  if (!input.sandboxEnabled) return denied('sandbox_disabled');

  let registry: ProductionExecutionQualificationRegistryV1;
  try {
    registry = loadApprovedProductionExecutionQualificationRegistryV1();
  } catch {
    return denied('approved_qualification_unavailable');
  }
  if (registry.status === 'accepted_empty_support_set' || registry.qualifications.length === 0) {
    return denied('platform_excluded');
  }

  const qualification = resolveProductionExecutionQualificationFromRegistryV1({
    registry,
    entrypoint: input.entrypoint,
  });
  if (!qualification) return denied('qualification_environment_mismatch');

  const evaluation = evaluateExecutionBoundaryQualificationV1({ ...input, qualification });
  if (!evaluation.allowed) return evaluation;
  return {
    ...evaluation,
    admissionKind: 'release_approved',
    qualificationProof: {
      registryRevision: registry.revision,
      registryDigest: registry.digest,
      qualificationId: qualification.qualificationId,
      evidenceDigest: qualification.evidenceDigest,
    },
  };
}

/**
 * Pure technical evaluator used to validate future release qualification
 * artifacts. Production callers must use admitProductionExecutionBoundaryV1,
 * which seals registry loading and exact-environment resolution.
 */
export function evaluateExecutionBoundaryQualificationV1(
  input: ExecutionBoundaryQualificationEvaluationInputV1,
): ExecutionBoundaryAdmissionV1 {
  if (!input.featureEnabled) return denied('feature_disabled');
  if (input.boundary === undefined) return denied('boundary_missing');

  let boundary: ExecutionBoundaryV1;
  try {
    boundary = parseExecutionBoundaryV1(input.boundary);
  } catch {
    return denied('boundary_invalid');
  }

  let workspaceKey: string;
  try {
    workspaceKey = canonicalWorkspaceKey(input.workspaceRoot);
    if (workspaceKey !== canonicalWorkspaceKey(boundary.workspaceRoot)) {
      return denied('workspace_mismatch');
    }
  } catch {
    return denied('workspace_mismatch');
  }

  let qualification: ProductionExecutionQualificationV1;
  try {
    qualification = parseProductionExecutionQualificationV1(input.qualification);
  } catch {
    return denied('approved_qualification_unavailable');
  }
  const backend: ExecutionBackendCapabilitiesV1 = qualification.backendCapabilities;

  if (boundary.filesystemScope === 'full_access') return denied('full_access_not_qualified');
  if (boundary.networkMode !== qualification.selectedNetworkMode) {
    return denied('qualification_boundary_mismatch');
  }

  if (qualification.outcome === 'read_only_only') {
    if (boundary.filesystemScope !== 'read_only') return denied('platform_read_only_only');
    const validFallback =
      boundary.networkMode === 'off' &&
      boundary.sandboxUnavailable === 'verified_in_process_read_only' &&
      backend.verifiedInProcessReadOnly === 'enforced' &&
      qualification.inProcessReadOnlyTools.tools.length > 0;
    if (!validFallback) return denied('read_only_fallback_unverified');
    return {
      allowed: true,
      admissionKind: 'technical_evaluation',
      reason: 'verified_in_process_read_only',
      boundary,
      workspaceKey,
      surface: {
        inProcessReadOnlyTools: qualification.inProcessReadOnlyTools,
        network: false,
        process: false,
        write: false,
        workspaceWrite: false,
        shell: false,
        skillChild: false,
        localStdioMcp: false,
      },
    };
  }

  if (!boundary.sandboxRequired || backend.backend === 'none') return denied('sandbox_required');
  if (backend.filesystem[boundary.filesystemScope] !== 'enforced') {
    return denied('backend_filesystem_unsupported');
  }
  if (backend.network[boundary.networkMode] !== 'enforced') {
    return denied('backend_network_unsupported');
  }
  if (backend.processTreeLimit !== 'enforced') {
    return denied('backend_process_tree_unsupported');
  }
  if (backend.childProcessInheritance !== 'enforced') {
    return denied('backend_child_inheritance_unsupported');
  }

  return {
    allowed: true,
    admissionKind: 'technical_evaluation',
    reason: 'admitted',
    boundary,
    workspaceKey,
    surface: {
      inProcessReadOnlyTools: qualification.inProcessReadOnlyTools,
      network: boundary.networkMode === 'allowlist',
      process: true,
      write: boundary.filesystemScope === 'workspace_write',
      workspaceWrite: boundary.filesystemScope === 'workspace_write',
      shell: true,
      skillChild: true,
      localStdioMcp: true,
    },
  };
}
