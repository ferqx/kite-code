import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { canonicalJsonBytes } from '../../scripts/release/canonical-json';
import { buildReleaseEvidenceBundle } from '../../scripts/release/evidence-bundle';
import {
  buildMaintainerSecurityReviewRecord,
  buildProductionReleaseReplayEvidenceRecord,
  type ReleaseEvidenceResult,
} from '../../scripts/release/evidence-schema';
import { buildReleaseGatePolicy, evaluateReleaseGate } from '../../scripts/release/gate-evaluator';
import {
  buildCosignKeylessBlobVerificationCommand,
  buildGithubArtifactAttestationVerificationCommand,
  buildPlatformSignatureVerificationCommands,
  PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_,
  PRODUCTION_RELEASE_REPOSITORY,
  PRODUCTION_RELEASE_REPOSITORY_NODE_ID,
  PRODUCTION_RELEASE_REPOSITORY_NUMERIC_ID,
  PRODUCTION_RELEASE_WORKFLOW_PATH,
  type ProductionArtifactPlatform,
  type ProductionReleaseExpectedIdentity,
  productionReleaseCertificateIdentity,
  productionReleaseRunInvocationUri,
} from '../../scripts/release/production-supply-chain-commands';
import {
  isProtectedWindowsToolPath,
  PRODUCTION_SUPPLY_CHAIN_ADMISSION_ENABLED,
  type ProductionSupplyChainCliInput,
  ProductionSupplyChainVerificationError,
  parseProductionSupplyChainCliInput,
  verifyProductionSupplyChainAdmission,
} from '../../scripts/release/verify-production-supply-chain';

const COMMIT = '1'.repeat(40);
const WORKFLOW_SHA = '2'.repeat(40);
const TRUSTED_VERIFIER_COMMIT = '3'.repeat(40);
const REVIEWER = 'github:@ferqx';

function identity(): ProductionReleaseExpectedIdentity {
  const ref = 'refs/tags/v1.0.0';
  return {
    repository: PRODUCTION_RELEASE_REPOSITORY,
    repositoryNumericId: PRODUCTION_RELEASE_REPOSITORY_NUMERIC_ID,
    repositoryNodeId: PRODUCTION_RELEASE_REPOSITORY_NODE_ID,
    workflowPath: PRODUCTION_RELEASE_WORKFLOW_PATH,
    workflowRef: `${PRODUCTION_RELEASE_REPOSITORY}/${PRODUCTION_RELEASE_WORKFLOW_PATH}@${ref}`,
    workflowSha: WORKFLOW_SHA,
    trustedVerifierCommit: TRUSTED_VERIFIER_COMMIT,
    ref,
    commit: COMMIT,
    runId: '123456',
    runAttempt: 2,
  };
}

