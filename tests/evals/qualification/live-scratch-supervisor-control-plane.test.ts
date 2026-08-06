import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1 } from '../../../release/qualification/l3-protected-scratch-supervisor-v1';
import { EVIDENCE_GOVERNANCE_PROFILE_V1 } from '../../../scripts/evals/contracts/qualification/evidence/governance-v1';
import {
  buildL3ProtectedScratchSupervisorManifestV1,
  buildLiveScratchAllocationCommitmentV1,
  buildLiveScratchLifecycleReceiptV1,
  buildLiveScratchSupervisorAttestationV1,
  buildLiveScratchSupervisorNonceConsumptionIndexV1,
  buildLiveScratchSupervisorNonceConsumptionV1,
  computeL3ProtectedScratchSupervisorPublicKeyDigestV1,
  computeLiveScratchLifecycleBindingDigestV1,
  computeLiveScratchSupervisorNonceDigestV1,
  isSafeLiveScratchSupervisorMetadataV1,
  LIVE_SCRATCH_SUPERVISOR_CRASH_RECOVERY_SECONDS_V1,
  LIVE_SCRATCH_SUPERVISOR_NORMAL_EXIT_DELETE_MILLISECONDS_V1,
  liveScratchAllocationCommitmentSigningBytesV1,
  liveScratchAllocationCommitmentV1Schema,
  liveScratchLifecycleBindingV1Schema,
  liveScratchLifecycleReceiptSigningBytesV1,
  liveScratchLifecycleReceiptV1Schema,
  liveScratchSupervisorAttestationSigningBytesV1,
  liveScratchSupervisorNonceConsumptionIndexSigningBytesV1,
  liveScratchSupervisorNonceConsumptionSigningBytesV1,
  liveScratchSupervisorNonceConsumptionV1Schema,
  verifyLiveScratchLifecycleReceiptV1,
  verifyLiveScratchSupervisorAttestationV1,
  verifyLiveScratchSupervisorNonceConsumptionV1,
} from '../../../scripts/evals/contracts/qualification/live-scratch-supervisor-control-plane-v1';

const CONTROL_PLANE_SOURCE_URL = new URL(
  '../../../scripts/evals/contracts/qualification/live-scratch-supervisor-control-plane-v1.ts',
  import.meta.url,
);
const EPHEMERAL_LOCAL_PROFILE_DIGEST =
  'sha256:84b74b5b3c54fac9d53a1f2c42524bee5cff27fce046e0f4b5737576e9a757b4' as const;
