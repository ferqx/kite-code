/**
 * Bounded read-only compatibility for uncommitted schema-v23/checkpoint-v2 data.
 *
 * ADR-0098 forbids using this module to prepare, schedule, dispatch, or persist
 * compaction. It exists only so a previously written local snapshot can fall
 * back safely instead of reviving the superseded Slice B producer chain.
 */
import { normalizeCompactionSummary } from '@/core/model/compaction-summary-frame';
import { findSafeCompactionBoundary } from '@/core/model/compaction-v2';
import {
  CONTEXT_ESTIMATOR_ID_V2,
  CONTEXT_PROJECTION_CONTRACT_V2,
  canonicalContextDigestV2,
} from '@/core/model/context-preparation-v2';
import { countTokens } from '@/core/token-counter';
import type { ContextCompactionCheckpointV1, ContextCompactionReason } from './context-compaction';
import type { RuntimeState, TranscriptMessage } from './state';

const LEGACY_SOURCE_MANIFEST_MAX_UTF8_BYTES = 8 * 1_024;
const LEGACY_CHECKPOINT_METADATA_MAX_UTF8_BYTES = 32 * 1_024;
const LEGACY_SUMMARY_MAX_UTF8_BYTES = 128 * 1_024;
const LEGACY_SUMMARY_MAX_TOKENS = 6_000;
const LEGACY_SOURCE_MAX_MESSAGES = 20_000;
const LEGACY_SOURCE_PROOF_MAX_UTF8_BYTES = 16 * 1_024 * 1_024;
const LEGACY_IDENTIFIER_MAX_UTF8_BYTES = 512;
const LEGACY_TOKEN_COUNT_MAX = 1_000_000_000;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key) || !expected.includes(key)) return false;
    count += 1;
    if (count > expected.length) return false;
  }
  return (
    count === expected.length &&
    expected.every((key) => Object.prototype.propertyIsEnumerable.call(value, key))
  );
}

function hasExactKeysWithOptional(
  value: object,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key) || (!required.includes(key) && !optional.includes(key))) {
      return false;
    }
    count += 1;
    if (count > required.length + optional.length) return false;
  }
  return (
    count >= required.length &&
    required.every((key) => Object.prototype.propertyIsEnumerable.call(value, key))
  );
}

function boundedText(value: unknown, maxBytes = LEGACY_IDENTIFIER_MAX_UTF8_BYTES): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxBytes &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
  );
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && SHA256_HEX.test(value);
}

/**
 * Counts a JSON-compatible tree without serializing or projecting it first.
 * The byte budget and depth cap stop traversal before a later getter/value can
 * be reached once the accepted historical envelope is already too large.
 */
