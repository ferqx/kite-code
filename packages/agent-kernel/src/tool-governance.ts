/**
 * Pure State 25 tool-governance contract.
 *
 * Host/Builtin supplies bounded, immutable classification facts. Kernel owns
 * authorization, approval identity, mode selection, and admission. This
 * module intentionally has no execution, persistence, provider, or ambient
 * clock authority.
 */

import { assertAuthorizationElevation } from './authorization';

export const TOOL_GOVERNANCE_FACTS_SCHEMA_ = 'kite.tool-governance-facts.v1' as const;

const MAX_IDENTITY_LENGTH = 256;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export type ToolGovernanceInteractionMode = 'auto' | 'accept_edits' | 'full';
export type ToolGovernanceAuthorizationMode = 'default' | 'full_access';
export type ToolGovernanceAuthorizationSource = 'user' | 'config' | 'test' | 'system';
export type ToolGovernancePhase = 'planning' | 'building';
export type ToolGovernanceApprovalStatus = 'queued' | 'approved';
export type ToolGovernanceExecutionMechanism = 'user_input' | 'shell' | 'other';
export type ToolGovernanceRisk =
  | 'read'
  | 'plan'
  | 'write_file'
  | 'execute_code'
  | 'destructive'
  | 'network'
  | 'vcs_mutation'
  | 'mcp'
  | 'unknown';
export type ToolGovernanceGrant = 'none' | 'approve_once' | 'same_command' | 'full_access';
export type ToolGovernanceMinimumApproval = 'none' | 'auto_review' | 'user';

export interface ToolGovernanceEffects {
  readonly network?: true;
  readonly externalRead?: true;
  readonly externalWrite?: true;
  readonly uncertainEffects?: true;
}

/** Exact invocation identity and digest facts captured for one proposal. */
export interface ToolGovernanceInvocationFact {
  readonly workspace: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly modelMessageId: string;
  readonly toolCallId: string;
  readonly exposedToolName: string;
  readonly operationId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly executorRevision: string | null;
  readonly descriptorRevision: string;
  readonly parserRevision: string;
  readonly schemaDigest: string;
  readonly argumentsDigest: string;
  readonly effectiveEffectsDigest: string;
  readonly bindingId: string | null;
  readonly builtinCatalogRevision: string | null;
  readonly dynamicCatalogRevision: string | null;
  readonly nestedCapabilityId: string | null;
  readonly nestedCapabilityRevision: string | null;
  readonly nestedCatalogRevision: string | null;
  readonly commandDigest: string | null;
}

/** Immutable operation policy facts compiled by Builtin. */
export interface ToolGovernancePolicyFact {
  readonly operationId: string;
  readonly capabilityRevision: string;
  readonly parserRevision: string;
  readonly effectiveEffectsDigest: string;
  readonly minimumApproval: ToolGovernanceMinimumApproval;
  readonly fullAccessMayBypassApproval: boolean;
  readonly sameCommandMayBypassApproval: boolean;
  readonly decision: 'allow' | 'ask' | 'deny';
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly risk: ToolGovernanceRisk;
  readonly effects?: Readonly<ToolGovernanceEffects>;
  readonly reason: string;
  readonly userVisibleSummary: string;
  readonly expectedEffects: readonly string[];
  readonly requiresSandbox?: boolean;
  readonly phaseConstraint?: 'planning';
}

/**
 * The two Kernel facts that form an approval binding.  This narrow boundary
 * is intentionally separate from the full governance envelope so a private
 * continuation can carry only the identity needed to resume one blocked tool.
 */
export interface ToolApprovalBindingFacts {
  readonly invocation: Readonly<ToolGovernanceInvocationFact>;
  readonly policy: Readonly<ToolGovernancePolicyFact>;
}

export interface ToolGovernanceApprovalFact {
  readonly status: ToolGovernanceApprovalStatus;
  readonly grant: ToolGovernanceGrant;
  readonly approvedToolCallId: string | null;
  readonly approvalBindingDigest: string | null;
}

export interface ToolGovernanceSameCommandGrantFact {
  readonly workspace: string;
  readonly threadId: string;
  readonly commandDigest: string;
  readonly source: ToolGovernanceAuthorizationSource;
  readonly grantedAt: number;
  readonly expiresAt?: number;
}

/** Dynamic MCP policy is intentionally separate from Builtin policy. */
export interface ToolGovernanceDynamicMcpFact {
  readonly minimumApproval: ToolGovernanceMinimumApproval;
  readonly readOnly: boolean;
}

