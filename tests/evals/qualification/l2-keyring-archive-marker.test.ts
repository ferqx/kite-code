import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildL2NativeCandidateIdentityV1 } from '../../../scripts/evals/contracts/qualification/l2-native-candidate-identity-v1';
import { verifyL2NativeCandidateStandaloneKeyringMarkerV1 } from '../../../scripts/evals/contracts/qualification/l2-native-conformance-adapter-v1';
import { L2_NATIVE_CONFORMANCE_TARGETS_V1 } from '../../../scripts/evals/contracts/qualification/l2-native-conformance-schema-v1';
import {
  ossCandidateManifestV1Schema,
  verifyOssCandidate,
  writeOssCandidateArchive,
} from '../../../scripts/release/oss-candidate';
import { STANDALONE_KEYRING_UNAVAILABLE_MARKER_V1 } from '../../../src/app/release/standalone-keyring-unavailable';

function digest(character: string): `sha256:${string}` {
  return ('sha256:' + character.repeat(64)) as `sha256:${string}`;
}

function rawDigest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function verifiedCandidateFixture() {
  const target = L2_NATIVE_CONFORMANCE_TARGETS_V1[0]!;
  const root = mkdtempSync(join(tmpdir(), 'kite-l2-keyring-archive-'));
  const archivePath = join(root, 'candidate.tar.gz');
  const files = new Map<string, Uint8Array>([
    ['bin/kite', bytes(`binary:${STANDALONE_KEYRING_UNAVAILABLE_MARKER_V1}`)],
    ['bin/kite-tui', bytes(`binary:${STANDALONE_KEYRING_UNAVAILABLE_MARKER_V1}`)],
    ['docs/MAINTAINER_CHECKLIST.md', bytes('# Checklist\n')],
    ['docs/KNOWN_LIMITATIONS.md', bytes('# Limitations\n')],
    ['docs/RELEASE_NOTES.md', bytes('# Notes\n')],
  ]);
  const manifest = ossCandidateManifestV1Schema.parse({
    schema: 'KiteCodeOssCandidateManifestV1',
    version: 1,
    productVersion: '0.0.0-l2-marker',
    commitSha: 'a'.repeat(40),
    sourceDate: '2026-08-06T00:00:00.000Z',
    sourceDirty: false,
    bunVersion: Bun.version,
    target: {
      id: target.candidateTargetId,
      os: target.platform,
      arch: target.arch,
      compileMode: 'native',
    },
    integrity: 'sha256-only-unsigned',
    defaultCapabilities: {
      autoCompaction: 'off',
      effectfulCapabilities: 'off',
      remoteTelemetry: 'off',
    },
    files: [...files]
      .map(([path, value]) => ({ path, sha256: rawDigest(value), size: value.byteLength }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
  await writeOssCandidateArchive({ archivePath, manifest, files });
  const verifiedCandidate = await verifyOssCandidate(archivePath, target.candidateTargetId);
  const candidateValue = buildL2NativeCandidateIdentityV1({
    target,
    artifact: {
      canonicalRepository: 'ferqx/kite-code',
      repositoryId: '1218896626',
      commit: verifiedCandidate.manifest.commitSha,
      payloadSha256: verifiedCandidate.archiveSha256,
      canonicalManifestDigest: verifiedCandidate.manifestSha256,
      behaviorDigest: digest('3'),
      profileDigest: digest('4'),
      gatePolicyDigest: digest('5'),
    },
  });
  return { root, candidate: candidateValue, verifiedCandidate };
}

describe('AQ-7 verified candidate archive keyring marker adapter', () => {
  test('scans both real verified native archive binaries and returns only the candidate-bound marker digest', async () => {
    const fixture = await verifiedCandidateFixture();
    try {
      const markerDigest = verifyL2NativeCandidateStandaloneKeyringMarkerV1({
        candidate: fixture.candidate,
        verifiedCandidate: fixture.verifiedCandidate,
      });

      expect(markerDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(markerDigest).not.toContain('candidate.tar.gz');
      expect(markerDigest).not.toContain('standalone-keyring');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('rejects archive/manifest/target identity splices and a marker missing from either executable', async () => {
    const fixture = await verifiedCandidateFixture();
    try {
      const verified = fixture.verifiedCandidate;
      const cliPath = 'bin/kite';
      const mutations: unknown[] = [
        { ...verified, archiveSha256: digest('0') },
        { ...verified, manifestSha256: digest('0') },
        { ...verified, manifest: { ...verified.manifest, commitSha: 'b'.repeat(40) } },
        {
          ...verified,
          manifest: {
            ...verified.manifest,
            target: { ...verified.manifest.target, id: 'linux-x64', os: 'linux', arch: 'x64' },
          },
        },
        {
          ...verified,
          files: new Map([
            [cliPath, new TextEncoder().encode('candidate without marker')],
            ['bin/kite-tui', verified.files.get('bin/kite-tui')!],
          ]),
        },
        {
          ...verified,
          files: new Map([[cliPath, verified.files.get(cliPath)!]]),
        },
      ];
      for (const mutated of mutations) {
        expect(() =>
          verifyL2NativeCandidateStandaloneKeyringMarkerV1({
            candidate: fixture.candidate,
            verifiedCandidate: mutated,
          }),
        ).toThrow();
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
