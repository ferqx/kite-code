import { createHash } from 'node:crypto';
import type { AuthorizationRequest, PermissionDecision, Permissions } from '../extensions';
import type { Json } from '../storage';

export type PermissionMode = 'accept_edits' | 'auto' | 'full';
export type CapabilityEffect =
  | 'read'
  | 'workspace_write'
  | 'record_write'
  | 'process'
  | 'network'
  | 'external'
  | 'unknown';
export interface CapabilityIdentity {
  readonly kind: AuthorizationRequest['kind'];
  readonly definitionId: string;
  readonly definitionVersion: string;
}
export interface PermissionPolicySnapshot {
  readonly mode: PermissionMode;
  readonly workspaceTrust: boolean;
  readonly revision: string;
  readonly allowed: readonly CapabilityIdentity[];
  readonly controlReads?: readonly {
    kind: 'permission.mode' | 'workspace.trust';
    scope: string;
    revision: string;
  }[];
}
/** Supplied by actual trusted host registration, never by a Tool description or remote text. */
export interface CapabilityDescription extends CapabilityIdentity {
  /** Trusted exact execution semantics, never a remote/Model supplied grant key. */
  readonly commandDigest?: string;
  /** Trusted Shell sandbox request, not an authorization supplied by a caller. */
  readonly executionScope?: {
    readonly filesystem: 'workspace_write' | 'full_access';
    readonly network: 'none' | 'internet';
  };
  readonly denialReason?: string;
  readonly revision: string;
  readonly effects: readonly CapabilityEffect[];
  readonly hardAllowed: boolean;
  readonly safeRead: boolean;
}
export interface AutoReviewContext {
  readonly task: Json;
  readonly plan: Json | null;
  readonly rejectionReasons: readonly string[];
}
export interface PermissionPolicyOptions {
  readPolicy(
    request: AuthorizationRequest,
  ): PermissionPolicySnapshot | Promise<PermissionPolicySnapshot>;
  describeCapability(
    request: AuthorizationRequest,
  ): CapabilityDescription | null | Promise<CapabilityDescription | null>;
  /** Read-only host context. Review execution and its authority stay in Core, never this callback. */
  readReviewContext?(request: AuthorizationRequest): AutoReviewContext | Promise<AutoReviewContext>;
}
const effects = new Set<CapabilityEffect>([
  'read',
  'workspace_write',
  'record_write',
  'process',
  'network',
  'external',
  'unknown',
]);
const modes = new Set<PermissionMode>(['accept_edits', 'auto', 'full']);
const kinds = new Set(['model', 'tool', 'job']);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;
function identity(value: CapabilityIdentity) {
  return (
    value && kinds.has(value.kind) && text(value.definitionId) && text(value.definitionVersion)
  );
}
function matches(left: CapabilityIdentity, right: CapabilityIdentity) {
  return (
    left.kind === right.kind &&
    left.definitionId === right.definitionId &&
    left.definitionVersion === right.definitionVersion
  );
}
function validPolicy(policy: PermissionPolicySnapshot) {
  return (
    policy &&
    modes.has(policy.mode) &&
    typeof policy.workspaceTrust === 'boolean' &&
    text(policy.revision) &&
    Array.isArray(policy.allowed) &&
    policy.allowed.length <= 512 &&
    policy.allowed.every(identity) &&
    (policy.controlReads === undefined ||
      (Array.isArray(policy.controlReads) &&
        policy.controlReads.length <= 3 &&
        policy.controlReads.every(
          (read) =>
            read !== null &&
            typeof read === 'object' &&
            Object.keys(read).every((key) => ['kind', 'scope', 'revision'].includes(key)) &&
            (read.kind === 'permission.mode' || read.kind === 'workspace.trust') &&
            text(read.scope) &&
            typeof read.revision === 'string' &&
            /^(0|[1-9]\d{0,18})$/.test(read.revision) &&
            BigInt(read.revision) <= 9223372036854775807n,
        )))
  );
}
function validDescription(description: CapabilityDescription) {
  return (
    identity(description) &&
    text(description.revision) &&
    typeof description.hardAllowed === 'boolean' &&
    typeof description.safeRead === 'boolean' &&
    (description.denialReason === undefined || text(description.denialReason)) &&
    (description.executionScope === undefined ||
      (description.executionScope !== null &&
        typeof description.executionScope === 'object' &&
        Object.keys(description.executionScope).every((key) =>
          ['filesystem', 'network'].includes(key),
        ) &&
        ['workspace_write', 'full_access'].includes(description.executionScope.filesystem) &&
        ['none', 'internet'].includes(description.executionScope.network))) &&
    (description.commandDigest === undefined ||
      (typeof description.commandDigest === 'string' &&
        /^[a-f0-9]{64}$/.test(description.commandDigest))) &&
    Array.isArray(description.effects) &&
    description.effects.length <= effects.size &&
    description.effects.every((effect) => effects.has(effect)) &&
    new Set(description.effects).size === description.effects.length
  );
}
function revision(policy: PermissionPolicySnapshot, description: CapabilityDescription | null) {
  // Reordering host sets is immaterial; semantic changes invalidate an old single-call approval.
  const allowed = policy.allowed
    .map((entry) => [entry.kind, entry.definitionId, entry.definitionVersion])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256')
    .update(
      JSON.stringify({
        policy: [
          policy.revision,
          policy.mode,
          policy.workspaceTrust,
          allowed,
          policy.controlReads ?? [],
        ],
        capability: description && [
          description.kind,
          description.definitionId,
          description.definitionVersion,
          description.revision,
          [...description.effects].sort(),
          description.hardAllowed,
          description.safeRead,
          description.commandDigest ?? null,
          description.executionScope ?? null,
          description.denialReason ?? null,
        ],
      }),
    )
    .digest('hex');
}