function fitsBoundedJsonUtf8(
  value: unknown,
  maxBytes: number,
  omitKey: (depth: number, key: string) => boolean = () => false,
): boolean {
  let remaining = maxBytes;
  const seen = new WeakSet<object>();

  const consume = (bytes: number): boolean => {
    if (bytes > remaining) return false;
    remaining -= bytes;
    return true;
  };
  const consumeAscii = (text: string): boolean => consume(text.length);
  const consumeJsonString = (text: string): boolean => {
    if (!consume(2)) return false;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code <= 0x1f) {
        // Conservatively count every control character as a six-byte \u00XX escape.
        if (!consume(6)) return false;
      } else if (code === 0x22 || code === 0x5c) {
        if (!consume(2)) return false;
      } else if (code <= 0x7f) {
        if (!consume(1)) return false;
      } else if (code <= 0x7ff) {
        if (!consume(2)) return false;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          if (!consume(4)) return false;
          index += 1;
        } else if (!consume(6)) {
          // Well-formed JSON.stringify escapes an unpaired surrogate as \uXXXX.
          return false;
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        if (!consume(6)) return false;
      } else if (!consume(3)) {
        return false;
      }
    }
    return true;
  };
  const visit = (current: unknown, depth: number): boolean => {
    if (depth > 64) return false;
    if (current === null) return consume(4);
    switch (typeof current) {
      case 'string':
        return consumeJsonString(current);
      case 'number':
        return Number.isFinite(current) && consumeAscii(String(current));
      case 'boolean':
        return consume(current ? 4 : 5);
      case 'object': {
        if (seen.has(current)) return false;
        seen.add(current);
        if (Array.isArray(current)) {
          if (!consume(2)) return false;
          let emitted = 0;
          for (let index = 0; index < current.length; index += 1) {
            const key = String(index);
            if (omitKey(depth, key)) continue;
            if (emitted > 0 && !consume(1)) return false;
            emitted += 1;
            if (!visit(current[index], depth + 1)) return false;
          }
          return true;
        }
        if (!consume(2)) return false;
        let keyCount = 0;
        let emitted = 0;
        for (const key in current) {
          if (!Object.hasOwn(current, key)) return false;
          keyCount += 1;
          if (keyCount > remaining) return false;
          if (omitKey(depth, key)) continue;
          if (emitted > 0 && !consume(1)) return false;
          emitted += 1;
          if (!consumeJsonString(key) || !consume(1)) return false;
          if (!visit((current as Record<string, unknown>)[key], depth + 1)) return false;
        }
        return true;
      }
      default:
        return false;
    }
  };

  return visit(value, 0);
}

function validateLegacyBase(base: LegacyContextCompactionBaseIdentityV2): boolean {
  if (!base || typeof base !== 'object') return false;
  if (hasExactKeys(base, ['kind'])) return base.kind === 'none';
  if (hasExactKeys(base, ['checkpointId', 'kind', 'sourceDigest'])) {
    return (
      base.kind === 'checkpoint_v1' && boundedText(base.checkpointId) && digest(base.sourceDigest)
    );
  }
  if (!hasExactKeys(base, ['checkpointId', 'kind', 'manifestIdentity', 'sourceIdentity'])) {
    return false;
  }
  return (
    base.kind === 'checkpoint_v2' &&
    boundedText(base.checkpointId) &&
    digest(base.manifestIdentity) &&
    (base.sourceIdentity === 'verified_v2' || base.sourceIdentity === 'legacy_raw_source')
  );
}

function validateLegacyReclaim(value: LegacyPersistedReclaimApplicationV2): boolean {
  if (!value || typeof value !== 'object') return false;
  if (hasExactKeys(value, ['kind', 'rawFramesDigest'])) {
    return value.kind === 'off' && digest(value.rawFramesDigest);
  }
  if (hasExactKeys(value, ['appliedFramesDigest', 'commitDigest', 'kind', 'planDigest'])) {
    return (
      value.kind === 'applied_commit' &&
      digest(value.planDigest) &&
      digest(value.commitDigest) &&
      digest(value.appliedFramesDigest)
    );
  }
  if (
    hasExactKeysWithOptional(
      value,
      ['appliedFramesDigest', 'kind', 'planDigest', 'selectedCoverageDigest'],
      ['baseCommitDigest'],
    )
  ) {
    return (
      value.kind === 'applied_plan' &&
      digest(value.planDigest) &&
      (value.baseCommitDigest === undefined || digest(value.baseCommitDigest)) &&
      digest(value.selectedCoverageDigest) &&
      digest(value.appliedFramesDigest)
    );
  }
  if (hasExactKeys(value, ['appliedFramesDigest', 'kind', 'planDigest'])) {
    return (
      value.kind === 'valid_noop_plan' &&
      digest(value.planDigest) &&
      digest(value.appliedFramesDigest)
    );
  }
  if (hasExactKeys(value, ['failure', 'kind', 'rawFramesDigest'])) {
    return (
      value.kind === 'raw_fallback' &&
      ['ineligible', 'plan_rejected', 'apply_rejected', 'cache_parent_frozen'].includes(
        value.failure,
      ) &&
      digest(value.rawFramesDigest)
    );
  }
  return false;
}

