import { createHash } from 'node:crypto';

export interface RuntimeEventLedgerBaseV1 {
  version: 1;
  kind: 'empty_v24' | 'migrated_v23' | 'verified_named_v24' | 'fork_rebound_v24';
  baseRevision: number;
  baseId: string;
  eventLedgerBaseDigest: string;
  prefixDigestAtBase: string;
  nextRevision: number;
  legacyEvidenceDigest?: string;
  branchMutationReceiptId?: string;
}

export interface RuntimeStorageFormatV1 {
  version: 1;
  format: 'v24_strict';
  canonicalEventRegistryId: 'runtime-event-registry:v24';
  ledgerBase: RuntimeEventLedgerBaseV1;
  tailEventCount: number;
  tailCanonicalBytes: number;
  tailPrefixDigest: string;
}

export interface LegacyRuntimeLedgerEvidenceV1 {
  version: 1;
  sourceEventCount: number;
  sourceEventBytes: number;
  sourceRawEventDigest: string;
  namedCatalogCount: number;
  namedCatalogBytes: number;
  namedCatalogDigest: string;
  namedCatalogVersion?: number;
}

export interface LegacyNamedCutProofV1 {
  version: 1;
  threadId: string;
  name: string;
  eventPosition: number;
  classification: 'verified_metadata_prefix' | 'legacy_unverified';
  evidenceDigest: string;
  namedLedgerBase: string;
  proofChecksum: string;
}

function digest(domain: string, value: string): string {
  return createHash('sha256').update(`${domain}\0`).update(value).digest('hex');
}

export function createLegacyNamedCutProofV1(input: {
  threadId: string;
  name: string;
  eventPosition: number;
  classification: LegacyNamedCutProofV1['classification'];
  evidence: unknown;
}): LegacyNamedCutProofV1 {
  const evidenceDigest = digest('legacy-named-cut-evidence:v1', JSON.stringify(input.evidence));
  // The base is deliberately one-way: it can depend on evidenceDigest, while
  // the final checksum may depend on the base but can never feed back into it.
  const namedLedgerBase = digest(
    'legacy-named-cut-ledger-base:v1',
    `${input.threadId}:${input.name}:${input.eventPosition}:${evidenceDigest}`,
  );
  const body = {
    version: 1 as const,
    threadId: input.threadId,
    name: input.name,
    eventPosition: input.eventPosition,
    classification: input.classification,
    evidenceDigest,
    namedLedgerBase,
  };
  return {
    ...body,
    proofChecksum: digest('legacy-named-cut-proof:v1', JSON.stringify(body)),
  };
}

export function verifyLegacyNamedCutProofV1(proof: LegacyNamedCutProofV1): boolean {
  const { proofChecksum, ...body } = proof;
  return (
    proof.version === 1 &&
    /^[a-f0-9]{64}$/.test(proof.evidenceDigest) &&
    proof.namedLedgerBase ===
      digest(
        'legacy-named-cut-ledger-base:v1',
        `${proof.threadId}:${proof.name}:${proof.eventPosition}:${proof.evidenceDigest}`,
      ) &&
    proofChecksum === digest('legacy-named-cut-proof:v1', JSON.stringify(body))
  );
}

export function migrateLegacyNamedStateV24(input: {
  state: Record<string, unknown>;
  proof: LegacyNamedCutProofV1;
}): Record<string, unknown> {
  if (input.proof.classification !== 'verified_metadata_prefix') {
    throw new Error('Only a verified metadata-prefix named cut may become branchable.');
  }
  const revision =
    typeof input.state.revision === 'number' && Number.isSafeInteger(input.state.revision)
      ? input.state.revision
      : 0;
  const { storageFormat: _legacyStorageFormat, ...canonicalPreV24State } = input.state;
  return {
    ...input.state,
    schemaVersion: 24,
    lastAppliedEventId: undefined,
    appliedEventIds: [],
    storageFormat: createMigratedRuntimeStorageFormatV24({
      sourceSchemaVersion: 23,
      stateRevision: revision,
      canonicalPreV24State: JSON.stringify({
        ...canonicalPreV24State,
        schemaVersion: 23,
      }),
      legacyEvidence: {
        version: 1,
        sourceEventCount: 0,
        sourceEventBytes: 0,
        sourceRawEventDigest: input.proof.evidenceDigest,
        namedCatalogCount: 1,
        namedCatalogBytes: Buffer.byteLength(JSON.stringify(input.state), 'utf8'),
        namedCatalogDigest: input.proof.namedLedgerBase,
      },
    }),
  };
}

export function createEmptyRuntimeStorageFormatV24(): RuntimeStorageFormatV1 {
  const baseId = digest('runtime-ledger-base-id:v1', 'empty-v24');
  const prefix = digest('runtime-event-prefix:v24', 'empty');
  return {
    version: 1,
    format: 'v24_strict',
    canonicalEventRegistryId: 'runtime-event-registry:v24',
    ledgerBase: {
      version: 1,
      kind: 'empty_v24',
      baseRevision: 0,
      baseId,
      eventLedgerBaseDigest: digest('runtime-event-ledger-base:v1', baseId),
      prefixDigestAtBase: prefix,
      nextRevision: 1,
    },
    tailEventCount: 0,
    tailCanonicalBytes: 0,
    tailPrefixDigest: prefix,
  };
}

