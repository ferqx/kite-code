import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  assertExactL3ProtectedScratchSupervisorInstallationContractV1,
  buildL3ProtectedScratchSupervisorInstallationContractV1,
  computeL3ProtectedScratchSupervisorInstallationContractDigestV1,
  L3_PROTECTED_SCRATCH_SUPERVISOR_INSTALLATION_CONTRACT_V1,
  l3ProtectedScratchSupervisorInstallationContractV1Schema,
} from '../../../release/qualification/l3-protected-scratch-supervisor-installation-contract-v1';
import { L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1 } from '../../../release/qualification/l3-protected-scratch-supervisor-v1';
import { liveScratchSupervisorActivationIsImplementedV1 } from '../../../scripts/evals/qualification/live-scratch-supervisor-health-v1';

const CONTRACT_SOURCE_URL = new URL(
  '../../../release/qualification/l3-protected-scratch-supervisor-installation-contract-v1.ts',
  import.meta.url,
);

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)]);
}

describe('L3 protected scratch supervisor installation contract', () => {
  test('is deployment-derived, diagnostic-only, and explicitly not an activation mechanism', () => {
    const contract = L3_PROTECTED_SCRATCH_SUPERVISOR_INSTALLATION_CONTRACT_V1;
    expect(contract).toMatchObject({
      schema: 'L3ProtectedScratchSupervisorInstallationContractV1',
      version: 1,
      authority: 'diagnostic',
      evidenceEligible: false,
      activationNotImplemented: true,
      deploymentDigest: L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1.deploymentDigest,
      systemService: {
        serviceManager: 'systemd_system',
        servicePrincipal: 'root',
        operatorActionOnly: true,
        executableUnitMaterial: 'not_representable',
      },
      immutableObjects: {
        manifestRole: 'root_only_checked_digest',
        bundleRole: 'immutable_checked_digest',
        attestationKeyMaterial: 'fingerprint_only',
        linkPolicy: 'single_link_no_follow',
      },
      nativeBoundary: {
        operations: ['create', 'scrub', 'recover'],
        internalFrame: {
          transport: 'root_supervisor_private_one_shot_channel_only',
          ingress: 'not_public',
          authorization: 'not_representable',
          allocationIdentity: 'root_journal_generated_l3_allocation_uuidv4',
        },
        hostInspection: 'required_before_activation',
        hostMutation: 'not_implemented',
        terminalFrame: 'metadata_only',
      },
    });
    expect(liveScratchSupervisorActivationIsImplementedV1()).toBe(false);
    expect(l3ProtectedScratchSupervisorInstallationContractV1Schema.parse(contract)).toEqual(
      contract,
    );
    expect(assertExactL3ProtectedScratchSupervisorInstallationContractV1(contract)).toEqual(
      contract,
    );
  });

  test('requires fixed native lifecycle, caller-input refusal, and exact source ownership', () => {
    const { installationContractDigest: _installationContractDigest, ...material } =
      L3_PROTECTED_SCRATCH_SUPERVISOR_INSTALLATION_CONTRACT_V1;
    expect(computeL3ProtectedScratchSupervisorInstallationContractDigestV1(material)).toBe(
      L3_PROTECTED_SCRATCH_SUPERVISOR_INSTALLATION_CONTRACT_V1.installationContractDigest as `sha256:${string}`,
    );
    expect(material.nativeBoundary.requiredProperties).toEqual([
      'fixed_parent_fd_derivation',
      'openat_no_follow',
      'unlinkat_no_follow',
      'fsync_each_transition',
      'mount_and_inode_identity',
      'worker_containment_and_reaping',
      'peer_credential_authorization',
      'normal_exit_deletion_deadline',
      'crash_recovery_deletion_deadline',
      'owner_only_terminal_projection',
    ]);
    expect(material.nativeBoundary.clientSelectedInputs).toEqual([
      'caller_path',
      'caller_command',
      'caller_file_descriptor',
      'caller_ref',
      'caller_sha',
      'caller_fixture',
      'caller_route',
      'caller_credential',
      'caller_environment_file',
      'caller_workspace_or_session',
    ]);
    expect(() =>
      l3ProtectedScratchSupervisorInstallationContractV1Schema.parse({
        ...L3_PROTECTED_SCRATCH_SUPERVISOR_INSTALLATION_CONTRACT_V1,
        nativeBoundary: {
          ...L3_PROTECTED_SCRATCH_SUPERVISOR_INSTALLATION_CONTRACT_V1.nativeBoundary,
          operations: ['create', 'recover'],
        },
      }),
    ).toThrow();

    expect(() =>
      buildL3ProtectedScratchSupervisorInstallationContractV1({
        ...material,
        immutableObjects: {
          ...material.immutableObjects,
          protectedObjectInventoryDigest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      }),
    ).toThrow();
  });

  test('has no content-bearing or caller-selected host-object surface', () => {
    const keys = collectKeys(L3_PROTECTED_SCRATCH_SUPERVISOR_INSTALLATION_CONTRACT_V1);
    expect(keys).not.toEqual(
      expect.arrayContaining([
        'apiKey',
        'credential',
        'endpoint',
        'prompt',
        'response',
        'reasoning',
        'command',
        'path',
        'fileDescriptor',
        'fixture',
        'workspace',
        'session',
      ]),
    );
    expect(JSON.stringify(L3_PROTECTED_SCRATCH_SUPERVISOR_INSTALLATION_CONTRACT_V1)).not.toMatch(
      /(?:\/Users\/|\\\\Users\\\\|https?:\/\/|sk-[a-z0-9_-]{8,}|AKIA[0-9A-Z]{16})/u,
    );
  });

  test('is declarative only and contains no host-control, service-control, or release ingress', () => {
    const source = readFileSync(CONTRACT_SOURCE_URL, 'utf8');
    expect(source).not.toMatch(
      /node:(?:child_process|cluster|dgram|fs|http|https|net|os|tls)|\bBun\.(?:connect|serve|spawn)\b|\bprocess\.(?:env|getuid|kill)\b/u,
    );
    expect(source).not.toMatch(
      /\b(?:exec|spawn)(?:Sync)?\s*\(|systemctl|sudo\s|pkexec|curl\s|fetch\(/u,
    );
    expect(source).not.toMatch(
      /NativeHelperRequestV1|nativeHelperRequestDigest|public.*admission/iu,
    );
    expect(source).not.toMatch(/ReleaseEvidenceV1|\bG[0-5]\b|gate-evaluator|release-bundle/u);
  });
});