/** Nested Skill facts may only tighten Builtin activation. */
export interface ToolGovernanceNestedSkillFact {
  readonly decision: 'allow' | 'ask' | 'deny';
  readonly minimumApproval: ToolGovernanceMinimumApproval;
}

export interface ToolGovernanceGateFacts {
  readonly recoveryAdmission: 'admitted' | 'blocked';
  readonly boundedCancellation: 'admitted' | 'blocked';
  readonly executionBoundary: 'admitted' | 'blocked';
  readonly skillCapabilityCeiling: 'admitted' | 'blocked';
}

export interface ToolGovernanceContextFacts {
  readonly phase: ToolGovernancePhase;
  readonly interactionMode: ToolGovernanceInteractionMode;
  readonly authorizationMode: ToolGovernanceAuthorizationMode;
  readonly sandboxAvailable: boolean;
  readonly circuitBreakerTripped: boolean;
  readonly executionMechanism: ToolGovernanceExecutionMechanism;
  readonly gates: Readonly<ToolGovernanceGateFacts>;
  readonly authorizationSource?: ToolGovernanceAuthorizationSource;
  readonly autoReview?: boolean;
  readonly loopMode?: boolean;
  /** Supplied observation time used only for same-command expiry checks. */
  readonly observedAt?: number;
}

export interface ToolGovernanceAdmissionFacts {
  readonly freshness: 'current' | 'stale';
  readonly reservationRequired: boolean;
  readonly reservationIds: readonly string[];
}

export interface ToolGovernanceFacts {
  readonly schema: typeof TOOL_GOVERNANCE_FACTS_SCHEMA_;
  readonly invocation: Readonly<ToolGovernanceInvocationFact>;
  readonly policy: Readonly<ToolGovernancePolicyFact>;
  readonly context: Readonly<ToolGovernanceContextFacts>;
  readonly admission: Readonly<ToolGovernanceAdmissionFacts>;
  readonly approval: Readonly<ToolGovernanceApprovalFact>;
  readonly sameCommandGrant?: Readonly<ToolGovernanceSameCommandGrantFact>;
  readonly dynamicMcp?: Readonly<ToolGovernanceDynamicMcpFact>;
  readonly nestedSkill?: Readonly<ToolGovernanceNestedSkillFact>;
}

/**
 * Canonical digest for the exact State 25 same-command grant subject.
 *
 * Builtin owns Shell parsing and supplies the invocation digest. Host uses
 * this pure Kernel helper only to prove that the persisted, trimmed grant
 * command names that same subject; it must not normalize internal whitespace
 * or infer Shell semantics.
 */
export function createToolGovernanceCommandDigest(command: string): string | null {
  const canonicalCommand = command.trim();
  return canonicalCommand.length === 0 ? null : sha256Hex(stableSerialize(canonicalCommand));
}

export type ToolGovernanceRejectFailure =
  | 'loop_exhausted'
  | 'mandatory_policy_unavailable'
  | 'policy_denied'
  | 'phase_deferred'
  | 'phase_denied';

export type ToolGovernanceRejectCode =
  | 'invalid_facts'
  | 'authorization_elevation_denied'
  | 'approval_identity_mismatch'
  | 'admission_stale'
  | 'reservation_invalid';

export type ToolGovernanceRejectDecision = {
  readonly kind: 'reject';
  readonly failureKind: ToolGovernanceRejectFailure;
  readonly reason: string;
  readonly code?: ToolGovernanceRejectCode;
};

export type ToolGovernanceDecision =
  | {
      readonly kind: 'allow';
      readonly authorizationKind: 'policy_allow' | 'approved_call';
      readonly grantUsed: ToolGovernanceGrant;
      readonly reservationIds: readonly string[];
    }
  | ToolGovernanceRejectDecision
  | {
      readonly kind: 'request_approval';
      readonly decision: Readonly<ToolGovernancePolicyFact>;
    }
  | {
      readonly kind: 'request_auto_review';
      readonly decision: Readonly<ToolGovernancePolicyFact>;
    }
  | { readonly kind: 'request_user_input' };

export type ToolGovernanceAuthorizationDecision =
  | {
      readonly kind: 'authorized';
      readonly authorizationKind: 'policy_allow' | 'approved_call';
      readonly grantUsed: ToolGovernanceGrant;
    }
  | ToolGovernanceRejectDecision
  | {
      readonly kind: 'request_approval';
      readonly decision: Readonly<ToolGovernancePolicyFact>;
    }
  | {
      readonly kind: 'request_auto_review';
      readonly decision: Readonly<ToolGovernancePolicyFact>;
    }
  | { readonly kind: 'request_user_input' };

