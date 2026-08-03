import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep, win32 as windowsPath } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { decodeReleaseManifest } from './artifact-layout';
import { canonicalJsonBytes, sha256DomainSeparated } from './canonical-json';
import { verifyReleaseEvidenceBundleV1 } from './evidence-bundle';
import {
  type MaintainerSecurityReviewRecordV1,
  maintainerSecurityReviewRecordV1Schema,
  type ProductionReleaseReplayEvidenceRecordV1,
  productionReleaseReplayEvidenceRecordV1Schema,
} from './evidence-schema';
import {
  evaluateReleaseGateV1,
  verifyReleaseGateDecisionV1,
  verifyReleaseGatePolicyV1,
} from './gate-evaluator';
import {
  buildCosignKeylessBlobVerificationCommandV1,
  buildGithubArtifactAttestationVerificationCommandV1,
  buildPlatformSignatureVerificationCommandsV1,
  GITHUB_ACTIONS_OIDC_ISSUER,
  PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_V1,
  PRODUCTION_RELEASE_REPOSITORY,
  PRODUCTION_RELEASE_REPOSITORY_NODE_ID,
  PRODUCTION_RELEASE_REPOSITORY_NUMERIC_ID,
  PRODUCTION_RELEASE_WORKFLOW_PATH,
  type ProductionArtifactPlatformV1,
  type ProductionNativeSignerExpectationV1,
  type ProductionReleaseExpectedIdentityV1,
  productionReleaseCertificateIdentityV1,
  productionReleaseRunInvocationUriV1,
} from './production-supply-chain-commands';

interface TrustedProductionSupplyChainVerifierV1 {
  trustedVerifierCommit: string;
  workflowPath: string;
}

// Enabling production admission is a governed source change. Runtime input
// cannot inject a verifier commit or turn this registry on.
const TRUSTED_PRODUCTION_SUPPLY_CHAIN_VERIFIERS_V1: readonly TrustedProductionSupplyChainVerifierV1[] =
  Object.freeze([]);
export const PRODUCTION_SUPPLY_CHAIN_ADMISSION_ENABLED =
  TRUSTED_PRODUCTION_SUPPLY_CHAIN_VERIFIERS_V1.length > 0;
