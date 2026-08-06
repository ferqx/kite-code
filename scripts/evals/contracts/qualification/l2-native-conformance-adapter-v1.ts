import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { STANDALONE_KEYRING_UNAVAILABLE_MARKER_V1 } from '../../../../src/app/release/standalone-keyring-unavailable';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import {
  type L2NativeCandidateIdentityV1,
  type L2NativeExecutionV1,
  type L2NativeVerifiedProbeBindingV1,
  l2NativeCandidateIdentityV1Schema,
  l2NativeExecutionV1Schema,
  l2NativeVerifiedProbeBindingV1Schema,
} from './l2-native-candidate-identity-v1';
import {
  type L2NativeConformanceCaseRecordV1,
  l2NativeConformanceCaseV1Schema,
} from './l2-native-conformance-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const digestSchema = z.string().regex(DIGEST);

/**
 * The marker itself stays in the candidate payload; retained L2 metadata uses
 * only this digest and a second digest bound to a specific payload SHA-256.
 */
export const L2_NATIVE_STANDALONE_KEYRING_MARKER_DIGEST_V1 = sha256DomainSeparated(
  'kite.qualification.l2.standalone-keyring-marker.v1',
  new TextEncoder().encode(STANDALONE_KEYRING_UNAVAILABLE_MARKER_V1),
);

function computeL2NativeCandidateKeyringMarkerDigestV1(
  candidatePayloadSha256: string,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.candidate-keyring-marker-binding.v1',
    canonicalJsonBytes({
      candidatePayloadSha256,
      markerDigest: L2_NATIVE_STANDALONE_KEYRING_MARKER_DIGEST_V1,
    }),
  );
}

/**
 * Future-only archive verifier input. It is intentionally local rather than
 * importing the release candidate implementation: the protected caller must
 * pass the runtime result it obtained from its candidate verifier, while L2
 * retains neither archive paths nor archive bytes.
 */
const verifiedOssCandidateForL2MarkerV1Schema = z
  .object({
    archivePath: z.string().min(1),
    archiveSha256: digestSchema,
    manifest: z
      .object({
        commitSha: z.string().regex(/^[a-f0-9]{40}$/),
        target: z
          .object({
            id: z.string().regex(/^(macos|linux|windows)-(arm64|x64)$/),
            os: z.enum(['darwin', 'linux', 'win32']),
            arch: z.enum(['arm64', 'x64']),
          })
          .passthrough(),
      })
      .passthrough(),
    manifestBytes: z.instanceof(Uint8Array),
    manifestSha256: digestSchema,
    candidateId: z.string().min(1),
    files: z.unknown(),
  })
  .strict();

function verifiedCandidateBinaryFilesForL2V1(value: unknown): ReadonlyMap<unknown, unknown> {
  if (!(value instanceof Map)) {
    throw new Error('l2_native_keyring_verified_candidate_files_invalid');
  }
  return value;
}

