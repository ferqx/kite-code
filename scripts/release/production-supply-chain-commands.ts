export const PRODUCTION_RELEASE_REPOSITORY = 'ferqx/kite-code' as const;
export const PRODUCTION_RELEASE_REPOSITORY_NUMERIC_ID = '1218896626' as const;
export const PRODUCTION_RELEASE_REPOSITORY_NODE_ID = 'R_kgDOSKbi8g' as const;
export const PRODUCTION_RELEASE_WORKFLOW_PATH = '.github/workflows/release-candidate.yml' as const;
export const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com' as const;
export const SLSA_PROVENANCE_V1_PREDICATE = 'https://slsa.dev/provenance/v1' as const;

export interface ProductionReleaseExpectedIdentityV1 {
  repository: typeof PRODUCTION_RELEASE_REPOSITORY;
  repositoryNumericId: typeof PRODUCTION_RELEASE_REPOSITORY_NUMERIC_ID;
  repositoryNodeId: typeof PRODUCTION_RELEASE_REPOSITORY_NODE_ID;
  workflowPath: typeof PRODUCTION_RELEASE_WORKFLOW_PATH;
  workflowRef: string;
  workflowSha: string;
  trustedVerifierCommit: string;
  ref: string;
  commit: string;
  runId: string;
  runAttempt: number;
}

export function productionReleaseCertificateIdentityV1(
  expected: ProductionReleaseExpectedIdentityV1,
): string {
  return `https://github.com/${expected.repository}/${expected.workflowPath}@${expected.ref}`;
}

export function productionReleaseRunInvocationUriV1(
  expected: ProductionReleaseExpectedIdentityV1,
): string {
  return `https://github.com/${expected.repository}/actions/runs/${expected.runId}/attempts/${expected.runAttempt}`;
}

/** Exact keyless verification of the signed canonical manifest bytes. */
export function buildCosignKeylessBlobVerificationCommandV1(input: {
  cosignPath: string;
  subjectPath: string;
  bundlePath: string;
  expected: ProductionReleaseExpectedIdentityV1;
}): string[] {
  return [
    input.cosignPath,
    'verify-blob',
    '--bundle',
    input.bundlePath,
    '--certificate-identity',
    productionReleaseCertificateIdentityV1(input.expected),
    '--certificate-oidc-issuer',
    GITHUB_ACTIONS_OIDC_ISSUER,
    input.subjectPath,
  ];
}

/**
 * GitHub's verifier authenticates the file digest plus signer/source identity.
 * Run/attempt and numeric repository identity are additionally checked from the
 * verified certificate output; they are intentionally not read from provenance.
 */
export function buildGithubArtifactAttestationVerificationCommandV1(input: {
  ghPath: string;
  subjectPath: string;
  bundlePath: string;
  expected: ProductionReleaseExpectedIdentityV1;
}): string[] {
  const expected = input.expected;
  return [
    input.ghPath,
    'attestation',
    'verify',
    input.subjectPath,
    '--repo',
    expected.repository,
    '--bundle',
    input.bundlePath,
    '--cert-identity',
    productionReleaseCertificateIdentityV1(expected),
    '--cert-oidc-issuer',
    GITHUB_ACTIONS_OIDC_ISSUER,
    '--signer-workflow',
    `${expected.repository}/${expected.workflowPath}`,
    '--signer-digest',
    expected.workflowSha,
    '--source-digest',
    expected.commit,
    '--source-ref',
    expected.ref,
    '--deny-self-hosted-runners',
    '--predicate-type',
    SLSA_PROVENANCE_V1_PREDICATE,
    '--format',
    'json',
  ];
}

export type ProductionArtifactPlatformV1 = 'linux-x64' | 'macos-arm64' | 'windows-x64';
export const PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_V1: Readonly<
  Record<ProductionArtifactPlatformV1, string>
> = Object.freeze({
  'linux-x64': 'kite/bin/kite',
  'macos-arm64': 'Kite.app/Contents/MacOS/kite',
  'windows-x64': 'kite/bin/kite.exe',
});

export type ProductionNativeSignerExpectationV1 =
  | { platform: 'linux-x64'; kind: 'github_actions_keyless' }
  | {
      platform: 'macos-arm64';
      kind: 'apple_developer_id';
      teamId: string;
      certificateSha256: string;
      notarizationRequired: true;
    }
  | {
      platform: 'windows-x64';
      kind: 'authenticode';
      signerCertificateSha256: string;
      signerSpkiSha256: string;
      trustedRootCertificateSha256: string;
      timestampCertificateSha256: string;
      timestampRequired: true;
    };