/** Pure SHA-256 binding over stable invocation and policy identity fields. */
export function createToolApprovalBindingDigest(
  invocation: Readonly<ToolGovernanceInvocationFact>,
  policy: Readonly<ToolGovernancePolicyFact>,
): string {
  return sha256Hex(
    stableSerialize({
      schema: 'kite.tool-approval-binding.v1',
      invocation,
      policy,
    }),
  );
}

export function decideToolGovernance(value: unknown): ToolGovernanceDecision {
  if (!isValidToolGovernanceFacts(value)) {
    return reject(
      'mandatory_policy_unavailable',
      'Tool governance facts are malformed.',
      'invalid_facts',
    );
  }
  const authorization = authorizeValidToolGovernanceFacts(value);
  return admitToolGovernance(authorization, value.admission);
}

export function authorizeToolGovernance(value: unknown): ToolGovernanceAuthorizationDecision {
  if (!isValidToolGovernanceFacts(value)) {
    return reject(
      'mandatory_policy_unavailable',
      'Tool governance facts are malformed.',
      'invalid_facts',
    );
  }
  return authorizeValidToolGovernanceFacts(value);
}

export function admitToolGovernance(
  authorization: ToolGovernanceAuthorizationDecision,
  admission: unknown,
): ToolGovernanceDecision {
  if (authorization.kind !== 'authorized') return authorization;
  if (!validAdmission(admission)) {
    return reject(
      'mandatory_policy_unavailable',
      'Tool governance admission facts are malformed.',
      'invalid_facts',
    );
  }
  if (admission.freshness !== 'current') {
    return reject(
      'mandatory_policy_unavailable',
      'Admission facts became stale.',
      'admission_stale',
    );
  }
  const reservationIds = [...new Set(admission.reservationIds)].sort();
  if (
    reservationIds.some((reservationId) => !boundedIdentity(reservationId)) ||
    (admission.reservationRequired && reservationIds.length === 0)
  ) {
    return reject(
      'mandatory_policy_unavailable',
      'A current Runtime reservation is required before admission.',
      'reservation_invalid',
    );
  }
  return freezeDecision({
    kind: 'allow',
    authorizationKind: authorization.authorizationKind,
    grantUsed: authorization.grantUsed,
    reservationIds,
  });
}