const RELEASE_GATE_IDS = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5'] as const;
const COMMAND_TIMEOUT_MS = 30_000;
const MAINTAINER_REVIEW_IDENTITY = 'github:@ferqx';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const uppercaseDigestSchema = z.string().regex(/^[A-F0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const refSchema = z.string().regex(/^refs\/tags\/v[0-9][0-9A-Za-z._-]*$/);
const nonEmptySchema = z.string().trim().min(1);

const expectedIdentitySchema = z
  .object({
    repository: z.literal(PRODUCTION_RELEASE_REPOSITORY),
    repositoryNumericId: z.literal(PRODUCTION_RELEASE_REPOSITORY_NUMERIC_ID),
    repositoryNodeId: z.literal(PRODUCTION_RELEASE_REPOSITORY_NODE_ID),
    workflowPath: z.literal(PRODUCTION_RELEASE_WORKFLOW_PATH),
    workflowRef: nonEmptySchema,
    workflowSha: commitSchema,
    trustedVerifierCommit: commitSchema,
    ref: refSchema,
    commit: commitSchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
  })
  .strict()
  .superRefine((identity, context) => {
    const expectedWorkflowRef = `${identity.repository}/${identity.workflowPath}@${identity.ref}`;
    if (identity.workflowRef !== expectedWorkflowRef) {
      context.addIssue({
        code: 'custom',
        path: ['workflowRef'],
        message: 'workflowRef must bind the canonical release workflow to the exact tag',
      });
    }
  });

const githubAttestationOutputSchema = z
  .array(
    z
      .object({
        verificationResult: z
          .object({
            signature: z.object({ certificate: z.record(z.string(), z.unknown()) }).passthrough(),
            statement: z
              .object({
                subject: z
                  .array(
                    z
                      .object({
                        name: nonEmptySchema,
                        digest: z
                          .object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) })
                          .passthrough(),
                      })
                      .passthrough(),
                  )
                  .min(1),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  )
  .min(1);

export interface TrustedToolReceiptV1 {
  path: string;
  sha256: `sha256:${string}`;
}

export interface ProductionSupplyChainCliInputV1 {
  expected: ProductionReleaseExpectedIdentityV1;
  platform: ProductionArtifactPlatformV1;
  paths: {
    payload: string;
    nativeLauncher: string;
    manifest: string;
    sbom: string;
    provenance: string;
    sigstoreBundle: string;
    githubAttestationBundle: string;
    gatePolicy: string;
    evidenceBundle: string;
    gateDecision: string;
    securityReviewEvidence: string;
    rollbackReport: string;
    compatibilityReport: string;
    platformSignatureBundle?: string;
  };
  tools: {
    gh: TrustedToolReceiptV1;
    cosign: TrustedToolReceiptV1;
    platformVerifier?: TrustedToolReceiptV1;
    macosPolicyVerifier?: TrustedToolReceiptV1;
  };
  nativeSigner: ProductionNativeSignerExpectationV1;
  expectedGateDecisionDigest: string;
}

const trustedToolReceiptSchema = z.object({ path: nonEmptySchema, sha256: digestSchema }).strict();
const nativeSignerExpectationSchema = z.discriminatedUnion('platform', [
  z
    .object({ platform: z.literal('linux-x64'), kind: z.literal('github_actions_keyless') })
    .strict(),
  z
    .object({
      platform: z.literal('macos-arm64'),
      kind: z.literal('apple_developer_id'),
      teamId: z.string().regex(/^[A-Z0-9]{10}$/),
      certificateSha256: uppercaseDigestSchema,
      notarizationRequired: z.literal(true),
    })
    .strict(),
  z
    .object({
      platform: z.literal('windows-x64'),
      kind: z.literal('authenticode'),
      signerCertificateSha256: uppercaseDigestSchema,
      signerSpkiSha256: uppercaseDigestSchema,
      trustedRootCertificateSha256: uppercaseDigestSchema,
      timestampCertificateSha256: uppercaseDigestSchema,
      timestampRequired: z.literal(true),
    })
    .strict(),
]);
const productionSupplyChainInputSchema = z
  .object({
    expected: expectedIdentitySchema,
    platform: z.enum(['linux-x64', 'macos-arm64', 'windows-x64']),
    paths: z
      .object({
        payload: nonEmptySchema,
        nativeLauncher: nonEmptySchema,
        manifest: nonEmptySchema,
        sbom: nonEmptySchema,
        provenance: nonEmptySchema,
        sigstoreBundle: nonEmptySchema,
        githubAttestationBundle: nonEmptySchema,
        gatePolicy: nonEmptySchema,
        evidenceBundle: nonEmptySchema,
        gateDecision: nonEmptySchema,
        securityReviewEvidence: nonEmptySchema,
        rollbackReport: nonEmptySchema,
        compatibilityReport: nonEmptySchema,
        platformSignatureBundle: nonEmptySchema.optional(),
      })
      .strict(),
    tools: z
      .object({
        gh: trustedToolReceiptSchema,
        cosign: trustedToolReceiptSchema,
        platformVerifier: trustedToolReceiptSchema.optional(),
        macosPolicyVerifier: trustedToolReceiptSchema.optional(),
      })
      .strict(),
    nativeSigner: nativeSignerExpectationSchema,
    expectedGateDecisionDigest: digestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.nativeSigner.platform !== value.platform) {
      context.addIssue({
        code: 'custom',
        path: ['nativeSigner', 'platform'],
        message: 'native signer platform must equal the artifact platform',
      });
    }
    if (value.platform === 'linux-x64' && !value.paths.platformSignatureBundle) {
      context.addIssue({
        code: 'custom',
        path: ['paths', 'platformSignatureBundle'],
        message: 'Linux keyless launcher verification requires a signature bundle',
      });
    }
    if (
      value.platform === 'macos-arm64' &&
      (!value.tools.platformVerifier || !value.tools.macosPolicyVerifier)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['tools'],
        message: 'macOS verification requires codesign and Gatekeeper tool receipts',
      });
    }
    if (value.platform === 'windows-x64' && !value.tools.platformVerifier) {
      context.addIssue({
        code: 'custom',
        path: ['tools', 'platformVerifier'],
        message: 'Windows verification requires a PowerShell tool receipt',
      });
    }
  });

export interface CommandExecutionResultV1 {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface ProductionSupplyChainVerifierDependenciesV1 {
  execute(command: readonly string[], timeoutMs: number): CommandExecutionResultV1;
  runtime: { platform: NodeJS.Platform; arch: string };
  now(): Date;
}

export class ProductionSupplyChainVerificationError extends Error {
  readonly code:
    | 'expected_identity_invalid'
    | 'input_missing_or_unsafe'
    | 'verifier_binary_missing'
    | 'verifier_binary_mismatch'
    | 'platform_identity_mismatch'
    | 'archive_layout_mismatch'
    | 'manifest_identity_mismatch'
    | 'gate_not_approved'
    | 'security_review_unverified'
    | 'cryptographic_verification_failed'
    | 'attestation_identity_mismatch'
    | 'attestation_subject_mismatch'
    | 'platform_signature_unverified';

  constructor(code: ProductionSupplyChainVerificationError['code'], detail: string) {
    super(`Production supply-chain verification failed (${code}): ${detail}`);
    this.name = 'ProductionSupplyChainVerificationError';
    this.code = code;
  }
}

export function parseProductionSupplyChainCliInputV1(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ProductionSupplyChainCliInputV1 {
  const flags = parseFlags(argv);
  const value = (flag: string, environment: string): string | undefined =>
    flags.get(flag) ?? env[environment];
  const required = (flag: string, environment: string): string => {
    const resolved = value(flag, environment)?.trim();
    if (!resolved) {
      throw new ProductionSupplyChainVerificationError(
        'expected_identity_invalid',
        `missing ${flag}/${environment}`,
      );
    }
    return resolved;
  };
  const parseDigest = (flag: string, environment: string): `sha256:${string}` => {
    const parsed = digestSchema.safeParse(required(flag, environment));
    if (!parsed.success) {
      throw new ProductionSupplyChainVerificationError(
        'expected_identity_invalid',
        `${flag}/${environment} must be a sha256 digest`,
      );
    }
    return parsed.data as `sha256:${string}`;
  };
  const parseUpperDigest = (flag: string, environment: string): string => {
    const parsed = uppercaseDigestSchema.safeParse(required(flag, environment).toUpperCase());
    if (!parsed.success) {
      throw new ProductionSupplyChainVerificationError(
        'expected_identity_invalid',
        `${flag}/${environment} must be a 64-character sha256 hex digest`,
      );
    }
    return parsed.data;
  };
  const rawIdentity = {
    repository: required('--repository', 'KITE_RELEASE_REPOSITORY'),
    repositoryNumericId: required('--repository-id', 'KITE_RELEASE_REPOSITORY_ID'),
    repositoryNodeId: required('--repository-node-id', 'KITE_RELEASE_REPOSITORY_NODE_ID'),
    workflowPath: required('--workflow-path', 'KITE_RELEASE_WORKFLOW_PATH'),
    workflowRef: required('--workflow-ref', 'KITE_RELEASE_WORKFLOW_REF'),
    workflowSha: required('--workflow-sha', 'KITE_RELEASE_WORKFLOW_SHA'),
    trustedVerifierCommit: required(
      '--trusted-verifier-commit',
      'KITE_RELEASE_TRUSTED_VERIFIER_COMMIT',
    ),
    ref: required('--ref', 'KITE_RELEASE_REF'),
    commit: required('--commit', 'KITE_RELEASE_COMMIT'),
    runId: required('--run-id', 'KITE_RELEASE_RUN_ID'),
    runAttempt: Number(required('--run-attempt', 'KITE_RELEASE_RUN_ATTEMPT')),
  };
  const parsedIdentity = expectedIdentitySchema.safeParse(rawIdentity);
  if (!parsedIdentity.success) {
    throw new ProductionSupplyChainVerificationError(
      'expected_identity_invalid',
      parsedIdentity.error.issues.map((issue) => issue.message).join('; '),
    );
  }
  const platform = required('--platform', 'KITE_RELEASE_PLATFORM');
  if (!['linux-x64', 'macos-arm64', 'windows-x64'].includes(platform)) {
    throw new ProductionSupplyChainVerificationError(
      'expected_identity_invalid',
      `unknown platform ${platform}`,
    );
  }
  const typedPlatform = platform as ProductionArtifactPlatformV1;
  let nativeSigner: ProductionNativeSignerExpectationV1;
  if (typedPlatform === 'linux-x64') {
    nativeSigner = { platform: typedPlatform, kind: 'github_actions_keyless' };
  } else if (typedPlatform === 'macos-arm64') {
    const teamId = required('--macos-team-id', 'KITE_RELEASE_MACOS_TEAM_ID').toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(teamId)) {
      throw new ProductionSupplyChainVerificationError(
        'expected_identity_invalid',
        'macOS Team ID must be ten uppercase alphanumeric characters',
      );
    }
    nativeSigner = {
      platform: typedPlatform,
      kind: 'apple_developer_id',
      teamId,
      certificateSha256: parseUpperDigest(
        '--macos-certificate-sha256',
        'KITE_RELEASE_MACOS_CERTIFICATE_SHA256',
      ),
      notarizationRequired: true,
    };
  } else {
    nativeSigner = {
      platform: typedPlatform,
      kind: 'authenticode',
      signerCertificateSha256: parseUpperDigest(
        '--windows-signer-certificate-sha256',
        'KITE_RELEASE_WINDOWS_SIGNER_CERTIFICATE_SHA256',
      ),
      signerSpkiSha256: parseUpperDigest(
        '--windows-signer-spki-sha256',
        'KITE_RELEASE_WINDOWS_SIGNER_SPKI_SHA256',
      ),
      trustedRootCertificateSha256: parseUpperDigest(
        '--windows-root-certificate-sha256',
        'KITE_RELEASE_WINDOWS_ROOT_CERTIFICATE_SHA256',
      ),
      timestampCertificateSha256: parseUpperDigest(
        '--windows-timestamp-certificate-sha256',
        'KITE_RELEASE_WINDOWS_TIMESTAMP_CERTIFICATE_SHA256',
      ),
      timestampRequired: true,
    };
  }
  const tool = (name: string, envName: string): TrustedToolReceiptV1 => ({
    path: required(`--${name}-path`, `KITE_RELEASE_${envName}_PATH`),
    sha256: parseDigest(`--${name}-sha256`, `KITE_RELEASE_${envName}_SHA256`),
  });
  return {
    expected: parsedIdentity.data,
    platform: typedPlatform,
    paths: {
      payload: required('--payload', 'KITE_RELEASE_PAYLOAD'),
      nativeLauncher: required('--native-launcher', 'KITE_RELEASE_NATIVE_LAUNCHER'),
      manifest: required('--manifest', 'KITE_RELEASE_MANIFEST'),
      sbom: required('--sbom', 'KITE_RELEASE_SBOM'),
      provenance: required('--provenance', 'KITE_RELEASE_PROVENANCE'),
      sigstoreBundle: required('--sigstore-bundle', 'KITE_RELEASE_SIGSTORE_BUNDLE'),
      githubAttestationBundle: required('--attestation-bundle', 'KITE_RELEASE_ATTESTATION_BUNDLE'),
      gatePolicy: required('--gate-policy', 'KITE_RELEASE_GATE_POLICY'),
      evidenceBundle: required('--evidence-bundle', 'KITE_RELEASE_EVIDENCE_BUNDLE'),
      gateDecision: required('--gate-decision', 'KITE_RELEASE_GATE_DECISION'),
      securityReviewEvidence: required(
        '--security-review-evidence',
        'KITE_RELEASE_SECURITY_REVIEW_EVIDENCE',
      ),
      rollbackReport: required('--rollback-report', 'KITE_RELEASE_ROLLBACK_REPORT'),
      compatibilityReport: required('--compatibility-report', 'KITE_RELEASE_COMPATIBILITY_REPORT'),
      ...(value('--platform-signature-bundle', 'KITE_RELEASE_PLATFORM_SIGNATURE_BUNDLE')
        ? {
            platformSignatureBundle: value(
              '--platform-signature-bundle',
              'KITE_RELEASE_PLATFORM_SIGNATURE_BUNDLE',
            )!.trim(),
          }
        : {}),
    },
    tools: {
      gh: tool('gh', 'GH'),
      cosign: tool('cosign', 'COSIGN'),
      ...(typedPlatform === 'macos-arm64'
        ? {
            platformVerifier: tool('platform-verifier', 'PLATFORM_VERIFIER'),
            macosPolicyVerifier: tool('macos-policy-verifier', 'MACOS_POLICY_VERIFIER'),
          }
        : typedPlatform === 'windows-x64'
          ? { platformVerifier: tool('platform-verifier', 'PLATFORM_VERIFIER') }
          : {}),
    },
    nativeSigner,
    expectedGateDecisionDigest: required(
      '--gate-decision-digest',
      'KITE_RELEASE_GATE_DECISION_DIGEST',
    ),
  };
}

export function verifyProductionSupplyChainAdmissionV1(
  input: ProductionSupplyChainCliInputV1,
  dependencies: ProductionSupplyChainVerifierDependenciesV1,
) {
  const parsedInput = productionSupplyChainInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new ProductionSupplyChainVerificationError(
      'expected_identity_invalid',
      parsedInput.error.issues.map((issue) => issue.message).join('; '),
    );
  }
  input = parsedInput.data as ProductionSupplyChainCliInputV1;
  const parsedIdentity = expectedIdentitySchema.safeParse(input.expected);
  const parsedGateDigest = digestSchema.safeParse(input.expectedGateDecisionDigest);
  if (!parsedIdentity.success || !parsedGateDigest.success) {
    throw new ProductionSupplyChainVerificationError(
      'expected_identity_invalid',
      'identity or expected Gate digest is invalid',
    );
  }
  assertNativePlatform(input.platform, dependencies.runtime);
  const snapshots = snapshotInputs(input.paths);
  try {
    const paths = snapshots.paths;
    const subjectDigests = {
      payload: snapshots.digests.payload,
      nativeLauncher: snapshots.digests.nativeLauncher,
      manifest: snapshots.digests.manifest,
      sbom: snapshots.digests.sbom,
      provenance: snapshots.digests.provenance,
      gatePolicy: snapshots.digests.gatePolicy,
      evidenceBundle: snapshots.digests.evidenceBundle,
      gateDecision: snapshots.digests.gateDecision,
      securityReview: snapshots.digests.securityReviewEvidence,
      rollbackReport: snapshots.digests.rollbackReport,
      compatibilityReport: snapshots.digests.compatibilityReport,
    };
    const launcherArchivePath = PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_V1[input.platform];
    const platformSigningSubject = verifyArchiveLayout(
      paths.payload,
      launcherArchivePath,
      paths.nativeLauncher,
      input.platform,
      join(snapshots.root, 'archive-extraction'),
    );
    verifyCanonicalManifest({
      path: paths.manifest,
      expected: parsedIdentity.data,
      platform: input.platform,
      payloadDigest: subjectDigests.payload,
    });
    const rollbackReport = verifyProductionReplayEvidence({
      path: paths.rollbackReport,
      kind: 'schema_rollback',
      expected: parsedIdentity.data,
      manifestPath: paths.manifest,
      payloadDigest: subjectDigests.payload,
      manifestDigest: subjectDigests.manifest,
    });
    const compatibilityReport = verifyProductionReplayEvidence({
      path: paths.compatibilityReport,
      kind: 'ga_compatibility',
      expected: parsedIdentity.data,
      manifestPath: paths.manifest,
      payloadDigest: subjectDigests.payload,
      manifestDigest: subjectDigests.manifest,
    });
    const securityReview = verifySecurityReviewEvidence({
      path: paths.securityReviewEvidence,
      expected: parsedIdentity.data,
      manifestPath: paths.manifest,
      platform: input.platform,
      payloadDigest: subjectDigests.payload,
      manifestDigest: subjectDigests.manifest,
      rollbackReport,
      compatibilityReport,
    });
    const gateContext = verifyGateDecision({
      path: paths.gateDecision,
      policyPath: paths.gatePolicy,
      evidenceBundlePath: paths.evidenceBundle,
      securityReviewPath: paths.securityReviewEvidence,
      expected: parsedIdentity.data,
      expectedDecisionDigest: parsedGateDigest.data,
      payloadDigest: subjectDigests.payload,
      manifestDigest: subjectDigests.manifest,
      manifestPath: paths.manifest,
    });

    const trustedTools = new Map<string, `sha256:${string}`>();
    const ghPath = requireTrustedTool('gh', input.tools.gh, trustedTools);
    const cosignPath = requireTrustedTool('cosign', input.tools.cosign, trustedTools);
    const platformVerifierPath = input.tools.platformVerifier
      ? requireTrustedTool('platform verifier', input.tools.platformVerifier, trustedTools)
      : undefined;
    const macosPolicyVerifierPath = input.tools.macosPolicyVerifier
      ? requireTrustedTool('macOS policy verifier', input.tools.macosPolicyVerifier, trustedTools)
      : undefined;

    verifyGithubMaintainerReviewActor({
      ghPath,
      expected: parsedIdentity.data,
      securityReview,
      gateContext,
      dependencies,
      trustedTools,
    });

    runRequiredCommand(
      buildCosignKeylessBlobVerificationCommandV1({
        cosignPath,
        subjectPath: paths.manifest,
        bundlePath: paths.sigstoreBundle,
        expected: parsedIdentity.data,
      }),
      dependencies,
      trustedTools,
      'cryptographic_verification_failed',
    );

    for (const [subject, subjectPath] of Object.entries({
      payload: paths.payload,
      nativeLauncher: paths.nativeLauncher,
      manifest: paths.manifest,
      sbom: paths.sbom,
      provenance: paths.provenance,
      gatePolicy: paths.gatePolicy,
      evidenceBundle: paths.evidenceBundle,
      gateDecision: paths.gateDecision,
      securityReview: paths.securityReviewEvidence,
      rollbackReport: paths.rollbackReport,
      compatibilityReport: paths.compatibilityReport,
    })) {
      const result = runRequiredCommand(
        buildGithubArtifactAttestationVerificationCommandV1({
          ghPath,
          subjectPath,
          bundlePath: paths.githubAttestationBundle,
          expected: parsedIdentity.data,
        }),
        dependencies,
        trustedTools,
        'cryptographic_verification_failed',
      );
      verifyGithubAttestationOutput({
        output: result.stdout,
        subjectPath,
        subjectDigest: subjectDigests[subject as keyof typeof subjectDigests],
        expected: parsedIdentity.data,
      });
    }

    const platformCommands = buildPlatformSignatureVerificationCommandsV1({
      platform: input.platform,
      subjectPath: platformSigningSubject,
      expected: parsedIdentity.data,
      signer: input.nativeSigner,
      cosignPath,
      platformVerifierPath,
      macosPolicyVerifierPath,
      macosCertificateOutputPrefix: join(snapshots.root, 'macos-signer-cert-'),
      platformSignatureBundlePath: paths.platformSignatureBundle,
    });
    for (const command of platformCommands) {
      const result = runRequiredCommand(
        command,
        dependencies,
        trustedTools,
        'platform_signature_unverified',
      );
      if (
        input.nativeSigner.kind === 'apple_developer_id' &&
        command[0] === macosPolicyVerifierPath
      ) {
        const assessment = `${result.stdout}\n${result.stderr}`;
        if (
          !assessment.includes('source=Notarized Developer ID') ||
          !assessment.includes(`(${input.nativeSigner.teamId})`)
        ) {
          throw new ProductionSupplyChainVerificationError(
            'platform_signature_unverified',
            'Gatekeeper output does not prove the pinned notarized Developer ID origin',
          );
        }
      }
    }
    if (input.nativeSigner.kind === 'apple_developer_id') {
      const extractedLeafCertificate = join(snapshots.root, 'macos-signer-cert-0');
      const expectedLeafDigest = `sha256:${input.nativeSigner.certificateSha256.toLowerCase()}`;
      if (requireSafeGeneratedFileDigest(extractedLeafCertificate) !== expectedLeafDigest) {
        throw new ProductionSupplyChainVerificationError(
          'platform_signature_unverified',
          'macOS signer leaf certificate digest does not match the protected expectation',
        );
      }
    }

    const trustedVerifier = TRUSTED_PRODUCTION_SUPPLY_CHAIN_VERIFIERS_V1.find(
      (candidate) =>
        candidate.trustedVerifierCommit === parsedIdentity.data.trustedVerifierCommit &&
        candidate.workflowPath === parsedIdentity.data.workflowPath,
    );
    const productionAccepted =
      PRODUCTION_SUPPLY_CHAIN_ADMISSION_ENABLED && trustedVerifier !== undefined;
    const checks = Object.freeze({
      immutableSnapshots: 'verified' as const,
      archiveLauncherBinding: 'verified' as const,
      canonicalManifestBinding: 'verified' as const,
      rollbackReplayEvidence: 'verified' as const,
      compatibilityReplayEvidence: 'verified' as const,
      maintainerSecurityReview: 'verified' as const,
      maintainerReviewActor: 'verified' as const,
      pinnedToolchain: 'verified' as const,
      cosignKeylessManifestSignature: 'verified' as const,
      githubArtifactAttestations: 'verified' as const,
      platformSignature: 'verified' as const,
      releaseGate: 'verified' as const,
    });
    const receiptMaterial = productionAccepted
      ? {
          schema: 'ProductionSupplyChainAdmissionReceiptV1' as const,
          identity: parsedIdentity.data,
          platform: input.platform,
          subjects: subjectDigests,
          checks,
        }
      : null;
    return Object.freeze({
      status: productionAccepted ? ('passed' as const) : ('blocked' as const),
      reason: productionAccepted ? null : ('production_workflow_disabled' as const),
      productionAccepted,
      productionReceipt: receiptMaterial
        ? Object.freeze({
            ...receiptMaterial,
            receiptDigest: sha256DomainSeparated(
              'kite.release.production-supply-chain-admission-receipt.v1',
              canonicalJsonBytes(receiptMaterial),
            ),
          })
        : null,
      identity: Object.freeze({ ...parsedIdentity.data }),
      subjects: Object.freeze({ ...subjectDigests }),
      nativeLayout: Object.freeze({ launcherArchivePath }),
      checks,
    });
  } finally {
    restoreOwnedDirectoryPermissions(snapshots.root);
    rmSync(snapshots.root, { recursive: true, force: false });
  }
}

function restoreOwnedDirectoryPermissions(root: string): void {
  const status = lstatSync(root);
  if (!status.isDirectory() || status.isSymbolicLink()) return;
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      restoreOwnedDirectoryPermissions(join(root, entry.name));
    }
  }
}