function containsExactByteSequenceV1(bytes: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || bytes.byteLength < needle.byteLength) return false;
  outer: for (let start = 0; start <= bytes.byteLength - needle.byteLength; start += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (bytes[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Verify the unavailable-keyring marker in the actual executable bytes of a
 * previously verified candidate archive. This does not authenticate an
 * arbitrary object claiming to be verified: its only permitted caller is a
 * future protected orchestration path that holds the same in-memory return
 * from the candidate verifier. The current L2 runner never calls this
 * future-only adapter; it remains preflight-only until a protected atomic
 * control plane exists. Only the payload-bound marker digest leaves this
 * function; archive paths, manifests, and binary bytes are not retained.
 */
export function verifyL2NativeCandidateStandaloneKeyringMarkerV1(input: {
  candidate: L2NativeCandidateIdentityV1;
  verifiedCandidate: unknown;
}): `sha256:${string}` {
  const candidate = l2NativeCandidateIdentityV1Schema.parse(input.candidate);
  const verified = verifiedOssCandidateForL2MarkerV1Schema.parse(input.verifiedCandidate);
  const files = verifiedCandidateBinaryFilesForL2V1(verified.files);
  if (
    verified.archiveSha256 !== candidate.artifact.payloadSha256 ||
    verified.manifestSha256 !== candidate.artifact.canonicalManifestDigest ||
    verified.manifest.commitSha !== candidate.artifact.commit ||
    verified.manifest.target.id !== candidate.target.candidateTargetId ||
    verified.manifest.target.os !== candidate.target.platform ||
    verified.manifest.target.arch !== candidate.target.arch
  ) {
    throw new Error('l2_native_keyring_verified_candidate_identity_mismatch');
  }
  const suffix = candidate.target.platform === 'win32' ? '.exe' : '';
  const marker = new TextEncoder().encode(STANDALONE_KEYRING_UNAVAILABLE_MARKER_V1);
  for (const path of [`bin/kite${suffix}`, `bin/kite-tui${suffix}`]) {
    const executable = files.get(path);
    if (!(executable instanceof Uint8Array) || !containsExactByteSequenceV1(executable, marker)) {
      throw new Error('l2_native_keyring_candidate_marker_missing');
    }
  }
  return computeL2NativeCandidateKeyringMarkerDigestV1(candidate.artifact.payloadSha256);
}

const STANDALONE_KEYRING_SOURCE_FILES_V1 = [
  {
    sourceRole: 'candidate_keyring_stub_resolver',
    path: 'scripts/release/oss-candidate.ts',
    symbol: 'createStandaloneReleaseStubsV1',
    requiredTokens: [
      'createStandaloneReleaseStubsV1',
      'standalone-keyring-unavailable.ts',
      'kite-keyring-stub',
      'readFileSync',
    ],
  },
  {
    sourceRole: 'public_known_limitations_disclosure',
    path: 'release/oss-first-release/KNOWN_LIMITATIONS.md',
    symbol: 'standalone-keyring-fail-closed-disclosure',
    requiredTokens: ['@napi-rs/keyring', 'fail closed', '文件'],
  },
  {
    sourceRole: 'public_release_notes_disclosure',
    path: 'release/oss-first-release/RELEASE_NOTES.md',
    symbol: 'standalone-keyring-unavailable-disclosure',
    requiredTokens: ['standalone candidate', 'unavailable', 'keyring'],
  },
  {
    sourceRole: 'standalone_keyring_unavailable_module',
    path: 'src/app/release/standalone-keyring-unavailable.ts',
    symbol: 'standalone-keyring-unavailable-module',
    requiredTokens: [
      'STANDALONE_KEYRING_UNAVAILABLE_MESSAGE_V1',
      'class AsyncEntry',
      'class Entry',
      'findCredentials(',
      'findCredentialsAsync(',
      'unavailable();',
    ],
  },
] as const;

const standaloneKeyringSourceFileV1Schema = z
  .object({
    sourceRole: z.string().regex(/^[a-z][a-z0-9_]{1,95}$/),
    path: z.string().regex(/^(?:src|release|scripts)\/[A-Za-z0-9][A-Za-z0-9._/-]{1,239}$/),
    symbol: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{1,127}$/),
    contentDigest: digestSchema,
  })
  .strict();

const standaloneKeyringProvenanceMaterialV1Schema = z
  .object({
    schema: z.literal('L2NativeStandaloneKeyringDisabledProvenanceV1'),
    version: z.literal(1),
    sourceFiles: z.array(standaloneKeyringSourceFileV1Schema),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.sourceFiles.length !== STANDALONE_KEYRING_SOURCE_FILES_V1.length ||
      !value.sourceFiles.every((entry, index) => {
        const expected = STANDALONE_KEYRING_SOURCE_FILES_V1[index];
        return (
          expected !== undefined &&
          entry.sourceRole === expected.sourceRole &&
          entry.path === expected.path &&
          entry.symbol === expected.symbol
        );
      })
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sourceFiles'],
        message:
          'standalone keyring provenance must bind the exact source module, resolver, and public disclosures',
      });
    }
  });
