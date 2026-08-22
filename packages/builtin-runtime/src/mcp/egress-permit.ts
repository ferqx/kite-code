import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalDataOriginSetV1,
  type DataOriginV1,
  type EgressAuthorityV1,
} from '@kite/runtime-spi';
import { digestCapability } from './capability-domain';
import { inspectRuntimeSecretV1 } from './secret-inspector';

export type RemoteMcpDataClassificationV1 = 'public' | 'internal' | 'confidential';
export type RemoteMcpPayloadKindV1 = 'user_prompt' | 'file_snippet' | 'tool_result';
export type RemoteMcpArgumentInspectionV1 = 'clear' | 'secret' | 'unknown';
export type RemoteMcpArgumentSnapshotV1 =
  | { ok: true; arguments: Readonly<Record<string, unknown>> }
  | { ok: false };
export const REMOTE_MCP_EGRESS_MAX_TTL_MS = 5 * 60 * 1000;
const REMOTE_MCP_ARGUMENT_INSPECTION_MAX_CHARS = 1_000_000;
const REMOTE_MCP_ARGUMENT_INSPECTION_MAX_DEPTH = 32;
const REMOTE_MCP_ARGUMENT_INSPECTION_MAX_NODES = 4_096;
const REMOTE_MCP_SECRET_FIELD =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth(?:orization)?|client[_-]?secret|credential|password|secret)$/i;

/** Redacted transport identity resolved from effective runtime configuration. */
export interface McpCapabilityRouteV1 {
  transport: 'stdio' | 'http';
  serverIdentity: string;
  endpointRevision: string;
  toolRevision: string;
}

export interface RemoteMcpEgressPermitV1 {
  version: 1;
  invocationId: string;
  serverIdentity: string;
  endpointRevision: string;
  toolRevision: string;
  argumentDigest: string;
  originDigest: string;
  dataClassifications: RemoteMcpDataClassificationV1[];
  payloadKinds: RemoteMcpPayloadKindV1[];
  nonce: string;
  approvedAt: string;
  expiresAt: string;
}

export interface RemoteMcpEgressContentV1 {
  dataClassifications: readonly RemoteMcpDataClassificationV1[];
  payloadKinds: readonly RemoteMcpPayloadKindV1[];
}

export interface RemoteMcpEgressPermitRequestV1 extends McpCapabilityRouteV1 {
  invocationId: string;
  toolCallId: string;
  argumentDigest: string;
  originDigest: string;
  content: Readonly<RemoteMcpEgressContentV1>;
}

export type RemoteMcpEgressPermitResolverV1 = (
  request: Readonly<RemoteMcpEgressPermitRequestV1>,
) => RemoteMcpEgressPermitV1 | undefined | Promise<RemoteMcpEgressPermitV1 | undefined>;

export type RemoteMcpEgressDecisionReasonV1 =
  | 'content_free'
  | 'permit_consumed'
  | 'feature_disabled'
  | 'route_unavailable'
  | 'secret_detected'
  | 'content_inspection_unknown'
  | 'permit_missing'
  | 'permit_invalid'
  | 'invocation_mismatch'
  | 'server_identity_mismatch'
  | 'endpoint_revision_mismatch'
  | 'tool_revision_mismatch'
  | 'argument_digest_mismatch'
  | 'origin_digest_mismatch'
  | 'classification_mismatch'
  | 'payload_kind_mismatch'
  | 'permit_not_yet_valid'
  | 'permit_ttl_exceeded'
  | 'permit_expired'
  | 'permit_replayed'
  | 'receipt_persistence_failed';

/** Durable, redacted decision. It intentionally omits the nonce and raw arguments. */
export interface RemoteMcpEgressReceiptV1 {
  version: 1;
  invocationId: string;
  toolCallId: string;
  serverIdentity: string;
  endpointRevision: string;
  toolRevision: string;
  argumentDigest: string;
  originDigest: string;
  dataClassifications: readonly RemoteMcpDataClassificationV1[];
  payloadKinds: readonly RemoteMcpPayloadKindV1[];
  admitted: boolean;
  reason: RemoteMcpEgressDecisionReasonV1;
  nonceDigest?: string;
  permitExpiresAt?: string;
  dataOrigins?: readonly DataOriginV1[];
  sourceOriginIds?: readonly string[];
  egressAuthority?: EgressAuthorityV1;
  decidedAt: string;
  receiptDigest: string;
}

