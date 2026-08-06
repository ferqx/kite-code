import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../scripts/release/canonical-json';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DEPLOYMENT_ID = /^[a-z][a-z0-9._-]{0,127}$/;

const NON_REPRESENTABLE_DATA_V1 = [
  'provider_key_material',
  'provider_origin',
  'prompt_content',
  'response_content',
  'reasoning_content',
  'source_content',
  'workspace_content',
  'session_content',
  'child_output',
] as const;

const nonRepresentableDataV1Schema = z.enum(NON_REPRESENTABLE_DATA_V1);
const digestSchema = z.string().regex(DIGEST);

function hasExactInventory(values: readonly string[], expected: readonly string[]): boolean {
  return (
    values.length === expected.length && values.every((value, index) => value === expected[index])
  );
}

/**
 * This is a checked-in deployment declaration, not an installer, service
 * client, health witness, or activation signal. It intentionally imports no
 * filesystem, process, network, child-process, or provider code.
 *
 * The absolute locations below are protected service-object locations, never
 * evidence/report fields and never caller-provided paths. A future native
 * installer must validate this exact declaration before it changes any host
 * state; this module cannot perform that operation.
 */
const deploymentMaterialV1Schema = z
  .object({
    schema: z.literal('L3ProtectedScratchSupervisorDeploymentV1'),
    version: z.literal(1),
    deploymentId: z.string().regex(DEPLOYMENT_ID),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    platform: z
      .object({
        kernel: z.literal('linux'),
        serviceManager: z.literal('systemd_system'),
        servicePrincipal: z.literal('root'),
        unitName: z.literal('kite-qualification-l3-supervisor.service'),
      })
      .strict(),
    protectedObjects: z
      .object({
        installManifest: z.literal('/etc/kite-qualification-l3/install-manifest-v1.json'),
        daemonBundle: z.literal('/usr/lib/kite-qualification-l3/supervisor-v1'),
        workerBundle: z.literal('/usr/lib/kite-qualification-l3/worker-v1'),
        nativeCleanupHelper: z.literal('/usr/lib/kite-qualification-l3/cleanup-helper-v1'),
        attestationKey: z.literal('/var/lib/kite-qualification-l3/attestation.key'),
        ownership: z.literal('root_only'),
        linkPolicy: z.literal('single_link_no_follow'),
        mutationPolicy: z.literal('checked_manifest_digest_only'),
      })
      .strict(),
    roots: z
      .object({
        scratch: z
          .object({
            path: z.literal('/run/kite-qualification-l3/scratch'),
            storage: z.literal('tmpfs'),
            ownership: z.literal('root_only'),
            mode: z.literal('0700'),
            allocator: z.literal('supervisor_only'),
          })
          .strict(),
        control: z
          .object({
            path: z.literal('/run/kite-qualification-l3/control'),
            storage: z.literal('tmpfs'),
            ownership: z.literal('root_only'),
            mode: z.literal('0700'),
            controlSocket: z.literal('/run/kite-qualification-l3/control/supervisor.sock'),
          })
          .strict(),
        recoveryIndex: z
          .object({
            path: z.literal('/var/lib/kite-qualification-l3/recovery-index'),
            storage: z.literal('local_disk_encrypted'),
            ownership: z.literal('root_only'),
            mode: z.literal('0700'),
            writer: z.literal('supervisor_only'),
            projection: z.literal('owner_only_metadata_receipt_only'),
            audit: z.literal('root_append_only_metadata_audit'),
            maxAgeSeconds: z.literal(7_776_000),
            deleteTrigger: z.literal('root_janitor_after_retention'),
            directExternalization: z.literal('forbidden'),
          })
          .strict(),
      })
      .strict(),
    controlPlane: z
      .object({
        peerCredential: z.literal('linux_so_peercred'),
        maintainerAuthorization: z.literal('root_manifest_allowlist_only'),
        callerSelectedSocketOrPath: z.literal('forbidden'),
        callerSelectedCommandOrEntrypoint: z.literal('forbidden'),
        callerSelectedRefOrSha: z.literal('forbidden'),
        callerSelectedFixtureOrRoute: z.literal('forbidden'),
        workerExecution: z.literal('immutable_bundle_only'),
        childEnvironment: z.literal('fixed_allowlist_only'),
        workspaceOrSessionAccess: z.literal('native_denied'),
        workerOutput: z.literal('metadata_only_terminal_frame'),
      })
      .strict(),
    operations: z
      .object({
        repositoryOrCliSudo: z.literal('forbidden'),
        automaticInstall: z.literal('forbidden'),
        automaticStartStopReload: z.literal('forbidden'),
        automaticSecretCiDispatch: z.literal('forbidden'),
        hostOperatorAction: z.literal('explicit_only'),
      })
      .strict(),
    releaseIsolation: z
      .object({
        releaseEvidenceInput: z.literal('forbidden'),
        releaseBundleInput: z.literal('forbidden'),
        releaseGateInput: z.literal('forbidden'),
      })
      .strict(),
    nonRepresentableData: z.array(nonRepresentableDataV1Schema),
  })
  .strict()
  .superRefine((value, context) => {
    if (!hasExactInventory(value.nonRepresentableData, NON_REPRESENTABLE_DATA_V1)) {
      context.addIssue({
        code: 'custom',
        path: ['nonRepresentableData'],
        message: 'deployment declaration must use the exact no-content inventory',
      });
    }
  });

