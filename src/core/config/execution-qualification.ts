import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  type ExecutionEnvironmentIdentityV1,
  readExecutionEnvironmentIdentityV1,
} from '@/core/sandbox/environment-identity';
import { detectSandboxBackend } from '@/core/sandbox/platform';
import type {
  InProcessReadOnlyToolCatalogV1,
  ProductionExecutionEntrypointV1,
  ProductionExecutionQualificationRegistryV1,
  ProductionExecutionQualificationV1,
} from '@/core/sandbox/types';
import { BROKERED_GIT_FEATURE_REVISION_V1 } from '@/protocol/git';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const enforcementSchema = z.enum(['enforced', 'unsupported']);

export const executionBackendCapabilitiesV1Schema = z
  .object({
    backend: z.enum(['seatbelt', 'bubblewrap', 'windows_restricted_token', 'none']),
    filesystem: z
      .object({
        read_only: enforcementSchema,
        workspace_write: enforcementSchema,
        full_access: enforcementSchema,
      })
      .strict(),
    network: z
      .object({
        off: enforcementSchema,
        allowlist: enforcementSchema,
      })
      .strict(),
    syscallFilter: enforcementSchema,
    processTreeLimit: enforcementSchema,
    childProcessInheritance: enforcementSchema,
    verifiedInProcessReadOnly: enforcementSchema,
  })
  .strict();

const inProcessReadOnlyToolContractV1Schema = z
  .object({
    toolId: z.string().trim().min(1),
    descriptorRevision: z.string().trim().min(1),
    filesystem: z.literal('workspace_read'),
    network: z.literal('none'),
    process: z.literal(false),
    write: z.literal(false),
    externalPath: z.literal(false),
  })
  .strict();