export function remoteMcpOriginDigestV1(origins: readonly DataOriginV1[]): string {
  return createHash('sha256').update(canonicalDataOriginSetV1(origins)).digest('hex');
}

export type RemoteMcpEgressDecisionRecorderV1 = (
  receipt: RemoteMcpEgressReceiptV1,
) => void | Promise<void>;

export interface RemoteMcpEgressInvocationPolicyV1 {
  enabled: boolean;
  invocationId: string;
  toolCallId: string;
  content: Readonly<RemoteMcpEgressContentV1>;
  originDigest: string;
  sourceOrigins: readonly DataOriginV1[];
  permit?: Readonly<RemoteMcpEgressPermitV1>;
  recordDecision: RemoteMcpEgressDecisionRecorderV1;
}

export class RemoteMcpEgressDeniedError extends Error {
  readonly receipt: RemoteMcpEgressReceiptV1;

  constructor(receipt: RemoteMcpEgressReceiptV1) {
    super(`Remote MCP content egress denied: ${receipt.reason}.`);
    this.name = 'RemoteMcpEgressDeniedError';
    this.receipt = receipt;
  }
}

export function remoteMcpArgumentDigestV1(argumentsValue: Record<string, unknown>): string {
  return digestCapability(argumentsValue);
}

/**
 * Runtime arguments currently do not retain field-level provenance. Treat any
 * non-empty argument object as confidential content with unknown provenance.
 * Unknown provenance binds every supported payload kind; it must never be
 * mislabeled as only a user prompt. Project/server configuration is
 * deliberately not an input, so it cannot lower this floor.
 */
export function classifyRemoteMcpArgumentsV1(
  argumentsValue: Record<string, unknown>,
): RemoteMcpEgressContentV1 {
  if (Object.keys(argumentsValue).length === 0) {
    return Object.freeze({ dataClassifications: [], payloadKinds: [] });
  }
  return Object.freeze({
    dataClassifications: Object.freeze(['confidential'] as const),
    payloadKinds: Object.freeze(['user_prompt', 'file_snippet', 'tool_result'] as const),
  });
}

export function hasRemoteMcpContentV1(content: Readonly<RemoteMcpEgressContentV1>): boolean {
  return content.dataClassifications.length > 0 || content.payloadKinds.length > 0;
}

/**
 * Capture one immutable JSON-safe argument value before any asynchronous
 * authorization work. Accessors, custom serialization and non-JSON values are
 * rejected so the signed digest and SDK payload cannot diverge.
 */
export function snapshotRemoteMcpArgumentsV1(
  argumentsValue: Record<string, unknown>,
): RemoteMcpArgumentSnapshotV1 {
  const seen = new Set<object>();
  let capturedChars = 0;
  let capturedNodes = 0;

  const capture = (value: unknown, depth: number): { ok: true; value: unknown } | { ok: false } => {
    capturedNodes += 1;
    if (
      capturedNodes > REMOTE_MCP_ARGUMENT_INSPECTION_MAX_NODES ||
      depth > REMOTE_MCP_ARGUMENT_INSPECTION_MAX_DEPTH
    ) {
      return { ok: false };
    }
    if (value === null || typeof value === 'boolean') return { ok: true, value };
    if (typeof value === 'string') {
      capturedChars += value.length;
      return capturedChars <= REMOTE_MCP_ARGUMENT_INSPECTION_MAX_CHARS
        ? { ok: true, value }
        : { ok: false };
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? { ok: true, value } : { ok: false };
    }
    if (typeof value !== 'object' || seen.has(value)) return { ok: false };
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) return { ok: false };
        const keys = Reflect.ownKeys(value);
        if (
          keys.some((key) => typeof key !== 'string') ||
          keys.length !== value.length + 1 ||
          !keys.includes('length')
        ) {
          return { ok: false };
        }
        const copy: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
            return { ok: false };
          }
          const captured = capture(descriptor.value, depth + 1);
          if (!captured.ok) return captured;
          copy.push(captured.value);
        }
        return { ok: true, value: Object.freeze(copy) };
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return { ok: false };
      const copy = Object.create(null) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') return { ok: false };
        capturedChars += key.length;
        if (capturedChars > REMOTE_MCP_ARGUMENT_INSPECTION_MAX_CHARS) return { ok: false };
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          return { ok: false };
        }
        const captured = capture(descriptor.value, depth + 1);
        if (!captured.ok) return captured;
        Object.defineProperty(copy, key, {
          value: captured.value,
          enumerable: true,
          writable: false,
          configurable: false,
        });
      }
      return { ok: true, value: Object.freeze(copy) };
    } catch {
      return { ok: false };
    }
  };

  const captured = capture(argumentsValue, 0);
  return captured.ok &&
    captured.value &&
    typeof captured.value === 'object' &&
    !Array.isArray(captured.value)
    ? { ok: true, arguments: captured.value as Readonly<Record<string, unknown>> }
    : { ok: false };
}