function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new ProductionSupplyChainVerificationError(
        'expected_identity_invalid',
        'arguments must be --flag value pairs',
      );
    }
    if (flags.has(flag)) {
      throw new ProductionSupplyChainVerificationError(
        'expected_identity_invalid',
        `duplicate flag ${flag}`,
      );
    }
    flags.set(flag, value);
  }
  return flags;
}

type SnapshotRole = keyof ProductionSupplyChainCliInputV1['paths'];
const SNAPSHOT_LIMITS: Readonly<Record<SnapshotRole, number>> = Object.freeze({
  payload: 256 * 1024 * 1024,
  nativeLauncher: 64 * 1024 * 1024,
  manifest: 1024 * 1024,
  sbom: 32 * 1024 * 1024,
  provenance: 8 * 1024 * 1024,
  sigstoreBundle: 8 * 1024 * 1024,
  githubAttestationBundle: 32 * 1024 * 1024,
  gatePolicy: 2 * 1024 * 1024,
  evidenceBundle: 16 * 1024 * 1024,
  gateDecision: 2 * 1024 * 1024,
  securityReviewEvidence: 2 * 1024 * 1024,
  rollbackReport: 2 * 1024 * 1024,
  compatibilityReport: 2 * 1024 * 1024,
  platformSignatureBundle: 8 * 1024 * 1024,
});