function authorizeValidToolGovernanceFacts(
  facts: ToolGovernanceFacts,
): ToolGovernanceAuthorizationDecision {
  const { context, invocation, policy } = facts;
  const gates = context.gates;

  if (gates.recoveryAdmission !== 'admitted') {
    return reject('loop_exhausted', 'Runtime recovery guard blocked this invocation.');
  }
  if (gates.boundedCancellation !== 'admitted') {
    return reject(
      'mandatory_policy_unavailable',
      'Bounded cancellation is required before production writer/child dispatch.',
    );
  }
  if (gates.executionBoundary !== 'admitted') {
    return reject(
      'mandatory_policy_unavailable',
      'Provider access is unavailable under the sealed execution boundary.',
    );
  }
  if (gates.skillCapabilityCeiling !== 'admitted') {
    return reject('policy_denied', 'Active Skill capability ceiling blocked this tool.');
  }

  // Compiler deny and phase deny always win over ambient elevation or approval.
  if (!policy.allowed) {
    const deferred =
      context.executionMechanism === 'shell' && policy.phaseConstraint === 'planning';
    return reject(
      deferred
        ? 'phase_deferred'
        : policy.phaseConstraint === 'planning'
          ? 'phase_denied'
          : 'policy_denied',
      deferred ? 'Deferred shell_execute until building phase.' : policy.userVisibleSummary,
    );
  }

  if (policy.requiresSandbox && !context.sandboxAvailable) {
    return reject(
      'mandatory_policy_unavailable',
      'This capability requires an available workspace sandbox.',
      'authorization_elevation_denied',
    );
  }

  try {
    assertAuthorizationElevation({
      mode: context.authorizationMode,
      source: context.authorizationSource,
      sandboxAvailable: context.sandboxAvailable,
      autoReview: context.autoReview,
      loopMode: context.loopMode,
    });
  } catch (error) {
    return reject(
      'mandatory_policy_unavailable',
      error instanceof Error ? error.message : String(error),
      'authorization_elevation_denied',
    );
  }

  if (context.executionMechanism === 'user_input') {
    return freezeAuthorizationDecision({ kind: 'request_user_input' });
  }

  if (
    facts.nestedSkill?.decision === 'deny' &&
    invocation.operationId === 'builtin:activate_skill'
  ) {
    return reject('policy_denied', 'Nested Skill policy denied activation.');
  }

  if (
    facts.approval.status === 'approved' &&
    !approvalIdentityMatches(facts.approval, invocation, policy)
  ) {
    return reject(
      'policy_denied',
      'Approved call identity does not match the exact invocation and policy.',
      'approval_identity_mismatch',
    );
  }

  if (facts.approval.status === 'approved') {
    return freezeAuthorizationDecision({
      kind: 'authorized',
      authorizationKind: 'approved_call',
      grantUsed: facts.approval.grant,
    });
  }

  const activationRequiresManual =
    invocation.operationId === 'builtin:activate_skill' && policy.minimumApproval === 'user';
  const nestedSkillRequiresManual =
    invocation.operationId === 'builtin:activate_skill' &&
    (facts.nestedSkill?.decision === 'ask' || facts.nestedSkill?.minimumApproval === 'user');
  const nestedSkillRequiresAutoReview =
    invocation.operationId === 'builtin:activate_skill' &&
    facts.nestedSkill?.minimumApproval === 'auto_review';
  const dynamicMcpRequiresManual = facts.dynamicMcp?.minimumApproval === 'user';
  const dynamicMcpRequiresAutoReview = facts.dynamicMcp?.minimumApproval === 'auto_review';
  const forceManualApproval =
    activationRequiresManual || nestedSkillRequiresManual || dynamicMcpRequiresManual;
  const forceAutoReview = dynamicMcpRequiresAutoReview || nestedSkillRequiresAutoReview;

  if (!forceManualApproval && !forceAutoReview && sameCommandGrantMatches(facts)) {
    return freezeAuthorizationDecision({
      kind: 'authorized',
      authorizationKind: 'approved_call',
      grantUsed: 'same_command',
    });
  }

  const fullAccessBypass =
    !forceManualApproval &&
    !forceAutoReview &&
    context.authorizationMode === 'full_access' &&
    policy.fullAccessMayBypassApproval;
  if (fullAccessBypass) {
    return freezeAuthorizationDecision({
      kind: 'authorized',
      authorizationKind: 'approved_call',
      grantUsed: 'full_access',
    });
  }

  const requiresEffectReview =
    !fullAccessBypass &&
    context.interactionMode !== 'full' &&
    !facts.dynamicMcp?.readOnly &&
    hasAuthorizationReviewEffect(policy.effects);
  const requiresApproval =
    policy.requiresApproval ||
    requiresEffectReview ||
    activationRequiresManual ||
    dynamicMcpRequiresManual ||
    dynamicMcpRequiresAutoReview ||
    nestedSkillRequiresManual ||
    nestedSkillRequiresAutoReview;

  if (!requiresApproval) {
    return freezeAuthorizationDecision({
      kind: 'authorized',
      authorizationKind: 'policy_allow',
      grantUsed: 'none',
    });
  }

  if (forceManualApproval) {
    return freezeAuthorizationDecision({ kind: 'request_approval', decision: clonePolicy(policy) });
  }

  if (forceAutoReview) {
    return freezeAuthorizationDecision({
      kind: 'request_auto_review',
      decision: clonePolicy(policy),
    });
  }

  const modeDecision = decideMode(context, policy);
  if (modeDecision === 'deny') {
    return reject('policy_denied', policy.reason);
  }
  if (modeDecision === 'allow') {
    return freezeAuthorizationDecision({
      kind: 'authorized',
      authorizationKind: 'policy_allow',
      grantUsed: 'none',
    });
  }
  if (modeDecision === 'auto_review') {
    return freezeAuthorizationDecision({
      kind: 'request_auto_review',
      decision: clonePolicy(policy),
    });
  }
  return freezeAuthorizationDecision({ kind: 'request_approval', decision: clonePolicy(policy) });
}