const EPHEMERAL_LOCAL_PROFILE_ID = 'qualification-governance/ephemeral_local/v1' as const;
const NONCE = '0123456789abcdef0123456789abcdef';
const ISSUED_AT = '2026-08-06T00:00:00.000Z';
const CONSUMED_AT = '2026-08-06T00:00:00.100Z';
const INDEXED_AT = '2026-08-06T00:00:00.200Z';
const COMMITTED_AT = '2026-08-06T00:00:01.000Z';
const ALLOCATED_AT = '2026-08-06T00:00:02.000Z';
const DEADLINE_AT = '2026-08-07T00:00:02.000Z';
const RESERVATION_ID = 'l3-00000000-0000-4000-8000-000000000008';
const ALLOCATION_ID = 'l3-allocation-00000000-0000-4000-8000-000000000009';
const NONCE_CONSUMPTION_ID = 'l3-nonce-consumption-00000000-0000-4000-8000-000000000010';
const REPLAY_ALLOCATION_ID = 'l3-allocation-00000000-0000-4000-8000-000000000011';
const REPLAY_NONCE_CONSUMPTION_ID = 'l3-nonce-consumption-00000000-0000-4000-8000-000000000012';

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const signBytes = (bytes: Uint8Array): string =>
    sign(null, Buffer.from(bytes), privateKey).toString('base64');
  const binding = {
    candidateClosureDigest: digest('a'),
    executionDigest: digest('b'),
    matrixDigest: digest('c'),
    suiteDigest: digest('d'),
    oracleDigest: digest('e'),
    corpusDigest: digest('f'),
    evaluatorDigest: digest('0'),
    verifierDigest: digest('1'),
    runnerDigest: digest('2'),
    governance: {
      profileId: EPHEMERAL_LOCAL_PROFILE_ID,
      profileDigest: EPHEMERAL_LOCAL_PROFILE_DIGEST,
      retentionClass: 'ephemeral_local',
      retention: { maxAgeSeconds: 86_400, deleteTrigger: 'process_exit' },
      storage: {
        acl: 'local_owner_only',
        encryption: 'local_owner_disk_encryption',
        audit: 'local_metadata_audit',
      },
      issuePublication: 'default_deny',
      requiredAuthorizer: 'local_owner',
      quotaLedgerDigests: { day: digest('2'), month: digest('3') },
      retentionWitnessDigest: digest('4'),
      ownerOnlyReceiptProjectionPolicyDigest: digest('5'),
    },
    routePolicyDigest: digest('3'),
    workerBundleDigest: digest('4'),
    serviceEpochDigest: digest('5'),
    reservationId: RESERVATION_ID,
    leaseFingerprint: digest('6'),
    journalPredecessorDigest: digest('7'),
    scratchHandleDigest: digest('8'),
  } as const;
  const manifest = buildL3ProtectedScratchSupervisorManifestV1({
    schema: 'L3ProtectedScratchSupervisorManifestV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    deploymentDigest: L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1.deploymentDigest,
    serviceId: 'qualification-l3-protected-scratch-supervisor-v1',
    protocolDigest: digest('9'),
    daemonBundleDigest: digest('a'),
    workerBundleDigest: binding.workerBundleDigest,
    nativeCleanupHelperDigest: digest('b'),
    fixtureRegistryDigest: digest('c'),
    policyRegistryDigest: digest('d'),
    runnerBindingDigest: binding.runnerDigest,
    journalSchemaDigest: digest('e'),
    attestationPublicKeyDigest: computeL3ProtectedScratchSupervisorPublicKeyDigestV1(publicKeyPem),
    crashRecoverySeconds: LIVE_SCRATCH_SUPERVISOR_CRASH_RECOVERY_SECONDS_V1,
    normalExitDeleteMilliseconds: LIVE_SCRATCH_SUPERVISOR_NORMAL_EXIT_DELETE_MILLISECONDS_V1,
    maintainerPeerAuthorization: 'root_manifest_allowlist_only',
  });
  const attestationUnsigned = {
    schema: 'LiveScratchSupervisorAttestationV1' as const,
    version: 1 as const,
    authority: 'diagnostic' as const,
    evidenceEligible: false as const,
    manifestDigest: manifest.manifestDigest,
    serviceEpochDigest: binding.serviceEpochDigest,
    nonceDigest: computeLiveScratchSupervisorNonceDigestV1(NONCE),
    requestBindingDigest: computeLiveScratchLifecycleBindingDigestV1(binding),
    issuedAt: ISSUED_AT,
    expiresAt: '2026-08-06T00:01:00.000Z',
    signatureAlgorithm: 'ed25519' as const,
  };
  const attestation = buildLiveScratchSupervisorAttestationV1({
    ...attestationUnsigned,
    serviceSignature: signBytes(
      liveScratchSupervisorAttestationSigningBytesV1(attestationUnsigned),
    ),
  });
  const nonceConsumptionUnsigned = {
    schema: 'LiveScratchSupervisorNonceConsumptionV1' as const,
    version: 1 as const,
    authority: 'diagnostic' as const,
    evidenceEligible: false as const,
    consumptionId: NONCE_CONSUMPTION_ID,
    allocationId: ALLOCATION_ID,
    manifestDigest: manifest.manifestDigest,
    attestationDigest: attestation.attestationDigest,
    serviceEpochDigest: binding.serviceEpochDigest,
    nonceDigest: attestation.nonceDigest,
    requestBindingDigest: attestation.requestBindingDigest,
    reservationId: binding.reservationId,
    leaseFingerprint: binding.leaseFingerprint,
    journalPredecessorDigest: binding.journalPredecessorDigest,
    journalSequence: 10,
    consumedAt: CONSUMED_AT,
    consumptionState: 'root_private_atomic_single_use_fsynced' as const,
    signatureAlgorithm: 'ed25519' as const,
  };
  const nonceConsumption = buildLiveScratchSupervisorNonceConsumptionV1({
    ...nonceConsumptionUnsigned,
    serviceSignature: signBytes(
      liveScratchSupervisorNonceConsumptionSigningBytesV1(nonceConsumptionUnsigned),
    ),
  });
  const nonceConsumptionIndexUnsigned = {
    schema: 'LiveScratchSupervisorNonceConsumptionIndexV1' as const,
    version: 1 as const,
    authority: 'diagnostic' as const,
    evidenceEligible: false as const,
    manifestDigest: manifest.manifestDigest,
    serviceEpochDigest: binding.serviceEpochDigest,
    nonceDigest: nonceConsumption.nonceDigest,
    requestBindingDigest: nonceConsumption.requestBindingDigest,
    reservationId: binding.reservationId,
    leaseFingerprint: binding.leaseFingerprint,
    indexedAt: INDEXED_AT,
    indexCoverage: 'complete_nonce_scope_at_indexed_at' as const,
    indexState: 'root_private_atomic_single_use_index' as const,
    observedNonceConsumptionCount: 1,
    observedUniqueAllocationCount: 1,
    indexedConsumptionDigests: [nonceConsumption.nonceConsumptionDigest],
    indexedAllocationIds: [nonceConsumption.allocationId],
    journalHeadDigest: nonceConsumption.nonceConsumptionDigest,
    journalHeadSequence: nonceConsumption.journalSequence,
    signatureAlgorithm: 'ed25519' as const,
  };
  const rootPrivateNonceConsumptionIndex = buildLiveScratchSupervisorNonceConsumptionIndexV1({
    ...nonceConsumptionIndexUnsigned,
    serviceSignature: signBytes(
      liveScratchSupervisorNonceConsumptionIndexSigningBytesV1(nonceConsumptionIndexUnsigned),
    ),
  });
  const commitmentUnsigned = {
    schema: 'LiveScratchAllocationCommitmentV1' as const,
    version: 1 as const,
    authority: 'diagnostic' as const,
    evidenceEligible: false as const,
    allocationId: ALLOCATION_ID,
    manifestDigest: manifest.manifestDigest,
    attestationDigest: attestation.attestationDigest,
    nonceConsumptionDigest: nonceConsumption.nonceConsumptionDigest,
    nonceConsumptionIndexDigest: rootPrivateNonceConsumptionIndex.nonceConsumptionIndexDigest,
    nonceConsumptionJournalSequence: nonceConsumption.journalSequence,
    commitmentJournalPredecessorDigest: nonceConsumption.nonceConsumptionDigest,
    commitmentJournalSequence: nonceConsumption.journalSequence + 1,
    serviceEpochDigest: binding.serviceEpochDigest,
    binding,
    committedAt: COMMITTED_AT,
    allocatedAt: ALLOCATED_AT,
    deletionDeadlineAt: DEADLINE_AT,
    allocationState: 'allocation_commitment_fsynced' as const,
    recoveryIndex: 'root_private_metadata_only' as const,
    signatureAlgorithm: 'ed25519' as const,
  };
  const commitment = buildLiveScratchAllocationCommitmentV1({
    ...commitmentUnsigned,
    serviceSignature: signBytes(liveScratchAllocationCommitmentSigningBytesV1(commitmentUnsigned)),
  });
  const receiptUnsigned = {
    schema: 'LiveScratchLifecycleReceiptV1' as const,
    version: 1 as const,
    authority: 'diagnostic' as const,
    evidenceEligible: false as const,
    allocationId: commitment.allocationId,
    commitmentDigest: commitment.commitmentDigest,
    manifestDigest: commitment.manifestDigest,
    attestationDigest: commitment.attestationDigest,
    nonceConsumptionDigest: commitment.nonceConsumptionDigest,
    nonceConsumptionIndexDigest: commitment.nonceConsumptionIndexDigest,
    nonceConsumptionJournalSequence: commitment.nonceConsumptionJournalSequence,
    commitmentJournalPredecessorDigest: commitment.commitmentJournalPredecessorDigest,
    commitmentJournalSequence: commitment.commitmentJournalSequence,
    serviceEpochDigest: commitment.serviceEpochDigest,
    binding,
    ownerOnlyReceiptProjectionDigest: digest('6'),
    committedAt: commitment.committedAt,
    allocatedAt: commitment.allocatedAt,
    deletionDeadlineAt: commitment.deletionDeadlineAt,
    workerExitedAt: '2026-08-06T00:00:03.000Z',
    processReapedAt: '2026-08-06T00:00:03.100Z',
    scrubStartedAt: '2026-08-06T00:00:03.200Z',
    deletedAt: '2026-08-06T00:00:03.500Z',
    deletionTrigger: 'normal_exit_deleted' as const,
    containmentState: 'process_group_absent' as const,
    deletionState: 'root_deleted' as const,
    journalState: 'deletion_proof_finalized' as const,
    nativeProofKind: 'linux_root_native_helper_v1' as const,
    nativeLifecycleProofDigest: digest('9'),
    signatureAlgorithm: 'ed25519' as const,
  };
  const receipt = buildLiveScratchLifecycleReceiptV1({
    ...receiptUnsigned,
    serviceSignature: signBytes(liveScratchLifecycleReceiptSigningBytesV1(receiptUnsigned)),
  });
  return {
    binding,
    signBytes,
    publicKeyPem,
    privateKeyPem,
    manifest,
    attestation,
    nonceConsumptionUnsigned,
    nonceConsumption,
    nonceConsumptionIndexUnsigned,
    rootPrivateNonceConsumptionIndex,
    commitmentUnsigned,
    commitment,
    receiptUnsigned,
    receipt,
  };
}