export function createMigratedRuntimeStorageFormatV24(input: {
  sourceSchemaVersion: 23;
  stateRevision: number;
  canonicalPreV24State: string;
  legacyEvidence?: LegacyRuntimeLedgerEvidenceV1;
}): RuntimeStorageFormatV1 {
  const stateDigest = digest('canonical-pre-v24-runtime-state:v1', input.canonicalPreV24State);
  const evidence =
    input.legacyEvidence ??
    ({
      version: 1,
      sourceEventCount: 0,
      sourceEventBytes: 0,
      sourceRawEventDigest: digest('legacy-runtime-raw-events:v1', 'empty'),
      namedCatalogCount: 0,
      namedCatalogBytes: 0,
      namedCatalogDigest: digest('legacy-runtime-named-catalog:v1', 'empty'),
    } satisfies LegacyRuntimeLedgerEvidenceV1);
  const baseId = digest(
    'runtime-ledger-base-id:v1',
    `${input.sourceSchemaVersion}:${input.stateRevision}:${stateDigest}:${JSON.stringify(evidence)}`,
  );
  const prefix = digest('runtime-event-prefix:v24', `migrated:${baseId}`);
  return {
    version: 1,
    format: 'v24_strict',
    canonicalEventRegistryId: 'runtime-event-registry:v24',
    ledgerBase: {
      version: 1,
      kind: 'migrated_v23',
      baseRevision: input.stateRevision,
      baseId,
      eventLedgerBaseDigest: digest(
        'runtime-event-ledger-base:v1',
        `${baseId}:${stateDigest}:${evidence.sourceEventCount}:${evidence.sourceEventBytes}:${evidence.sourceRawEventDigest}:${evidence.namedCatalogCount}:${evidence.namedCatalogBytes}:${evidence.namedCatalogDigest}`,
      ),
      prefixDigestAtBase: prefix,
      nextRevision: input.stateRevision + 1,
      legacyEvidenceDigest: digest('legacy-runtime-ledger-evidence:v1', JSON.stringify(evidence)),
    },
    tailEventCount: 0,
    tailCanonicalBytes: 0,
    tailPrefixDigest: prefix,
  };
}

export function createBranchReboundRuntimeStorageFormatV24(input: {
  kind: 'verified_named_v24' | 'fork_rebound_v24';
  stateRevision: number;
  branchIdentity: string;
  canonicalState: string;
  branchMutationReceiptId?: string;
}): RuntimeStorageFormatV1 {
  const stateDigest = digest('canonical-branch-runtime-state:v24', input.canonicalState);
  const baseId = digest(
    'runtime-ledger-base-id:v1',
    `${input.kind}:${input.stateRevision}:${input.branchIdentity}:${stateDigest}`,
  );
  const prefix = digest('runtime-event-prefix:v24', `${input.kind}:${baseId}`);
  return {
    version: 1,
    format: 'v24_strict',
    canonicalEventRegistryId: 'runtime-event-registry:v24',
    ledgerBase: {
      version: 1,
      kind: input.kind,
      baseRevision: input.stateRevision,
      baseId,
      eventLedgerBaseDigest: digest('runtime-event-ledger-base:v1', `${baseId}:${stateDigest}`),
      prefixDigestAtBase: prefix,
      nextRevision: input.stateRevision + 1,
      ...(input.branchMutationReceiptId
        ? { branchMutationReceiptId: input.branchMutationReceiptId }
        : {}),
    },
    tailEventCount: 0,
    tailCanonicalBytes: 0,
    tailPrefixDigest: prefix,
  };
}

/** Bind a completed streamed legacy ledger build to a pure migration candidate. */
export function bindMigratedRuntimeLedgerEvidenceV24(input: {
  current: RuntimeStorageFormatV1;
  legacyEvidence: LegacyRuntimeLedgerEvidenceV1;
}): RuntimeStorageFormatV1 {
  if (input.current.ledgerBase.kind !== 'migrated_v23') {
    throw new Error('Legacy ledger evidence can bind only a migrated-v23 base.');
  }
  const baseId = digest(
    'runtime-ledger-base-evidence:v1',
    `${input.current.ledgerBase.baseId}:${JSON.stringify(input.legacyEvidence)}`,
  );
  const prefix = digest('runtime-event-prefix:v24', `migrated:${baseId}`);
  return {
    ...input.current,
    ledgerBase: {
      ...input.current.ledgerBase,
      baseId,
      eventLedgerBaseDigest: digest(
        'runtime-event-ledger-base:v1',
        `${baseId}:${input.legacyEvidence.sourceEventCount}:${input.legacyEvidence.sourceEventBytes}:${input.legacyEvidence.sourceRawEventDigest}:${input.legacyEvidence.namedCatalogCount}:${input.legacyEvidence.namedCatalogBytes}:${input.legacyEvidence.namedCatalogDigest}`,
      ),
      prefixDigestAtBase: prefix,
      legacyEvidenceDigest: digest(
        'legacy-runtime-ledger-evidence:v1',
        JSON.stringify(input.legacyEvidence),
      ),
    },
    tailEventCount: 0,
    tailCanonicalBytes: 0,
    tailPrefixDigest: prefix,
  };
}

export function advanceRuntimeStorageFormatV24(input: {
  current: RuntimeStorageFormatV1;
  eventId: string;
  canonicalBytes: number;
}): RuntimeStorageFormatV1 {
  if (!/^[a-f0-9]{64}$/.test(input.eventId) || input.canonicalBytes < 1) {
    throw new Error('Runtime event prefix advance requires canonical event evidence.');
  }
  return {
    ...input.current,
    tailEventCount: input.current.tailEventCount + 1,
    tailCanonicalBytes: input.current.tailCanonicalBytes + input.canonicalBytes,
    tailPrefixDigest: digest(
      'runtime-event-prefix:v24',
      `${input.current.tailPrefixDigest}:${input.eventId}:${input.canonicalBytes}`,
    ),
  };
}