/**
 * Inspect final structured arguments before a permit is requested and again
 * at the Manager boundary. Secret/protected-path signals are never representable
 * as a sendable permit classification; unsupported or over-budget input is
 * unknown and therefore fail closed.
 */
export function inspectRemoteMcpArgumentsV1(
  argumentsValue: Record<string, unknown>,
  options: { knownSecrets?: Iterable<string | undefined> } = {},
): RemoteMcpArgumentInspectionV1 {
  const seen = new Set<object>();
  let inspectedChars = 0;
  let inspectedNodes = 0;

  const inspectText = (text: string, field?: string): RemoteMcpArgumentInspectionV1 => {
    inspectedChars += text.length;
    if (inspectedChars > REMOTE_MCP_ARGUMENT_INSPECTION_MAX_CHARS) return 'unknown';
    return inspectRuntimeSecretV1({
      text: field ? `${field}=${text}` : text,
      knownSecrets: options.knownSecrets,
      maxInspectionChars: REMOTE_MCP_ARGUMENT_INSPECTION_MAX_CHARS,
    });
  };

  const visit = (
    value: unknown,
    field: string | undefined,
    depth: number,
  ): RemoteMcpArgumentInspectionV1 => {
    inspectedNodes += 1;
    if (
      inspectedNodes > REMOTE_MCP_ARGUMENT_INSPECTION_MAX_NODES ||
      depth > REMOTE_MCP_ARGUMENT_INSPECTION_MAX_DEPTH
    ) {
      return 'unknown';
    }
    if (field) {
      inspectedChars += field.length;
      if (inspectedChars > REMOTE_MCP_ARGUMENT_INSPECTION_MAX_CHARS) return 'unknown';
      if (REMOTE_MCP_SECRET_FIELD.test(field) && value != null && value !== '') return 'secret';
    }
    if (value === null) return 'clear';
    if (typeof value === 'string') return inspectText(value, field);
    if (typeof value === 'boolean') return 'clear';
    if (typeof value === 'number') return Number.isFinite(value) ? 'clear' : 'unknown';
    if (typeof value !== 'object') return 'unknown';
    if (seen.has(value)) return 'unknown';
    seen.add(value);

    let values: Array<[string | undefined, unknown]>;
    try {
      if (Array.isArray(value)) {
        values = value.map((entry) => [undefined, entry]);
      } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return 'unknown';
        values = Object.entries(value);
      }
    } catch {
      return 'unknown';
    }
    for (const [nestedField, nestedValue] of values) {
      const verdict = visit(nestedValue, nestedField, depth + 1);
      if (verdict !== 'clear') return verdict;
    }
    return 'clear';
  };

  return visit(argumentsValue, undefined, 0);
}