describe('L3 protected scratch supervisor control-plane contract', () => {
  test('verifies a root-key-pinned, nonce-bound, pre-allocation signed chain before accepting a receipt', () => {
    const {
      binding,
      publicKeyPem,
      manifest,
      attestation,
      nonceConsumption,
      rootPrivateNonceConsumptionIndex,
      commitment,
      receipt,
    } = fixture();
    const ephemeralProfile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local;
    expect(binding.governance).toMatchObject({
      profileId: ephemeralProfile.profileId,
      profileDigest: ephemeralProfile.profileDigest,
      retentionClass: ephemeralProfile.retentionClass,
      retention: ephemeralProfile.retention,
      storage: ephemeralProfile.storage,
      issuePublication: ephemeralProfile.issuePublication,
      requiredAuthorizer: ephemeralProfile.requiredAuthorizer,
    });
    expect(attestation.nonceDigest).toBe(computeLiveScratchSupervisorNonceDigestV1(NONCE));
    expect(
      verifyLiveScratchSupervisorAttestationV1({
        attestation,
        manifest,
        trustedManifestDigest: manifest.manifestDigest,
        expectedNonce: NONCE,
        expectedRequestBindingDigest: computeLiveScratchLifecycleBindingDigestV1(binding),
        expectedServiceEpochDigest: binding.serviceEpochDigest,
        trustedPublicKeyPem: publicKeyPem,
        now: new Date('2026-08-06T00:00:30.000Z'),
      }),
    ).toBe(true);
    expect(
      verifyLiveScratchSupervisorNonceConsumptionV1({
        nonceConsumption,
        rootPrivateNonceConsumptionIndex,
        attestation,
        manifest,
        trustedManifestDigest: manifest.manifestDigest,
        trustedPublicKeyPem: publicKeyPem,
        expectedNonce: NONCE,
        expectedBinding: binding,
        expectedAllocationId: commitment.allocationId,
        now: new Date(COMMITTED_AT),
      }),
    ).toBe(true);
    expect(
      verifyLiveScratchLifecycleReceiptV1({
        receipt,
        commitment,
        nonceConsumption,
        rootPrivateNonceConsumptionIndex,
        attestation,
        manifest,
        trustedManifestDigest: manifest.manifestDigest,
        trustedPublicKeyPem: publicKeyPem,
        expectedNonce: NONCE,
      }),
    ).toBe(true);
  });

  test('fails closed on raw nonce, expired attestation, replay index, chain splice, wrong key, and unsafe metadata', () => {
    const {
      binding,
      signBytes,
      publicKeyPem,
      privateKeyPem,
      manifest,
      attestation,
      nonceConsumptionUnsigned,
      nonceConsumption,
      nonceConsumptionIndexUnsigned,
      rootPrivateNonceConsumptionIndex,
      commitment,
      receipt,
    } = fixture();
    expect(
      verifyLiveScratchSupervisorAttestationV1({
        attestation,
        manifest,
        trustedManifestDigest: manifest.manifestDigest,
        expectedNonce: NONCE,
        expectedRequestBindingDigest: computeLiveScratchLifecycleBindingDigestV1(binding),
        expectedServiceEpochDigest: binding.serviceEpochDigest,
        trustedPublicKeyPem: publicKeyPem,
        now: new Date('2026-08-06T00:01:00.000Z'),
      }),
    ).toBe(false);
    expect(
      liveScratchSupervisorNonceConsumptionV1Schema.safeParse({
        ...nonceConsumption,
        nonce: NONCE,
      }).success,
    ).toBe(false);
    for (const unsafeMetadata of [
      'fixtures/secret-corpus.txt',
      'workspace/src/index.ts',
      'api.example.invalid/v1',
      'sk-redacted-placeholder',
      'AKIAREDACTEDPLACEHOLDER',
      '6'.repeat(32),
    ]) {
      expect(isSafeLiveScratchSupervisorMetadataV1(unsafeMetadata)).toBe(false);
    }
    expect(isSafeLiveScratchSupervisorMetadataV1(RESERVATION_ID)).toBe(true);
    expect(isSafeLiveScratchSupervisorMetadataV1(ALLOCATION_ID)).toBe(true);
    expect(
      liveScratchLifecycleBindingV1Schema.safeParse({
        ...binding,
        reservationId: 'api.example.invalid/v1',
      }).success,
    ).toBe(false);
    expect(
      liveScratchLifecycleBindingV1Schema.safeParse({
        ...binding,
        governance: { ...binding.governance, profileId: 'qualification-governance/other/v1' },
      }).success,
    ).toBe(false);
    expect(
      verifyLiveScratchLifecycleReceiptV1({
        receipt,
        commitment,
        nonceConsumption,
        rootPrivateNonceConsumptionIndex,
        attestation,
        manifest,
        trustedManifestDigest: manifest.manifestDigest,
        trustedPublicKeyPem: publicKeyPem,
        expectedNonce: 'ffffffffffffffffffffffffffffffff',
      }),
    ).toBe(false);
    expect(() => computeL3ProtectedScratchSupervisorPublicKeyDigestV1(privateKeyPem)).toThrow(
      'l3_protected_scratch_supervisor_public_key_invalid',
    );
    expect(
      verifyLiveScratchSupervisorAttestationV1({
        attestation,
        manifest,
        trustedManifestDigest: manifest.manifestDigest,
        expectedNonce: NONCE,
        expectedRequestBindingDigest: computeLiveScratchLifecycleBindingDigestV1(binding),
        expectedServiceEpochDigest: binding.serviceEpochDigest,
        trustedPublicKeyPem: privateKeyPem,
        now: new Date(COMMITTED_AT),
      }),
    ).toBe(false);
    const wrongKey = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    expect(
      verifyLiveScratchLifecycleReceiptV1({
        receipt,
        commitment,
        nonceConsumption,
        rootPrivateNonceConsumptionIndex,
        attestation,
        manifest,
        trustedManifestDigest: manifest.manifestDigest,
        trustedPublicKeyPem: wrongKey,
        expectedNonce: NONCE,
      }),
    ).toBe(false);
    expect(
      verifyLiveScratchLifecycleReceiptV1({
        receipt,
        commitment,
        nonceConsumption,
        rootPrivateNonceConsumptionIndex,
        attestation,
        manifest,
        trustedManifestDigest: digest('f'),
        trustedPublicKeyPem: publicKeyPem,
        expectedNonce: NONCE,
      }),
    ).toBe(false);
    const duplicateNonceConsumptionUnsigned = {
      ...nonceConsumptionUnsigned,
      consumptionId: REPLAY_NONCE_CONSUMPTION_ID,
      allocationId: REPLAY_ALLOCATION_ID,
      journalPredecessorDigest: nonceConsumption.nonceConsumptionDigest,
      journalSequence: nonceConsumption.journalSequence + 1,
      consumedAt: '2026-08-06T00:00:00.300Z',
    };
    const duplicateNonceConsumption = buildLiveScratchSupervisorNonceConsumptionV1({
      ...duplicateNonceConsumptionUnsigned,
      serviceSignature: signBytes(
        liveScratchSupervisorNonceConsumptionSigningBytesV1(duplicateNonceConsumptionUnsigned),
      ),
    });
    const duplicateIndex = buildLiveScratchSupervisorNonceConsumptionIndexV1({
      ...nonceConsumptionIndexUnsigned,
      indexedAt: '2026-08-06T00:00:00.400Z',
      observedNonceConsumptionCount: 2,
      observedUniqueAllocationCount: 2,
      indexedConsumptionDigests: [
        nonceConsumption.nonceConsumptionDigest,
        duplicateNonceConsumption.nonceConsumptionDigest,
      ],
      indexedAllocationIds: [nonceConsumption.allocationId, duplicateNonceConsumption.allocationId],
      journalHeadDigest: duplicateNonceConsumption.nonceConsumptionDigest,
      journalHeadSequence: duplicateNonceConsumption.journalSequence,
      serviceSignature: signBytes(
        liveScratchSupervisorNonceConsumptionIndexSigningBytesV1({
          ...nonceConsumptionIndexUnsigned,
          indexedAt: '2026-08-06T00:00:00.400Z',
          observedNonceConsumptionCount: 2,
          observedUniqueAllocationCount: 2,
          indexedConsumptionDigests: [
            nonceConsumption.nonceConsumptionDigest,
            duplicateNonceConsumption.nonceConsumptionDigest,
          ],
          indexedAllocationIds: [
            nonceConsumption.allocationId,
            duplicateNonceConsumption.allocationId,
          ],
          journalHeadDigest: duplicateNonceConsumption.nonceConsumptionDigest,
          journalHeadSequence: duplicateNonceConsumption.journalSequence,
        }),
      ),
    });
    expect(
      verifyLiveScratchSupervisorNonceConsumptionV1({
        nonceConsumption,
        rootPrivateNonceConsumptionIndex: duplicateIndex,
        attestation,
        manifest,
        trustedManifestDigest: manifest.manifestDigest,
        trustedPublicKeyPem: publicKeyPem,
        expectedNonce: NONCE,
        expectedBinding: binding,
        expectedAllocationId: commitment.allocationId,
        now: new Date(COMMITTED_AT),
      }),
    ).toBe(false);
    expect(
      liveScratchAllocationCommitmentV1Schema.safeParse({
        ...commitment,
        allocationId: '/workspace/forbidden',
      }).success,
    ).toBe(false);
    expect(
      liveScratchLifecycleReceiptV1Schema.safeParse({
        ...receipt,
        attestationDigest: digest('0'),
      }).success,
    ).toBe(false);
    expect(
      liveScratchLifecycleReceiptV1Schema.safeParse({
        ...receipt,
        ownerOnlyReceiptProjectionDigest: undefined,
      }).success,
    ).toBe(false);
  });

  test('requires strict pre-allocation journaling, attestation freshness at allocation, and immediate normal-exit deletion', () => {
    const {
      signBytes,
      publicKeyPem,
      manifest,
      attestation,
      nonceConsumption,
      rootPrivateNonceConsumptionIndex,
      commitmentUnsigned,
      receiptUnsigned,
    } = fixture();
    expect(() =>
      buildLiveScratchAllocationCommitmentV1({
        ...commitmentUnsigned,
        allocatedAt: COMMITTED_AT,
        deletionDeadlineAt: '2026-08-07T00:00:01.000Z',
        serviceSignature: 'A'.repeat(86) + '==',
      }),
    ).toThrow();
    expect(() =>
      buildLiveScratchAllocationCommitmentV1({
        ...commitmentUnsigned,
        commitmentJournalSequence: commitmentUnsigned.commitmentJournalSequence + 1,
        serviceSignature: 'A'.repeat(86) + '==',
      }),
    ).toThrow();
    const expiredAllocationUnsigned = {
      ...commitmentUnsigned,
      allocatedAt: '2026-08-06T00:01:00.000Z',
      deletionDeadlineAt: '2026-08-07T00:01:00.000Z',
    };
    const expiredAllocationCommitment = buildLiveScratchAllocationCommitmentV1({
      ...expiredAllocationUnsigned,
      serviceSignature: signBytes(
        liveScratchAllocationCommitmentSigningBytesV1(expiredAllocationUnsigned),
      ),
    });
    const expiredAllocationReceiptUnsigned = {
      ...receiptUnsigned,
      commitmentDigest: expiredAllocationCommitment.commitmentDigest,
      allocatedAt: expiredAllocationCommitment.allocatedAt,
      deletionDeadlineAt: expiredAllocationCommitment.deletionDeadlineAt,
      workerExitedAt: '2026-08-06T00:01:00.100Z',
      processReapedAt: '2026-08-06T00:01:00.200Z',
      scrubStartedAt: '2026-08-06T00:01:00.300Z',
      deletedAt: '2026-08-06T00:01:00.500Z',
    };
    const expiredAllocationReceipt = buildLiveScratchLifecycleReceiptV1({
      ...expiredAllocationReceiptUnsigned,
      serviceSignature: signBytes(
        liveScratchLifecycleReceiptSigningBytesV1(expiredAllocationReceiptUnsigned),
      ),
    });
    expect(
      verifyLiveScratchLifecycleReceiptV1({
        receipt: expiredAllocationReceipt,
        commitment: expiredAllocationCommitment,
        nonceConsumption,
        rootPrivateNonceConsumptionIndex,
        attestation,
        manifest,
        trustedManifestDigest: manifest.manifestDigest,
        trustedPublicKeyPem: publicKeyPem,
        expectedNonce: NONCE,
      }),
    ).toBe(false);
    expect(() =>
      buildLiveScratchLifecycleReceiptV1({
        ...receiptUnsigned,
        deletedAt: '2026-08-06T00:00:04.101Z',
        serviceSignature: 'A'.repeat(86) + '==',
      }),
    ).toThrow();
    expect(() =>
      buildLiveScratchLifecycleReceiptV1({
        ...receiptUnsigned,
        processReapedAt: '2026-08-06T00:00:04.001Z',
        scrubStartedAt: '2026-08-06T00:00:04.100Z',
        deletedAt: '2026-08-06T00:00:04.500Z',
        serviceSignature: 'A'.repeat(86) + '==',
      }),
    ).toThrow();
    expect(() =>
      buildLiveScratchLifecycleReceiptV1({
        ...receiptUnsigned,
        scrubStartedAt: '2026-08-06T00:00:02.999Z',
        serviceSignature: 'A'.repeat(86) + '==',
      }),
    ).toThrow();
  });

  test('contains no host-control, runtime activation, release Gate, or persisted content-bearing surface', () => {
    const source = readFileSync(CONTROL_PLANE_SOURCE_URL, 'utf8');
    expect(source).not.toMatch(
      /node:(?:child_process|fs|http|https|net|tls)|\bBun\.(?:connect|serve|spawn)|\bprocess\.(?:env|kill|getuid)\b/u,
    );
    expect(source).not.toMatch(
      /ReleaseEvidenceV1|\bG[0-5]\b|gate-evaluator|release-bundle|systemctl|sudo\s|\.\/evidence\//u,
    );
    expect(source).not.toMatch(
      /\b(?:absolutePath|apiKey|endpoint|prompt|response|reasoning|workspace|childOutput)\s*:/u,
    );
  });
});