function snapshotInputs(paths: ProductionSupplyChainCliInputV1['paths']): {
  root: string;
  paths: Record<SnapshotRole, string>;
  digests: Record<SnapshotRole, `sha256:${string}`>;
} {
  const root = mkdtempSync(join(tmpdir(), 'kite-production-verifier-'));
  const snapshots = {} as Record<SnapshotRole, string>;
  const digests = {} as Record<SnapshotRole, `sha256:${string}`>;
  const identities = new Set<string>();
  try {
    for (const [role, originalPath] of Object.entries(paths) as [SnapshotRole, string][]) {
      const absolute = resolve(originalPath);
      const link = lstatSync(absolute);
      if (link.isSymbolicLink()) throw new Error(`${role} is a symbolic link`);
      const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.size < 1 || before.size > SNAPSHOT_LIMITS[role]) {
          throw new Error(`${role} is not a bounded nonempty regular file`);
        }
        if (before.nlink !== 1) throw new Error(`${role} has a hard-link alias`);
        const identity = `${before.dev}:${before.ino}`;
        if (identities.has(identity)) throw new Error(`${role} aliases another input role`);
        identities.add(identity);
        bytes = readFileSync(fd);
        const after = fstatSync(fd);
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          bytes.byteLength !== before.size
        ) {
          throw new Error(`${role} changed while snapshotting`);
        }
      } finally {
        closeSync(fd);
      }
      const roleDirectory = join(root, role);
      mkdirSync(roleDirectory, { mode: 0o700 });
      const snapshotPath = join(roleDirectory, basename(absolute));
      writeFileSync(snapshotPath, bytes, {
        flag: 'wx',
        mode: role === 'nativeLauncher' ? 0o500 : 0o400,
      });
      snapshots[role] = snapshotPath;
      digests[role] = bytesDigest(bytes);
    }
    return { root, paths: snapshots, digests };
  } catch (error) {
    rmSync(root, { recursive: true, force: false });
    throw new ProductionSupplyChainVerificationError(
      'input_missing_or_unsafe',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function requireTrustedTool(
  name: string,
  receipt: TrustedToolReceiptV1,
  trustedTools: Map<string, `sha256:${string}`>,
): string {
  try {
    const parsedDigest = digestSchema.parse(receipt.sha256) as `sha256:${string}`;
    if (!isAbsolute(receipt.path)) throw new Error('path is not absolute');
    const absolute = resolve(receipt.path);
    const link = lstatSync(absolute);
    if (link.isSymbolicLink()) throw new Error('path is a symbolic link');
    const resolved = realpathSync.native(absolute);
    requireOsProtectedToolPath(resolved);
    if (fileDigest(resolved) !== parsedDigest) throw new Error('digest mismatch');
    trustedTools.set(resolved, parsedDigest);
    return resolved;
  } catch (error) {
    const code =
      error instanceof Error && error.message === 'digest mismatch'
        ? 'verifier_binary_mismatch'
        : 'verifier_binary_missing';
    throw new ProductionSupplyChainVerificationError(
      code,
      `${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const PROTECTED_WINDOWS_TOOL_PATHS_V1 = new Set(
  [
    'C:\\Program Files\\GitHub CLI\\gh.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\Kite Verifiers\\cosign.exe',
  ].map((path) => windowsPath.normalize(path).toLowerCase()),
);

export function isProtectedWindowsToolPathV1(path: string): boolean {
  if (!windowsPath.isAbsolute(path)) return false;
  return PROTECTED_WINDOWS_TOOL_PATHS_V1.has(windowsPath.normalize(path).toLowerCase());
}

function requireOsProtectedToolPath(path: string): void {
  if (process.platform === 'win32') {
    if (!isProtectedWindowsToolPathV1(path)) {
      throw new Error('Windows tool is outside the exact system-volume protected allowlist');
    }
    return;
  }
  let current = path;
  while (true) {
    const status = lstatSync(current);
    if (status.isSymbolicLink()) throw new Error('protected tool path contains a symbolic link');
    if (status.uid !== 0 || (status.mode & 0o022) !== 0) {
      throw new Error('tool or ancestor is not root-owned and protected from runner writes');
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function requireSafeGeneratedFileDigest(path: string): `sha256:${string}` {
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink()) throw new Error('generated output is a symbolic link');
    const status = statSync(path);
    if (!status.isFile() || status.size < 1 || status.size > 1024 * 1024 || status.nlink !== 1) {
      throw new Error('generated output is not a bounded unique regular file');
    }
    return fileDigest(path);
  } catch (error) {
    throw new ProductionSupplyChainVerificationError(
      'platform_signature_unverified',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function assertNativePlatform(
  platform: ProductionArtifactPlatformV1,
  runtime: ProductionSupplyChainVerifierDependenciesV1['runtime'],
): void {
  const expected = {
    'linux-x64': { platform: 'linux', arch: 'x64' },
    'macos-arm64': { platform: 'darwin', arch: 'arm64' },
    'windows-x64': { platform: 'win32', arch: 'x64' },
  } as const;
  const identity = expected[platform];
  if (runtime.platform !== identity.platform || runtime.arch !== identity.arch) {
    throw new ProductionSupplyChainVerificationError(
      'platform_identity_mismatch',
      `${runtime.platform}/${runtime.arch} cannot verify ${platform} native signing`,
    );
  }
}

function fileDigest(path: string): `sha256:${string}` {
  return bytesDigest(readFileSync(path));
}

function bytesDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function verifyArchiveLayout(
  archivePath: string,
  launcherArchivePath: string,
  launcherPath: string,
  platform: ProductionArtifactPlatformV1,
  extractionRoot: string,
): string {
  try {
    const tar = gunzipSync(readFileSync(archivePath), { maxOutputLength: 512 * 1024 * 1024 });
    let offset = 0;
    let found: Buffer | undefined;
    let terminated = false;
    const entries = new Set<string>();
    const macosBundlePath = resolve(extractionRoot, 'Kite.app');
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) {
        if (
          offset + 1024 > tar.length ||
          !tar.subarray(offset, offset + 1024).every((byte) => byte === 0) ||
          !tar.subarray(offset + 1024).every((byte) => byte === 0)
        ) {
          throw new Error('tar does not have a canonical two-block terminator');
        }
        terminated = true;
        break;
      }
      const expectedChecksum = parseTarOctal(header.subarray(148, 156));
      const checksumHeader = Buffer.from(header);
      checksumHeader.fill(0x20, 148, 156);
      const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
      if (expectedChecksum !== actualChecksum) throw new Error('tar header checksum mismatch');
      if (
        !header.subarray(257, 263).equals(Buffer.from('ustar\0', 'ascii')) ||
        !header.subarray(263, 265).equals(Buffer.from('00', 'ascii'))
      ) {
        throw new Error('tar entry is not canonical USTAR');
      }
      const name = tarPathText(header.subarray(0, 100));
      const prefix = tarPathText(header.subarray(345, 500));
      const type = String.fromCharCode(header[156] ?? 0);
      if (type !== '0' && type !== '\0' && type !== '5') {
        throw new Error(`tar contains unsupported entry type ${JSON.stringify(type)}`);
      }
      const rawEntryPath = prefix ? `${prefix}/${name}` : name;
      if (type === '5' && rawEntryPath.endsWith('//')) {
        throw new Error('tar directory path contains an empty trailing segment');
      }
      const entryPath =
        type === '5' && rawEntryPath.endsWith('/') ? rawEntryPath.slice(0, -1) : rawEntryPath;
      if (
        !entryPath ||
        entryPath.startsWith('/') ||
        entryPath.includes('\\') ||
        entryPath.split('/').some((part) => part === '.' || part === '..' || part === '')
      ) {
        throw new Error('tar contains an unsafe path');
      }
      if (entries.has(entryPath)) throw new Error(`tar entry ${entryPath} is duplicated`);
      entries.add(entryPath);
      const size = parseTarOctal(header.subarray(124, 136));
      const mode = parseTarOctal(header.subarray(100, 108));
      if (type === '5' && size !== 0) throw new Error('tar directory entry has a body');
      const bodyStart = offset + 512;
      const bodyEnd = bodyStart + size;
      if (bodyEnd > tar.length) throw new Error('tar entry exceeds the archive boundary');
      const paddedBodyEnd = bodyStart + Math.ceil(size / 512) * 512;
      if (paddedBodyEnd > tar.length) throw new Error('tar padding exceeds the archive boundary');
      if (!tar.subarray(bodyEnd, paddedBodyEnd).every((byte) => byte === 0)) {
        throw new Error('tar entry has nonzero padding');
      }
      if (entryPath === launcherArchivePath) {
        if (found || (type !== '0' && type !== '\0')) {
          throw new Error('launcher entry is duplicated or not a regular file');
        }
        found = Buffer.from(tar.subarray(bodyStart, bodyEnd));
      }
      if (
        platform === 'macos-arm64' &&
        (entryPath === 'Kite.app' || entryPath.startsWith('Kite.app/'))
      ) {
        const targetPath = resolve(extractionRoot, entryPath);
        if (targetPath !== macosBundlePath && !targetPath.startsWith(`${macosBundlePath}${sep}`)) {
          throw new Error('macOS bundle entry escapes the extraction root');
        }
        if (type === '5') {
          mkdirSync(targetPath, { recursive: true, mode: 0o700 });
        } else {
          const parent = dirname(targetPath);
          mkdirSync(parent, { recursive: true, mode: 0o700 });
          writeFileSync(targetPath, tar.subarray(bodyStart, bodyEnd), {
            flag: 'wx',
            mode: (mode & 0o111) !== 0 ? 0o500 : 0o400,
          });
        }
      }
      offset = paddedBodyEnd;
    }
    if (!terminated) throw new Error('tar canonical terminator is absent');
    if (!found) throw new Error(`launcher entry ${launcherArchivePath} is absent`);
    if (bytesDigest(found) !== fileDigest(launcherPath)) {
      throw new Error('signed launcher bytes do not equal the archive member bytes');
    }
    if (platform === 'macos-arm64') {
      for (const requiredPath of [
        launcherArchivePath,
        'Kite.app/Contents/Info.plist',
        'Kite.app/Contents/_CodeSignature/CodeResources',
      ]) {
        if (!entries.has(requiredPath))
          throw new Error(`macOS bundle entry ${requiredPath} is absent`);
      }
      freezeOwnedDirectoryTree(extractionRoot);
      return macosBundlePath;
    }
    return launcherPath;
  } catch (error) {
    throw new ProductionSupplyChainVerificationError(
      'archive_layout_mismatch',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function freezeOwnedDirectoryTree(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      freezeOwnedDirectoryTree(join(root, entry.name));
    }
  }
  chmodSync(root, 0o500);
}

function tarPathText(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  if (nul >= 0 && !bytes.subarray(nul).every((byte) => byte === 0)) {
    throw new Error('tar path field is not canonically NUL-padded');
  }
  const value = Buffer.from(nul >= 0 ? bytes.subarray(0, nul) : bytes).toString('utf8');
  if (value.includes('\uFFFD')) throw new Error('tar path field is not valid UTF-8');
  return value;
}

function tarText(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  return Buffer.from(nul >= 0 ? bytes.subarray(0, nul) : bytes).toString('utf8');
}

function parseTarOctal(bytes: Uint8Array): number {
  const value = tarText(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('tar numeric field is not canonical octal');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('tar numeric field is invalid');
  return parsed;
}

function verifyCanonicalManifest(input: {
  path: string;
  expected: ProductionReleaseExpectedIdentityV1;
  platform: ProductionArtifactPlatformV1;
  payloadDigest: string;
}): void {
  try {
    const manifest = decodeReleaseManifest(readFileSync(input.path));
    const distributionIdentity = {
      'linux-x64': 'ubuntu-24.04-x64',
      'macos-arm64': 'macos-15-arm64',
      'windows-x64': 'windows-2025-x64',
    } as const;
    if (
      manifest.payloadSha256 !== input.payloadDigest ||
      manifest.commitSha !== input.expected.commit ||
      manifest.supportedPlatforms.length !== 1 ||
      manifest.supportedPlatforms[0] !== distributionIdentity[input.platform]
    ) {
      throw new Error('manifest does not bind the expected archive, commit, and platform');
    }
  } catch (error) {
    throw new ProductionSupplyChainVerificationError(
      'manifest_identity_mismatch',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function expectedArtifactIdentity(input: {
  expected: ProductionReleaseExpectedIdentityV1;
  manifestPath: string;
  payloadDigest: string;
  manifestDigest: string;
}) {
  const manifest = decodeReleaseManifest(readFileSync(input.manifestPath));
  return {
    canonicalRepository: input.expected.repository,
    repositoryId: input.expected.repositoryNodeId,
    commit: input.expected.commit,
    payloadSha256: input.payloadDigest,
    canonicalManifestDigest: input.manifestDigest,
    behaviorDigest: manifest.behaviorDigest,
    profileDigest: manifest.releaseProfileDigest,
    gatePolicyDigest: manifest.releaseGatePolicyDigest,
  };
}

function verifyProductionReplayEvidence(input: {
  path: string;
  kind: 'schema_rollback' | 'ga_compatibility';
  expected: ProductionReleaseExpectedIdentityV1;
  manifestPath: string;
  payloadDigest: string;
  manifestDigest: string;
}): ProductionReleaseReplayEvidenceRecordV1 {
  try {
    const parsed = productionReleaseReplayEvidenceRecordV1Schema.parse(
      JSON.parse(readFileSync(input.path, 'utf8')),
    );
    const candidate = expectedArtifactIdentity(input);
    if (
      parsed.kind !== input.kind ||
      parsed.trustedVerifierCommit !== input.expected.trustedVerifierCommit ||
      !Buffer.from(canonicalJsonBytes(parsed.candidate)).equals(
        Buffer.from(canonicalJsonBytes(candidate)),
      )
    ) {
      throw new Error(`${input.kind} replay evidence does not bind the expected candidate`);
    }
    return parsed;
  } catch (error) {
    throw new ProductionSupplyChainVerificationError(
      'gate_not_approved',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function verifySecurityReviewEvidence(input: {
  path: string;
  expected: ProductionReleaseExpectedIdentityV1;
  manifestPath: string;
  platform: ProductionArtifactPlatformV1;
  payloadDigest: string;
  manifestDigest: string;
  rollbackReport: ProductionReleaseReplayEvidenceRecordV1;
  compatibilityReport: ProductionReleaseReplayEvidenceRecordV1;
}): MaintainerSecurityReviewRecordV1 {
  try {
    const parsed = maintainerSecurityReviewRecordV1Schema.parse(
      JSON.parse(readFileSync(input.path, 'utf8')),
    );
    const manifest = decodeReleaseManifest(readFileSync(input.manifestPath));
    const platformIdentity = {
      'linux-x64': 'ubuntu-24.04-x64',
      'macos-arm64': 'macos-15-arm64',
      'windows-x64': 'windows-2025-x64',
    }[input.platform];
    const candidate = expectedArtifactIdentity(input);
    if (
      parsed.reviewerIdentity !== MAINTAINER_REVIEW_IDENTITY ||
      parsed.outcome !== 'passed' ||
      parsed.ref !== input.expected.ref ||
      parsed.trustedVerifierCommit !== input.expected.trustedVerifierCommit ||
      !Buffer.from(canonicalJsonBytes(parsed.candidate)).equals(
        Buffer.from(canonicalJsonBytes(candidate)),
      ) ||
      parsed.routeIdentity !== manifest.providerDataPolicyDigest ||
      parsed.platformIdentity !== platformIdentity ||
      parsed.rollbackReportDigest !== input.rollbackReport.recordDigest ||
      parsed.compatibilityReportDigest !== input.compatibilityReport.recordDigest ||
      Date.parse(parsed.reviewedAt) < Date.parse(input.rollbackReport.completedAt) ||
      Date.parse(parsed.reviewedAt) < Date.parse(input.compatibilityReport.completedAt)
    ) {
      throw new Error('maintainer security review or reviewed artifact identity is mismatched');
    }
    return parsed;
  } catch (error) {
    throw new ProductionSupplyChainVerificationError(
      'security_review_unverified',
      error instanceof Error ? error.message : String(error),
    );
  }
}

interface VerifiedReleaseGateContextV1 {
  evaluatedAt: string;
  reviewMaxAgeSeconds: number;
  executionWindows: ReadonlyArray<{ startedAt: string; endedAt: string }>;
}

function verifyGithubMaintainerReviewActor(input: {
  ghPath: string;
  expected: ProductionReleaseExpectedIdentityV1;
  securityReview: MaintainerSecurityReviewRecordV1;
  gateContext: VerifiedReleaseGateContextV1;
  dependencies: ProductionSupplyChainVerifierDependenciesV1;
  trustedTools: ReadonlyMap<string, `sha256:${string}`>;
}): void {
  const result = runRequiredCommand(
    [
      input.ghPath,
      'api',
      `repos/${input.expected.repository}/actions/runs/${input.expected.runId}`,
      '--method',
      'GET',
    ],
    input.dependencies,
    input.trustedTools,
    'security_review_unverified',
  );
  try {
    const run = z
      .object({
        id: z.number().int().positive(),
        event: z.literal('workflow_dispatch'),
        head_sha: z.literal(input.expected.commit),
        run_attempt: z.literal(input.expected.runAttempt),
        status: z.literal('completed'),
        conclusion: z.literal('success'),
        created_at: z.iso.datetime({ offset: true }),
        run_started_at: z.iso.datetime({ offset: true }),
        updated_at: z.iso.datetime({ offset: true }),
        actor: z.object({ login: z.literal('ferqx') }).passthrough(),
        triggering_actor: z.object({ login: z.literal('ferqx') }).passthrough(),
        repository: z.object({ full_name: z.literal(input.expected.repository) }).passthrough(),
      })
      .passthrough()
      .parse(JSON.parse(result.stdout));
    if (String(run.id) !== input.expected.runId) {
      throw new Error('GitHub run ID does not match the reviewed release run');
    }
    const nowMs = input.dependencies.now().getTime();
    const createdAtMs = Date.parse(run.created_at);
    const runStartedAtMs = Date.parse(run.run_started_at);
    const updatedAtMs = Date.parse(run.updated_at);
    const reviewedAtMs = Date.parse(input.securityReview.reviewedAt);
    const evaluatedAtMs = Date.parse(input.gateContext.evaluatedAt);
    if (!Number.isFinite(nowMs)) throw new Error('Verifier current time is invalid');
    if (
      createdAtMs > runStartedAtMs ||
      runStartedAtMs > reviewedAtMs ||
      reviewedAtMs > evaluatedAtMs ||
      evaluatedAtMs > updatedAtMs ||
      updatedAtMs > nowMs ||
      nowMs - reviewedAtMs > input.gateContext.reviewMaxAgeSeconds * 1000 ||
      input.gateContext.executionWindows.some(
        ({ startedAt, endedAt }) =>
          Date.parse(startedAt) < runStartedAtMs || Date.parse(endedAt) > updatedAtMs,
      )
    ) {
      throw new Error('Maintainer review is stale or outside the authenticated GitHub run window');
    }
  } catch (error) {
    throw new ProductionSupplyChainVerificationError(
      'security_review_unverified',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function verifyGateDecision(input: {
  path: string;
  policyPath: string;
  evidenceBundlePath: string;
  securityReviewPath: string;
  expected: ProductionReleaseExpectedIdentityV1;
  expectedDecisionDigest: string;
  payloadDigest: string;
  manifestDigest: string;
  manifestPath: string;
}): VerifiedReleaseGateContextV1 {
  try {
    const policy = verifyReleaseGatePolicyV1(JSON.parse(readFileSync(input.policyPath, 'utf8')));
    const evidence = verifyReleaseEvidenceBundleV1(
      JSON.parse(readFileSync(input.evidenceBundlePath, 'utf8')),
    );
    const parsed = verifyReleaseGateDecisionV1(JSON.parse(readFileSync(input.path, 'utf8')));
    const reviewRecord = maintainerSecurityReviewRecordV1Schema.parse(
      JSON.parse(readFileSync(input.securityReviewPath, 'utf8')),
    );
    const replayed = evaluateReleaseGateV1({
      policy,
      evidence,
      artifactIdentity: parsed.artifactIdentity,
      evaluatedAt: parsed.evaluatedAt,
    });
    const expectedArtifactIdentityValue = expectedArtifactIdentity(input);
    const exactGateSet =
      new Set(parsed.gates.map((gate) => gate.gate)).size === RELEASE_GATE_IDS.length &&
      RELEASE_GATE_IDS.every((gate) => parsed.gates.some((entry) => entry.gate === gate));
    const securityResults = evidence.results.filter(
      (result) => result.kind === 'maintainer_security_review',
    );
    const reviewRequirement = policy.requirements.find(
      (requirement) => requirement.kind === 'maintainer_security_review',
    );
    if (
      parsed.decisionDigest !== input.expectedDecisionDigest ||
      replayed.decisionDigest !== parsed.decisionDigest ||
      parsed.overall !== 'approved_candidate' ||
      parsed.evidenceBundleDigest !== evidence.bundleDigest ||
      policy.releaseWorkflowSha !== input.expected.workflowSha ||
      !Buffer.from(canonicalJsonBytes(parsed.artifactIdentity)).equals(
        Buffer.from(canonicalJsonBytes(expectedArtifactIdentityValue)),
      ) ||
      !exactGateSet ||
      parsed.gates.some((gate) => gate.status !== 'passed') ||
      parsed.requirements.some((requirement) => requirement.status !== 'passed') ||
      parsed.requiredManualApprovals.length !== 0 ||
      securityResults.length !== 1 ||
      securityResults[0]?.maintainerReview?.recordDigest !== reviewRecord.recordDigest ||
      reviewRequirement?.maxAgeSeconds === undefined ||
      evidence.results.some((result) => !matchesExpectedReleaseExecution(result, input.expected))
    ) {
      throw new Error(
        'Gate decision is incomplete, identity-mismatched, or not approved by every required Gate',
      );
    }
    return {
      evaluatedAt: parsed.evaluatedAt,
      reviewMaxAgeSeconds: reviewRequirement.maxAgeSeconds,
      executionWindows: evidence.results.map(({ executionIdentity }) => ({
        startedAt: executionIdentity.startedAt,
        endedAt: executionIdentity.endedAt,
      })),
    };
  } catch (error) {
    throw new ProductionSupplyChainVerificationError(
      'gate_not_approved',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function matchesExpectedReleaseExecution(
  result: ReturnType<typeof verifyReleaseEvidenceBundleV1>['results'][number],
  expected: ProductionReleaseExpectedIdentityV1,
): boolean {
  const execution = result.executionIdentity;
  if (
    result.kind === 'maintainer_security_review'
      ? execution.source !== 'github_maintainer_review'
      : execution.source !== 'github_actions'
  ) {
    return false;
  }
  if (execution.source !== 'github_actions' && execution.source !== 'github_maintainer_review') {
    return false;
  }
  return (
    execution.canonicalRepository === expected.repository &&
    execution.repositoryId === expected.repositoryNodeId &&
    execution.workflowPath === expected.workflowPath &&
    execution.workflowRef === expected.workflowRef &&
    execution.workflowSha === expected.workflowSha &&
    execution.oidcIssuer === GITHUB_ACTIONS_OIDC_ISSUER &&
    execution.ref === expected.ref &&
    execution.runId === expected.runId &&
    execution.runAttempt === expected.runAttempt &&
    execution.commit === expected.commit &&
    (execution.source !== 'github_maintainer_review' ||
      (execution.actorIdentity === MAINTAINER_REVIEW_IDENTITY &&
        execution.reviewerIdentity === MAINTAINER_REVIEW_IDENTITY))
  );
}

function runRequiredCommand(
  command: readonly string[],
  dependencies: ProductionSupplyChainVerifierDependenciesV1,
  trustedTools: ReadonlyMap<string, `sha256:${string}`>,
  code:
    | 'security_review_unverified'
    | 'cryptographic_verification_failed'
    | 'platform_signature_unverified',
): CommandExecutionResultV1 {
  const toolPath = command[0];
  const expectedDigest = toolPath ? trustedTools.get(toolPath) : undefined;
  if (!toolPath || !expectedDigest || fileDigest(toolPath) !== expectedDigest) {
    throw new ProductionSupplyChainVerificationError(
      'verifier_binary_mismatch',
      `${basename(toolPath ?? 'verifier')} changed before execution`,
    );
  }
  const result = dependencies.execute(command, COMMAND_TIMEOUT_MS);
  if (fileDigest(toolPath) !== expectedDigest) {
    throw new ProductionSupplyChainVerificationError(
      'verifier_binary_mismatch',
      `${basename(toolPath)} changed during execution`,
    );
  }
  if (result.exitCode !== 0 || result.timedOut === true) {
    throw new ProductionSupplyChainVerificationError(
      code,
      `${basename(toolPath)} ${result.timedOut ? 'timed out' : `exited ${result.exitCode}`}`,
    );
  }
  return result;
}

function verifyGithubAttestationOutput(input: {
  output: string;
  subjectPath: string;
  subjectDigest: string;
  expected: ProductionReleaseExpectedIdentityV1;
}): void {
  let parsed: z.infer<typeof githubAttestationOutputSchema>;
  try {
    parsed = githubAttestationOutputSchema.parse(JSON.parse(input.output));
  } catch (error) {
    throw new ProductionSupplyChainVerificationError(
      'attestation_identity_mismatch',
      error instanceof Error ? error.message : String(error),
    );
  }
  const expectedDigest = input.subjectDigest.replace(/^sha256:/, '');
  const expectedName = basename(input.subjectPath);
  const matching = parsed.find((entry) =>
    entry.verificationResult.statement.subject.some(
      (subject) => subject.name === expectedName && subject.digest.sha256 === expectedDigest,
    ),
  );
  if (!matching) {
    throw new ProductionSupplyChainVerificationError(
      'attestation_subject_mismatch',
      `${expectedName} sha256 subject is absent`,
    );
  }
  const certificateValues = new Set(
    collectScalarValues(matching.verificationResult.signature.certificate),
  );
  const requiredCertificateValues = [
    input.expected.repository,
    input.expected.repositoryNumericId,
    input.expected.workflowSha,
    input.expected.commit,
    input.expected.ref,
    productionReleaseCertificateIdentityV1(input.expected),
    productionReleaseRunInvocationUriV1(input.expected),
    GITHUB_ACTIONS_OIDC_ISSUER,
  ];
  if (requiredCertificateValues.some((value) => !certificateValues.has(value))) {
    throw new ProductionSupplyChainVerificationError(
      'attestation_identity_mismatch',
      'verified certificate does not contain the complete expected identity',
    );
  }
}

function collectScalarValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) return value.flatMap(collectScalarValues);
  if (typeof value === 'object') return Object.values(value).flatMap(collectScalarValues);
  return [];
}

function executeCommand(command: readonly string[], timeoutMs: number): CommandExecutionResultV1 {
  const result = spawnSync(command[0]!, command.slice(1), {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.error?.message.includes('ETIMEDOUT') ?? false,
  };
}

if (import.meta.main) {
  const input = parseProductionSupplyChainCliInputV1(process.argv.slice(2));
  const result = verifyProductionSupplyChainAdmissionV1(input, {
    execute: executeCommand,
    runtime: { platform: process.platform, arch: process.arch },
    now: () => new Date(),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.productionAccepted || !PRODUCTION_SUPPLY_CHAIN_ADMISSION_ENABLED) {
    process.exitCode = 1;
  }
}