const processCapabilitySurfaceV1Schema = z
  .object({
    shell: z.boolean(),
    skillChild: z.boolean(),
    localStdioMcp: z.boolean(),
    brokeredGit: z
      .object({
        featureRevision: z.literal(BROKERED_GIT_FEATURE_REVISION_V1),
        inspect: z.boolean(),
        shellDenyEvidence: z
          .object({
            featureRevision: z.literal(BROKERED_GIT_FEATURE_REVISION_V1),
            platform: z.enum(['darwin', 'linux', 'win32']),
            backend: z.enum(['seatbelt', 'bubblewrap', 'windows_restricted_token', 'none']),
            outcome: z.enum(['qualified', 'excluded']),
            metadataReadDeny: z.boolean(),
            metadataWriteDeny: z.boolean(),
            profileRevision: z.string().min(1),
            profileDigest: digestSchema,
            protectedRulesDigest: digestSchema,
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((surface, context) => {
    if (!surface.shell && (surface.skillChild || surface.localStdioMcp)) {
      context.addIssue({
        code: 'custom',
        path: ['shell'],
        message: 'child process capabilities require the qualified shell process boundary',
      });
    }
    if (surface.brokeredGit) {
      const evidence = surface.brokeredGit.shellDenyEvidence;
      if (
        evidence.outcome !== 'qualified' ||
        evidence.backend === 'none' ||
        !evidence.metadataReadDeny ||
        !evidence.metadataWriteDeny
      ) {
        context.addIssue({
          code: 'custom',
          path: ['brokeredGit', 'shellDenyEvidence'],
          message: 'brokered Git requires proven native metadata read and write denial',
        });
      }
    }
  });

const inProcessReadOnlyToolCatalogObjectV1Schema = z
  .object({
    version: z.literal(1),
    revision: z.string().trim().min(1),
    digest: digestSchema,
    tools: z.array(inProcessReadOnlyToolContractV1Schema),
  })
  .strict();

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function catalogCanonicalValue(catalog: Omit<InProcessReadOnlyToolCatalogV1, 'digest'>): unknown {
  return {
    version: catalog.version,
    revision: catalog.revision,
    tools: [...catalog.tools]
      .map((tool) => ({
        toolId: tool.toolId,
        descriptorRevision: tool.descriptorRevision,
        filesystem: tool.filesystem,
        network: tool.network,
        process: tool.process,
        write: tool.write,
        externalPath: tool.externalPath,
      }))
      .sort((left, right) => compareCodeUnits(left.toolId, right.toolId)),
  };
}

export function computeInProcessReadOnlyToolCatalogDigestV1(
  value: Omit<InProcessReadOnlyToolCatalogV1, 'digest'>,
): string {
  return `sha256:${createHash('sha256')
    .update('kite.in-process-read-only-tool-catalog.v1\0')
    .update(JSON.stringify(catalogCanonicalValue(value)))
    .digest('hex')}`;
}

export const inProcessReadOnlyToolCatalogV1Schema =
  inProcessReadOnlyToolCatalogObjectV1Schema.superRefine((catalog, context) => {
    if (new Set(catalog.tools.map((tool) => tool.toolId)).size !== catalog.tools.length) {
      context.addIssue({
        code: 'custom',
        path: ['tools'],
        message: 'toolId values must be unique',
      });
    }
    if (computeInProcessReadOnlyToolCatalogDigestV1(catalog) !== catalog.digest) {
      context.addIssue({ code: 'custom', path: ['digest'], message: 'catalog digest mismatch' });
    }
  });

const qualificationSchema = z
  .object({
    version: z.literal(1),
    qualificationId: z.string().trim().min(1),
    decisionId: z.literal('D-04'),
    outcome: z.enum(['supported', 'read_only_only']),
    platform: z.enum(['darwin', 'linux', 'win32']),
    osRelease: z.string().trim().min(1),
    osVersion: z.string().trim().min(1),
    arch: z.string().trim().min(1),
    bunVersion: z.string().trim().min(1),
    backend: z.enum(['seatbelt', 'bubblewrap', 'windows_restricted_token', 'none']),
    selectedNetworkMode: z.enum(['off', 'allowlist']),
    entrypoints: z.array(z.enum(['tui', 'foreground_cli'])).min(1),
    evidenceDigest: digestSchema,
    evidenceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    backendCapabilities: executionBackendCapabilitiesV1Schema,
    processCapabilitySurface: processCapabilitySurfaceV1Schema,
    inProcessReadOnlyTools: inProcessReadOnlyToolCatalogV1Schema,
  })
  .strict()
  .superRefine((qualification, context) => {
    if (qualification.backend !== qualification.backendCapabilities.backend) {
      context.addIssue({
        code: 'custom',
        path: ['backendCapabilities', 'backend'],
        message: 'backend capability identity must match qualification backend',
      });
    }
    if (
      qualification.entrypoints.length !== 2 ||
      !qualification.entrypoints.includes('tui') ||
      !qualification.entrypoints.includes('foreground_cli')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['entrypoints'],
        message: 'qualification requires both TUI and foreground CLI composition evidence',
      });
    }
    if (
      qualification.outcome === 'read_only_only' &&
      qualification.inProcessReadOnlyTools.tools.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['inProcessReadOnlyTools', 'tools'],
        message: 'read_only_only requires at least one verified in-process tool',
      });
    }
    const gitEvidence = qualification.processCapabilitySurface.brokeredGit?.shellDenyEvidence;
    if (
      gitEvidence &&
      (gitEvidence.platform !== qualification.platform ||
        gitEvidence.backend !== qualification.backend)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['processCapabilitySurface', 'brokeredGit', 'shellDenyEvidence'],
        message: 'brokered Git native evidence must match qualification platform and backend',
      });
    }
  });

export function parseProductionExecutionQualificationV1(
  value: unknown,
): ProductionExecutionQualificationV1 {
  return qualificationSchema.parse(value);
}

const registryObjectSchema = z
  .object({
    version: z.literal(1),
    decisionId: z.literal('D-04'),
    revision: z.string().trim().min(1),
    status: z.enum(['accepted_empty_support_set', 'accepted_non_empty_support_set']),
    selectedNetworkMode: z.enum(['off', 'allowlist']),
    evidenceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    digest: digestSchema,
    qualifications: z.array(qualificationSchema),
  })
  .strict();