/** Runtime validation for the Host-to-Kernel canonical DTO boundary. */
export function isValidToolGovernanceFacts(value: unknown): value is ToolGovernanceFacts {
  if (!plainRecord(value)) return false;
  if (
    !exactKeys(
      value,
      ['schema', 'invocation', 'policy', 'context', 'admission', 'approval'],
      ['sameCommandGrant', 'dynamicMcp', 'nestedSkill'],
    )
  ) {
    return false;
  }
  if (value.schema !== TOOL_GOVERNANCE_FACTS_SCHEMA_) return false;
  if (!validInvocation(value.invocation)) return false;
  if (!validPolicy(value.policy)) return false;
  if (!validContext(value.context)) return false;
  if (!validAdmission(value.admission)) return false;
  if (!validApproval(value.approval)) return false;
  if (value.sameCommandGrant !== undefined && !validSameCommandGrant(value.sameCommandGrant)) {
    return false;
  }
  if (value.dynamicMcp !== undefined && !validDynamicMcp(value.dynamicMcp)) return false;
  if (value.nestedSkill !== undefined && !validNestedSkill(value.nestedSkill)) return false;
  if (
    value.nestedSkill !== undefined &&
    value.invocation.operationId !== 'builtin:activate_skill'
  ) {
    return false;
  }
  const hasNestedIdentity =
    value.invocation.nestedCapabilityId !== null &&
    value.invocation.nestedCapabilityRevision !== null &&
    value.invocation.nestedCatalogRevision !== null;
  if ((value.nestedSkill !== undefined) !== hasNestedIdentity) return false;
  if (
    value.policy.operationId !== value.invocation.operationId ||
    value.policy.capabilityRevision !== value.invocation.capabilityRevision ||
    value.policy.parserRevision !== value.invocation.parserRevision ||
    value.policy.effectiveEffectsDigest !== value.invocation.effectiveEffectsDigest
  ) {
    return false;
  }
  const dynamicInvocation = isDynamicInvocation(value.invocation);
  const dynamicName = value.invocation.exposedToolName.startsWith('mcp__');
  if (dynamicInvocation !== dynamicName) return false;
  if (dynamicInvocation !== (value.dynamicMcp !== undefined)) return false;
  return dynamicInvocation
    ? value.invocation.builtinCatalogRevision === null &&
        value.invocation.dynamicCatalogRevision !== null
    : value.invocation.builtinCatalogRevision !== null &&
        value.invocation.dynamicCatalogRevision === null;
}

/** Runtime validation for the exact Kernel facts transported in a binding. */
export function isValidToolApprovalBindingFacts(value: unknown): value is ToolApprovalBindingFacts {
  if (!plainRecord(value) || !exactKeys(value, ['invocation', 'policy'])) return false;
  if (!validInvocation(value.invocation) || !validPolicy(value.policy)) return false;
  return (
    value.policy.operationId === value.invocation.operationId &&
    value.policy.capabilityRevision === value.invocation.capabilityRevision &&
    value.policy.parserRevision === value.invocation.parserRevision &&
    value.policy.effectiveEffectsDigest === value.invocation.effectiveEffectsDigest
  );
}

function decideMode(
  context: Readonly<ToolGovernanceContextFacts>,
  policy: Readonly<ToolGovernancePolicyFact>,
): 'allow' | 'deny' | 'approval' | 'auto_review' {
  if (context.interactionMode === 'full') {
    if (policy.risk === 'destructive') return 'deny';
    return policy.risk === 'read' || policy.risk === 'plan' ? 'allow' : 'approval';
  }

  const acceptEdits = decideAcceptEdits(policy);
  if (context.interactionMode === 'accept_edits') return acceptEdits;
  if (acceptEdits === 'deny' || acceptEdits === 'allow') return acceptEdits;
  return context.circuitBreakerTripped ? 'approval' : 'auto_review';
}

function decideAcceptEdits(
  policy: Readonly<ToolGovernancePolicyFact>,
): 'allow' | 'deny' | 'approval' {
  if (policy.risk === 'destructive') return 'deny';
  if (hasModeReviewEffect(policy.effects)) return 'approval';
  if (policy.risk === 'write_file' || policy.risk === 'read' || policy.risk === 'plan') {
    return 'allow';
  }
  return 'approval';
}

function hasAuthorizationReviewEffect(
  effects: Readonly<ToolGovernanceEffects> | undefined,
): boolean {
  return Boolean(effects?.network || effects?.externalWrite || effects?.uncertainEffects);
}

function hasModeReviewEffect(effects: Readonly<ToolGovernanceEffects> | undefined): boolean {
  return Boolean(
    effects?.network ||
      effects?.externalRead ||
      effects?.externalWrite ||
      effects?.uncertainEffects,
  );
}

function approvalIdentityMatches(
  approval: Readonly<ToolGovernanceApprovalFact>,
  invocation: Readonly<ToolGovernanceInvocationFact>,
  policy: Readonly<ToolGovernancePolicyFact>,
): boolean {
  return (
    approval.status === 'approved' &&
    approval.grant !== 'none' &&
    approval.approvedToolCallId === invocation.toolCallId &&
    approval.approvalBindingDigest === createToolApprovalBindingDigest(invocation, policy)
  );
}

