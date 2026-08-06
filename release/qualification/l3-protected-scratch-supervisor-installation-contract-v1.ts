import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../scripts/release/canonical-json';
import {
  L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1,
  type L3ProtectedScratchSupervisorDeploymentV1,
} from './l3-protected-scratch-supervisor-v1';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const nativeOperationSchema = z.enum(['create', 'scrub', 'recover']);
const nativePropertySchema = z.enum([
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
const prohibitedSelectorSchema = z.enum([
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

const EXACT_NATIVE_OPERATIONS = ['create', 'scrub', 'recover'] as const;
const EXACT_NATIVE_PROPERTIES = [
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
] as const;
const EXACT_PROHIBITED_SELECTORS = [
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
] as const;

function hasExactValues<T extends string>(value: readonly T[], expected: readonly T[]): boolean {
  return (
    value.length === expected.length && value.every((entry, index) => entry === expected[index])
  );
}

function canonicalDigest(domain: string, value: unknown): `sha256:${string}` {
  return sha256DomainSeparated(domain, canonicalJsonBytes(value));
}

function deploymentDerivedInstallationSemantics(
  deployment: L3ProtectedScratchSupervisorDeploymentV1,
): Readonly<{
  serviceManager: 'systemd_system';
  servicePrincipal: 'root';
  linkPolicy: 'single_link_no_follow';
}> {
  return {
    serviceManager: deployment.platform.serviceManager,
    servicePrincipal: deployment.platform.servicePrincipal,
    linkPolicy: deployment.protectedObjects.linkPolicy,
  };
}

/**
 * This contract deliberately carries digests of the deployment-derived object
 * inventories, rather than a second unit file, manifest, root path, or bundle
 * inventory. It cannot install, start, or inspect a host service.
 */
const installationContractMaterialV1Schema = z
  .object({
    schema: z.literal('L3ProtectedScratchSupervisorInstallationContractV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    activationNotImplemented: z.literal(true),
    deploymentDigest: digestSchema,
    systemService: z
      .object({
        serviceManager: z.literal('systemd_system'),
        servicePrincipal: z.literal('root'),
        unitIdentityDigest: digestSchema,
        operatorActionOnly: z.literal(true),
        executableUnitMaterial: z.literal('not_representable'),
      })
      .strict(),
    immutableObjects: z
      .object({
        protectedObjectInventoryDigest: digestSchema,
        rootInventoryDigest: digestSchema,
        manifestRole: z.literal('root_only_checked_digest'),
        bundleRole: z.literal('immutable_checked_digest'),
        attestationKeyMaterial: z.literal('fingerprint_only'),
        linkPolicy: z.literal('single_link_no_follow'),
      })
      .strict(),
    nativeBoundary: z
      .object({
        operations: z.array(nativeOperationSchema),
        requiredProperties: z.array(nativePropertySchema),
        clientSelectedInputs: z.array(prohibitedSelectorSchema),
        internalFrame: z
          .object({
            transport: z.literal('root_supervisor_private_one_shot_channel_only'),
            ingress: z.literal('not_public'),
            authorization: z.literal('not_representable'),
            allocationIdentity: z.literal('root_journal_generated_l3_allocation_uuidv4'),
            lifecycleBinding: z.literal('root_verified_sha256_digest'),
            serviceEpoch: z.literal('root_verified_sha256_digest'),
            lease: z.literal('root_verified_sha256_digest'),
            journal: z.literal('root_verified_sha256_digest'),
            scratchHandle: z.literal('root_verified_sha256_digest'),
          })
          .strict(),
        hostInspection: z.literal('required_before_activation'),
        hostMutation: z.literal('not_implemented'),
        terminalFrame: z.literal('metadata_only'),
      })
      .strict(),
    isolation: z
      .object({
        workspaceAndSessionAccess: z.literal('native_denied_required'),
        childEnvironment: z.literal('fixed_allowlist_required'),
        providerSecretHandoff: z.literal('private_one_shot_channel_required'),
      })
      .strict(),
    releaseIsolationDigest: digestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedSemantics = deploymentDerivedInstallationSemantics(
      L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1,
    );
    const expectedDigests = deploymentDerivedInventoryDigests(
      L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1,
    );
    if (value.deploymentDigest !== L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1.deploymentDigest) {
      context.addIssue({
        code: 'custom',
        path: ['deploymentDigest'],
        message: 'installation contract must bind the exact protected deployment declaration',
      });
    }
    if (
      value.systemService.serviceManager !== expectedSemantics.serviceManager ||
      value.systemService.servicePrincipal !== expectedSemantics.servicePrincipal ||
      value.systemService.unitIdentityDigest !== expectedDigests.unitIdentityDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['systemService'],
        message: 'system-service semantics must be derived from the exact protected deployment',
      });
    }
    if (
      value.immutableObjects.linkPolicy !== expectedSemantics.linkPolicy ||
      value.immutableObjects.protectedObjectInventoryDigest !==
        expectedDigests.protectedObjectInventoryDigest ||
      value.immutableObjects.rootInventoryDigest !== expectedDigests.rootInventoryDigest ||
      value.releaseIsolationDigest !== expectedDigests.releaseIsolationDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['immutableObjects'],
        message: 'immutable-object and release-isolation semantics must be derived from deployment',
      });
    }
    if (!hasExactValues(value.nativeBoundary.operations, EXACT_NATIVE_OPERATIONS)) {
      context.addIssue({
        code: 'custom',
        path: ['nativeBoundary', 'operations'],
        message: 'installation contract must keep the exact native lifecycle operations',
      });
    }
    if (!hasExactValues(value.nativeBoundary.requiredProperties, EXACT_NATIVE_PROPERTIES)) {
      context.addIssue({
        code: 'custom',
        path: ['nativeBoundary', 'requiredProperties'],
        message: 'installation contract must keep the exact native verification properties',
      });
    }
    if (!hasExactValues(value.nativeBoundary.clientSelectedInputs, EXACT_PROHIBITED_SELECTORS)) {
      context.addIssue({
        code: 'custom',
        path: ['nativeBoundary', 'clientSelectedInputs'],
        message: 'installation contract must forbid the exact caller-selected inputs',
      });
    }
  });

export type L3ProtectedScratchSupervisorInstallationContractMaterialV1 = z.infer<
  typeof installationContractMaterialV1Schema
>;

export function computeL3ProtectedScratchSupervisorInstallationContractDigestV1(
  material: L3ProtectedScratchSupervisorInstallationContractMaterialV1,
): `sha256:${string}` {
  return canonicalDigest(
    'kite.qualification.l3-protected-scratch-supervisor-installation-contract.v1',
    installationContractMaterialV1Schema.parse(material),
  );
}

export const l3ProtectedScratchSupervisorInstallationContractV1Schema =
  installationContractMaterialV1Schema
    .extend({ installationContractDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { installationContractDigest, ...material } = value;
      const expected = computeL3ProtectedScratchSupervisorInstallationContractDigestV1(material);
      if (installationContractDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['installationContractDigest'],
          message: 'installation contract digest mismatch',
        });
      }
    });

