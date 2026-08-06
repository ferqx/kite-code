import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../../release/canonical-json';
import { isQualificationSafeIdentifierV1 } from './metadata-safety-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_METADATA_ID = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const digestSchema = z.string().regex(DIGEST);
const metadataIdSchema = z
  .string()
  .regex(SAFE_METADATA_ID)
  .refine(isQualificationSafeIdentifierV1, {
    message:
      'governance metadata identifier must not contain an endpoint, absolute path, or unsafe metadata',
  });
const isoTimestampSchema = z.iso.datetime({ offset: true });
const nonNegativeIntegerSchema = z.number().int().nonnegative();

export const EVIDENCE_DATA_CATEGORIES_V1 = [
  'aggregate_counter',
  'candidate_identity',
  'canonical_digest',
  'diagnostic_policy_metadata',
  'duration_bucket',
  'execution_identity',
  'public_source_reference',
  'reason_code',
  'repro_fingerprint',
  'reserve_case_digest',
  'retained_artifact_digest',
  'route_alias_and_model',
  'token_cost_bucket',
  'workflow_identity',
] as const;
export type EvidenceDataCategoryV1 = (typeof EVIDENCE_DATA_CATEGORIES_V1)[number];

export const EVIDENCE_PROHIBITED_DATA_CATEGORIES_V1 = [
  'absolute_path',
  'child_output',
  'command_content',
  'credential',
  'endpoint_full',
  'prompt_content',
  'reasoning_content',
  'reserve_content',
  'response_content',
  'session_log_content',
  'source_content',
  'untrusted_executable_output',
  'workspace_content',
] as const;
export type EvidenceProhibitedDataCategoryV1 =
  (typeof EVIDENCE_PROHIBITED_DATA_CATEGORIES_V1)[number];

export const EVIDENCE_RETENTION_CLASSES_V1 = [
  'repository_declaration',
  'ephemeral_local',
  'protected_ci_retained',
  'private_reserve',
] as const;
export type EvidenceRetentionClassV1 = (typeof EVIDENCE_RETENTION_CLASSES_V1)[number];

export const EVIDENCE_ACLS_V1 = [
  'repository_readers',
  'local_owner_only',
  'protected_ci_maintainers',
  'reserve_custodian_and_reviewer',
] as const;
export const EVIDENCE_ENCRYPTIONS_V1 = [
  'github_managed_at_rest_and_tls',
  'local_owner_disk_encryption',
  'customer_managed_key_and_tls',
] as const;
export const EVIDENCE_AUDITS_V1 = [
  'git_history_and_review',
  'local_metadata_audit',
  'github_actions_artifact_access',
  'append_only_reserve_access_deletion',
] as const;
export const EVIDENCE_AUTHORIZERS_V1 = [
  'none',
  'local_owner',
  'repository_maintainer',
  'reserve_custodian',
] as const;

const quotaSchema = z
  .object({
    attempts: nonNegativeIntegerSchema,
    tokens: nonNegativeIntegerSchema,
    runWallClockSeconds: nonNegativeIntegerSchema,
    costUsdMicros: nonNegativeIntegerSchema,
  })
  .strict();

const profileMaterialV1Schema = z
  .object({
    profileId: metadataIdSchema,
    retentionClass: z.enum(EVIDENCE_RETENTION_CLASSES_V1),
    allowedDataCategories: z.array(z.enum(EVIDENCE_DATA_CATEGORIES_V1)),
    prohibitedDataCategories: z.array(z.enum(EVIDENCE_PROHIBITED_DATA_CATEGORIES_V1)),
    retention: z
      .object({
        maxAgeSeconds: z.union([nonNegativeIntegerSchema, z.literal('source_lifecycle')]),
        deleteTrigger: z.enum([
          'process_exit',
          'artifact_expiry',
          'cryptographic_purge',
          'source_lifecycle',
        ]),
      })
      .strict(),
    storage: z
      .object({
        acl: z.enum(EVIDENCE_ACLS_V1),
        encryption: z.enum(EVIDENCE_ENCRYPTIONS_V1),
        audit: z.enum(EVIDENCE_AUDITS_V1),
      })
      .strict(),
    quotas: z
      .object({
        perRun: quotaSchema,
        perDay: quotaSchema,
        perMonth: quotaSchema,
        maxConcurrentRuns: nonNegativeIntegerSchema,
      })
      .strict(),
    issuePublication: z.literal('default_deny'),
    requiredAuthorizer: z.enum(EVIDENCE_AUTHORIZERS_V1),
  })
  .strict();