/** Pure classification over freshly read host facts; import/factory creation performs no I/O. */
export function createPermissionPolicy(options: PermissionPolicyOptions): Permissions {
  return {
    async authorize(request): Promise<PermissionDecision> {
      request.signal.throwIfAborted();
      const policy = structuredClone(await options.readPolicy(request));
      request.signal.throwIfAborted();
      if (!validPolicy(policy))
        return { allowed: false, revision: 'invalid-policy', reason: 'permission_policy_invalid' };
      let description = structuredClone(await options.describeCapability(request));
      request.signal.throwIfAborted();
      if (description !== null && !validDescription(description))
        return {
          allowed: false,
          revision: 'invalid-capability',
          reason: 'capability_metadata_invalid',
        };
      if (description?.executionScope && policy.mode === 'full')
        description = {
          ...description,
          executionScope: { filesystem: 'full_access', network: 'internet' },
        };
      const boundRevision = revision(policy, description);
      const controlProof = {
        ...(policy.controlReads ? { controlReads: policy.controlReads } : {}),
        snapshot: {
          namespace: 'builtin.permissions',
          version: '1',
          data: {
            mode: policy.mode,
            workspaceTrust: policy.workspaceTrust,
            policyRevision: policy.revision,
            capability: description
              ? {
                  kind: description.kind,
                  definitionId: description.definitionId,
                  definitionVersion: description.definitionVersion,
                  revision: description.revision,
                  effects: [...description.effects],
                  hardAllowed: description.hardAllowed,
                  safeRead: description.safeRead,
                  ...(description.executionScope
                    ? { executionScope: description.executionScope }
                    : {}),
                }
              : null,
          },
        },
      };
      const deny = (reason: string): PermissionDecision => ({
        ...controlProof,
        allowed: false,
        revision: boundRevision,
        reason,
      });
      if (
        !description ||
        !matches(description, request) ||
        !policy.allowed.some((entry) => matches(entry, request))
      )
        return deny('capability_not_allowed');
      if (!description.hardAllowed)
        return deny(description.denialReason ?? 'capability_unavailable');
      // Model authority is kind-specific and does not grant a namesake Tool access to a Workspace.
      if (request.kind === 'model')
        return { ...controlProof, allowed: true, revision: boundRevision };
      if (!policy.workspaceTrust) return deny('workspace_untrusted');
      if (policy.mode === 'full')
        return { ...controlProof, allowed: true, revision: boundRevision };
      const safeRead =
        description.safeRead && description.effects.every((effect) => effect === 'read');
      const workspaceEdit = description.effects.every(
        (effect) => effect === 'read' || effect === 'workspace_write',
      );
      const scopedWorkspace =
        description.executionScope?.filesystem === 'workspace_write' &&
        description.executionScope.network === 'none';
      if (safeRead || (policy.mode === 'accept_edits' && (workspaceEdit || scopedWorkspace)))
        return { ...controlProof, allowed: true, revision: boundRevision };
      if (policy.mode === 'auto') {
        const context = options.readReviewContext
          ? structuredClone(await options.readReviewContext(request))
          : undefined;
        request.signal.throwIfAborted();
        const { signal: _signal, ...invocation } = request;
        return {
          ...controlProof,
          allowed: false,
          revision: boundRevision,
          reason: 'auto_review_required',
          review: {
            request: {
              mode: policy.mode,
              effects: [...description.effects],
              ...(description.executionScope ? { executionScope: description.executionScope } : {}),
              invocation: structuredClone(invocation),
              ...(context ? { context: context as unknown as Json } : {}),
            },
          },
          approval: {
            ...(description.commandDigest === undefined
              ? {}
              : {
                  grants: ['approve_once', 'same_command'] as const,
                  commandDigest: description.commandDigest,
                }),
            request: {
              mode: policy.mode,
              reason: 'auto_review_unavailable',
              effects: [...description.effects],
              ...(description.executionScope ? { executionScope: description.executionScope } : {}),
            },
          },
        };
      }
      const reason = 'approval_required';
      return {
        ...controlProof,
        allowed: false,
        revision: boundRevision,
        reason,
        approval: {
          request: {
            mode: policy.mode,
            reason,
            effects: [...description.effects],
            ...(description.executionScope ? { executionScope: description.executionScope } : {}),
          },
          ...(description.commandDigest === undefined
            ? {}
            : {
                grants: ['approve_once', 'same_command'],
                commandDigest: description.commandDigest,
              }),
        },
      };
    },
  };
}

export {
  builtinToolEffect,
  createMcpSourceCapabilityDescription,
  hostReadOnlyTool,
  planningEffect,
  taskToolCapability,
} from './capabilities';
export {
  createPlanningPermissionPolicy,
  requireFileRestoreApproval,
  requireWorkflowApproval,
} from './constraints';