export type L3ProtectedScratchSupervisorInstallationContractV1 = z.infer<
  typeof l3ProtectedScratchSupervisorInstallationContractV1Schema
>;

export function buildL3ProtectedScratchSupervisorInstallationContractV1(
  material: L3ProtectedScratchSupervisorInstallationContractMaterialV1,
): L3ProtectedScratchSupervisorInstallationContractV1 {
  const parsed = installationContractMaterialV1Schema.parse(material);
  return l3ProtectedScratchSupervisorInstallationContractV1Schema.parse({
    ...parsed,
    installationContractDigest:
      computeL3ProtectedScratchSupervisorInstallationContractDigestV1(parsed),
  });
}

function deploymentDerivedInventoryDigests(
  deployment: L3ProtectedScratchSupervisorDeploymentV1,
): Readonly<{
  unitIdentityDigest: `sha256:${string}`;
  protectedObjectInventoryDigest: `sha256:${string}`;
  rootInventoryDigest: `sha256:${string}`;
  releaseIsolationDigest: `sha256:${string}`;
}> {
  return {
    unitIdentityDigest: canonicalDigest(
      'kite.qualification.l3-protected-scratch-supervisor-system-service.v1',
      deployment.platform,
    ),
    protectedObjectInventoryDigest: canonicalDigest(
      'kite.qualification.l3-protected-scratch-supervisor-protected-objects.v1',
      deployment.protectedObjects,
    ),
    rootInventoryDigest: canonicalDigest(
      'kite.qualification.l3-protected-scratch-supervisor-roots.v1',
      deployment.roots,
    ),
    releaseIsolationDigest: canonicalDigest(
      'kite.qualification.l3-protected-scratch-supervisor-release-isolation.v1',
      deployment.releaseIsolation,
    ),
  };
}