function qualificationAdmissionKey(qualification: ProductionExecutionQualificationV1): string {
  return JSON.stringify([
    qualification.platform,
    qualification.osRelease,
    qualification.osVersion,
    qualification.arch,
    qualification.bunVersion,
    qualification.backend,
    qualification.selectedNetworkMode,
  ]);
}

function registryCanonicalValue(
  registry: Omit<ProductionExecutionQualificationRegistryV1, 'digest'>,
): unknown {
  return {
    version: registry.version,
    decisionId: registry.decisionId,
    revision: registry.revision,
    status: registry.status,
    selectedNetworkMode: registry.selectedNetworkMode,
    evidenceCommit: registry.evidenceCommit,
    qualifications: [...registry.qualifications]
      .map((qualification) => ({
        version: qualification.version,
        qualificationId: qualification.qualificationId,
        decisionId: qualification.decisionId,
        outcome: qualification.outcome,
        platform: qualification.platform,
        osRelease: qualification.osRelease,
        osVersion: qualification.osVersion,
        arch: qualification.arch,
        bunVersion: qualification.bunVersion,
        backend: qualification.backend,
        selectedNetworkMode: qualification.selectedNetworkMode,
        entrypoints: [...qualification.entrypoints].sort(compareCodeUnits),
        evidenceDigest: qualification.evidenceDigest,
        evidenceCommit: qualification.evidenceCommit,
        backendCapabilities: {
          backend: qualification.backendCapabilities.backend,
          filesystem: {
            read_only: qualification.backendCapabilities.filesystem.read_only,
            workspace_write: qualification.backendCapabilities.filesystem.workspace_write,
            full_access: qualification.backendCapabilities.filesystem.full_access,
          },
          network: {
            off: qualification.backendCapabilities.network.off,
            allowlist: qualification.backendCapabilities.network.allowlist,
          },
          syscallFilter: qualification.backendCapabilities.syscallFilter,
          processTreeLimit: qualification.backendCapabilities.processTreeLimit,
          childProcessInheritance: qualification.backendCapabilities.childProcessInheritance,
          verifiedInProcessReadOnly: qualification.backendCapabilities.verifiedInProcessReadOnly,
        },
        processCapabilitySurface: {
          shell: qualification.processCapabilitySurface.shell,
          skillChild: qualification.processCapabilitySurface.skillChild,
          localStdioMcp: qualification.processCapabilitySurface.localStdioMcp,
          ...(qualification.processCapabilitySurface.brokeredGit
            ? { brokeredGit: qualification.processCapabilitySurface.brokeredGit }
            : {}),
        },
        inProcessReadOnlyTools: {
          version: qualification.inProcessReadOnlyTools.version,
          revision: qualification.inProcessReadOnlyTools.revision,
          digest: qualification.inProcessReadOnlyTools.digest,
          tools: [...qualification.inProcessReadOnlyTools.tools]
            .map((tool) => ({
              toolId: tool.toolId,
              descriptorRevision: tool.descriptorRevision,
              filesystem: tool.filesystem,
              network: tool.network,
              process: tool.process,
              write: tool.write,
              externalPath: tool.externalPath,
            }))
            .sort((left, right) => compareCodeUnits(left.toolId, right.toolId)),
        },
      }))
      .sort((left, right) => compareCodeUnits(left.qualificationId, right.qualificationId)),
  };
}

export function computeProductionExecutionQualificationRegistryDigestV1(
  value: Omit<ProductionExecutionQualificationRegistryV1, 'digest'>,
): string {
  return `sha256:${createHash('sha256')
    .update('kite.production-execution-qualification-registry.v1\0')
    .update(JSON.stringify(registryCanonicalValue(value)))
    .digest('hex')}`;
}