function computeL2NativeStandaloneKeyringDisabledProvenanceDigestV1(
  material: z.infer<typeof standaloneKeyringProvenanceMaterialV1Schema>,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.standalone-keyring-disabled-provenance.v1',
    canonicalJsonBytes(standaloneKeyringProvenanceMaterialV1Schema.parse(material)),
  );
}

/**
 * Retained worker/receipt metadata may carry only this digest. The exact
 * source roles, paths, symbols, and source-file digests are reconstructed
 * locally by the specialized verifier and are never serialized into
 * protected-CI-retained output.
 */
export const l2NativeStandaloneKeyringDisabledProvenanceV1Schema = z
  .object({ provenanceDigest: digestSchema })
  .strict();
export type L2NativeStandaloneKeyringDisabledProvenanceV1 = z.infer<
  typeof l2NativeStandaloneKeyringDisabledProvenanceV1Schema
>;

function sourceFileContents(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8');
}

/**
 * Rebuild the only permitted unavailable-keyring disclosure proof. Source and
 * public documents are read solely to compute a local canonical digest. Their
 * names, text, and component hashes are not returned, persisted, or included
 * in an L2 observation.
 */
export function reconstructL2NativeStandaloneKeyringDisabledProvenanceV1(): L2NativeStandaloneKeyringDisabledProvenanceV1 {
  const sourceFiles = STANDALONE_KEYRING_SOURCE_FILES_V1.map((spec) => {
    const contents = sourceFileContents(spec.path);
    if (!spec.requiredTokens.every((token) => contents.includes(token))) {
      throw new Error(`l2_native_keyring_source_contract_missing:${spec.sourceRole}`);
    }
    return standaloneKeyringSourceFileV1Schema.parse({
      sourceRole: spec.sourceRole,
      path: spec.path,
      symbol: spec.symbol,
      contentDigest: sha256DomainSeparated(
        'kite.qualification.l2.standalone-keyring-source-file.v1',
        new TextEncoder().encode(contents),
      ),
    });
  });
  const material = standaloneKeyringProvenanceMaterialV1Schema.parse({
    schema: 'L2NativeStandaloneKeyringDisabledProvenanceV1',
    version: 1,
    sourceFiles,
  });
  return l2NativeStandaloneKeyringDisabledProvenanceV1Schema.parse({
    provenanceDigest: computeL2NativeStandaloneKeyringDisabledProvenanceDigestV1(material),
  });
}

export const L2_NATIVE_ADAPTER_OUTCOMES_V1 = ['passed', 'failed', 'not_observed'] as const;
export type L2NativeAdapterOutcomeV1 = (typeof L2_NATIVE_ADAPTER_OUTCOMES_V1)[number];

/**
 * A deliberately unavailable standalone keyring may only be described by the
 * complete all-entrypoint-rejection-plus-public-disclosure proof. It is never
 * a substitute for a positive native capability observation.
 */
export const L2_NATIVE_DISABLED_PROOF_STATES_V1 = [
  'all_entrypoints_rejected_and_disclosed',
  'entrypoint_rejection_incomplete',
  'not_applicable',
  'public_disclosure_inconsistent',
] as const;
export type L2NativeDisabledProofStateV1 = (typeof L2_NATIVE_DISABLED_PROOF_STATES_V1)[number];

/**
 * Worker records retain only a closed outcome token and this stable reason
 * token. Neither field can carry command output, a probe body, or an
 * environment-specific explanation.
 */
export const L2_NATIVE_ADAPTER_REASON_CODES_V1 = [
  'all_entrypoints_rejected_and_disclosed',
  'entrypoint_rejection_incomplete',
  'native_assertion_failed',
  'native_observation_passed',
  'not_observed',
  'public_disclosure_inconsistent',
] as const;
export type L2NativeAdapterReasonCodeV1 = (typeof L2_NATIVE_ADAPTER_REASON_CODES_V1)[number];
const adapterReasonCodeSchema = z.enum(L2_NATIVE_ADAPTER_REASON_CODES_V1);