export type EvidenceGovernanceProfileMaterialV1 = z.infer<typeof profileMaterialV1Schema>;

const ZERO_QUOTA = {
  attempts: 0,
  tokens: 0,
  runWallClockSeconds: 0,
  costUsdMicros: 0,
} as const;

const EPHEMERAL_ALLOWED_DATA_V1 = [
  'aggregate_counter',
  'candidate_identity',
  'canonical_digest',
  'diagnostic_policy_metadata',
  'duration_bucket',
  'execution_identity',
  'reason_code',
  'repro_fingerprint',
  'route_alias_and_model',
  'token_cost_bucket',
] as const satisfies readonly EvidenceDataCategoryV1[];

const PROTECTED_CI_ALLOWED_DATA_V1 = [
  'aggregate_counter',
  'candidate_identity',
  'canonical_digest',
  'diagnostic_policy_metadata',
  'duration_bucket',
  'execution_identity',
  'reason_code',
  'repro_fingerprint',
  'retained_artifact_digest',
  'route_alias_and_model',
  'token_cost_bucket',
  'workflow_identity',
] as const satisfies readonly EvidenceDataCategoryV1[];

const PRIVATE_RESERVE_ALLOWED_DATA_V1 = [
  'aggregate_counter',
  'candidate_identity',
  'canonical_digest',
  'diagnostic_policy_metadata',
  'duration_bucket',
  'execution_identity',
  'reason_code',
  'repro_fingerprint',
  'reserve_case_digest',
  'route_alias_and_model',
  'token_cost_bucket',
] as const satisfies readonly EvidenceDataCategoryV1[];

const EXPECTED_PROFILE_MATERIAL_V1 = {
  repository_declaration: {
    profileId: 'qualification-governance/repository_declaration/v1',
    retentionClass: 'repository_declaration',
    allowedDataCategories: [
      'canonical_digest',
      'diagnostic_policy_metadata',
      'public_source_reference',
      'route_alias_and_model',
    ],
    prohibitedDataCategories: EVIDENCE_PROHIBITED_DATA_CATEGORIES_V1,
    retention: { maxAgeSeconds: 'source_lifecycle', deleteTrigger: 'source_lifecycle' },
    storage: {
      acl: 'repository_readers',
      encryption: 'github_managed_at_rest_and_tls',
      audit: 'git_history_and_review',
    },
    quotas: { perRun: ZERO_QUOTA, perDay: ZERO_QUOTA, perMonth: ZERO_QUOTA, maxConcurrentRuns: 0 },
    issuePublication: 'default_deny',
    requiredAuthorizer: 'none',
  },
  ephemeral_local: {
    profileId: 'qualification-governance/ephemeral_local/v1',
    retentionClass: 'ephemeral_local',
    allowedDataCategories: EPHEMERAL_ALLOWED_DATA_V1,
    prohibitedDataCategories: EVIDENCE_PROHIBITED_DATA_CATEGORIES_V1,
    // Normal live-run scratch is deleted at process exit. The accepted
    // emergency upper bound is for crash-recovery cleanup only; it is not a
    // license to retain evidence or content during a healthy process.
    retention: { maxAgeSeconds: 86_400, deleteTrigger: 'process_exit' },
    storage: {
      acl: 'local_owner_only',
      encryption: 'local_owner_disk_encryption',
      audit: 'local_metadata_audit',
    },
    quotas: {
      perRun: { attempts: 3, tokens: 12_288, runWallClockSeconds: 600, costUsdMicros: 250_000 },
      perDay: { attempts: 6, tokens: 24_576, runWallClockSeconds: 1_200, costUsdMicros: 500_000 },
      perMonth: {
        attempts: 30,
        tokens: 122_880,
        runWallClockSeconds: 7_200,
        costUsdMicros: 2_500_000,
      },
      maxConcurrentRuns: 1,
    },
    issuePublication: 'default_deny',
    requiredAuthorizer: 'local_owner',
  },
  protected_ci_retained: {
    profileId: 'qualification-governance/protected_ci_retained/v1',
    retentionClass: 'protected_ci_retained',
    allowedDataCategories: PROTECTED_CI_ALLOWED_DATA_V1,
    prohibitedDataCategories: EVIDENCE_PROHIBITED_DATA_CATEGORIES_V1,
    retention: { maxAgeSeconds: 1_209_600, deleteTrigger: 'artifact_expiry' },
    storage: {
      acl: 'protected_ci_maintainers',
      encryption: 'github_managed_at_rest_and_tls',
      audit: 'github_actions_artifact_access',
    },
    quotas: {
      perRun: { attempts: 2, tokens: 12_288, runWallClockSeconds: 600, costUsdMicros: 250_000 },
      perDay: { attempts: 4, tokens: 24_576, runWallClockSeconds: 1_200, costUsdMicros: 500_000 },
      perMonth: {
        attempts: 30,
        tokens: 184_320,
        runWallClockSeconds: 9_000,
        costUsdMicros: 3_750_000,
      },
      maxConcurrentRuns: 1,
    },
    issuePublication: 'default_deny',
    requiredAuthorizer: 'repository_maintainer',
  },
  private_reserve: {
    profileId: 'qualification-governance/private_reserve/v1',
    retentionClass: 'private_reserve',
    allowedDataCategories: PRIVATE_RESERVE_ALLOWED_DATA_V1,
    prohibitedDataCategories: EVIDENCE_PROHIBITED_DATA_CATEGORIES_V1,
    retention: { maxAgeSeconds: 2_592_000, deleteTrigger: 'cryptographic_purge' },
    storage: {
      acl: 'reserve_custodian_and_reviewer',
      encryption: 'customer_managed_key_and_tls',
      audit: 'append_only_reserve_access_deletion',
    },
    quotas: {
      perRun: {
        attempts: 10,
        tokens: 49_152,
        runWallClockSeconds: 1_800,
        costUsdMicros: 5_000_000,
      },
      perDay: {
        attempts: 20,
        tokens: 98_304,
        runWallClockSeconds: 3_600,
        costUsdMicros: 10_000_000,
      },
      perMonth: {
        attempts: 100,
        tokens: 491_520,
        runWallClockSeconds: 18_000,
        costUsdMicros: 50_000_000,
      },
      maxConcurrentRuns: 1,
    },
    issuePublication: 'default_deny',
    requiredAuthorizer: 'reserve_custodian',
  },
} as const;

function codePointSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
}

function hasExpectedMaterial(
  value: EvidenceGovernanceProfileMaterialV1,
  expected: EvidenceGovernanceProfileMaterialV1,
): boolean {
  return (
    JSON.stringify(value.allowedDataCategories) ===
      JSON.stringify(expected.allowedDataCategories) &&
    JSON.stringify(value.prohibitedDataCategories) ===
      JSON.stringify(expected.prohibitedDataCategories) &&
    JSON.stringify(value.retention) === JSON.stringify(expected.retention) &&
    JSON.stringify(value.storage) === JSON.stringify(expected.storage) &&
    JSON.stringify(value.quotas) === JSON.stringify(expected.quotas) &&
    value.profileId === expected.profileId &&
    value.issuePublication === expected.issuePublication &&
    value.requiredAuthorizer === expected.requiredAuthorizer
  );
}

export function computeEvidenceGovernanceProfileDigestV1(
  material: EvidenceGovernanceProfileMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.governance-profile.v1',
    canonicalJsonBytes(profileMaterialV1Schema.parse(material)),
  );
}

export const evidenceGovernanceProfileRecordV1Schema = profileMaterialV1Schema
  .extend({ profileDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { profileDigest, ...material } = value;
    const expected = profileMaterialV1Schema.parse(
      EXPECTED_PROFILE_MATERIAL_V1[material.retentionClass],
    );
    if (!codePointSortedUnique(material.allowedDataCategories)) {
      context.addIssue({
        code: 'custom',
        path: ['allowedDataCategories'],
        message: 'allowed data categories must be code-point sorted and unique',
      });
    }
    if (!codePointSortedUnique(material.prohibitedDataCategories)) {
      context.addIssue({
        code: 'custom',
        path: ['prohibitedDataCategories'],
        message: 'prohibited data categories must be code-point sorted and unique',
      });
    }
    if (!hasExpectedMaterial(material, expected)) {
      context.addIssue({
        code: 'custom',
        message: 'governance profile material must equal the ADR-0070 closed profile',
      });
    }
    const expectedDigest = computeEvidenceGovernanceProfileDigestV1(material);
    if (profileDigest !== expectedDigest) {
      context.addIssue({
        code: 'custom',
        path: ['profileDigest'],
        message: `governance profile digest mismatch: expected ${expectedDigest}`,
      });
    }
  });

