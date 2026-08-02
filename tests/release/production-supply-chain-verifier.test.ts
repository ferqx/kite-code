import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../scripts/release/canonical-json';
import {
  buildCosignKeylessBlobVerificationCommandV1,
  buildGithubArtifactAttestationVerificationCommandV1,
  buildPlatformSignatureVerificationCommandsV1,
  PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_V1,
  PRODUCTION_RELEASE_REPOSITORY,
  PRODUCTION_RELEASE_REPOSITORY_NODE_ID,
  PRODUCTION_RELEASE_REPOSITORY_NUMERIC_ID,
  PRODUCTION_RELEASE_WORKFLOW_PATH,
  type ProductionArtifactPlatformV1,
  type ProductionReleaseExpectedIdentityV1,
  productionReleaseCertificateIdentityV1,
  productionReleaseRunInvocationUriV1,
} from '../../scripts/release/production-supply-chain-commands';
import {
  isProtectedWindowsToolPathV1,
  PRODUCTION_SUPPLY_CHAIN_ADMISSION_ENABLED,
  type ProductionSupplyChainCliInputV1,
  ProductionSupplyChainVerificationError,
  parseProductionSupplyChainCliInputV1,
  verifyProductionSupplyChainAdmissionV1,
} from '../../scripts/release/verify-production-supply-chain';

const COMMIT = '1'.repeat(40);
const WORKFLOW_SHA = '2'.repeat(40);
const TRUSTED_VERIFIER_COMMIT = '3'.repeat(40);
const REVIEWER = 'github:@independent-reviewer';