export type LegacyContextCompactionSourceIdentityV2 = 'verified_v2' | 'legacy_raw_source';

export type LegacyContextCompactionBaseIdentityV2 =
  | { kind: 'none' }
  | { kind: 'checkpoint_v1'; checkpointId: string; sourceDigest: string }
  | {
      kind: 'checkpoint_v2';
      checkpointId: string;
      sourceIdentity: LegacyContextCompactionSourceIdentityV2;
      manifestIdentity: string;
    };

export type LegacyPersistedReclaimApplicationV2 =
  | { kind: 'off'; rawFramesDigest: string }
  | {
      kind: 'applied_commit';
      planDigest: string;
      commitDigest: string;
      appliedFramesDigest: string;
    }
  | {
      kind: 'applied_plan';
      planDigest: string;
      baseCommitDigest?: string;
      selectedCoverageDigest: string;
      appliedFramesDigest: string;
    }
  | { kind: 'valid_noop_plan'; planDigest: string; appliedFramesDigest: string }
  | {
      kind: 'raw_fallback';
      failure: 'ineligible' | 'plan_rejected' | 'apply_rejected' | 'cache_parent_frozen';
      rawFramesDigest: string;
    };

/** Historical events are accepted during replay but never update current rolling state. */
export type LegacySliceBGuardEvent =
  | ({ type: 'context.compaction_refill_observed' } & Record<string, unknown>)
  | ({ type: 'context.compaction_guard_carried_forward' } & Record<string, unknown>)
  | ({ type: 'context.compaction_guard_reset' } & Record<string, unknown>);

export interface LegacyContextCompactionSourceManifestV1 {
  readonly version: 1;
  readonly sourceRevision: number;
  readonly sourceStartMessageId: string;
  readonly coveredThroughMessageId: string;
  readonly coveredThroughTurnId: string;
  readonly rawSourceDigest: string;
  readonly rawTranscriptDigest: string;
  readonly rawFramesDigest: string;
  readonly summaryProjectionDigest: string;
  readonly appliedFramesDigest: string;
  readonly toolResultBudgetPolicyId: string;
  readonly reclaimPolicyId: string;
  readonly summaryPolicyId: 'context-compaction-summary:v2';
  readonly estimatorId: typeof CONTEXT_ESTIMATOR_ID_V2;
  readonly projectionEnvironmentDigest: string;
  readonly cacheAffectingEnvironmentDigest: string;
  readonly projectionContractId: typeof CONTEXT_PROJECTION_CONTRACT_V2;
  readonly routeIdentityDigest: string;
  readonly requestShape: 'cache_safe_fork:v1' | 'isolated_minimal_no_tools:v1';
  readonly sourceIdentity: LegacyContextCompactionSourceIdentityV2;
  readonly base: LegacyContextCompactionBaseIdentityV2;
  readonly reclaimApplication: LegacyPersistedReclaimApplicationV2;
}

export interface LegacyContextCompactionCheckpointV2 {
  compactionId: string;
  version: 2;
  sourceRevision: number;
  sourceDigest: string;
  rawSourceDigest: string;
  sourceIdentity: LegacyContextCompactionSourceIdentityV2;
  coveredThroughMessageId: string;
  coveredThroughTurnId: string;
  summary: string;
  inputTokensBefore: number;
  inputTokensAfter: number;
  reason: ContextCompactionReason;
  createdAt: string;
  base: LegacyContextCompactionBaseIdentityV2;
  baseCheckpointId?: string;
  rawTranscriptDigest: string;
  rawFramesDigest: string;
  summaryProjectionDigest: string;
  appliedFramesDigest: string;
  normalizedSummaryDigest: string;
  candidateAfterFramesDigest: string;
  candidateAfterProjectionDigest: string;
  toolResultBudgetPolicyId: string;
  reclaimPolicyId: string;
  summaryPolicyId: 'context-compaction-summary:v2';
  estimatorId: string;
  projectionEnvironmentDigest: string;
  cacheAffectingEnvironmentDigest: string;
  projectionContractId: string;
  routeIdentityDigest: string;
  requestShape: 'cache_safe_fork:v1' | 'isolated_minimal_no_tools:v1';
  manifestIdentity: string;
  sourceManifest: LegacyContextCompactionSourceManifestV1;
  reclaimApplication: LegacyPersistedReclaimApplicationV2;
}