export const productionExecutionQualificationRegistryV1Schema = registryObjectSchema.superRefine(
  (registry, context) => {
    const expectsEmpty = registry.status === 'accepted_empty_support_set';
    if (expectsEmpty !== (registry.qualifications.length === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'registry status must agree with qualification count',
      });
    }
    if (
      registry.qualifications.some(
        (qualification) =>
          qualification.selectedNetworkMode !== registry.selectedNetworkMode ||
          qualification.evidenceCommit !== registry.evidenceCommit,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['qualifications'],
        message: 'qualification release pins must match the registry',
      });
    }
    if (
      new Set(registry.qualifications.map((item) => item.qualificationId)).size !==
      registry.qualifications.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['qualifications'],
        message: 'qualificationId values must be unique',
      });
    }
    if (
      new Set(registry.qualifications.map(qualificationAdmissionKey)).size !==
      registry.qualifications.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['qualifications'],
        message: 'production environment admission keys must be unique',
      });
    }
    if (computeProductionExecutionQualificationRegistryDigestV1(registry) !== registry.digest) {
      context.addIssue({ code: 'custom', path: ['digest'], message: 'registry digest mismatch' });
    }
  },
);

export function parseProductionExecutionQualificationRegistryV1(
  value: unknown,
): ProductionExecutionQualificationRegistryV1 {
  return productionExecutionQualificationRegistryV1Schema.parse(value);
}

export const APPROVED_PRODUCTION_EXECUTION_QUALIFICATION_REVISION_V1 = 'd04-empty-2026-07-31';
export const APPROVED_PRODUCTION_EXECUTION_QUALIFICATION_DIGEST_V1 =
  'sha256:6c33ab090cd138d0eb26cdcbdc97ef92bc794adb3b1690fd7e8d2d24a4510656';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function loadApprovedProductionExecutionQualificationRegistryV1(): ProductionExecutionQualificationRegistryV1 {
  const approvedPath = new URL(
    '../../../release/platform-capabilities/approved-execution-qualifications-v1.json',
    import.meta.url,
  );
  const registry = parseProductionExecutionQualificationRegistryV1(
    JSON.parse(readFileSync(fileURLToPath(approvedPath), 'utf8')),
  );
  if (
    registry.revision !== APPROVED_PRODUCTION_EXECUTION_QUALIFICATION_REVISION_V1 ||
    registry.digest !== APPROVED_PRODUCTION_EXECUTION_QUALIFICATION_DIGEST_V1
  ) {
    throw new Error(
      'Approved production execution qualification artifact does not match release pin.',
    );
  }
  return deepFreeze(registry);
}

export interface ResolveApprovedProductionExecutionQualificationInputV1 {
  registry: ProductionExecutionQualificationRegistryV1;
  entrypoint: ProductionExecutionEntrypointV1;
}

export function qualificationMatchesExecutionEnvironmentV1(input: {
  qualification: ProductionExecutionQualificationV1;
  environment: ExecutionEnvironmentIdentityV1;
  backend: ProductionExecutionQualificationV1['backend'];
  entrypoint: ProductionExecutionEntrypointV1;
}): boolean {
  const { qualification, environment, backend, entrypoint } = input;
  return (
    qualification.platform === environment.platform &&
    qualification.osRelease === environment.osRelease &&
    qualification.osVersion === environment.osVersion &&
    qualification.arch === environment.arch &&
    qualification.bunVersion === environment.bunVersion &&
    qualification.backend === backend &&
    qualification.entrypoints.includes(entrypoint)
  );
}

/** Match only the exact native environment admitted by release evidence. */
export function resolveProductionExecutionQualificationFromRegistryV1(
  input: ResolveApprovedProductionExecutionQualificationInputV1,
): ProductionExecutionQualificationV1 | undefined {
  const backend = detectSandboxBackend();
  const environment = readExecutionEnvironmentIdentityV1();
  const matches = input.registry.qualifications.filter(
    (qualification) =>
      qualificationMatchesExecutionEnvironmentV1({
        qualification,
        environment,
        backend,
        entrypoint: input.entrypoint,
      }) &&
      qualification.selectedNetworkMode === input.registry.selectedNetworkMode &&
      environment.exactOsVersionAvailable,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
