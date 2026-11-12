import { createHash } from 'node:crypto';
import { toolBehaviorBinding } from '../authorization-check-output';
import type { AuthorizationRequest, PermissionDecision, Permissions } from '../extensions';
import {
  approvalOptions,
  capabilityKey,
  type GrantCandidate,
  type GrantOffer,
  grantDigest,
  parseGrantCandidate,
  sameCapability,
} from '../permission-grants';
import type { Json } from '../storage';
import type { ToolBehaviorBinding } from '../tool-behavior';
import { isBuiltinBrowserApprovalExempt } from './capabilities';
import { sealWorktreeDecision } from './worktree-authorization';

export { shellRiskReviewContractDigest } from '../shell-risk-review';

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
  /** Trusted fixed worktree implementation, after canonical command and asset verification. */
  readonly worktreeAuthorization?: { readonly configurationIdentity: string };
  /** Trusted default-host review contract; absent preserves custom and historical policies. */
  readonly autoReview?: 'check' | 'none';
  /** Trusted classification requires an exact human decision for this call. */
  readonly requiresApproval?: true;
  readonly reviewBehavior?: ToolBehaviorBinding;
  readonly grantOffers?: readonly GrantCandidate[];
  readonly grantBehavior?: { readonly contractRef: string; readonly configurationDigest: string };
  readonly grantSatisfiesDefaultCheck?: true;
  /** Trusted exact execution semantics, never a remote/Model supplied grant key. */
  readonly commandDigest?: string;
  readonly autoReviewKey?: string;
  readonly autoTimeoutScope?:
    | 'governed'
    | {
        readonly filesystem: 'workspace_write' | 'full_access';
        readonly network: 'none' | 'internet';
      };
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
  /** Trusted builtin record-only operation; never applies to arbitrary/custom Task effects. */
  readonly internalRecordOnly?: true;
  /** Host-registered builtin browser operations need no review or approval in any mode. */
  readonly approvalExempt?: 'builtin.browser';
}
export interface AuthorizationCheckContext {
  /** Host contract: Core may project verified task inputs instead of the business Model window. */
  readonly reviewInput?: 'task_authorization';
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
    /** Isolated copy of this authorization's validated policy; never a second host read. */
    policy?: Readonly<PermissionPolicySnapshot>,
  ): CapabilityDescription | null | Promise<CapabilityDescription | null>;
  /** Read-only host context. Review execution and its authority stay in Core, never this callback. */
  readCheckContext?(
    request: AuthorizationRequest,
  ): AuthorizationCheckContext | Promise<AuthorizationCheckContext>;
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
    (description.worktreeAuthorization === undefined ||
      (description.worktreeAuthorization !== null &&
        Object.keys(description.worktreeAuthorization).join() === 'configurationIdentity' &&
        /^[a-f0-9]{64}$/.test(description.worktreeAuthorization.configurationIdentity) &&
        description.definitionVersion === '1' &&
        ((description.kind === 'tool' && description.definitionId === 'git.worktree') ||
          (description.kind === 'job' && description.definitionId === 'shell.command')))) &&
    (description.autoReview === undefined ||
      description.autoReview === 'check' ||
      description.autoReview === 'none') &&
    (description.requiresApproval === undefined || description.requiresApproval === true) &&
    (description.reviewBehavior === undefined ||
      (!!toolBehaviorBinding(description.reviewBehavior) &&
        matches(description.reviewBehavior.capability, description))) &&
    (description.grantBehavior === undefined ||
      (description.grantBehavior !== null &&
        text(description.grantBehavior.contractRef) &&
        /^[a-f0-9]{64}$/.test(description.grantBehavior.configurationDigest))) &&
    (description.denialReason === undefined || text(description.denialReason)) &&
    (description.approvalExempt === undefined ||
      (description.approvalExempt === 'builtin.browser' &&
        isBuiltinBrowserApprovalExempt(
          description.definitionId,
          description.kind,
          description.definitionVersion,
        ))) &&
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
    new Set(description.effects).size === description.effects.length &&
    (description.internalRecordOnly === undefined ||
      (description.internalRecordOnly === true &&
        description.effects.length > 0 &&
        description.effects.every((effect) => effect === 'read' || effect === 'record_write')))
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
          description.autoReviewKey ?? null,
          description.autoTimeoutScope ?? null,
          description.executionScope ?? null,
          description.denialReason ?? null,
          description.grantBehavior ?? null,
          description.reviewBehavior ?? null,
          description.internalRecordOnly ?? null,
          ...(description.approvalExempt ? [description.approvalExempt] : []),
          ...(description.autoReview ? [description.autoReview] : []),
          ...(description.requiresApproval ? ['requires_approval'] : []),
          ...(description.worktreeAuthorization ? [description.worktreeAuthorization] : []),
        ],
      }),
    )
    .digest('hex');
}