export function createRemoteMcpEgressPermitV1(input: {
  request: Readonly<RemoteMcpEgressPermitRequestV1>;
  approvedAt?: Date;
  expiresAt: Date;
  nonce?: string;
}): RemoteMcpEgressPermitV1 {
  const approvedAt = input.approvedAt ?? new Date();
  const ttl = input.expiresAt.getTime() - approvedAt.getTime();
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > REMOTE_MCP_EGRESS_MAX_TTL_MS) {
    throw new RangeError(
      `Remote MCP egress permit TTL must be within ${REMOTE_MCP_EGRESS_MAX_TTL_MS}ms.`,
    );
  }
  return Object.freeze({
    version: 1 as const,
    invocationId: input.request.invocationId,
    serverIdentity: input.request.serverIdentity,
    endpointRevision: input.request.endpointRevision,
    toolRevision: input.request.toolRevision,
    argumentDigest: input.request.argumentDigest,
    originDigest: input.request.originDigest,
    dataClassifications: [...input.request.content.dataClassifications],
    payloadKinds: [...input.request.content.payloadKinds],
    nonce: input.nonce ?? randomUUID(),
    approvedAt: approvedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  });
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = [...left].sort();
  const actual = [...right].sort();
  return expected.every((value, index) => value === actual[index]);
}

function nonceDigest(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

function isStringArrayFromSet(value: unknown, allowed: ReadonlySet<string>): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && allowed.has(entry))
  );
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRuntimePermitV1(value: unknown): value is RemoteMcpEgressPermitV1 {
  if (!value || typeof value !== 'object') return false;
  const permit = value as Record<string, unknown>;
  return (
    permit.version === 1 &&
    [
      permit.invocationId,
      permit.serverIdentity,
      permit.endpointRevision,
      permit.toolRevision,
      permit.argumentDigest,
      permit.originDigest,
      permit.nonce,
    ].every((entry) => typeof entry === 'string' && entry.length > 0) &&
    isCanonicalIsoTimestamp(permit.approvedAt) &&
    isCanonicalIsoTimestamp(permit.expiresAt) &&
    isStringArrayFromSet(
      permit.dataClassifications,
      new Set<RemoteMcpDataClassificationV1>(['public', 'internal', 'confidential']),
    ) &&
    isStringArrayFromSet(
      permit.payloadKinds,
      new Set<RemoteMcpPayloadKindV1>(['user_prompt', 'file_snippet', 'tool_result']),
    )
  );
}

function decisionReason(input: {
  enabled: boolean;
  request: Readonly<RemoteMcpEgressPermitRequestV1>;
  permit?: Readonly<RemoteMcpEgressPermitV1>;
  now: number;
  consumedNonceDigests?: ReadonlySet<string>;
}): RemoteMcpEgressDecisionReasonV1 {
  if (!hasRemoteMcpContentV1(input.request.content)) return 'content_free';
  if (!input.enabled) return 'feature_disabled';
  const permit = input.permit;
  if (!permit) return 'permit_missing';
  if (!isRuntimePermitV1(permit) || Date.parse(permit.expiresAt) <= Date.parse(permit.approvedAt)) {
    return 'permit_invalid';
  }
  if (permit.invocationId !== input.request.invocationId) return 'invocation_mismatch';
  if (permit.serverIdentity !== input.request.serverIdentity) return 'server_identity_mismatch';
  if (permit.endpointRevision !== input.request.endpointRevision) {
    return 'endpoint_revision_mismatch';
  }
  if (permit.toolRevision !== input.request.toolRevision) return 'tool_revision_mismatch';
  if (permit.argumentDigest !== input.request.argumentDigest) return 'argument_digest_mismatch';
  if (permit.originDigest !== input.request.originDigest) return 'origin_digest_mismatch';
  if (!sameSet(permit.dataClassifications, input.request.content.dataClassifications)) {
    return 'classification_mismatch';
  }
  if (!sameSet(permit.payloadKinds, input.request.content.payloadKinds)) {
    return 'payload_kind_mismatch';
  }
  if (Date.parse(permit.expiresAt) - Date.parse(permit.approvedAt) > REMOTE_MCP_EGRESS_MAX_TTL_MS) {
    return 'permit_ttl_exceeded';
  }
  if (input.now < Date.parse(permit.approvedAt)) return 'permit_not_yet_valid';
  if (input.now >= Date.parse(permit.expiresAt)) return 'permit_expired';
  if (input.consumedNonceDigests?.has(nonceDigest(permit.nonce))) return 'permit_replayed';
  return 'permit_consumed';
}