function sameCommandGrantMatches(facts: ToolGovernanceFacts): boolean {
  const grant = facts.sameCommandGrant;
  const invocation = facts.invocation;
  if (!grant || !facts.policy.sameCommandMayBypassApproval || !invocation.commandDigest) {
    return false;
  }
  if (
    grant.workspace !== invocation.workspace ||
    grant.threadId !== invocation.threadId ||
    grant.commandDigest !== invocation.commandDigest
  ) {
    return false;
  }
  const observedAt = facts.context.observedAt;
  if (observedAt === undefined || observedAt < grant.grantedAt) {
    return false;
  }
  if (grant.expiresAt !== undefined && observedAt >= grant.expiresAt) {
    return false;
  }
  return true;
}

function reject(
  failureKind: ToolGovernanceRejectFailure,
  reason: string,
  code?: ToolGovernanceRejectCode,
): ToolGovernanceRejectDecision {
  return freezeAuthorizationDecision({
    kind: 'reject',
    failureKind,
    reason,
    ...(code ? { code } : {}),
  });
}

function clonePolicy(
  policy: Readonly<ToolGovernancePolicyFact>,
): Readonly<ToolGovernancePolicyFact> {
  return {
    ...policy,
    ...(policy.effects ? { effects: { ...policy.effects } } : {}),
    expectedEffects: [...policy.expectedEffects],
  };
}

function freezeAuthorizationDecision<
  T extends ToolGovernanceAuthorizationDecision | ToolGovernanceDecision,
>(value: T): T {
  if (value.kind === 'request_approval' || value.kind === 'request_auto_review') {
    deepFreeze(value.decision);
  }
  deepFreeze(value);
  return value;
}

function freezeDecision<T extends ToolGovernanceDecision>(value: T): T {
  return freezeAuthorizationDecision(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as PlainRecord)) deepFreeze(child);
  return Object.freeze(value);
}

type PlainRecord = Record<string, unknown>;

function plainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => 'value' in descriptor && descriptor.enumerable,
  );
}

function exactKeys(
  value: PlainRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH;
}

function digest64(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

function nullableDigest(value: unknown): value is string | null {
  return value === null || digest64(value);
}

function validEffects(value: unknown): value is ToolGovernanceEffects {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [], ['network', 'externalRead', 'externalWrite', 'uncertainEffects'])
  ) {
    return false;
  }
  return Object.values(value).every((entry) => entry === true);
}

function validInvocation(value: unknown): value is ToolGovernanceInvocationFact {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      'workspace',
      'threadId',
      'turnId',
      'modelMessageId',
      'toolCallId',
      'exposedToolName',
      'operationId',
      'capabilityId',
      'capabilityRevision',
      'executorRevision',
      'descriptorRevision',
      'parserRevision',
      'schemaDigest',
      'argumentsDigest',
      'effectiveEffectsDigest',
      'bindingId',
      'builtinCatalogRevision',
      'dynamicCatalogRevision',
      'nestedCapabilityId',
      'nestedCapabilityRevision',
      'nestedCatalogRevision',
      'commandDigest',
    ])
  ) {
    return false;
  }
  return (
    boundedIdentity(value.workspace) &&
    boundedIdentity(value.threadId) &&
    boundedIdentity(value.turnId) &&
    boundedIdentity(value.modelMessageId) &&
    boundedIdentity(value.toolCallId) &&
    boundedIdentity(value.exposedToolName) &&
    boundedIdentity(value.operationId) &&
    boundedIdentity(value.capabilityId) &&
    ((value.operationId === 'mcp:dynamic_tool' &&
      value.capabilityId.startsWith('mcp:') &&
      value.capabilityId !== 'mcp:dynamic_tool') ||
      (value.operationId !== 'mcp:dynamic_tool' && value.operationId === value.capabilityId)) &&
    digest64(value.capabilityRevision) &&
    (value.executorRevision === null || digest64(value.executorRevision)) &&
    digest64(value.descriptorRevision) &&
    digest64(value.parserRevision) &&
    digest64(value.schemaDigest) &&
    digest64(value.argumentsDigest) &&
    digest64(value.effectiveEffectsDigest) &&
    nullableDigest(value.bindingId) &&
    nullableDigest(value.builtinCatalogRevision) &&
    nullableDigest(value.dynamicCatalogRevision) &&
    (value.nestedCapabilityId === null || boundedIdentity(value.nestedCapabilityId)) &&
    nullableDigest(value.nestedCapabilityRevision) &&
    nullableDigest(value.nestedCatalogRevision) &&
    nullableDigest(value.commandDigest)
  );
}