export type EvidenceGovernanceProfileRecordV1 = z.infer<
  typeof evidenceGovernanceProfileRecordV1Schema
>;

function buildProfileRecordV1(
  retentionClass: EvidenceRetentionClassV1,
): EvidenceGovernanceProfileRecordV1 {
  const material = profileMaterialV1Schema.parse(EXPECTED_PROFILE_MATERIAL_V1[retentionClass]);
  return evidenceGovernanceProfileRecordV1Schema.parse({
    ...material,
    profileDigest: computeEvidenceGovernanceProfileDigestV1(material),
  });
}

export const evidenceGovernanceProfileV1Schema = z
  .object({
    schema: z.literal('EvidenceGovernanceProfileV1'),
    version: z.literal(1),
    profiles: z
      .object({
        repository_declaration: evidenceGovernanceProfileRecordV1Schema,
        ephemeral_local: evidenceGovernanceProfileRecordV1Schema,
        protected_ci_retained: evidenceGovernanceProfileRecordV1Schema,
        private_reserve: evidenceGovernanceProfileRecordV1Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const retentionClass of EVIDENCE_RETENTION_CLASSES_V1) {
      if (value.profiles[retentionClass].retentionClass !== retentionClass) {
        context.addIssue({
          code: 'custom',
          path: ['profiles', retentionClass, 'retentionClass'],
          message: 'profile key must match its retention class',
        });
      }
    }
  });

export type EvidenceGovernanceProfileV1 = z.infer<typeof evidenceGovernanceProfileV1Schema>;

export const EVIDENCE_GOVERNANCE_PROFILE_V1: EvidenceGovernanceProfileV1 =
  evidenceGovernanceProfileV1Schema.parse({
    schema: 'EvidenceGovernanceProfileV1',
    version: 1,
    profiles: {
      repository_declaration: buildProfileRecordV1('repository_declaration'),
      ephemeral_local: buildProfileRecordV1('ephemeral_local'),
      protected_ci_retained: buildProfileRecordV1('protected_ci_retained'),
      private_reserve: buildProfileRecordV1('private_reserve'),
    },
  });

export const evidenceGovernanceBindingV1Schema = z
  .object({
    retentionClass: z.enum(EVIDENCE_RETENTION_CLASSES_V1),
    profileId: metadataIdSchema,
    profileDigest: digestSchema,
    expiresAt: isoTimestampSchema.optional(),
    retainedArtifactDigest: digestSchema.optional(),
    quotaLedgerDigests: z
      .object({
        day: digestSchema,
        month: digestSchema,
      })
      .strict()
      .optional(),
    storageDeletionWitnessDigest: digestSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles[value.retentionClass];
    if (value.profileId !== expected.profileId || value.profileDigest !== expected.profileDigest) {
      context.addIssue({
        code: 'custom',
        message: 'governance binding must match the exact closed profile and digest',
      });
    }
    if (value.retentionClass === 'ephemeral_local') {
      if (value.expiresAt !== undefined || value.retainedArtifactDigest !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'ephemeral local records cannot carry retained-artifact metadata',
        });
      }
      if (
        value.quotaLedgerDigests === undefined ||
        value.storageDeletionWitnessDigest === undefined
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'ephemeral local evidence requires day/month ledger and deletion witness digests',
        });
      }
    } else if (value.retentionClass === 'protected_ci_retained') {
      if (value.expiresAt === undefined || value.retainedArtifactDigest === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'protected CI retained records require expiry and retained artifact digest',
        });
      }
      if (
        value.quotaLedgerDigests === undefined ||
        value.storageDeletionWitnessDigest === undefined
      ) {
        context.addIssue({
          code: 'custom',
          message: 'protected CI evidence requires day/month ledger and deletion witness digests',
        });
      }
    } else if (value.retentionClass === 'repository_declaration') {
      if (
        value.expiresAt !== undefined ||
        value.retainedArtifactDigest !== undefined ||
        value.quotaLedgerDigests !== undefined ||
        value.storageDeletionWitnessDigest !== undefined
      ) {
        context.addIssue({
          code: 'custom',
          message: 'repository declarations cannot carry runtime retention metadata',
        });
      }
    } else {
      if (value.expiresAt === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'private reserve records require an expiry',
        });
      }
      if (
        value.quotaLedgerDigests === undefined ||
        value.storageDeletionWitnessDigest === undefined
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'private reserve evidence requires day/month ledger and deletion witness digests',
        });
      }
    }
  });