function transcriptProofValue(messages: readonly TranscriptMessage[]): unknown {
  return messages.map(({ createdAt: _createdAt, ...message }) => message);
}

function sourceQualification(
  coveredMessages: readonly TranscriptMessage[],
  baseOverride: LegacyContextCompactionBaseIdentityV2,
): LegacyContextCompactionSourceIdentityV2 {
  const legacyBase =
    baseOverride.kind === 'checkpoint_v1' ||
    (baseOverride.kind === 'checkpoint_v2' && baseOverride.sourceIdentity !== 'verified_v2');
  if (legacyBase) return 'legacy_raw_source';
  for (const message of coveredMessages) {
    if (message.kind !== 'tool') continue;
    const receipt = message.resultMeta?.toolResultReceipt;
    if (
      message.resultMeta?.terminalMigration ||
      message.resultMeta?.digestScope !== 'raw' ||
      receipt?.version !== 2 ||
      receipt.projectionMode !== 'budget_v2'
    ) {
      return 'legacy_raw_source';
    }
  }
  return 'verified_v2';
}

function manifestIdentity(manifest: LegacyContextCompactionSourceManifestV1): string {
  return canonicalContextDigestV2('context-compaction-source-manifest:v1', manifest);
}

function validateManifest(manifest: LegacyContextCompactionSourceManifestV1): void {
  const expectedKeys = [
    'appliedFramesDigest',
    'base',
    'cacheAffectingEnvironmentDigest',
    'coveredThroughMessageId',
    'coveredThroughTurnId',
    'estimatorId',
    'projectionContractId',
    'projectionEnvironmentDigest',
    'rawFramesDigest',
    'rawSourceDigest',
    'rawTranscriptDigest',
    'reclaimApplication',
    'reclaimPolicyId',
    'requestShape',
    'routeIdentityDigest',
    'sourceIdentity',
    'sourceRevision',
    'sourceStartMessageId',
    'summaryPolicyId',
    'summaryProjectionDigest',
    'toolResultBudgetPolicyId',
    'version',
  ];
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !hasExactKeys(manifest, expectedKeys) ||
    manifest.version !== 1 ||
    !Number.isSafeInteger(manifest.sourceRevision) ||
    manifest.sourceRevision < 0 ||
    !boundedText(manifest.sourceStartMessageId) ||
    !boundedText(manifest.coveredThroughMessageId) ||
    !boundedText(manifest.coveredThroughTurnId) ||
    !digest(manifest.rawSourceDigest) ||
    !digest(manifest.rawTranscriptDigest) ||
    !digest(manifest.rawFramesDigest) ||
    !digest(manifest.summaryProjectionDigest) ||
    !digest(manifest.appliedFramesDigest) ||
    !boundedText(manifest.toolResultBudgetPolicyId) ||
    !boundedText(manifest.reclaimPolicyId) ||
    manifest.summaryPolicyId !== 'context-compaction-summary:v2' ||
    manifest.estimatorId !== CONTEXT_ESTIMATOR_ID_V2 ||
    !digest(manifest.projectionEnvironmentDigest) ||
    !digest(manifest.cacheAffectingEnvironmentDigest) ||
    manifest.projectionContractId !== CONTEXT_PROJECTION_CONTRACT_V2 ||
    !digest(manifest.routeIdentityDigest) ||
    (manifest.requestShape !== 'cache_safe_fork:v1' &&
      manifest.requestShape !== 'isolated_minimal_no_tools:v1') ||
    (manifest.sourceIdentity !== 'verified_v2' &&
      manifest.sourceIdentity !== 'legacy_raw_source') ||
    !validateLegacyBase(manifest.base) ||
    !validateLegacyReclaim(manifest.reclaimApplication) ||
    !fitsBoundedJsonUtf8(manifest, LEGACY_SOURCE_MANIFEST_MAX_UTF8_BYTES)
  ) {
    throw new Error('legacy_checkpoint_v2_manifest_invalid');
  }
}