function sha256(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

interface TarEntry {
  path: string;
  bytes?: Uint8Array;
  mode?: number;
  type?: string;
}

function tarGz(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const bytes = entry.bytes ?? new Uint8Array();
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, 'utf8');
    writeTarOctal(header, 100, 8, entry.mode ?? 0o755);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, bytes.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const checksumText = checksum.toString(8).padStart(6, '0');
    header.write(checksumText, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    const padding = Buffer.alloc(Math.ceil(bytes.byteLength / 512) * 512 - bytes.byteLength);
    blocks.push(header, Buffer.from(bytes), padding);
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  buffer.write(encoded, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function fixture(platform: ProductionArtifactPlatform = 'linux-x64') {
  const root = mkdtempSync(join(tmpdir(), 'kite-production-supply-chain-'));
  const paths = {
    payload: join(root, `kite-${platform}.tar.gz`),
    nativeLauncher: join(root, 'kite'),
    manifest: join(root, 'manifest.json'),
    sbom: join(root, 'sbom.spdx.json'),
    provenance: join(root, 'provenance.json'),
    sigstoreBundle: join(root, 'manifest.sigstore.json'),
    githubAttestationBundle: join(root, 'attestations.jsonl'),
    gatePolicy: join(root, 'gate-policy.json'),
    evidenceBundle: join(root, 'release-evidence.json'),
    gateDecision: join(root, 'gate.json'),
    securityReviewEvidence: join(root, 'security-review.json'),
    rollbackReport: join(root, 'rollback-report.json'),
    compatibilityReport: join(root, 'compatibility-report.json'),
    platformSignatureBundle: join(root, 'launcher.sigstore.json'),
  };
  const launcher = new TextEncoder().encode('signed-launcher-bytes');
  writeFileSync(paths.nativeLauncher, launcher, { mode: 0o700 });
  const payload = tarGz([
    {
      path: PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_[platform],
      bytes: launcher,
      mode: 0o755,
    },
    ...(platform === 'macos-arm64'
      ? [
          {
            path: 'Kite.app/Contents/Info.plist',
            bytes: new TextEncoder().encode('<plist/>'),
            mode: 0o644,
          },
          {
            path: 'Kite.app/Contents/_CodeSignature/CodeResources',
            bytes: new TextEncoder().encode('sealed-resources'),
            mode: 0o644,
          },
        ]
      : []),
  ]);
  writeFileSync(paths.payload, payload);
  const gatePolicy = buildReleaseGatePolicy({
    schema: 'ReleaseGatePolicy',
    policyId: 'production-release-policy-v1',
    mode: 'github_release',
    canonicalRepository: PRODUCTION_RELEASE_REPOSITORY,
    repositoryId: PRODUCTION_RELEASE_REPOSITORY_NODE_ID,
    releaseWorkflowPath: PRODUCTION_RELEASE_WORKFLOW_PATH,
    releaseWorkflowSha: WORKFLOW_SHA,
    oidcIssuer: 'https://token.actions.githubusercontent.com',
    allowedRefPrefixes: ['refs/tags/v'],
    capabilities: ['builtin_read_tools'],
    requirements: [
      { requirementId: 'g0', evidenceId: 'g0', kind: 'execution_conformance', gate: 'G0' },
      { requirementId: 'g1', evidenceId: 'g1', kind: 'required_ci', gate: 'G1' },
      { requirementId: 'g2', evidenceId: 'g2', kind: 'dependency_audit', gate: 'G2' },
      { requirementId: 'g3', evidenceId: 'g3', kind: 'agent_task_suite', gate: 'G3' },
      { requirementId: 'g4', evidenceId: 'g4', kind: 'incident_rehearsal', gate: 'G4' },
      {
        requirementId: 'g5',
        evidenceId: 'g5',
        kind: 'maintainer_security_review',
        gate: 'G5',
        maxAgeSeconds: 3_600,
        requiredRouteIdentity: sha256('provider-policy'),
        requiredPlatformIdentity: {
          'linux-x64': 'ubuntu-24.04-x64',
          'macos-arm64': 'macos-15-arm64',
          'windows-x64': 'windows-2025-x64',
        }[platform],
      },
    ],
  });
  const manifest = {
    version: 1,
    productVersion: '1.0.0',
    commitSha: COMMIT,
    buildTimestamp: '2026-08-02T00:00:00.000Z',
    bunVersion: '1.3.14',
    payloadSha256: sha256(payload),
    releaseProfileDigest: sha256('release-profile'),
    lockfileDigest: sha256('lockfile'),
    agentContractDigest: sha256('agent-contract'),
    modelVisibleToolRegistryDigest: sha256('tool-registry'),
    defaultConfigDigest: sha256('default-config'),
    providerRouteDigest: sha256('provider-policy'),
    releaseGatePolicyDigest: gatePolicy.policyDigest,
    runtimeSchedulingPolicyDigest: sha256('scheduling-policy'),
    buildRecipeDigest: sha256('build-recipe'),
    behaviorDigest: sha256('behavior'),
    runtimeSchemaVersion: 21,
    supportedPlatforms: [
      {
        'linux-x64': 'ubuntu-24.04-x64',
        'macos-arm64': 'macos-15-arm64',
        'windows-x64': 'windows-2025-x64',
      }[platform],
    ],
    supportedProviderTypes: ['openai-compatible'],
  };
  writeFileSync(paths.manifest, canonicalJsonBytes(manifest));
  writeFileSync(paths.sbom, '{"spdxVersion":"SPDX-2.3"}');
  writeFileSync(paths.provenance, '{"predicateType":"https://slsa.dev/provenance/v1"}');
  writeFileSync(paths.sigstoreBundle, '{"bundle":true}');
  writeFileSync(paths.githubAttestationBundle, '{"bundle":true}');
  writeFileSync(paths.platformSignatureBundle, '{"bundle":true}');
  const candidate = {
    canonicalRepository: PRODUCTION_RELEASE_REPOSITORY,
    repositoryId: PRODUCTION_RELEASE_REPOSITORY_NODE_ID,
    commit: COMMIT,
    payloadSha256: sha256(payload),
    canonicalManifestDigest: sha256(canonicalJsonBytes(manifest)),
    behaviorDigest: manifest.behaviorDigest,
    profileDigest: manifest.releaseProfileDigest,
    gatePolicyDigest: manifest.releaseGatePolicyDigest,
  };
  const rollbackReport = buildProductionReleaseReplayEvidenceRecord({
    schema: 'ProductionReleaseReplayEvidenceRecord',
    kind: 'schema_rollback',
    productionEvidence: true,
    status: 'passed',
    candidate,
    completedAt: '2026-08-02T00:40:00.000Z',
    trustedVerifierCommit: TRUSTED_VERIFIER_COMMIT,
    reportDigest: sha256('rollback-report'),
    verificationReceiptDigest: sha256('rollback-verification-receipt'),
  });
  const compatibilityReport = buildProductionReleaseReplayEvidenceRecord({
    schema: 'ProductionReleaseReplayEvidenceRecord',
    kind: 'ga_compatibility',
    productionEvidence: true,
    status: 'passed',
    candidate,
    completedAt: '2026-08-02T00:42:00.000Z',
    trustedVerifierCommit: TRUSTED_VERIFIER_COMMIT,
    reportDigest: sha256('compatibility-report'),
    verificationReceiptDigest: sha256('compatibility-verification-receipt'),
  });
  writeFileSync(paths.rollbackReport, JSON.stringify(rollbackReport));
  writeFileSync(paths.compatibilityReport, JSON.stringify(compatibilityReport));
  const reviewExecution = {
    canonicalRepository: PRODUCTION_RELEASE_REPOSITORY,
    repositoryId: PRODUCTION_RELEASE_REPOSITORY_NODE_ID,
    workflowPath: PRODUCTION_RELEASE_WORKFLOW_PATH,
    workflowRef: `${PRODUCTION_RELEASE_REPOSITORY}/${PRODUCTION_RELEASE_WORKFLOW_PATH}@${identity().ref}`,
    workflowSha: WORKFLOW_SHA,
    oidcIssuer: 'https://token.actions.githubusercontent.com' as const,
    ref: identity().ref,
    runId: identity().runId,
    runAttempt: identity().runAttempt,
    actorIdentity: REVIEWER,
  };
  const securityReview = buildMaintainerSecurityReviewRecord({
    schema: 'MaintainerSecurityReviewRecord',
    reviewMode: 'single_maintainer',
    reviewerIdentity: REVIEWER,
    reviewedAt: '2026-08-02T01:00:00.000Z',
    outcome: 'passed',
    candidate,
    execution: reviewExecution,
    ref: identity().ref,
    trustedVerifierCommit: TRUSTED_VERIFIER_COMMIT,
    routeIdentity: manifest.providerRouteDigest,
    platformIdentity: manifest.supportedPlatforms[0]!,
    rollbackReportDigest: rollbackReport.recordDigest,
    compatibilityReportDigest: compatibilityReport.recordDigest,
    unresolvedP0: 0,
    unresolvedP1: 0,
    p2Dispositions: [],
    scope: [
      'architecture',
      'security_boundaries',
      'artifact_identity',
      'rollback',
      'adversarial_bypass',
    ],
  });
  writeFileSync(paths.securityReviewEvidence, JSON.stringify(securityReview));
  const githubExecution = (job: string): ReleaseEvidenceResult['executionIdentity'] => ({
    source: 'github_actions',
    canonicalRepository: PRODUCTION_RELEASE_REPOSITORY,
    repositoryId: PRODUCTION_RELEASE_REPOSITORY_NODE_ID,
    workflowPath: PRODUCTION_RELEASE_WORKFLOW_PATH,
    workflowRef: `${PRODUCTION_RELEASE_REPOSITORY}/${PRODUCTION_RELEASE_WORKFLOW_PATH}@${identity().ref}`,
    workflowSha: WORKFLOW_SHA,
    oidcIssuer: 'https://token.actions.githubusercontent.com',
    ref: identity().ref,
    runId: identity().runId,
    runAttempt: identity().runAttempt,
    job,
    commit: COMMIT,
    startedAt: '2026-08-02T00:00:00.000Z',
    endedAt: '2026-08-02T00:30:00.000Z',
  });
  const automaticKinds = [
    ['g0', 'execution_conformance', 'G0'],
    ['g1', 'required_ci', 'G1'],
    ['g2', 'dependency_audit', 'G2'],
    ['g3', 'agent_task_suite', 'G3'],
    ['g4', 'incident_rehearsal', 'G4'],
  ] as const;
  const results: ReleaseEvidenceResult[] = automaticKinds.map(([evidenceId, kind, gate]) => ({
    evidenceId,
    kind,
    gate,
    status: 'passed',
    artifactIdentity: securityReview.candidate,
    executionIdentity: githubExecution(evidenceId),
    suiteIdentity: `${evidenceId}-suite-v1`,
    record: {
      uri: `https://github.com/${PRODUCTION_RELEASE_REPOSITORY}/actions/runs/${identity().runId}`,
      digest: sha256(`${evidenceId}-record`),
    },
    summary: `${gate} production evidence fixture.`,
  }));
  results.push({
    evidenceId: 'g5',
    kind: 'maintainer_security_review',
    gate: 'G5',
    status: 'passed',
    artifactIdentity: securityReview.candidate,
    executionIdentity: {
      source: 'github_maintainer_review',
      ...reviewExecution,
      reviewerIdentity: REVIEWER,
      recordIdentity: 'maintainer-review-record-v1',
      commit: COMMIT,
      startedAt: '2026-08-02T00:45:00.000Z',
      endedAt: securityReview.reviewedAt,
    },
    routeIdentity: securityReview.routeIdentity,
    platformIdentity: securityReview.platformIdentity,
    suiteIdentity: 'maintainer-security-review-v1',
    record: {
      uri: `https://github.com/${PRODUCTION_RELEASE_REPOSITORY}/actions/runs/${identity().runId}`,
      digest: securityReview.recordDigest,
    },
    summary: 'Candidate-bound single-maintainer security review.',
    maintainerReview: securityReview,
  });
  const evidenceBundle = buildReleaseEvidenceBundle({
    schema: 'ReleaseEvidence',
    evidenceBundleId: 'production-release-evidence-v1',
    generatedAt: '2026-08-02T01:05:00.000Z',
    artifactIdentity: securityReview.candidate,
    nonDistributable: false,
    syntheticTrustRoot: false,
    results,
    risks: [],
    exceptions: [],
  });
  const gateDecision = evaluateReleaseGate({
    policy: gatePolicy,
    evidence: evidenceBundle,
    artifactIdentity: securityReview.candidate,
    evaluatedAt: '2026-08-02T01:05:00.000Z',
  });
  const gateDecisionDigest = gateDecision.decisionDigest;
  writeFileSync(paths.gatePolicy, JSON.stringify(gatePolicy));
  writeFileSync(paths.evidenceBundle, JSON.stringify(evidenceBundle));
  writeFileSync(paths.gateDecision, JSON.stringify(gateDecision));
  const toolPaths =
    process.platform === 'win32'
      ? {
          gh: 'C:\\Program Files\\GitHub CLI\\gh.exe',
          cosign: 'C:\\Program Files\\GitHub CLI\\gh.exe',
          codesign: 'C:\\Program Files\\GitHub CLI\\gh.exe',
          spctl: 'C:\\Program Files\\GitHub CLI\\GH.exe',
          pwsh: 'C:\\Program Files\\GitHub CLI\\gh.exe',
        }
      : {
          gh: '/usr/bin/true',
          cosign: '/usr/bin/false',
          codesign: '/usr/bin/true',
          spctl: '/usr/bin/false',
          pwsh: '/usr/bin/true',
        };
  const nativeSigner =
    platform === 'linux-x64'
      ? ({ platform, kind: 'github_actions_keyless' } as const)
      : platform === 'macos-arm64'
        ? ({
            platform,
            kind: 'apple_developer_id',
            teamId: 'ABCDEFGHIJ',
            certificateSha256: sha256('trusted-mac-leaf').replace('sha256:', '').toUpperCase(),
            notarizationRequired: true,
          } as const)
        : ({
            platform,
            kind: 'authenticode',
            signerCertificateSha256: 'A'.repeat(64),
            signerSpkiSha256: 'B'.repeat(64),
            trustedRootCertificateSha256: 'C'.repeat(64),
            timestampCertificateSha256: 'D'.repeat(64),
            timestampRequired: true,
          } as const);
  const input: ProductionSupplyChainCliInput = {
    expected: identity(),
    platform,
    paths,
    tools: {
      gh: { path: toolPaths.gh, sha256: sha256(readFileSync(toolPaths.gh)) },
      cosign: { path: toolPaths.cosign, sha256: sha256(readFileSync(toolPaths.cosign)) },
      ...(platform === 'macos-arm64'
        ? {
            platformVerifier: {
              path: toolPaths.codesign,
              sha256: sha256(readFileSync(toolPaths.codesign)),
            },
            macosPolicyVerifier: {
              path: toolPaths.spctl,
              sha256: sha256(readFileSync(toolPaths.spctl)),
            },
          }
        : platform === 'windows-x64'
          ? {
              platformVerifier: {
                path: toolPaths.pwsh,
                sha256: sha256(readFileSync(toolPaths.pwsh)),
              },
            }
          : {}),
    },
    nativeSigner,
    expectedGateDecisionDigest: gateDecisionDigest,
  };
  return { root, paths, input, toolPaths };
}

function attestationOutput(input: {
  expected: ProductionReleaseExpectedIdentity;
  subjectPath: string;
  digest: string;
}) {
  const certificate = {
    issuer: 'https://token.actions.githubusercontent.com',
    repository: input.expected.repository,
    repositoryId: Number(input.expected.repositoryNumericId),
    workflowSha: input.expected.workflowSha,
    sourceDigest: input.expected.commit,
    sourceRef: input.expected.ref,
    san: productionReleaseCertificateIdentity(input.expected),
    runInvocation: productionReleaseRunInvocationUri(input.expected),
  };
  return JSON.stringify([
    {
      verificationResult: {
        signature: { certificate },
        statement: {
          subject: [
            {
              name: basename(input.subjectPath),
              digest: { sha256: input.digest.replace(/^sha256:/, '') },
            },
          ],
        },
      },
    },
  ]);
}

describe('production supply-chain command builders', () => {
  test('pins Windows tools to exact system-volume protected installation paths', () => {
    expect(isProtectedWindowsToolPath('C:\\Program Files\\GitHub CLI\\gh.exe')).toBe(true);
    expect(isProtectedWindowsToolPath('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(true);
    expect(isProtectedWindowsToolPath('C:\\Program Files\\Kite Verifiers\\cosign.exe')).toBe(true);
    expect(isProtectedWindowsToolPath('D:\\Program Files\\evil\\evil.exe')).toBe(false);
    expect(isProtectedWindowsToolPath('C:\\Program Files\\evil\\evil.exe')).toBe(false);
    expect(
      isProtectedWindowsToolPath(
        'C:\\Program Files\\PowerShell\\7\\..\\..\\..\\Users\\runneradmin\\pwsh.exe',
      ),
    ).toBe(false);
  });

  test('pins keyless and GitHub verification to expected CLI identity', () => {
    const expected = identity();
    expect(
      buildCosignKeylessBlobVerificationCommand({
        cosignPath: '/usr/bin/cosign',
        subjectPath: '/release/manifest.json',
        bundlePath: '/release/manifest.sigstore.json',
        expected,
      }),
    ).toContain(productionReleaseCertificateIdentity(expected));
    const github = buildGithubArtifactAttestationVerificationCommand({
      ghPath: '/usr/bin/gh',
      subjectPath: '/release/payload.tar.gz',
      bundlePath: '/release/attestations.jsonl',
      expected,
    });
    expect(github).toContain('--deny-self-hosted-runners');
    expect(github).toContain(COMMIT);
    expect(github).toContain(WORKFLOW_SHA);
  });

  test('pins macOS Developer ID/notarization and Windows signer, chain, and timestamp', () => {
    const expected = identity();
    const mac = buildPlatformSignatureVerificationCommands({
      platform: 'macos-arm64',
      subjectPath: '/release/Kite.app',
      expected,
      signer: {
        platform: 'macos-arm64',
        kind: 'apple_developer_id',
        teamId: 'ABCDEFGHIJ',
        certificateSha256: 'A'.repeat(64),
        notarizationRequired: true,
      },
      platformVerifierPath: '/usr/bin/codesign',
      macosPolicyVerifierPath: '/usr/sbin/spctl',
      macosCertificateOutputPrefix: '/tmp/kite-cert-',
    });
    expect(mac).toHaveLength(3);
    expect(mac[0]).toContain('--deep');
    expect(mac[0]).toContain('--test-requirement');
    expect(mac[0]).not.toContain('--requirements');
    expect(mac[0]?.at(-1)).toBe('/release/Kite.app');
    expect(mac[0]?.join(' ')).toContain('=anchor apple generic');
    expect(mac[0]?.join(' ')).toContain('certificate leaf[subject.OU] = "ABCDEFGHIJ"');
    expect(mac[1]).toContain('--extract-certificates');
    expect(mac[2]).toContain('--assess');

    const windows = buildPlatformSignatureVerificationCommands({
      platform: 'windows-x64',
      subjectPath: 'C:\\release\\kite.exe',
      expected,
      signer: {
        platform: 'windows-x64',
        kind: 'authenticode',
        signerCertificateSha256: 'A'.repeat(64),
        signerSpkiSha256: 'B'.repeat(64),
        trustedRootCertificateSha256: 'C'.repeat(64),
        timestampCertificateSha256: 'D'.repeat(64),
        timestampRequired: true,
      },
      platformVerifierPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    });
    expect(windows[0]?.join(' ')).toContain('TimeStamperCertificate');
    expect(windows[0]).toContain('A'.repeat(64));
    expect(windows[0]).toContain('B'.repeat(64));
    expect(windows[0]).toContain('C'.repeat(64));
    expect(windows[0]).toContain('D'.repeat(64));
  });

  test('accepts expected identity only from explicit CLI/env and rejects branch refs', () => {
    const value = fixture();
    try {
      const expected = identity();
      const env = {
        KITE_RELEASE_REPOSITORY: expected.repository,
        KITE_RELEASE_REPOSITORY_ID: expected.repositoryNumericId,
        KITE_RELEASE_REPOSITORY_NODE_ID: expected.repositoryNodeId,
        KITE_RELEASE_WORKFLOW_PATH: expected.workflowPath,
        KITE_RELEASE_WORKFLOW_REF: expected.workflowRef,
        KITE_RELEASE_WORKFLOW_SHA: expected.workflowSha,
        KITE_RELEASE_TRUSTED_VERIFIER_COMMIT: expected.trustedVerifierCommit,
        KITE_RELEASE_REF: expected.ref,
        KITE_RELEASE_COMMIT: expected.commit,
        KITE_RELEASE_RUN_ID: expected.runId,
        KITE_RELEASE_RUN_ATTEMPT: String(expected.runAttempt),
        KITE_RELEASE_PLATFORM: 'linux-x64',
        KITE_RELEASE_PAYLOAD: value.paths.payload,
        KITE_RELEASE_NATIVE_LAUNCHER: value.paths.nativeLauncher,
        KITE_RELEASE_MANIFEST: value.paths.manifest,
        KITE_RELEASE_SBOM: value.paths.sbom,
        KITE_RELEASE_PROVENANCE: value.paths.provenance,
        KITE_RELEASE_SIGSTORE_BUNDLE: value.paths.sigstoreBundle,
        KITE_RELEASE_ATTESTATION_BUNDLE: value.paths.githubAttestationBundle,
        KITE_RELEASE_GATE_POLICY: value.paths.gatePolicy,
        KITE_RELEASE_EVIDENCE_BUNDLE: value.paths.evidenceBundle,
        KITE_RELEASE_GATE_DECISION: value.paths.gateDecision,
        KITE_RELEASE_SECURITY_REVIEW_EVIDENCE: value.paths.securityReviewEvidence,
        KITE_RELEASE_ROLLBACK_REPORT: value.paths.rollbackReport,
        KITE_RELEASE_COMPATIBILITY_REPORT: value.paths.compatibilityReport,
        KITE_RELEASE_GH_PATH: value.toolPaths.gh,
        KITE_RELEASE_GH_SHA256: value.input.tools.gh.sha256,
        KITE_RELEASE_COSIGN_PATH: value.toolPaths.cosign,
        KITE_RELEASE_COSIGN_SHA256: value.input.tools.cosign.sha256,
        KITE_RELEASE_GATE_DECISION_DIGEST: value.input.expectedGateDecisionDigest,
      };
      expect(parseProductionSupplyChainCliInput([], env).expected).toEqual(expected);
      expect(() =>
        parseProductionSupplyChainCliInput([], {
          ...env,
          KITE_RELEASE_REF: 'refs/heads/main',
        }),
      ).toThrow(ProductionSupplyChainVerificationError);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
});

function dependencies(value: ReturnType<typeof fixture>, commands: string[][]) {
  const runtime = {
    'linux-x64': { platform: 'linux' as const, arch: 'x64' },
    'macos-arm64': { platform: 'darwin' as const, arch: 'arm64' },
    'windows-x64': { platform: 'win32' as const, arch: 'x64' },
  }[value.input.platform];
  return {
    runtime,
    now: () => new Date('2026-08-02T01:10:00.000Z'),
    execute(command: readonly string[]) {
      commands.push([...command]);
      const extractIndex = command.indexOf('--extract-certificates');
      if (extractIndex >= 0) {
        writeFileSync(`${command[extractIndex + 1]}0`, 'trusted-mac-leaf');
      }
      if (command.includes('attestation')) {
        const subjectPath = command[3]!;
        return {
          exitCode: 0,
          stdout: attestationOutput({
            expected: value.input.expected,
            subjectPath,
            digest: sha256(readFileSync(subjectPath)),
          }),
          stderr: '',
        };
      }
      if (command.includes('api')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: Number(value.input.expected.runId),
            event: 'workflow_dispatch',
            head_sha: value.input.expected.commit,
            run_attempt: value.input.expected.runAttempt,
            status: 'completed',
            conclusion: 'success',
            created_at: '2026-08-01T23:59:00.000Z',
            run_started_at: '2026-08-02T00:00:00.000Z',
            updated_at: '2026-08-02T01:06:00.000Z',
            actor: { login: 'ferqx' },
            triggering_actor: { login: 'ferqx' },
            repository: { full_name: value.input.expected.repository },
          }),
          stderr: '',
        };
      }
      if (command.includes('--assess')) {
        return {
          exitCode: 0,
          stdout: '',
          stderr:
            'source=Notarized Developer ID\norigin=Developer ID Application: Kite (ABCDEFGHIJ)',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

describe('production supply-chain admission verifier skeleton', () => {
  test('verifies eleven immutable subjects and remains non-admitting', () => {
    const value = fixture();
    const commands: string[][] = [];
    try {
      const result = verifyProductionSupplyChainAdmission(
        value.input,
        dependencies(value, commands),
      );
      expect(PRODUCTION_SUPPLY_CHAIN_ADMISSION_ENABLED).toBe(false);
      expect(result).toMatchObject({
        status: 'blocked',
        reason: 'production_workflow_disabled',
        productionAccepted: false,
        productionReceipt: null,
        checks: {
          immutableSnapshots: 'verified',
          archiveLauncherBinding: 'verified',
          canonicalManifestBinding: 'verified',
          maintainerSecurityReview: 'verified',
          pinnedToolchain: 'verified',
          platformSignature: 'verified',
          releaseGate: 'verified',
        },
      });
      expect(commands.filter((command) => command.includes('attestation'))).toHaveLength(11);
      expect(commands.filter((command) => command.includes('verify-blob'))).toHaveLength(2);
      expect(commands.flat().join(' ')).toContain(join('nativeLauncher', 'kite'));
      expect(commands.flat().join(' ')).not.toContain(value.paths.nativeLauncher);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test('fails closed for tool substitution, incomplete Gate, archive splice, or platform signature failure', () => {
    const value = fixture();
    try {
      const base = dependencies(value, []);
      expect(() =>
        verifyProductionSupplyChainAdmission(
          {
            ...value.input,
            tools: {
              ...value.input.tools,
              cosign: { ...value.input.tools.cosign, sha256: sha256('attacker-binary') },
            },
          },
          base,
        ),
      ).toThrow(/verifier_binary_mismatch/);
      expect(() =>
        verifyProductionSupplyChainAdmission(value.input, {
          ...base,
          execute(command) {
            if (command.includes('api')) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  id: Number(value.input.expected.runId),
                  event: 'workflow_dispatch',
                  head_sha: value.input.expected.commit,
                  run_attempt: value.input.expected.runAttempt,
                  actor: { login: 'attacker' },
                  triggering_actor: { login: 'attacker' },
                  repository: { full_name: value.input.expected.repository },
                }),
                stderr: '',
              };
            }
            return base.execute(command);
          },
        }),
      ).toThrow(/security_review_unverified/);
      expect(() =>
        verifyProductionSupplyChainAdmission(
          {
            ...value.input,
            expected: { ...value.input.expected, trustedVerifierCommit: '4'.repeat(40) },
          },
          base,
        ),
      ).toThrow(/gate_not_approved/);
      expect(() =>
        verifyProductionSupplyChainAdmission(
          {
            ...value.input,
            nativeSigner: {
              platform: 'macos-arm64',
              kind: 'apple_developer_id',
              teamId: '" OR TRUE',
              certificateSha256: 'A'.repeat(64),
              notarizationRequired: true,
            } as never,
          },
          base,
        ),
      ).toThrow(/expected_identity_invalid/);

      const gate = JSON.parse(readFileSync(value.paths.gateDecision, 'utf8'));
      writeFileSync(
        value.paths.gateDecision,
        JSON.stringify({
          ...gate,
          gates: gate.gates.map((entry: { gate: string }) =>
            entry.gate === 'G5' ? { ...entry, status: 'not_applicable' } : entry,
          ),
        }),
      );
      expect(() => verifyProductionSupplyChainAdmission(value.input, base)).toThrow(
        /gate_not_approved/,
      );
      writeFileSync(value.paths.gateDecision, JSON.stringify(gate));

      writeFileSync(value.paths.nativeLauncher, 'different-launcher');
      expect(() => verifyProductionSupplyChainAdmission(value.input, base)).toThrow(
        /archive_layout_mismatch/,
      );
      writeFileSync(value.paths.nativeLauncher, 'signed-launcher-bytes');

      expect(() =>
        verifyProductionSupplyChainAdmission(value.input, {
          ...base,
          execute(command) {
            if (
              command.includes('verify-blob') &&
              basename(command.at(-1) ?? '') === basename(value.paths.nativeLauncher)
            ) {
              return { exitCode: 1, stdout: '', stderr: 'invalid signature' };
            }
            return base.execute(command);
          },
        }),
      ).toThrow(/platform_signature_unverified/);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test('rejects stale review time, run splicing, and unattested replay-record mutation', () => {
    const value = fixture();
    try {
      const base = dependencies(value, []);
      expect(() =>
        verifyProductionSupplyChainAdmission(value.input, {
          ...base,
          now: () => new Date('2026-08-02T02:01:00.001Z'),
        }),
      ).toThrow(/security_review_unverified/);
      expect(() =>
        verifyProductionSupplyChainAdmission(
          {
            ...value.input,
            expected: { ...value.input.expected, runId: '654321' },
          },
          base,
        ),
      ).toThrow(/gate_not_approved/);

      const rollback = JSON.parse(readFileSync(value.paths.rollbackReport, 'utf8'));
      writeFileSync(
        value.paths.rollbackReport,
        JSON.stringify({ ...rollback, reportDigest: sha256('spliced-rollback-report') }),
      );
      expect(() => verifyProductionSupplyChainAdmission(value.input, base)).toThrow(
        /gate_not_approved/,
      );
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test('rejects hard-link role aliases before any verifier command runs', () => {
    const value = fixture();
    try {
      rmSync(value.paths.provenance);
      linkSync(value.paths.sbom, value.paths.provenance);
      const commands: string[][] = [];
      expect(() =>
        verifyProductionSupplyChainAdmission(value.input, dependencies(value, commands)),
      ).toThrow(/input_missing_or_unsafe/);
      expect(commands).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test('rejects a user-writable verifier tool path before command execution', () => {
    const value = fixture();
    const commands: string[][] = [];
    try {
      const unprotectedGh = join(value.root, 'unprotected-gh');
      writeFileSync(unprotectedGh, 'attacker-controlled-tool', { mode: 0o500 });
      expect(() =>
        verifyProductionSupplyChainAdmission(
          {
            ...value.input,
            tools: {
              ...value.input.tools,
              gh: { path: unprotectedGh, sha256: sha256('attacker-controlled-tool') },
            },
          },
          dependencies(value, commands),
        ),
      ).toThrow(/verifier_binary_missing/);
      expect(commands).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test('rejects PAX metadata and dot-segment overwrite archives', () => {
    const value = fixture();
    try {
      const launcher = new TextEncoder().encode('signed-launcher-bytes');
      writeFileSync(
        value.paths.payload,
        tarGz([
          { path: PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_['linux-x64'], bytes: launcher },
          { path: 'pax-header', bytes: new TextEncoder().encode('path=kite/bin/kite'), type: 'x' },
        ]),
      );
      expect(() =>
        verifyProductionSupplyChainAdmission(value.input, dependencies(value, [])),
      ).toThrow(/archive_layout_mismatch/);

      writeFileSync(
        value.paths.payload,
        tarGz([
          { path: PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_['linux-x64'], bytes: launcher },
          { path: 'kite/bin//', type: '5' },
        ]),
      );
      expect(() =>
        verifyProductionSupplyChainAdmission(value.input, dependencies(value, [])),
      ).toThrow(/archive_layout_mismatch/);

      writeFileSync(
        value.paths.payload,
        tarGz([
          { path: PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_['linux-x64'], bytes: launcher },
          { path: 'kite/bin/./kite', bytes: new TextEncoder().encode('attacker-launcher') },
        ]),
      );
      expect(() =>
        verifyProductionSupplyChainAdmission(value.input, dependencies(value, [])),
      ).toThrow(/archive_layout_mismatch/);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test('rejects an incomplete macOS app before native verifier execution', () => {
    const value = fixture('macos-arm64');
    const commands: string[][] = [];
    try {
      writeFileSync(
        value.paths.payload,
        tarGz([
          {
            path: PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_['macos-arm64'],
            bytes: new TextEncoder().encode('signed-launcher-bytes'),
          },
          {
            path: 'Kite.app/Contents/Info.plist',
            bytes: new TextEncoder().encode('<plist/>'),
          },
        ]),
      );
      expect(() =>
        verifyProductionSupplyChainAdmission(value.input, dependencies(value, commands)),
      ).toThrow(/archive_layout_mismatch/);
      expect(commands).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')(
    'verifies the extracted macOS leaf certificate and notarization policy separately',
    () => {
      const value = fixture('macos-arm64');
      try {
        const commands: string[][] = [];
        expect(() =>
          verifyProductionSupplyChainAdmission(value.input, dependencies(value, commands)),
        ).not.toThrow();
        expect(
          commands.filter((command) => command.includes('--extract-certificates')),
        ).toHaveLength(1);
        expect(commands.filter((command) => command.includes('--test-requirement'))).toHaveLength(
          1,
        );
        expect(commands.filter((command) => command.includes('--assess'))).toHaveLength(1);
        for (const command of commands.filter((entry) =>
          entry.some((argument) =>
            ['--test-requirement', '--extract-certificates', '--assess'].includes(argument),
          ),
        )) {
          expect(command.at(-1)).toContain('/archive-extraction/Kite.app');
          expect(command.at(-1)).not.toContain('/Contents/MacOS/kite');
        }
        expect(() =>
          verifyProductionSupplyChainAdmission(
            {
              ...value.input,
              nativeSigner: {
                ...value.input.nativeSigner,
                certificateSha256: 'F'.repeat(64),
              } as never,
            },
            dependencies(value, []),
          ),
        ).toThrow('leaf certificate digest');
        const base = dependencies(value, []);
        expect(() =>
          verifyProductionSupplyChainAdmission(value.input, {
            ...base,
            execute(command) {
              const result = base.execute(command);
              return command.includes('--assess')
                ? { ...result, stderr: 'source=Developer ID\norigin=local override' }
                : result;
            },
          }),
        ).toThrow('pinned notarized Developer ID origin');
      } finally {
        rmSync(value.root, { recursive: true, force: true });
      }
    },
  );
});
