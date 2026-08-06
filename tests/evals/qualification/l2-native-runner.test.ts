import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { L2_NATIVE_CONFORMANCE_TARGETS_V1 } from '../../../scripts/evals/contracts/qualification/l2-native-conformance-schema-v1';
import { parseL2NativeConformanceBlockedWorkerTransportV1 } from '../../../scripts/evals/contracts/qualification/l2-native-conformance-worker-record-v1';
import {
  L2_NATIVE_CONFORMANCE_WORKER_OUTPUT_NAME_V1,
  runL2NativeConformanceGovernancePreflightV1,
} from '../../../scripts/evals/qualification/run-l2-native-conformance';
import { canonicalJsonBytes } from '../../../scripts/release/canonical-json';

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), 'kite-l2-native-runner-'));
}

function preflightArgs(targetId = L2_NATIVE_CONFORMANCE_TARGETS_V1[0]!.distributionTargetId) {
  return [
    '--worker-output',
    L2_NATIVE_CONFORMANCE_WORKER_OUTPUT_NAME_V1,
    '--distribution-target',
    targetId,
    '--governance-preflight-only',
  ];
}

describe('AQ-7 sealed native-conformance governance preflight runner', () => {
  test('writes only the fixed metadata-only blocked transport before any native dispatch', () => {
    const root = temporaryRoot();
    try {
      const result = runL2NativeConformanceGovernancePreflightV1({
        argv: preflightArgs(),
        workingDirectory: root,
      });
      expect(result.outputPath).toBe(resolve(root, L2_NATIVE_CONFORMANCE_WORKER_OUTPUT_NAME_V1));
      const persisted = parseL2NativeConformanceBlockedWorkerTransportV1(
        JSON.parse(readFileSync(result.outputPath, 'utf8')),
      );
      expect(persisted).toEqual(result.transport);
      expect(persisted).toMatchObject({
        authority: 'diagnostic',
        evidenceEligible: false,
        governancePreflight: 'unavailable',
        reasonCode: 'protected_ci_governance_control_plane_unavailable',
      });
      for (const forbiddenField of [
        'candidate',
        'execution',
        'observations',
        'probe',
        'receipt',
        'report',
        'retainedArtifactDigest',
      ]) {
        expect(Object.keys(persisted)).not.toContain(forbiddenField);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires the exact preflight-only command shape and never accepts candidate or probe inputs', () => {
    const root = temporaryRoot();
    try {
      expect(() =>
        runL2NativeConformanceGovernancePreflightV1({
          argv: [
            '--worker-output',
            L2_NATIVE_CONFORMANCE_WORKER_OUTPUT_NAME_V1,
            '--candidate',
            'untrusted.tar.gz',
            '--governance-preflight-only',
          ],
          workingDirectory: root,
        }),
      ).toThrow('l2_native_runner_invalid_arguments');
      expect(() =>
        runL2NativeConformanceGovernancePreflightV1({
          argv: [
            '--worker-output',
            L2_NATIVE_CONFORMANCE_WORKER_OUTPUT_NAME_V1,
            '--distribution-target',
            L2_NATIVE_CONFORMANCE_TARGETS_V1[0]!.distributionTargetId,
            '--probe',
          ],
          workingDirectory: root,
        }),
      ).toThrow('l2_native_runner_preflight_mode_required');
      expect(() =>
        runL2NativeConformanceGovernancePreflightV1({
          argv: [
            '--worker-output',
            '../outside.json',
            '--distribution-target',
            L2_NATIVE_CONFORMANCE_TARGETS_V1[0]!.distributionTargetId,
            '--governance-preflight-only',
          ],
          workingDirectory: root,
        }),
      ).toThrow('l2_native_runner_invalid_worker_output');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails without logging a filesystem exception or overwriting an existing worker record', () => {
    const root = temporaryRoot();
    try {
      const output = join(root, L2_NATIVE_CONFORMANCE_WORKER_OUTPUT_NAME_V1);
      writeFileSync(output, 'existing-metadata');
      expect(() =>
        runL2NativeConformanceGovernancePreflightV1({
          argv: preflightArgs(),
          workingDirectory: root,
        }),
      ).toThrow('l2_native_runner_worker_output_exists');
      expect(readFileSync(output, 'utf8')).toBe('existing-metadata');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('CLI emits one canonical blocked transport and no stderr', async () => {
    const root = temporaryRoot();
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          resolve('scripts/evals/qualification/run-l2-native-conformance.ts'),
          ...preflightArgs(),
        ],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      const transport = parseL2NativeConformanceBlockedWorkerTransportV1(JSON.parse(stdout));
      expect(stdout).toBe(`${new TextDecoder().decode(canonicalJsonBytes(transport))}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('contains no child dispatch, candidate/probe reader, ordinary config lookup, or credential source', () => {
    const source = readFileSync(
      resolve('scripts/evals/qualification/run-l2-native-conformance.ts'),
      'utf8',
    );
    for (const forbiddenFragment of [
      'child_process',
      'Bun.spawn',
      'Bun.$',
      'verifyOssCandidate',
      'buildOssCandidate',
      'verifyL2NativeCandidateStandaloneKeyringMarkerV1',
      'platform-capability-probe',
      'verifyPlatformCapabilityEvidenceV1',
      'process.env',
      'loadProductionAgentConfig',
      'ReleaseEvidenceV1',
      'G0',
      'G1',
      'release bundle',
    ]) {
      expect(source).not.toContain(forbiddenFragment);
    }
  });
});