export function createRemoteMcpEgressReceiptV1(input: {
  enabled: boolean;
  request: Readonly<RemoteMcpEgressPermitRequestV1>;
  permit?: Readonly<RemoteMcpEgressPermitV1>;
  now?: Date;
  consumedNonceDigests?: ReadonlySet<string>;
  reason?: RemoteMcpEgressDecisionReasonV1;
  dataOrigins?: readonly DataOriginV1[];
  sourceOriginIds?: readonly string[];
  egressAuthority?: EgressAuthorityV1;
}): RemoteMcpEgressReceiptV1 {
  const decidedAt = (input.now ?? new Date()).toISOString();
  const reason =
    input.reason ??
    decisionReason({
      enabled: input.enabled,
      request: input.request,
      permit: input.permit,
      now: Date.parse(decidedAt),
      consumedNonceDigests: input.consumedNonceDigests,
    });
  const receipt = {
    version: 1 as const,
    invocationId: input.request.invocationId,
    toolCallId: input.request.toolCallId,
    serverIdentity: input.request.serverIdentity,
    endpointRevision: input.request.endpointRevision,
    toolRevision: input.request.toolRevision,
    argumentDigest: input.request.argumentDigest,
    originDigest: input.request.originDigest,
    dataClassifications: [...input.request.content.dataClassifications],
    payloadKinds: [...input.request.content.payloadKinds],
    admitted: reason === 'content_free' || reason === 'permit_consumed',
    reason,
    ...(typeof input.permit?.nonce === 'string' && input.permit.nonce
      ? { nonceDigest: nonceDigest(input.permit.nonce) }
      : {}),
    ...(typeof input.permit?.expiresAt === 'string'
      ? { permitExpiresAt: input.permit.expiresAt }
      : {}),
    ...(input.dataOrigins ? { dataOrigins: Object.freeze([...input.dataOrigins]) } : {}),
    ...(input.sourceOriginIds
      ? { sourceOriginIds: Object.freeze([...input.sourceOriginIds]) }
      : {}),
    ...(input.egressAuthority ? { egressAuthority: input.egressAuthority } : {}),
    decidedAt,
  };
  return Object.freeze({ ...receipt, receiptDigest: digestCapability(receipt) });
}

/** Reclassify a redacted receipt without recovering the raw nonce or arguments. */
export function reclassifyRemoteMcpEgressReceiptV1(
  receipt: Readonly<RemoteMcpEgressReceiptV1>,
  reason: RemoteMcpEgressDecisionReasonV1,
  now = new Date(),
): RemoteMcpEgressReceiptV1 {
  const { receiptDigest: _previousDigest, ...previous } = receipt;
  const next = {
    ...previous,
    admitted: reason === 'content_free' || reason === 'permit_consumed',
    reason,
    decidedAt: now.toISOString(),
  };
  return Object.freeze({ ...next, receiptDigest: digestCapability(next) });
}

/** Manager-owned one-shot ledger. Validation and nonce claim are synchronous and atomic. */
export class RemoteMcpEgressPermitLedgerV1 {
  private readonly consumedNonceDigests = new Set<string>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  consume(input: {
    enabled: boolean;
    request: Readonly<RemoteMcpEgressPermitRequestV1>;
    permit?: Readonly<RemoteMcpEgressPermitV1>;
  }): RemoteMcpEgressReceiptV1 {
    const receipt = createRemoteMcpEgressReceiptV1({
      ...input,
      now: this.now(),
      consumedNonceDigests: this.consumedNonceDigests,
    });
    if (receipt.reason === 'permit_consumed' && input.permit) {
      this.consumedNonceDigests.add(nonceDigest(input.permit.nonce));
    }
    return receipt;
  }
}