function validPolicy(value: unknown): value is ToolGovernancePolicyFact {
  if (
    !plainRecord(value) ||
    !exactKeys(
      value,
      [
        'operationId',
        'capabilityRevision',
        'parserRevision',
        'effectiveEffectsDigest',
        'minimumApproval',
        'fullAccessMayBypassApproval',
        'sameCommandMayBypassApproval',
        'decision',
        'allowed',
        'requiresApproval',
        'risk',
        'reason',
        'userVisibleSummary',
        'expectedEffects',
      ],
      ['effects', 'requiresSandbox', 'phaseConstraint'],
    )
  ) {
    return false;
  }
  if (
    !boundedIdentity(value.operationId) ||
    !digest64(value.capabilityRevision) ||
    !digest64(value.parserRevision) ||
    !digest64(value.effectiveEffectsDigest) ||
    !['none', 'auto_review', 'user'].includes(String(value.minimumApproval)) ||
    typeof value.fullAccessMayBypassApproval !== 'boolean' ||
    typeof value.sameCommandMayBypassApproval !== 'boolean' ||
    !['allow', 'ask', 'deny'].includes(String(value.decision)) ||
    typeof value.allowed !== 'boolean' ||
    typeof value.requiresApproval !== 'boolean' ||
    ![
      'read',
      'plan',
      'write_file',
      'execute_code',
      'destructive',
      'network',
      'vcs_mutation',
      'mcp',
      'unknown',
    ].includes(String(value.risk)) ||
    !boundedIdentity(value.reason) ||
    !boundedIdentity(value.userVisibleSummary) ||
    !Array.isArray(value.expectedEffects) ||
    value.expectedEffects.length === 0 ||
    !value.expectedEffects.every(boundedIdentity)
  ) {
    return false;
  }
  if (value.decision === 'allow' && (!value.allowed || value.requiresApproval)) return false;
  if (value.decision === 'ask' && (!value.allowed || !value.requiresApproval)) return false;
  if (value.decision === 'deny' && (value.allowed || value.requiresApproval)) return false;
  if (value.effects !== undefined && !validEffects(value.effects)) return false;
  if (value.requiresSandbox !== undefined && typeof value.requiresSandbox !== 'boolean') {
    return false;
  }
  return value.phaseConstraint === undefined || value.phaseConstraint === 'planning';
}

function validApproval(value: unknown): value is ToolGovernanceApprovalFact {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ['status', 'grant', 'approvedToolCallId', 'approvalBindingDigest'])
  ) {
    return false;
  }
  if (
    !['queued', 'approved'].includes(String(value.status)) ||
    !['none', 'approve_once', 'same_command', 'full_access'].includes(String(value.grant)) ||
    !(value.approvedToolCallId === null || boundedIdentity(value.approvedToolCallId)) ||
    !nullableDigest(value.approvalBindingDigest)
  ) {
    return false;
  }
  if (value.status === 'queued') {
    return (
      value.grant === 'none' &&
      value.approvedToolCallId === null &&
      value.approvalBindingDigest === null
    );
  }
  return (
    value.grant !== 'none' &&
    value.approvedToolCallId !== null &&
    value.approvalBindingDigest !== null
  );
}

function validSameCommandGrant(value: unknown): value is ToolGovernanceSameCommandGrantFact {
  if (
    !plainRecord(value) ||
    !exactKeys(
      value,
      ['workspace', 'threadId', 'commandDigest', 'source', 'grantedAt'],
      ['expiresAt'],
    )
  ) {
    return false;
  }
  return (
    boundedIdentity(value.workspace) &&
    boundedIdentity(value.threadId) &&
    digest64(value.commandDigest) &&
    ['user', 'config', 'test', 'system'].includes(String(value.source)) &&
    validTimestamp(value.grantedAt) &&
    (value.expiresAt === undefined ||
      (validTimestamp(value.expiresAt) && value.expiresAt > value.grantedAt))
  );
}

function validDynamicMcp(value: unknown): value is ToolGovernanceDynamicMcpFact {
  return (
    plainRecord(value) &&
    exactKeys(value, ['minimumApproval', 'readOnly']) &&
    ['none', 'auto_review', 'user'].includes(String(value.minimumApproval)) &&
    typeof value.readOnly === 'boolean'
  );
}