export type EvidenceGovernanceBindingV1 = z.infer<typeof evidenceGovernanceBindingV1Schema>;

const quotaCountersV1Schema = z
  .object({
    attempts: nonNegativeIntegerSchema,
    tokens: nonNegativeIntegerSchema,
    runWallClockSeconds: nonNegativeIntegerSchema,
    costUsdMicros: nonNegativeIntegerSchema,
  })
  .strict();

const quotaLedgerMaterialV1Schema = z
  .object({
    schema: z.literal('EvidenceQuotaLedgerV1'),
    profileId: metadataIdSchema,
    profileDigest: digestSchema,
    routePolicyDigest: digestSchema,
    period: z.enum(['day', 'month']),
    periodStart: z.iso.date(),
    reservationId: metadataIdSchema,
    status: z.enum(['reserved', 'reconciled', 'expired']),
    reserved: quotaCountersV1Schema,
    reconciled: quotaCountersV1Schema.optional(),
  })
  .strict();

export const evidenceQuotaLedgerV1Schema = quotaLedgerMaterialV1Schema
  .extend({ recordDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { recordDigest, ...material } = value;
    const profile = Object.values(EVIDENCE_GOVERNANCE_PROFILE_V1.profiles).find(
      (candidate) =>
        candidate.profileId === value.profileId && candidate.profileDigest === value.profileDigest,
    );
    if (!profile || profile.quotas.maxConcurrentRuns === 0) {
      context.addIssue({ code: 'custom', message: 'profile cannot create a quota ledger' });
    }
    if (value.status === 'reconciled' && value.reconciled === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'reconciled ledger requires reconciliation counters',
      });
    }
    if (value.status !== 'reconciled' && value.reconciled !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'only reconciled ledger may carry reconciliation counters',
      });
    }
    if (recordDigest !== computeEvidenceQuotaLedgerDigestV1(material)) {
      context.addIssue({
        code: 'custom',
        path: ['recordDigest'],
        message: 'quota ledger digest mismatch',
      });
    }
  });

export type EvidenceQuotaLedgerV1 = z.infer<typeof evidenceQuotaLedgerV1Schema>;
export type EvidenceQuotaLedgerMaterialV1 = z.infer<typeof quotaLedgerMaterialV1Schema>;

export function computeEvidenceQuotaLedgerDigestV1(
  material: EvidenceQuotaLedgerMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.quota-ledger.v1',
    canonicalJsonBytes(quotaLedgerMaterialV1Schema.parse(material)),
  );
}

export function buildEvidenceQuotaLedgerV1(
  material: EvidenceQuotaLedgerMaterialV1,
): EvidenceQuotaLedgerV1 {
  const parsed = quotaLedgerMaterialV1Schema.parse(material);
  return evidenceQuotaLedgerV1Schema.parse({
    ...parsed,
    recordDigest: computeEvidenceQuotaLedgerDigestV1(parsed),
  });
}

const retentionWitnessMaterialV1Schema = z
  .object({
    schema: z.literal('EvidenceRetentionWitnessV1'),
    profileId: metadataIdSchema,
    profileDigest: digestSchema,
    retentionClass: z.enum(EVIDENCE_RETENTION_CLASSES_V1),
    storage: z
      .object({
        acl: z.enum(EVIDENCE_ACLS_V1),
        encryption: z.enum(EVIDENCE_ENCRYPTIONS_V1),
        audit: z.enum(EVIDENCE_AUDITS_V1),
      })
      .strict(),
    deleteTrigger: z.enum([
      'process_exit',
      'artifact_expiry',
      'cryptographic_purge',
      'source_lifecycle',
    ]),
    observedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema.optional(),
    retainedArtifactDigest: digestSchema.optional(),
  })
  .strict();

export type EvidenceRetentionWitnessMaterialV1 = z.infer<typeof retentionWitnessMaterialV1Schema>;

