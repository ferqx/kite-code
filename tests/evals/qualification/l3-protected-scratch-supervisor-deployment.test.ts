import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  assertExactL3ProtectedScratchSupervisorDeploymentV1,
  buildL3ProtectedScratchSupervisorDeploymentV1,
  computeL3ProtectedScratchSupervisorDeploymentDigestV1,
  L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1,
  l3ProtectedScratchSupervisorDeploymentV1Schema,
} from '../../../release/qualification/l3-protected-scratch-supervisor-v1';

const DECLARATION_SOURCE_URL = new URL(
  '../../../release/qualification/l3-protected-scratch-supervisor-v1.ts',
  import.meta.url,
);

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)]);
}

describe('L3 protected scratch supervisor deployment declaration', () => {
  test('is a fixed Linux root-systemd, tmpfs-scratch, diagnostic-only declaration', () => {
    expect(L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1).toMatchObject({
      schema: 'L3ProtectedScratchSupervisorDeploymentV1',
      version: 1,
      authority: 'diagnostic',
      evidenceEligible: false,
      platform: {
        kernel: 'linux',
        serviceManager: 'systemd_system',
        servicePrincipal: 'root',
        unitName: 'kite-qualification-l3-supervisor.service',
      },
      roots: {
        scratch: {
          path: '/run/kite-qualification-l3/scratch',
          storage: 'tmpfs',
          ownership: 'root_only',
          allocator: 'supervisor_only',
        },
        control: {
          path: '/run/kite-qualification-l3/control',
          storage: 'tmpfs',
          ownership: 'root_only',
        },
        recoveryIndex: {
          path: '/var/lib/kite-qualification-l3/recovery-index',
          storage: 'local_disk_encrypted',
          ownership: 'root_only',
          projection: 'owner_only_metadata_receipt_only',
          audit: 'root_append_only_metadata_audit',
          maxAgeSeconds: 7_776_000,
          deleteTrigger: 'root_janitor_after_retention',
          directExternalization: 'forbidden',
        },
      },
    });
    expect(
      l3ProtectedScratchSupervisorDeploymentV1Schema.parse(
        L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1,
      ),
    ).toEqual(L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1);
    expect(
      assertExactL3ProtectedScratchSupervisorDeploymentV1(
        L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1,
      ),
    ).toEqual(L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1);
  });

  test('forbids automatic privileged deployment, caller-selected execution, and release integration', () => {
    expect(L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1.operations).toEqual({
      repositoryOrCliSudo: 'forbidden',
      automaticInstall: 'forbidden',
      automaticStartStopReload: 'forbidden',
      automaticSecretCiDispatch: 'forbidden',
      hostOperatorAction: 'explicit_only',
    });
    expect(L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1.controlPlane).toMatchObject({
      peerCredential: 'linux_so_peercred',
      maintainerAuthorization: 'root_manifest_allowlist_only',
      callerSelectedSocketOrPath: 'forbidden',
      callerSelectedCommandOrEntrypoint: 'forbidden',
      callerSelectedRefOrSha: 'forbidden',
      callerSelectedFixtureOrRoute: 'forbidden',
      workerExecution: 'immutable_bundle_only',
      childEnvironment: 'fixed_allowlist_only',
      workspaceOrSessionAccess: 'native_denied',
      workerOutput: 'metadata_only_terminal_frame',
    });
    expect(L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1.releaseIsolation).toEqual({
      releaseEvidenceInput: 'forbidden',
      releaseBundleInput: 'forbidden',
      releaseGateInput: 'forbidden',
    });
  });

  test('has a canonical digest, exact no-content inventory, and rejects a valid-shape source drift', () => {
    const { deploymentDigest: _deploymentDigest, ...material } =
      L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1;
    expect(computeL3ProtectedScratchSupervisorDeploymentDigestV1(material)).toBe(
      L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1.deploymentDigest as `sha256:${string}`,
    );
    expect(material.nonRepresentableData).toEqual([
      'provider_key_material',
      'provider_origin',
      'prompt_content',
      'response_content',
      'reasoning_content',
      'source_content',
      'workspace_content',
      'session_content',
      'child_output',
    ]);
    expect(collectKeys(L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1)).not.toEqual(
      expect.arrayContaining([
        'apiKey',
        'credential',
        'endpoint',
        'prompt',
        'response',
        'reasoning',
        'command',
      ]),
    );

    const otherDescriptor = buildL3ProtectedScratchSupervisorDeploymentV1({
      ...material,
      deploymentId: 'qualification-l3-untrusted-supervisor-v1',
    });
    expect(() => assertExactL3ProtectedScratchSupervisorDeploymentV1(otherDescriptor)).toThrow(
      'l3_protected_scratch_supervisor_deployment_not_source_owned',
    );
  });

  test('is declarative only: it imports no host-control or provider runtime APIs', () => {
    const source = readFileSync(DECLARATION_SOURCE_URL, 'utf8');
    expect(source).not.toMatch(
      /node:(?:child_process|cluster|dgram|fs|http|https|net|tls)|\bBun\.(?:connect|serve|spawn)\b|\bprocess\.(?:env|getuid|kill)\b/u,
    );
    expect(source).not.toMatch(/(?:systemctl|sudo\s|pkexec|curl\s|fetch\()/u);
    expect(source).not.toMatch(/ReleaseEvidenceV1|\bG[0-5]\b|gate-evaluator|release-bundle/u);
  });
});