function validNestedSkill(value: unknown): value is ToolGovernanceNestedSkillFact {
  return (
    plainRecord(value) &&
    exactKeys(value, ['decision', 'minimumApproval']) &&
    ['allow', 'ask', 'deny'].includes(String(value.decision)) &&
    ['none', 'auto_review', 'user'].includes(String(value.minimumApproval))
  );
}

function validGates(value: unknown): value is ToolGovernanceGateFacts {
  return (
    plainRecord(value) &&
    exactKeys(value, [
      'recoveryAdmission',
      'boundedCancellation',
      'executionBoundary',
      'skillCapabilityCeiling',
    ]) &&
    Object.values(value).every((entry) => entry === 'admitted' || entry === 'blocked')
  );
}

function validContext(value: unknown): value is ToolGovernanceContextFacts {
  if (
    !plainRecord(value) ||
    !exactKeys(
      value,
      [
        'phase',
        'interactionMode',
        'authorizationMode',
        'sandboxAvailable',
        'circuitBreakerTripped',
        'executionMechanism',
        'gates',
      ],
      ['authorizationSource', 'autoReview', 'loopMode', 'observedAt'],
    )
  ) {
    return false;
  }
  return (
    (value.phase === 'planning' || value.phase === 'building') &&
    ['auto', 'accept_edits', 'full'].includes(String(value.interactionMode)) &&
    ['default', 'full_access'].includes(String(value.authorizationMode)) &&
    typeof value.sandboxAvailable === 'boolean' &&
    typeof value.circuitBreakerTripped === 'boolean' &&
    ['user_input', 'shell', 'other'].includes(String(value.executionMechanism)) &&
    validGates(value.gates) &&
    (value.authorizationSource === undefined ||
      ['user', 'config', 'test', 'system'].includes(String(value.authorizationSource))) &&
    (value.autoReview === undefined || typeof value.autoReview === 'boolean') &&
    (value.loopMode === undefined || typeof value.loopMode === 'boolean') &&
    (value.observedAt === undefined || validTimestamp(value.observedAt))
  );
}

function validAdmission(value: unknown): value is ToolGovernanceAdmissionFacts {
  return (
    plainRecord(value) &&
    exactKeys(value, ['freshness', 'reservationRequired', 'reservationIds']) &&
    ['current', 'stale'].includes(String(value.freshness)) &&
    typeof value.reservationRequired === 'boolean' &&
    Array.isArray(value.reservationIds) &&
    value.reservationIds.every(boundedIdentity)
  );
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDynamicInvocation(invocation: Readonly<ToolGovernanceInvocationFact>): boolean {
  return invocation.operationId === 'mcp:dynamic_tool';
}

function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot serialize non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Cannot serialize unsupported approval binding value.');
}

function sha256Hex(value: string): string {
  const bytes = utf8Bytes(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  for (let index = 0; index < 8; index += 1) {
    padded[padded.length - 1 - index] = Math.floor(bitLength / 2 ** (index * 8)) & 0xff;
  }

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      words[index] =
        (padded[position]! << 24) |
        (padded[position + 1]! << 16) |
        (padded[position + 2]! << 8) |
        padded[position + 3]!;
    }
    for (let index = 16; index < 64; index += 1) {
      const value0 =
        rotr32(words[index - 15]!, 7) ^ rotr32(words[index - 15]!, 18) ^ (words[index - 15]! >>> 3);
      const value1 =
        rotr32(words[index - 2]!, 17) ^ rotr32(words[index - 2]!, 19) ^ (words[index - 2]! >>> 10);
      words[index] = add32(words[index - 16]!, value0, words[index - 7]!, value1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = add32(h, sigma1, choose, SHA256_CONSTANTS_[index]!, words[index]!);
      const sigma0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = add32(sigma0, majority);
      h = g;
      g = f;
      f = e;
      e = add32(d, temporary1);
      d = c;
      c = b;
      b = a;
      a = add32(temporary1, temporary2);
    }
    h0 = add32(h0, a);
    h1 = add32(h1, b);
    h2 = add32(h2, c);
    h3 = add32(h3, d);
    h4 = add32(h4, e);
    h5 = add32(h5, f);
    h6 = add32(h6, g);
    h7 = add32(h7, h);
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((part) => (part >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      }
    }
    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function add32(...values: number[]): number {
  let result = 0;
  for (const value of values) result = (result + value) >>> 0;
  return result;
}

function rotr32(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

const SHA256_CONSTANTS_ = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const);