export function readLegacyCheckpointV2ReadOnly(input: {
  checkpoint: LegacyContextCompactionCheckpointV2;
  state: Readonly<RuntimeState>;
}): ContextCompactionCheckpointV1 {
  const checkpoint = input.checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object') {
    throw new Error('legacy_checkpoint_v2_envelope_invalid');
  }
  const checkpointKeys = [
    'appliedFramesDigest',
    'base',
    'cacheAffectingEnvironmentDigest',
    'candidateAfterFramesDigest',
    'candidateAfterProjectionDigest',
    'compactionId',
    'coveredThroughMessageId',
    'coveredThroughTurnId',
    'createdAt',
    'estimatorId',
    'inputTokensAfter',
    'inputTokensBefore',
    'manifestIdentity',
    'normalizedSummaryDigest',
    'projectionContractId',
    'projectionEnvironmentDigest',
    'rawFramesDigest',
    'rawSourceDigest',
    'rawTranscriptDigest',
    'reason',
    'reclaimApplication',
    'reclaimPolicyId',
    'requestShape',
    'routeIdentityDigest',
    'sourceDigest',
    'sourceIdentity',
    'sourceManifest',
    'sourceRevision',
    'summary',
    'summaryPolicyId',
    'summaryProjectionDigest',
    'toolResultBudgetPolicyId',
    'version',
  ];
  if (
    !hasExactKeysWithOptional(checkpoint, checkpointKeys, ['baseCheckpointId']) ||
    checkpoint.version !== 2 ||
    !boundedText(checkpoint.compactionId) ||
    !Number.isSafeInteger(checkpoint.sourceRevision) ||
    checkpoint.sourceRevision < 0 ||
    checkpoint.sourceRevision > input.state.revision ||
    !boundedText(checkpoint.coveredThroughMessageId) ||
    !boundedText(checkpoint.coveredThroughTurnId) ||
    !Number.isSafeInteger(checkpoint.inputTokensBefore) ||
    !Number.isSafeInteger(checkpoint.inputTokensAfter) ||
    checkpoint.inputTokensBefore < 0 ||
    checkpoint.inputTokensBefore > LEGACY_TOKEN_COUNT_MAX ||
    checkpoint.inputTokensAfter < 0 ||
    checkpoint.inputTokensAfter > LEGACY_TOKEN_COUNT_MAX ||
    checkpoint.inputTokensBefore - checkpoint.inputTokensAfter < 1_024 ||
    (checkpoint.reason !== 'manual' && checkpoint.reason !== 'auto') ||
    !boundedText(checkpoint.summary, LEGACY_SUMMARY_MAX_UTF8_BYTES) ||
    !fitsBoundedJsonUtf8(checkpoint.summary, LEGACY_SUMMARY_MAX_UTF8_BYTES) ||
    !boundedText(checkpoint.createdAt) ||
    !Number.isFinite(Date.parse(checkpoint.createdAt)) ||
    new Date(checkpoint.createdAt).toISOString() !== checkpoint.createdAt ||
    !validateLegacyBase(checkpoint.base) ||
    !validateLegacyReclaim(checkpoint.reclaimApplication) ||
    (checkpoint.base.kind === 'none'
      ? checkpoint.baseCheckpointId !== undefined
      : checkpoint.baseCheckpointId !== checkpoint.base.checkpointId)
  ) {
    throw new Error('legacy_checkpoint_v2_envelope_invalid');
  }
  validateManifest(checkpoint.sourceManifest);
  if (
    !fitsBoundedJsonUtf8(
      checkpoint,
      LEGACY_CHECKPOINT_METADATA_MAX_UTF8_BYTES,
      (depth, key) => depth === 0 && (key === 'summary' || key === 'sourceManifest'),
    )
  ) {
    throw new Error('legacy_checkpoint_v2_envelope_invalid');
  }
  const normalizedSummary = normalizeCompactionSummary(checkpoint.summary);
  if (
    checkpoint.sourceRevision !== checkpoint.sourceManifest.sourceRevision ||
    checkpoint.manifestIdentity !== manifestIdentity(checkpoint.sourceManifest) ||
    !digest(checkpoint.manifestIdentity) ||
    checkpoint.sourceDigest !== checkpoint.rawSourceDigest ||
    !digest(checkpoint.rawSourceDigest) ||
    !digest(checkpoint.rawTranscriptDigest) ||
    !digest(checkpoint.rawFramesDigest) ||
    !digest(checkpoint.summaryProjectionDigest) ||
    !digest(checkpoint.appliedFramesDigest) ||
    !digest(checkpoint.normalizedSummaryDigest) ||
    !digest(checkpoint.candidateAfterFramesDigest) ||
    !digest(checkpoint.candidateAfterProjectionDigest) ||
    checkpoint.rawSourceDigest !== checkpoint.sourceManifest.rawSourceDigest ||
    checkpoint.rawTranscriptDigest !== checkpoint.sourceManifest.rawTranscriptDigest ||
    checkpoint.coveredThroughMessageId !== checkpoint.sourceManifest.coveredThroughMessageId ||
    checkpoint.coveredThroughTurnId !== checkpoint.sourceManifest.coveredThroughTurnId ||
    checkpoint.rawFramesDigest !== checkpoint.sourceManifest.rawFramesDigest ||
    checkpoint.summaryProjectionDigest !== checkpoint.sourceManifest.summaryProjectionDigest ||
    checkpoint.appliedFramesDigest !== checkpoint.sourceManifest.appliedFramesDigest ||
    checkpoint.toolResultBudgetPolicyId !== checkpoint.sourceManifest.toolResultBudgetPolicyId ||
    checkpoint.reclaimPolicyId !== checkpoint.sourceManifest.reclaimPolicyId ||
    checkpoint.summaryPolicyId !== checkpoint.sourceManifest.summaryPolicyId ||
    checkpoint.estimatorId !== checkpoint.sourceManifest.estimatorId ||
    checkpoint.projectionEnvironmentDigest !==
      checkpoint.sourceManifest.projectionEnvironmentDigest ||
    checkpoint.cacheAffectingEnvironmentDigest !==
      checkpoint.sourceManifest.cacheAffectingEnvironmentDigest ||
    checkpoint.projectionContractId !== checkpoint.sourceManifest.projectionContractId ||
    checkpoint.routeIdentityDigest !== checkpoint.sourceManifest.routeIdentityDigest ||
    checkpoint.requestShape !== checkpoint.sourceManifest.requestShape ||
    checkpoint.sourceIdentity !== checkpoint.sourceManifest.sourceIdentity ||
    JSON.stringify(checkpoint.base) !== JSON.stringify(checkpoint.sourceManifest.base) ||
    JSON.stringify(checkpoint.reclaimApplication) !==
      JSON.stringify(checkpoint.sourceManifest.reclaimApplication) ||
    !normalizedSummary ||
    normalizedSummary !== checkpoint.summary ||
    countTokens(checkpoint.summary) > LEGACY_SUMMARY_MAX_TOKENS ||
    checkpoint.normalizedSummaryDigest !==
      canonicalContextDigestV2('normalized-compaction-summary:v2', normalizedSummary)
  ) {
    throw new Error('legacy_checkpoint_v2_manifest_mismatch');
  }
  const transcriptMessages = input.state.transcript.messages;
  if (
    !Array.isArray(transcriptMessages) ||
    transcriptMessages.length > LEGACY_SOURCE_MAX_MESSAGES
  ) {
    throw new Error('legacy_checkpoint_v2_source_too_large');
  }
  let coveredIndex = -1;
  for (let index = 0; index < transcriptMessages.length; index += 1) {
    const message = transcriptMessages[index];
    if (
      message?.messageId === checkpoint.coveredThroughMessageId &&
      message.turnId === checkpoint.coveredThroughTurnId
    ) {
      coveredIndex = index;
      break;
    }
  }
  if (coveredIndex < 0) throw new Error('legacy_checkpoint_v2_boundary_missing');
  if (
    !fitsBoundedJsonUtf8(
      transcriptMessages,
      LEGACY_SOURCE_PROOF_MAX_UTF8_BYTES,
      (depth, key) =>
        (depth === 0 && /^\d+$/.test(key) && Number(key) > coveredIndex) ||
        (depth === 1 && key === 'createdAt'),
    )
  ) {
    throw new Error('legacy_checkpoint_v2_source_too_large');
  }
  const sourceMessages = transcriptMessages.slice(0, coveredIndex + 1);
  const transcriptProof = transcriptProofValue(sourceMessages);
  const boundary = findSafeCompactionBoundary({
    ...input.state,
    transcript: { ...input.state.transcript, messages: sourceMessages },
  });
  if (
    !boundary.eligible ||
    boundary.firstMessageId !== checkpoint.sourceManifest.sourceStartMessageId ||
    boundary.lastMessageId !== checkpoint.coveredThroughMessageId ||
    boundary.coveredThroughTurnId !== checkpoint.coveredThroughTurnId
  ) {
    throw new Error('legacy_checkpoint_v2_boundary_invalid');
  }
  const rawTranscriptDigest = canonicalContextDigestV2(
    'context-compaction-raw-transcript:v2',
    transcriptProof,
  );
  const rawSourceDigest = canonicalContextDigestV2('context-compaction-raw-source:v2', {
    base: checkpoint.base,
    rawTranscriptDigest,
    sourceStartMessageId: boundary.firstMessageId,
    coveredThroughMessageId: boundary.lastMessageId,
    coveredThroughTurnId: boundary.coveredThroughTurnId,
  });
  if (
    rawTranscriptDigest !== checkpoint.rawTranscriptDigest ||
    rawSourceDigest !== checkpoint.rawSourceDigest ||
    sourceQualification(sourceMessages, checkpoint.base) !== checkpoint.sourceIdentity
  ) {
    throw new Error('legacy_checkpoint_v2_source_mismatch');
  }
  return {
    compactionId: checkpoint.compactionId,
    version: 1,
    sourceRevision: checkpoint.sourceRevision,
    sourceDigest: checkpoint.sourceDigest,
    coveredThroughMessageId: checkpoint.coveredThroughMessageId,
    coveredThroughTurnId: checkpoint.coveredThroughTurnId,
    summary: checkpoint.summary,
    inputTokensBefore: checkpoint.inputTokensBefore,
    inputTokensAfter: checkpoint.inputTokensAfter,
    reason: checkpoint.reason,
    createdAt: checkpoint.createdAt,
    ...(checkpoint.baseCheckpointId ? { baseCheckpointId: checkpoint.baseCheckpointId } : {}),
  };
}

export function isLegacyCheckpointV2(value: unknown): value is LegacyContextCompactionCheckpointV2 {
  return Boolean(
    value && typeof value === 'object' && (value as { version?: unknown }).version === 2,
  );
}