export type L3ProtectedScratchSupervisorDeploymentMaterialV1 = z.infer<
  typeof deploymentMaterialV1Schema
>;

export function computeL3ProtectedScratchSupervisorDeploymentDigestV1(
  material: L3ProtectedScratchSupervisorDeploymentMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l3-protected-scratch-supervisor-deployment.v1',
    canonicalJsonBytes(deploymentMaterialV1Schema.parse(material)),
  );
}

export const l3ProtectedScratchSupervisorDeploymentV1Schema = deploymentMaterialV1Schema
  .extend({ deploymentDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { deploymentDigest, ...material } = value;
    const expected = computeL3ProtectedScratchSupervisorDeploymentDigestV1(material);
    if (deploymentDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['deploymentDigest'],
        message: 'protected-supervisor deployment digest mismatch',
      });
    }
  });

export type L3ProtectedScratchSupervisorDeploymentV1 = z.infer<
  typeof l3ProtectedScratchSupervisorDeploymentV1Schema
>;

export function buildL3ProtectedScratchSupervisorDeploymentV1(
  material: L3ProtectedScratchSupervisorDeploymentMaterialV1,
): L3ProtectedScratchSupervisorDeploymentV1 {
  const parsed = deploymentMaterialV1Schema.parse(material);
  return l3ProtectedScratchSupervisorDeploymentV1Schema.parse({
    ...parsed,
    deploymentDigest: computeL3ProtectedScratchSupervisorDeploymentDigestV1(parsed),
  });
}

/**
 * The sole source-owned declaration for a future protected Linux deployment.
 * It is immutable data and deliberately does not assert that a matching host
 * service exists or that live L3 dispatch is allowed today.
 */
export const L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1 =
  buildL3ProtectedScratchSupervisorDeploymentV1({
    schema: 'L3ProtectedScratchSupervisorDeploymentV1',
    version: 1,
    deploymentId: 'qualification-l3-protected-scratch-supervisor-v1',
    authority: 'diagnostic',
    evidenceEligible: false,
    platform: {
      kernel: 'linux',
      serviceManager: 'systemd_system',
      servicePrincipal: 'root',
      unitName: 'kite-qualification-l3-supervisor.service',
    },
    protectedObjects: {
      installManifest: '/etc/kite-qualification-l3/install-manifest-v1.json',
      daemonBundle: '/usr/lib/kite-qualification-l3/supervisor-v1',
      workerBundle: '/usr/lib/kite-qualification-l3/worker-v1',
      nativeCleanupHelper: '/usr/lib/kite-qualification-l3/cleanup-helper-v1',
      attestationKey: '/var/lib/kite-qualification-l3/attestation.key',
      ownership: 'root_only',
      linkPolicy: 'single_link_no_follow',
      mutationPolicy: 'checked_manifest_digest_only',
    },
    roots: {
      scratch: {
        path: '/run/kite-qualification-l3/scratch',
        storage: 'tmpfs',
        ownership: 'root_only',
        mode: '0700',
        allocator: 'supervisor_only',
      },
      control: {
        path: '/run/kite-qualification-l3/control',
        storage: 'tmpfs',
        ownership: 'root_only',
        mode: '0700',
        controlSocket: '/run/kite-qualification-l3/control/supervisor.sock',
      },
      recoveryIndex: {
        path: '/var/lib/kite-qualification-l3/recovery-index',
        storage: 'local_disk_encrypted',
        ownership: 'root_only',
        mode: '0700',
        writer: 'supervisor_only',
        projection: 'owner_only_metadata_receipt_only',
        audit: 'root_append_only_metadata_audit',
        maxAgeSeconds: 7_776_000,
        deleteTrigger: 'root_janitor_after_retention',
        directExternalization: 'forbidden',
      },
    },
    controlPlane: {
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
    },
    operations: {
      repositoryOrCliSudo: 'forbidden',
      automaticInstall: 'forbidden',
      automaticStartStopReload: 'forbidden',
      automaticSecretCiDispatch: 'forbidden',
      hostOperatorAction: 'explicit_only',
    },
    releaseIsolation: {
      releaseEvidenceInput: 'forbidden',
      releaseBundleInput: 'forbidden',
      releaseGateInput: 'forbidden',
    },
    nonRepresentableData: [...NON_REPRESENTABLE_DATA_V1],
  });

/**
 * Future privileged code must require this exact source-owned declaration,
 * rather than accepting a caller-provided deployment descriptor.
 */
export function assertExactL3ProtectedScratchSupervisorDeploymentV1(
  value: unknown,
): L3ProtectedScratchSupervisorDeploymentV1 {
  const parsed = l3ProtectedScratchSupervisorDeploymentV1Schema.parse(value);
  if (parsed.deploymentDigest !== L3_PROTECTED_SCRATCH_SUPERVISOR_DEPLOYMENT_V1.deploymentDigest) {
    throw new Error('l3_protected_scratch_supervisor_deployment_not_source_owned');
  }
  return parsed;
}