const deploymentDerivedDigests = deploymentDerivedInventoryDigests(
  L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1,
);
const deploymentDerivedSemantics = deploymentDerivedInstallationSemantics(
  L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1,
);

/**
 * Source-owned, non-executable Linux installation and native-boundary contract.
 * It is intentionally not a unit, manifest, installer, host probe, or activation input.
 */
export const L3_PROTECTED_SCRATCH_SUPERVISOR_INSTALLATION_CONTRACT_V1 =
  buildL3ProtectedScratchSupervisorInstallationContractV1({
    schema: 'L3ProtectedScratchSupervisorInstallationContractV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    activationNotImplemented: true,
    deploymentDigest: L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1.deploymentDigest,
    systemService: {
      serviceManager: deploymentDerivedSemantics.serviceManager,
      servicePrincipal: deploymentDerivedSemantics.servicePrincipal,
      unitIdentityDigest: deploymentDerivedDigests.unitIdentityDigest,
      operatorActionOnly: true,
      executableUnitMaterial: 'not_representable',
    },
    immutableObjects: {
      protectedObjectInventoryDigest: deploymentDerivedDigests.protectedObjectInventoryDigest,
      rootInventoryDigest: deploymentDerivedDigests.rootInventoryDigest,
      manifestRole: 'root_only_checked_digest',
      bundleRole: 'immutable_checked_digest',
      attestationKeyMaterial: 'fingerprint_only',
      linkPolicy: deploymentDerivedSemantics.linkPolicy,
    },
    nativeBoundary: {
      operations: [...EXACT_NATIVE_OPERATIONS],
      requiredProperties: [...EXACT_NATIVE_PROPERTIES],
      clientSelectedInputs: [...EXACT_PROHIBITED_SELECTORS],
      internalFrame: {
        transport: 'root_supervisor_private_one_shot_channel_only',
        ingress: 'not_public',
        authorization: 'not_representable',
        allocationIdentity: 'root_journal_generated_l3_allocation_uuidv4',
        lifecycleBinding: 'root_verified_sha256_digest',
        serviceEpoch: 'root_verified_sha256_digest',
        lease: 'root_verified_sha256_digest',
        journal: 'root_verified_sha256_digest',
        scratchHandle: 'root_verified_sha256_digest',
      },
      hostInspection: 'required_before_activation',
      hostMutation: 'not_implemented',
      terminalFrame: 'metadata_only',
    },
    isolation: {
      workspaceAndSessionAccess: 'native_denied_required',
      childEnvironment: 'fixed_allowlist_required',
      providerSecretHandoff: 'private_one_shot_channel_required',
    },
    releaseIsolationDigest: deploymentDerivedDigests.releaseIsolationDigest,
  });

/** Future privileged code may only accept this exact source-owned contract. */
export function assertExactL3ProtectedScratchSupervisorInstallationContractV1(
  value: unknown,
): L3ProtectedScratchSupervisorInstallationContractV1 {
  const parsed = l3ProtectedScratchSupervisorInstallationContractV1Schema.parse(value);
  if (
    parsed.installationContractDigest !==
    L3_PROTECTED_SCRATCH_SUPERVISOR_INSTALLATION_CONTRACT_V1.installationContractDigest
  ) {
    throw new Error('l3_protected_scratch_supervisor_installation_contract_not_source_owned');
  }
  return parsed;
}