function expectedAdapterReasonCodeV1(input: {
  case: L2NativeConformanceCaseRecordV1;
  observedOutcome: L2NativeAdapterOutcomeV1;
  disabledProof: L2NativeDisabledProofStateV1;
}): L2NativeAdapterReasonCodeV1 {
  if (input.observedOutcome === 'not_observed') return 'not_observed';
  if (input.case.capabilityId !== 'standalone_keyring_unavailable') {
    return input.observedOutcome === 'passed'
      ? 'native_observation_passed'
      : 'native_assertion_failed';
  }
  if (input.observedOutcome === 'passed') return 'all_entrypoints_rejected_and_disclosed';
  switch (input.disabledProof) {
    case 'entrypoint_rejection_incomplete':
      return 'entrypoint_rejection_incomplete';
    case 'public_disclosure_inconsistent':
      return 'public_disclosure_inconsistent';
    default:
      return 'native_assertion_failed';
  }
}

const adapterObservationMaterialV1Schema = z
  .object({
    schema: z.literal('L2NativeConformanceAdapterObservationV1'),
    version: z.literal(1),
    case: l2NativeConformanceCaseV1Schema,
    candidate: l2NativeCandidateIdentityV1Schema,
    execution: l2NativeExecutionV1Schema,
    probe: l2NativeVerifiedProbeBindingV1Schema,
    observedOutcome: z.enum(L2_NATIVE_ADAPTER_OUTCOMES_V1),
    disabledProof: z.enum(L2_NATIVE_DISABLED_PROOF_STATES_V1),
    reasonCode: adapterReasonCodeSchema,
    candidateKeyringMarkerDigest: digestSchema.optional(),
    standaloneKeyringProvenance: l2NativeStandaloneKeyringDisabledProvenanceV1Schema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const target = value.case.target;
    if (
      value.candidate.target.distributionTargetId !== target.distributionTargetId ||
      value.execution.target.distributionTargetId !== target.distributionTargetId ||
      value.probe.target.distributionTargetId !== target.distributionTargetId
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'L2 adapter observation cannot borrow candidate, execution, or probe from another platform',
      });
    }
    const executionIdentity = value.execution.identity;
    if (
      executionIdentity.source !== 'github_actions' ||
      executionIdentity.commit !== value.candidate.artifact.commit ||
      executionIdentity.canonicalRepository !== value.candidate.artifact.canonicalRepository ||
      executionIdentity.repositoryId !== value.candidate.artifact.repositoryId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['execution'],
        message: 'L2 adapter execution must bind the exact candidate repository and commit',
      });
    }
    if (value.probe.executionDigest !== value.execution.executionDigest) {
      context.addIssue({
        code: 'custom',
        path: ['probe', 'executionDigest'],
        message: 'L2 adapter probe must bind the exact candidate execution',
      });
    }
    const expectedReasonCode = expectedAdapterReasonCodeV1(value);
    if (value.reasonCode !== expectedReasonCode) {
      context.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: `L2 adapter reason code must derive from the sealed outcome: expected ${expectedReasonCode}`,
      });
    }
    const isStandaloneKeyring = value.case.capabilityId === 'standalone_keyring_unavailable';
    if (!isStandaloneKeyring && value.disabledProof !== 'not_applicable') {
      context.addIssue({
        code: 'custom',
        path: ['disabledProof'],
        message: 'only the standalone keyring capability may carry disabled-proof metadata',
      });
    }
    if (!isStandaloneKeyring && value.standaloneKeyringProvenance !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['standaloneKeyringProvenance'],
        message:
          'only the standalone keyring capability may carry keyring source/disclosure provenance',
      });
    }
    if (!isStandaloneKeyring && value.candidateKeyringMarkerDigest !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['candidateKeyringMarkerDigest'],
        message:
          'only the standalone keyring capability may carry a candidate keyring marker digest',
      });
    }
    if (isStandaloneKeyring && value.standaloneKeyringProvenance === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['standaloneKeyringProvenance'],
        message:
          'standalone keyring observation requires source-owned unavailable/disclosure provenance',
      });
    }
    const expectedCandidateKeyringMarkerDigest = computeL2NativeCandidateKeyringMarkerDigestV1(
      value.candidate.artifact.payloadSha256,
    );
    if (
      isStandaloneKeyring &&
      value.candidateKeyringMarkerDigest !== expectedCandidateKeyringMarkerDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['candidateKeyringMarkerDigest'],
        message:
          'standalone keyring observation must bind the fixed marker to the exact candidate payload digest',
      });
    }
    if (isStandaloneKeyring && value.standaloneKeyringProvenance !== undefined) {
      const current = reconstructL2NativeStandaloneKeyringDisabledProvenanceV1();
      if (value.standaloneKeyringProvenance.provenanceDigest !== current.provenanceDigest) {
        context.addIssue({
          code: 'custom',
          path: ['standaloneKeyringProvenance'],
          message:
            'standalone keyring provenance drifted from the source module, resolver, or public disclosures',
        });
      }
    }
    if (
      isStandaloneKeyring &&
      value.observedOutcome === 'passed' &&
      value.disabledProof !== 'all_entrypoints_rejected_and_disclosed'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['disabledProof'],
        message:
          'a passed standalone keyring observation requires complete rejection and disclosure proof',
      });
    }
    if (
      isStandaloneKeyring &&
      value.observedOutcome !== 'passed' &&
      value.disabledProof === 'all_entrypoints_rejected_and_disclosed'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['disabledProof'],
        message: 'complete disabled proof cannot accompany an unobserved or failed keyring result',
      });
    }
  });

