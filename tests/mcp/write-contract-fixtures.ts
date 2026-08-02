import { createHash } from 'node:crypto';
import type { FeatureFlags } from '@/core/config/features';
import type { ResolvedMcpToolPolicy } from '@/core/mcp/tool-policy';

export interface McpWriteRouteContractV1 {
  routeId: string;
  operatorIdentity: string;
  serverIdentity: string;
  endpointRevision: string;
  toolName: string;
  toolRevision: string;
  schemaDigest: string;
  policyDigest: string;
  effects: ResolvedMcpToolPolicy['effectiveEffects'];
  minimumApproval: ResolvedMcpToolPolicy['minimumApproval'];
  providerDataPolicyRevision: string;
  idempotency: 'provider_key' | 'reconciliation_only' | 'unsupported';
  reconciliation: 'required' | 'unsupported';
  rateLimitPerMinute: number;
  timeoutMs: number;
  evidenceObservedAt: string;
  evidenceExpiresAt: string;
}

export interface McpWriteInvocationFactsV1 {
  providerIdentity: string;
  serverIdentity: string;
  endpointRevision: string;
  toolName: string;
  toolRevision: string;
  schemaDigest: string;
  policyDigest: string;
  bindingCurrent: boolean;
  providerDataPolicyAdmitted: boolean;
  egressApproved: boolean;
  networkBoundaryQualified: boolean;
}

export interface McpWriteIntentV1 {
  invocationId: string;
  routeDigest: string;
  argumentsDigest: string;
  idempotencyKey?: string;
  persistedBeforeDispatch: boolean;
}

export interface McpWriteReceiptV1 {
  invocationId: string;
  status: 'succeeded' | 'failed' | 'unknown';
  providerReceiptDigest?: string;
  reconciliation: 'matched' | 'mismatched' | 'not_observed';
  compensation: 'not_required' | 'succeeded' | 'failed' | 'not_observed';
}

export type McpWriteAdmissionDecisionV1 = Readonly<{
  status: 'admitted' | 'blocked';
  reasonCodes: string[];
}>;

const REQUIRED_FLAGS = ['mcpExecutionRecordV1', 'mcpProviderActionV1', 'verificationV1'] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contractDigestV1(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function routeContractDigestV1(route: McpWriteRouteContractV1): string {
  return contractDigestV1(route);
}

export function evaluateMcpWriteAdmissionV1(input: {
  flags: Pick<FeatureFlags, (typeof REQUIRED_FLAGS)[number]>;
  route?: McpWriteRouteContractV1;
  invocation: McpWriteInvocationFactsV1;
  now: Date;
}): McpWriteAdmissionDecisionV1 {
  const reasons = new Set<string>();
  for (const flag of REQUIRED_FLAGS) if (!input.flags[flag]) reasons.add(`flag_off:${flag}`);
  const route = input.route;
  if (!route) reasons.add('production_route_unconfigured');
  if (!input.invocation.bindingCurrent) reasons.add('binding_stale');
  if (!input.invocation.providerDataPolicyAdmitted) reasons.add('provider_data_policy_denied');
  if (!input.invocation.egressApproved) reasons.add('egress_not_approved');
  if (!input.invocation.networkBoundaryQualified) reasons.add('network_boundary_unqualified');
  if (route) {
    const identities = [
      ['provider_identity', input.invocation.providerIdentity, route.operatorIdentity],
      ['server_identity', input.invocation.serverIdentity, route.serverIdentity],
      ['endpoint_revision', input.invocation.endpointRevision, route.endpointRevision],
      ['tool_name', input.invocation.toolName, route.toolName],
      ['tool_revision', input.invocation.toolRevision, route.toolRevision],
      ['schema_digest', input.invocation.schemaDigest, route.schemaDigest],
      ['policy_digest', input.invocation.policyDigest, route.policyDigest],
    ] as const;
    for (const [name, actual, expected] of identities)
      if (actual !== expected) reasons.add(`${name}_mismatch`);
    if (route.effects.externalState !== 'write' && route.effects.externalState !== 'destructive')
      reasons.add('route_not_write_classified');
    if (route.minimumApproval !== 'user') reasons.add('approval_below_user');
    if (
      input.now < new Date(route.evidenceObservedAt) ||
      input.now >= new Date(route.evidenceExpiresAt)
    )
      reasons.add('route_evidence_stale');
  }
  return Object.freeze({
    status: reasons.size === 0 ? 'admitted' : 'blocked',
    reasonCodes: [...reasons].sort(),
  });
}

export function classifyMcpWriteRecoveryV1(input: {
  intent?: McpWriteIntentV1;
  receipt?: McpWriteReceiptV1;
  retryPolicy: ResolvedMcpToolPolicy['retry'];
  idempotencyKeyArgument?: string;
  providerActionRecovered: boolean;
}): Readonly<{
  action: 'replay_same_invocation' | 'reconcile' | 'compensate' | 'blocked';
  reason: string;
  preserveIntent: boolean;
  preserveReceipt: boolean;
}> {
  if (!input.intent?.persistedBeforeDispatch) {
    return Object.freeze({
      action: 'blocked',
      reason: 'durable_intent_missing',
      preserveIntent: Boolean(input.intent),
      preserveReceipt: Boolean(input.receipt),
    });
  }
  if (!input.receipt || input.receipt.status === 'unknown') {
    if (
      input.retryPolicy === 'idempotency_key' &&
      input.idempotencyKeyArgument &&
      input.intent.idempotencyKey
    ) {
      return Object.freeze({
        action: 'replay_same_invocation',
        reason: 'provider_idempotency_key',
        preserveIntent: true,
        preserveReceipt: Boolean(input.receipt),
      });
    }
    return Object.freeze({
      action: 'reconcile',
      reason: input.providerActionRecovered
        ? 'control_plane_recovered_effect_unknown'
        : 'effect_unknown',
      preserveIntent: true,
      preserveReceipt: Boolean(input.receipt),
    });
  }
  if (input.receipt.reconciliation === 'mismatched') {
    return Object.freeze({
      action: 'compensate',
      reason: 'reconciliation_mismatch',
      preserveIntent: true,
      preserveReceipt: true,
    });
  }
  return Object.freeze({
    action: 'blocked',
    reason: 'invocation_terminal',
    preserveIntent: true,
    preserveReceipt: true,
  });
}

export function qualifyMcpWriteRouteV1(input: {
  route?: McpWriteRouteContractV1;
  observedRouteDigest?: string;
  formalTaskEvidence: 'passed' | 'failed' | 'not_observed';
  duplicateSideEffects: number;
  unauthorizedSideEffects: number;
  dataBoundaryViolations: number;
  now: Date;
}): Readonly<{
  status: 'qualified' | 'blocked' | 'off';
  reasonCodes: string[];
}> {
  const reasons = new Set<string>();
  if (!input.route) reasons.add('production_route_unconfigured');
  if (input.formalTaskEvidence !== 'passed') reasons.add('formal_task_evidence_not_passed');
  if (
    input.duplicateSideEffects > 0 ||
    input.unauthorizedSideEffects > 0 ||
    input.dataBoundaryViolations > 0
  ) {
    reasons.add('hard_safety_violation');
  }
  if (input.route) {
    if (input.observedRouteDigest !== routeContractDigestV1(input.route))
      reasons.add('route_identity_drift');
    if (input.now >= new Date(input.route.evidenceExpiresAt)) reasons.add('route_evidence_stale');
  }
  return Object.freeze({
    status: reasons.has('hard_safety_violation') ? 'off' : reasons.size ? 'blocked' : 'qualified',
    reasonCodes: [...reasons].sort(),
  });
}