export function computeEvidenceRetentionWitnessDigestV1(
  material: EvidenceRetentionWitnessMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.retention-witness.v1',
    canonicalJsonBytes(retentionWitnessMaterialV1Schema.parse(material)),
  );
}

export const evidenceRetentionWitnessV1Schema = retentionWitnessMaterialV1Schema
  .extend({ recordDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { recordDigest, ...material } = value;
    const profile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles[value.retentionClass];
    if (
      value.profileId !== profile.profileId ||
      value.profileDigest !== profile.profileDigest ||
      JSON.stringify(value.storage) !== JSON.stringify(profile.storage) ||
      value.deleteTrigger !== profile.retention.deleteTrigger
    ) {
      context.addIssue({
        code: 'custom',
        message: 'retention witness must match exact profile storage and deletion policy',
      });
    }
    if (
      value.retentionClass === 'protected_ci_retained' ||
      value.retentionClass === 'private_reserve'
    ) {
      if (!value.expiresAt || Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) {
        context.addIssue({ code: 'custom', message: 'retained witness requires future expiry' });
      }
    } else if (value.expiresAt !== undefined) {
      context.addIssue({ code: 'custom', message: 'non-retained witness cannot carry expiry' });
    }
    if (
      value.retentionClass === 'protected_ci_retained' &&
      value.retainedArtifactDigest === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'protected retained witness requires retained artifact digest',
      });
    }
    if (
      value.retentionClass !== 'protected_ci_retained' &&
      value.retainedArtifactDigest !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'only protected retained witness may carry retained artifact digest',
      });
    }
    if (recordDigest !== computeEvidenceRetentionWitnessDigestV1(material)) {
      context.addIssue({
        code: 'custom',
        path: ['recordDigest'],
        message: 'retention witness digest mismatch',
      });
    }
  });

export type EvidenceRetentionWitnessV1 = z.infer<typeof evidenceRetentionWitnessV1Schema>;

export function buildEvidenceRetentionWitnessV1(
  material: EvidenceRetentionWitnessMaterialV1,
): EvidenceRetentionWitnessV1 {
  const parsed = retentionWitnessMaterialV1Schema.parse(material);
  return evidenceRetentionWitnessV1Schema.parse({
    ...parsed,
    recordDigest: computeEvidenceRetentionWitnessDigestV1(parsed),
  });
}

const authorizationMaterialV1Schema = z
  .object({
    schema: z.literal('EvidenceGovernanceAuthorizationV1'),
    profileId: metadataIdSchema,
    profileDigest: digestSchema,
    routePolicyDigest: digestSchema,
    actorIdentity: metadataIdSchema,
    purpose: z.literal('metadata_only_issue_handoff'),
    sanitizedSummaryDigest: digestSchema,
    issuedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict();

export const evidenceGovernanceAuthorizationV1Schema = authorizationMaterialV1Schema
  .extend({ recordDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { recordDigest, ...material } = value;
    const profile = Object.values(EVIDENCE_GOVERNANCE_PROFILE_V1.profiles).find(
      (candidate) =>
        candidate.profileId === value.profileId && candidate.profileDigest === value.profileDigest,
    );
    if (!profile || profile.requiredAuthorizer === 'none') {
      context.addIssue({ code: 'custom', message: 'profile cannot authorize issue handoff' });
    }
    if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'authorization must expire after issue',
      });
    }
    if (recordDigest !== computeEvidenceGovernanceAuthorizationDigestV1(material)) {
      context.addIssue({
        code: 'custom',
        path: ['recordDigest'],
        message: 'authorization digest mismatch',
      });
    }
  });

export type EvidenceGovernanceAuthorizationV1 = z.infer<
  typeof evidenceGovernanceAuthorizationV1Schema
>;
export type EvidenceGovernanceAuthorizationMaterialV1 = z.infer<
  typeof authorizationMaterialV1Schema
>;

export function computeEvidenceGovernanceAuthorizationDigestV1(
  material: EvidenceGovernanceAuthorizationMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.governance-authorization.v1',
    canonicalJsonBytes(authorizationMaterialV1Schema.parse(material)),
  );
}

/**
 * AQ-2 has no trusted maintainer control path or Issue publisher.  Parsing a
 * metadata record is never an authorization grant; later runner work must add
 * an independently authenticated control path before this can become true.
 */
export function isEvidenceIssueHandoffAllowedV1(_authorization: unknown): false {
  return false;
}