export type L2NativeConformanceAdapterObservationMaterialV1 = z.infer<
  typeof adapterObservationMaterialV1Schema
>;

export function computeL2NativeConformanceAdapterObservationDigestV1(
  material: L2NativeConformanceAdapterObservationMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-conformance.adapter-observation.v1',
    canonicalJsonBytes(adapterObservationMaterialV1Schema.parse(material)),
  );
}

/**
 * A completed adapter observation is metadata only: its digest binds the
 * candidate, protected execution, independently verified probe and a closed
 * outcome token. It cannot contain test output, keyring values, archive paths,
 * source content, or platform build strings.
 */
export const l2NativeConformanceAdapterObservationV1Schema = adapterObservationMaterialV1Schema
  .extend({ observationDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { observationDigest, ...material } = value;
    const expected = computeL2NativeConformanceAdapterObservationDigestV1(material);
    if (observationDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['observationDigest'],
        message: `L2 adapter observation digest mismatch: expected ${expected}`,
      });
    }
  });
export type L2NativeConformanceAdapterObservationV1 = z.infer<
  typeof l2NativeConformanceAdapterObservationV1Schema
>;

export function buildL2NativeConformanceAdapterObservationV1(input: {
  case: L2NativeConformanceCaseRecordV1;
  candidate: L2NativeCandidateIdentityV1;
  execution: L2NativeExecutionV1;
  probe: L2NativeVerifiedProbeBindingV1;
  observedOutcome: L2NativeAdapterOutcomeV1;
  disabledProof: L2NativeDisabledProofStateV1;
  candidateKeyringMarkerDigest?: string;
  standaloneKeyringProvenance?: L2NativeStandaloneKeyringDisabledProvenanceV1;
}): L2NativeConformanceAdapterObservationV1 {
  const material = adapterObservationMaterialV1Schema.parse({
    schema: 'L2NativeConformanceAdapterObservationV1',
    version: 1,
    ...input,
    reasonCode: expectedAdapterReasonCodeV1(input),
  });
  return l2NativeConformanceAdapterObservationV1Schema.parse({
    ...material,
    observationDigest: computeL2NativeConformanceAdapterObservationDigestV1(material),
  });
}