/** Pure classification over freshly read host facts; import/factory creation performs no I/O. */
export function createPermissionPolicy(options: PermissionPolicyOptions): Permissions {
  const snapshots = new WeakMap<
    object,
    { policy: PermissionPolicySnapshot; description: CapabilityDescription | null }
  >();
  const reuse: NonNullable<Permissions['reuseRevision']> = async (
    request,
    capability,
    candidate,
    decision,
  ) => {
    const facts = decision.snapshot && snapshots.get(decision.snapshot);
    if (
      !facts?.policy.workspaceTrust ||
      !facts.description?.hardAllowed ||
      facts.description.requiresApproval ||
      !facts.policy.allowed.some((entry) => sameCapability(entry, capability))
    )
      return null;
    const satisfiesCheck =
      facts.description.grantSatisfiesDefaultCheck === true &&
      facts.description.autoReview === 'check';
    return {
      reuseRevision: grantDigest({
        policy: {
          identity: facts.policy.revision,
          mode: facts.policy.mode,
          workspaceTrust: facts.policy.workspaceTrust,
          allowed: [...facts.policy.allowed].sort((a, b) =>
            capabilityKey(a).localeCompare(capabilityKey(b)),
          ) as unknown as Json,
          controlReads: (facts.policy.controlReads ?? []) as unknown as Json,
        },
        sessionId: request.sessionId,
        capability: capability as unknown as Json,
        ruleId: candidate.ruleId,
        contractId: candidate.contractId,
        scopeDigest: candidate.scopeDigest,
        effects: [...facts.description.effects].sort(),
        executionScope: facts.description.executionScope ?? null,
        satisfiesCheck,
        behavior: facts.description.grantBehavior ?? null,
      }),
      ...(satisfiesCheck ? { satisfiesCheck: true as const } : {}),
      requireApproval: decision.check?.requireApproval === true,
    };
  };
  const policy: Permissions = {
    reuseRevision: reuse,
    toolDispatchOrder: 'model',
    async authorize(request): Promise<PermissionDecision> {
      request.signal.throwIfAborted();
      const policy = structuredClone(await options.readPolicy(request));
      request.signal.throwIfAborted();
      if (!validPolicy(policy))
        return { allowed: false, revision: 'invalid-policy', reason: 'permission_policy_invalid' };
      let description = structuredClone(
        await options.describeCapability(request, structuredClone(policy)),
      );
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
            ...(description?.worktreeAuthorization
              ? {
                  worktreeAllowedDigest: createHash('sha256')
                    .update(
                      JSON.stringify(
                        policy.allowed
                          .map((entry) => [entry.kind, entry.definitionId, entry.definitionVersion])
                          .sort(),
                      ),
                    )
                    .digest('hex'),
                }
              : {}),
            capability: description
              ? {
                  kind: description.kind,
                  definitionId: description.definitionId,
                  definitionVersion: description.definitionVersion,
                  revision: description.revision,
                  effects: [...description.effects],
                  hardAllowed: description.hardAllowed,
                  safeRead: description.safeRead,
                  ...(description.autoReviewKey
                    ? { autoReviewKey: description.autoReviewKey }
                    : {}),
                  ...(description.commandDigest
                    ? { commandDigest: description.commandDigest }
                    : {}),
                  ...(description.worktreeAuthorization
                    ? { worktreeAuthorization: description.worktreeAuthorization }
                    : {}),
                  ...(description.autoReview ? { autoReview: description.autoReview } : {}),
                  ...(description.internalRecordOnly ? { internalRecordOnly: true } : {}),
                  ...(description.approvalExempt
                    ? { approvalExempt: description.approvalExempt }
                    : {}),
                  ...(description.executionScope
                    ? { executionScope: description.executionScope }
                    : {}),
                }
              : null,
          },
        },
      };
      snapshots.set(controlProof.snapshot, { policy, description });
      const grantOffers: GrantOffer[] = [];
      if (
        policy.workspaceTrust &&
        description?.hardAllowed &&
        policy.allowed.some((entry) => matches(entry, request))
      ) {
        for (const raw of description.grantOffers ?? []) {
          const candidate = parseGrantCandidate(raw);
          const policyBindings = [];
          for (const capability of candidate.bindings) {
            const binding = await reuse(request, capability, candidate, {
              ...controlProof,
              allowed: false,
              revision: boundRevision,
            });
            if (!binding) break;
            policyBindings.push({ capability, ...binding });
          }
          if (policyBindings.length === candidate.bindings.length)
            grantOffers.push({ ...candidate, policyBindings });
        }
      }
      const offerProof = { ...controlProof, ...(grantOffers.length ? { grantOffers } : {}) };
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
        return { ...offerProof, allowed: true, revision: boundRevision };
      if (!policy.workspaceTrust) return deny('workspace_untrusted');
      if (description.approvalExempt === 'builtin.browser')
        return { ...offerProof, allowed: true, revision: boundRevision };
      if (!description.requiresApproval && policy.mode === 'full')
        return { ...offerProof, allowed: true, revision: boundRevision };
      const safeRead =
        description.safeRead && description.effects.every((effect) => effect === 'read');
      const workspaceEdit = description.effects.every(
        (effect) => effect === 'read' || effect === 'workspace_write',
      );
      const scopedWorkspace =
        description.executionScope?.filesystem === 'workspace_write' &&
        description.executionScope.network === 'none';
      if (
        !description.requiresApproval &&
        (safeRead ||
          description.internalRecordOnly === true ||
          (policy.mode === 'accept_edits' && (workspaceEdit || scopedWorkspace)))
      )
        return { ...offerProof, allowed: true, revision: boundRevision };
      if (!description.requiresApproval && policy.mode === 'auto') {
        if (description.autoReview === 'none')
          return { ...offerProof, allowed: true, revision: boundRevision };
        const riskOnly = description.autoReview === 'check';
        const context =
          !riskOnly && options.readCheckContext
            ? structuredClone(await options.readCheckContext(request))
            : undefined;
        request.signal.throwIfAborted();
        const { signal: _signal, ...invocation } = request;
        return {
          ...offerProof,
          allowed: false,
          revision: boundRevision,
          reason: 'auto_check_required',
          check: {
            ...(description.autoReview === 'check' && description.reviewBehavior
              ? { behavior: description.reviewBehavior }
              : {}),
            ...(description.autoReviewKey ? { operationKey: description.autoReviewKey } : {}),
            timeoutScope: description.autoTimeoutScope ?? 'governed',
            request: {
              mode: policy.mode,
              effects: [...description.effects],
              ...(description.executionScope ? { executionScope: description.executionScope } : {}),
              invocation: structuredClone(invocation),
              ...(context ? { context: context as unknown as Json } : {}),
            },
          },
          approval: {
            options: approvalOptions(grantOffers),
            request: {
              mode: policy.mode,
              reason: 'auto_check_unavailable',
              effects: [...description.effects],
              ...(description.executionScope ? { executionScope: description.executionScope } : {}),
            },
          },
        };
      }
      const reason = 'approval_required';
      return {
        ...offerProof,
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
          options: approvalOptions(grantOffers),
        },
      };
    },
  };
  return {
    toolDispatchOrder: policy.toolDispatchOrder,
    reuseRevision: reuse,
    async consumesExecutionConfirmation(request, decision) {
      const facts = decision.snapshot && snapshots.get(decision.snapshot);
      return !!(
        facts?.policy.workspaceTrust &&
        facts.description?.hardAllowed &&
        matches(facts.description, request) &&
        facts.policy.allowed.some((entry) => matches(entry, request))
      );
    },
    async authorize(request) {
      return sealWorktreeDecision(await policy.authorize(request));
    },
  };
}

export {
  createDefaultAfterTurnPolicy,
  type DefaultAfterTurnCurrent,
  type DefaultAfterTurnInput,
} from './after-turn';
export {
  builtinCapability,
  builtinToolEffect,
  createMcpSourceCapabilityDescription,
  hostReadOnlyTool,
  planningEffect,
  taskToolCapability,
} from './capabilities';
export { createPermissionCheckContextReader } from './check-context';
export { createBusinessPermissionPolicy } from './constraints';
export { dispatchScopeLeaves } from './dispatch-scope';
export { intersectPermissionPolicies } from './inheritance';