/** Native/platform signing verification remains argv-only and fail closed. */
export function buildPlatformSignatureVerificationCommandsV1(input: {
  platform: ProductionArtifactPlatformV1;
  subjectPath: string;
  expected: ProductionReleaseExpectedIdentityV1;
  signer: ProductionNativeSignerExpectationV1;
  cosignPath?: string;
  platformVerifierPath?: string;
  macosPolicyVerifierPath?: string;
  macosCertificateOutputPrefix?: string;
  platformSignatureBundlePath?: string;
}): string[][] {
  if (input.signer.platform !== input.platform) {
    throw new Error('Native signer expectation does not match the artifact platform.');
  }
  if (input.platform === 'linux-x64') {
    if (!input.cosignPath || !input.platformSignatureBundlePath) {
      throw new Error('Linux platform signing requires cosign and a keyless signature bundle.');
    }
    return [
      buildCosignKeylessBlobVerificationCommandV1({
        cosignPath: input.cosignPath,
        subjectPath: input.subjectPath,
        bundlePath: input.platformSignatureBundlePath,
        expected: input.expected,
      }),
    ];
  }
  if (!input.platformVerifierPath) {
    throw new Error(`Platform signature verifier is missing for ${input.platform}.`);
  }
  if (input.platform === 'macos-arm64') {
    if (
      input.signer.kind !== 'apple_developer_id' ||
      !input.macosPolicyVerifierPath ||
      !input.macosCertificateOutputPrefix
    ) {
      throw new Error('macOS signing requires pinned Developer ID and Gatekeeper verifiers.');
    }
    const requirement = [
      '=anchor apple generic',
      'and certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
      `and certificate leaf[subject.OU] = "${input.signer.teamId}"`,
    ].join(' ');
    return [
      [
        input.platformVerifierPath,
        '--verify',
        '--deep',
        '--strict',
        '--verbose=4',
        '--test-requirement',
        requirement,
        input.subjectPath,
      ],
      [
        input.platformVerifierPath,
        '--display',
        '--extract-certificates',
        input.macosCertificateOutputPrefix,
        input.subjectPath,
      ],
      [
        input.macosPolicyVerifierPath,
        '--assess',
        '--type',
        'execute',
        '--verbose=4',
        input.subjectPath,
      ],
    ];
  }
  if (input.signer.kind !== 'authenticode') {
    throw new Error('Windows signing requires a pinned Authenticode signer.');
  }
  const script = [
    'param([string]$ArtifactPath,[string]$SignerCert,[string]$SignerSpki,[string]$RootCert,[string]$TimestampCert)',
    '$ErrorActionPreference = "Stop"',
    '$signature = Get-AuthenticodeSignature -LiteralPath $ArtifactPath',
    'if ($signature.Status -ne "Valid") { throw "Authenticode signature is not valid" }',
    'if ($null -eq $signature.SignerCertificate) { throw "Authenticode signer is missing" }',
    'if ($null -eq $signature.TimeStamperCertificate) { throw "Authenticode timestamp is missing" }',
    '$signerHash = $signature.SignerCertificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)',
    'if ($signerHash -ne $SignerCert) { throw "Authenticode signer certificate mismatch" }',
    '$spkiBytes = $signature.SignerCertificate.ExportSubjectPublicKeyInfo()',
    '$spkiHash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($spkiBytes))',
    'if ($spkiHash -ne $SignerSpki) { throw "Authenticode signer SPKI mismatch" }',
    '$chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()',
    'if (-not $chain.Build($signature.SignerCertificate)) { throw "Authenticode chain is invalid" }',
    '$rootHash = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)',
    'if ($rootHash -ne $RootCert) { throw "Authenticode trusted root mismatch" }',
    '$timestampHash = $signature.TimeStamperCertificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)',
    'if ($timestampHash -ne $TimestampCert) { throw "Authenticode timestamp certificate mismatch" }',
  ].join('; ');
  return [
    [
      input.platformVerifierPath,
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
      input.subjectPath,
      input.signer.signerCertificateSha256,
      input.signer.signerSpkiSha256,
      input.signer.trustedRootCertificateSha256,
      input.signer.timestampCertificateSha256,
    ],
  ];
}

export function buildCosignKeyVerificationCommandV1(input: {
  cosignPath: string;
  subjectPath: string;
  bundlePath: string;
  publicKeyPath: string;
}): string[] {
  return [
    input.cosignPath,
    'verify-blob',
    '--key',
    input.publicKeyPath,
    '--bundle',
    input.bundlePath,
    input.subjectPath,
  ];
}