function identity(): ProductionReleaseExpectedIdentityV1 {
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

function fixture(platform: ProductionArtifactPlatformV1 = 'linux-x64') {
  const root = mkdtempSync(join(tmpdir(), 'kite-production-supply-chain-'));
  const paths = {
    payload: join(root, `kite-${platform}.tar.gz`),
    nativeLauncher: join(root, 'kite'),
    manifest: join(root, 'manifest.json'),
    sbom: join(root, 'sbom.spdx.json'),
    provenance: join(root, 'provenance.json'),
    sigstoreBundle: join(root, 'manifest.sigstore.json'),
    githubAttestationBundle: join(root, 'attestations.jsonl'),
    gateDecision: join(root, 'gate.json'),
    securityReviewEvidence: join(root, 'security-review.json'),
    securityReviewBundle: join(root, 'security-review.sigstore.json'),
    securityReviewerPublicKey: join(root, 'security-reviewer.pub'),
    platformSignatureBundle: join(root, 'launcher.sigstore.json'),
  };
  const launcher = new TextEncoder().encode('signed-launcher-bytes');
  writeFileSync(paths.nativeLauncher, launcher, { mode: 0o700 });
  const payload = tarGz([
    {
      path: PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_V1[platform],
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
    providerDataPolicyDigest: sha256('provider-policy'),
    releaseGatePolicyDigest: sha256('gate-policy'),
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
  writeFileSync(paths.securityReviewBundle, '{"bundle":true}');
  writeFileSync(paths.securityReviewerPublicKey, 'independent-public-key');
  const securityReview = {
    schema: 'IndependentSecurityReviewEvidenceV1',
    reviewerIdentity: REVIEWER,
    independentFromMaintainer: true,
    reviewedAt: '2026-08-02T01:00:00.000Z',
    outcome: 'passed',
    repository: PRODUCTION_RELEASE_REPOSITORY,
    ref: identity().ref,
    commit: COMMIT,
    trustedVerifierCommit: TRUSTED_VERIFIER_COMMIT,
    payloadSha256: sha256(payload),
    nativeLauncherSha256: sha256(launcher),
    canonicalManifestDigest: sha256(canonicalJsonBytes(manifest)),
    scope: [
      'architecture',
      'security_boundaries',
      'artifact_identity',
      'rollback',
      'adversarial_bypass',
    ],
  };
  writeFileSync(paths.securityReviewEvidence, JSON.stringify(securityReview));
  const gateMaterial = {
    schema: 'ReleaseGateDecisionV1' as const,
    overall: 'approved_candidate' as const,
    artifactIdentity: {
      canonicalRepository: PRODUCTION_RELEASE_REPOSITORY,
      repositoryId: PRODUCTION_RELEASE_REPOSITORY_NODE_ID,
      commit: COMMIT,
      trustedVerifierCommit: TRUSTED_VERIFIER_COMMIT,
      payloadSha256: sha256(payload),
      nativeLauncherSha256: sha256(launcher),
      nativeLauncherArchivePath: PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_V1[platform],
      canonicalManifestDigest: sha256(canonicalJsonBytes(manifest)),
      securityReviewEvidenceDigest: sha256(JSON.stringify(securityReview)),
    },
    gates: (['G0', 'G1', 'G2', 'G3', 'G4', 'G5'] as const).map((gate) => ({
      gate,
      status: 'passed' as const,
      reasons: [],
    })),
    capabilities: [
      { capability: 'builtin_read_tools', status: 'enabled', reasons: [] },
      { capability: 'shell', status: 'disabled', reasons: ['execution_support_unavailable'] },
    ],
    requiredManualApprovals: [],
  };
  const gateDecisionDigest = sha256DomainSeparated(
    'release-gate-decision-v1',
    canonicalJsonBytes(gateMaterial),
  );
  writeFileSync(
    paths.gateDecision,
    JSON.stringify({ ...gateMaterial, decisionDigest: gateDecisionDigest }),
  );
  const toolPaths =
    process.platform === 'win32'
      ? {
          gh: 'C:\\Program Files\\GitHub CLI\\gh.exe',
          cosign: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          codesign: 'C:\\Program Files\\GitHub CLI\\gh.exe',
          spctl: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
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
  const input: ProductionSupplyChainCliInputV1 = {
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
    expectedSecurityReviewerIdentity: REVIEWER,
    expectedSecurityReviewerPublicKeySha256: sha256('independent-public-key'),
    expectedGateDecisionDigest: gateDecisionDigest,
  };
  return { root, paths, input, toolPaths };
}

function attestationOutput(input: {
  expected: ProductionReleaseExpectedIdentityV1;
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
    san: productionReleaseCertificateIdentityV1(input.expected),
    runInvocation: productionReleaseRunInvocationUriV1(input.expected),
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
    expect(isProtectedWindowsToolPathV1('C:\\Program Files\\GitHub CLI\\gh.exe')).toBe(true);
    expect(isProtectedWindowsToolPathV1('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(true);
    expect(isProtectedWindowsToolPathV1('C:\\Program Files\\Kite Verifiers\\cosign.exe')).toBe(
      true,
    );
    expect(isProtectedWindowsToolPathV1('D:\\Program Files\\evil\\evil.exe')).toBe(false);
    expect(isProtectedWindowsToolPathV1('C:\\Program Files\\evil\\evil.exe')).toBe(false);
    expect(
      isProtectedWindowsToolPathV1(
        'C:\\Program Files\\PowerShell\\7\\..\\..\\..\\Users\\runneradmin\\pwsh.exe',
      ),
    ).toBe(false);
  });

  test('pins keyless and GitHub verification to expected CLI identity', () => {
    const expected = identity();
    expect(
      buildCosignKeylessBlobVerificationCommandV1({
        cosignPath: '/usr/bin/cosign',
        subjectPath: '/release/manifest.json',
        bundlePath: '/release/manifest.sigstore.json',
        expected,
      }),
    ).toContain(productionReleaseCertificateIdentityV1(expected));
    const github = buildGithubArtifactAttestationVerificationCommandV1({
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
    const mac = buildPlatformSignatureVerificationCommandsV1({
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

    const windows = buildPlatformSignatureVerificationCommandsV1({
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

  test('accepts expected identity only from explicit CLI/env and rejects branch or maintainer review', () => {
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
        KITE_RELEASE_GATE_DECISION: value.paths.gateDecision,
        KITE_RELEASE_SECURITY_REVIEW_EVIDENCE: value.paths.securityReviewEvidence,
        KITE_RELEASE_SECURITY_REVIEW_BUNDLE: value.paths.securityReviewBundle,
        KITE_RELEASE_SECURITY_REVIEWER_PUBLIC_KEY: value.paths.securityReviewerPublicKey,
        KITE_RELEASE_SECURITY_REVIEWER_PUBLIC_KEY_SHA256:
          value.input.expectedSecurityReviewerPublicKeySha256,
        KITE_RELEASE_SECURITY_REVIEWER_IDENTITY: REVIEWER,
        KITE_RELEASE_GH_PATH: value.toolPaths.gh,
        KITE_RELEASE_GH_SHA256: value.input.tools.gh.sha256,
        KITE_RELEASE_COSIGN_PATH: value.toolPaths.cosign,
        KITE_RELEASE_COSIGN_SHA256: value.input.tools.cosign.sha256,
        KITE_RELEASE_GATE_DECISION_DIGEST: value.input.expectedGateDecisionDigest,
      };
      expect(parseProductionSupplyChainCliInputV1([], env).expected).toEqual(expected);
      expect(() =>
        parseProductionSupplyChainCliInputV1([], {
          ...env,
          KITE_RELEASE_REF: 'refs/heads/main',
        }),
      ).toThrow(ProductionSupplyChainVerificationError);
      expect(() =>
        parseProductionSupplyChainCliInputV1([], {
          ...env,
          KITE_RELEASE_SECURITY_REVIEWER_IDENTITY: 'github:@ferqx',
        }),
      ).toThrow(/independent/);
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
  test('verifies five immutable subjects and remains non-admitting', () => {
    const value = fixture();
    const commands: string[][] = [];
    try {
      const result = verifyProductionSupplyChainAdmissionV1(
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
          independentSecurityReview: 'verified',
          pinnedToolchain: 'verified',
          platformSignature: 'verified',
          releaseGate: 'verified',
        },
      });
      expect(commands.filter((command) => command.includes('attestation'))).toHaveLength(5);
      expect(commands.filter((command) => command.includes('verify-blob'))).toHaveLength(3);
      expect(commands.flat().join(' ')).toContain('/nativeLauncher/kite');
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
        verifyProductionSupplyChainAdmissionV1(
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
        verifyProductionSupplyChainAdmissionV1(
          {
            ...value.input,
            expected: { ...value.input.expected, trustedVerifierCommit: '4'.repeat(40) },
          },
          base,
        ),
      ).toThrow(/security_review_unverified/);
      expect(() =>
        verifyProductionSupplyChainAdmissionV1(
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
      expect(() => verifyProductionSupplyChainAdmissionV1(value.input, base)).toThrow(
        /gate_not_approved/,
      );
      writeFileSync(value.paths.gateDecision, JSON.stringify(gate));

      writeFileSync(value.paths.nativeLauncher, 'different-launcher');
      expect(() => verifyProductionSupplyChainAdmissionV1(value.input, base)).toThrow(
        /archive_layout_mismatch/,
      );
      writeFileSync(value.paths.nativeLauncher, 'signed-launcher-bytes');

      expect(() =>
        verifyProductionSupplyChainAdmissionV1(value.input, {
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

  test('rejects hard-link role aliases before any verifier command runs', () => {
    const value = fixture();
    try {
      rmSync(value.paths.provenance);
      linkSync(value.paths.sbom, value.paths.provenance);
      const commands: string[][] = [];
      expect(() =>
        verifyProductionSupplyChainAdmissionV1(value.input, dependencies(value, commands)),
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
        verifyProductionSupplyChainAdmissionV1(
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
          { path: PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_V1['linux-x64'], bytes: launcher },
          { path: 'pax-header', bytes: new TextEncoder().encode('path=kite/bin/kite'), type: 'x' },
        ]),
      );
      expect(() =>
        verifyProductionSupplyChainAdmissionV1(value.input, dependencies(value, [])),
      ).toThrow(/archive_layout_mismatch/);

      writeFileSync(
        value.paths.payload,
        tarGz([
          { path: PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_V1['linux-x64'], bytes: launcher },
          { path: 'kite/bin//', type: '5' },
        ]),
      );
      expect(() =>
        verifyProductionSupplyChainAdmissionV1(value.input, dependencies(value, [])),
      ).toThrow(/archive_layout_mismatch/);

      writeFileSync(
        value.paths.payload,
        tarGz([
          { path: PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_V1['linux-x64'], bytes: launcher },
          { path: 'kite/bin/./kite', bytes: new TextEncoder().encode('attacker-launcher') },
        ]),
      );
      expect(() =>
        verifyProductionSupplyChainAdmissionV1(value.input, dependencies(value, [])),
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
            path: PRODUCTION_NATIVE_LAUNCHER_ARCHIVE_PATH_V1['macos-arm64'],
            bytes: new TextEncoder().encode('signed-launcher-bytes'),
          },
          {
            path: 'Kite.app/Contents/Info.plist',
            bytes: new TextEncoder().encode('<plist/>'),
          },
        ]),
      );
      expect(() =>
        verifyProductionSupplyChainAdmissionV1(value.input, dependencies(value, commands)),
      ).toThrow(/archive_layout_mismatch/);
      expect(commands).toEqual([]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test('verifies the extracted macOS leaf certificate and notarization policy separately', () => {
    const value = fixture('macos-arm64');
    try {
      const commands: string[][] = [];
      expect(() =>
        verifyProductionSupplyChainAdmissionV1(value.input, dependencies(value, commands)),
      ).not.toThrow();
      expect(commands.filter((command) => command.includes('--extract-certificates'))).toHaveLength(
        1,
      );
      expect(commands.filter((command) => command.includes('--test-requirement'))).toHaveLength(1);
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
        verifyProductionSupplyChainAdmissionV1(
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
        verifyProductionSupplyChainAdmissionV1(value.input, {
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
  });
});
