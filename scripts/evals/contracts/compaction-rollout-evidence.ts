import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from '../../release/canonical-json';
import { releaseArtifactIdentityV1Schema } from '../../release/evidence-schema';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const timestampSchema = z.iso.datetime({ offset: true });

export const compactionRolloutIdentityV1Schema = z
  .object({
    artifactIdentity: releaseArtifactIdentityV1Schema,
    routeDigest: digestSchema,
    promptDigest: digestSchema,
    policyDigest: digestSchema,
    evaluatorDigest: digestSchema,
    operationsReadinessDecisionDigest: digestSchema,
    routeQualificationDecisionDigest: digestSchema,
    liveProviderMatrixDecisionDigest: digestSchema,
  })
  .strict();

export const compactionRolloutSourceV1Schema = z
  .object({
    sourceKind: z.literal('github_actions_unsigned_contract'),
    repository: z.literal('ferqx/kite-code'),
    repositoryId: z.literal('R_kgDOSKbi8g'),
    headSha: commitSchema,
    ref: z.string().startsWith('refs/'),
    workflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
    workflowRef: z.string().min(1),
    workflowSha: commitSchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    jobName: z.string().min(1).max(256),
    artifactId: z.string().regex(/^[1-9][0-9]*$/),
    artifactName: z.string().min(1).max(256),
    artifactDigest: digestSchema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    authentication: z
      .object({
        kind: z.literal('unconfigured'),
        reason: z.literal('production_compaction_rollout_authority_not_configured'),
      })
      .strict(),
  })
  .strict()
  .superRefine((source, context) => {
    const expected = `${source.repository}/${source.workflowPath}@${source.ref}`;
    if (source.workflowRef !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['workflowRef'],
        message: 'workflowRef must bind repository, workflowPath, and ref.',
      });
    }
    if (Date.parse(source.endedAt) < Date.parse(source.startedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'source endedAt precedes startedAt.',
      });
    }
  });

const compactionGateCheckSchema = z.enum([
  'continuation_non_inferiority',
  'false_trigger_bound',
  'resource_bound',
  'rollback_rehearsal',
]);

const compactionGateReceiptMaterialV1Schema = z
  .object({
    schema: z.literal('CompactionGateReceiptV1'),
    sequence: z.number().int().positive(),
    gate: z.enum(['G3', 'G4']),
    check: compactionGateCheckSchema,
    outcome: z.enum(['passed', 'failed', 'not_observed']),
    sampleCount: z.number().int().nonnegative(),
    observedAt: timestampSchema,
    observationDigest: digestSchema,
    previousReceiptDigest: digestSchema.nullable(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const expectedGate =
      receipt.check === 'continuation_non_inferiority' || receipt.check === 'false_trigger_bound'
        ? 'G3'
        : 'G4';
    if (receipt.gate !== expectedGate) {
      context.addIssue({
        code: 'custom',
        path: ['gate'],
        message: 'check is assigned to wrong Gate.',
      });
    }
  });

export const compactionGateReceiptV1Schema = compactionGateReceiptMaterialV1Schema.safeExtend({
  receiptDigest: digestSchema,
});

const compactionGateLedgerMaterialV1Schema = z
  .object({
    schema: z.literal('CompactionG3G4LedgerV1'),
    receipts: z.array(compactionGateReceiptV1Schema).min(1).max(64),
  })
  .strict();

export const compactionGateLedgerV1Schema = compactionGateLedgerMaterialV1Schema.extend({
  ledgerDigest: digestSchema,
});

export type CompactionGateReceiptMaterialV1 = z.infer<typeof compactionGateReceiptMaterialV1Schema>;
export type CompactionGateReceiptV1 = z.infer<typeof compactionGateReceiptV1Schema>;
export type CompactionGateLedgerV1 = z.infer<typeof compactionGateLedgerV1Schema>;

export function buildCompactionGateReceiptV1(
  input: CompactionGateReceiptMaterialV1,
): CompactionGateReceiptV1 {
  const material = compactionGateReceiptMaterialV1Schema.parse(input);
  return compactionGateReceiptV1Schema.parse({
    ...material,
    receiptDigest: sha256DomainSeparated(
      'kite.compaction.gate-receipt.v1',
      canonicalJson(material),
    ),
  });
}

export function buildCompactionGateLedgerV1(
  receipts: readonly CompactionGateReceiptV1[],
): CompactionGateLedgerV1 {
  const material = compactionGateLedgerMaterialV1Schema.parse({
    schema: 'CompactionG3G4LedgerV1',
    receipts,
  });
  verifyReceiptChain(material.receipts);
  return compactionGateLedgerV1Schema.parse({
    ...material,
    ledgerDigest: sha256DomainSeparated('kite.compaction.g3-g4-ledger.v1', canonicalJson(material)),
  });
}

const stageObservationSchema = z
  .object({
    stage: z.enum(['internal_manual', 'internal_auto_shadow', 'internal_auto_live']),
    decisionId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/),
    windowId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/),
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    outcome: z.enum(['passed', 'failed', 'not_observed']),
    sampleCount: z.number().int().nonnegative(),
    summaryDispatchCount: z.number().int().nonnegative(),
    checkpointWriteCount: z.number().int().nonnegative(),
    observationDigest: digestSchema,
  })
  .strict();

const internalRolloutMaterialV1Schema = z
  .object({
    schema: z.literal('InternalCompactionRolloutEvidenceV1'),
    identity: compactionRolloutIdentityV1Schema,
    source: compactionRolloutSourceV1Schema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    stages: z.tuple([stageObservationSchema, stageObservationSchema, stageObservationSchema]),
    gateLedger: compactionGateLedgerV1Schema,
  })
  .strict()
  .superRefine((evidence, context) => {
    const expectedStages = ['internal_manual', 'internal_auto_shadow', 'internal_auto_live'];
    if (evidence.stages.some((stage, index) => stage.stage !== expectedStages[index])) {
      context.addIssue({
        code: 'custom',
        path: ['stages'],
        message: 'rollout stages are out of order.',
      });
    }
    if (Date.parse(evidence.endedAt) < Date.parse(evidence.startedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'endedAt precedes startedAt.',
      });
    }
    if (
      evidence.startedAt !== evidence.source.startedAt ||
      evidence.endedAt !== evidence.source.endedAt
    ) {
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'source and rollout windows must match.',
      });
    }
    const decisionIds = new Set(evidence.stages.map((stage) => stage.decisionId));
    const windowIds = new Set(evidence.stages.map((stage) => stage.windowId));
    if (decisionIds.size !== evidence.stages.length || windowIds.size !== evidence.stages.length) {
      context.addIssue({
        code: 'custom',
        path: ['stages'],
        message: 'stage decision/window identities must be unique.',
      });
    }
    let previousEndedAt = Date.parse(evidence.startedAt);
    const rolloutEndedAt = Date.parse(evidence.endedAt);
    for (const [index, stage] of evidence.stages.entries()) {
      const startedAt = Date.parse(stage.startedAt);
      const endedAt = Date.parse(stage.endedAt);
      if (startedAt < previousEndedAt || endedAt <= startedAt || endedAt > rolloutEndedAt) {
        context.addIssue({
          code: 'custom',
          path: ['stages', index],
          message: 'stage windows must be ordered and contained.',
        });
      }
      previousEndedAt = endedAt;
    }
  });

export const internalCompactionRolloutEvidenceV1Schema = internalRolloutMaterialV1Schema.extend({
  evidenceDigest: digestSchema,
});

export type InternalCompactionRolloutEvidenceV1 = z.infer<
  typeof internalCompactionRolloutEvidenceV1Schema
>;

export interface CompactionRolloutExpectedIdentityV1 {
  identity: z.infer<typeof compactionRolloutIdentityV1Schema>;
  source: z.infer<typeof compactionRolloutSourceV1Schema>;
}

export interface InternalCompactionRolloutVerificationV1 {
  schema: 'InternalCompactionRolloutVerificationV1';
  status: 'blocked';
  evidenceEligible: false;
  authenticatedAuthorityConfigured: false;
  effectiveStage: 'off';
  milestone: null;
  evidenceDigest: `sha256:${string}`;
  gateLedgerDigest: `sha256:${string}`;
  reasonCodes: string[];
  verificationDigest: `sha256:${string}`;
}

export function buildInternalCompactionRolloutEvidenceV1(
  input: z.input<typeof internalRolloutMaterialV1Schema>,
): InternalCompactionRolloutEvidenceV1 {
  const material = internalRolloutMaterialV1Schema.parse(input);
  verifyGateLedger(material.gateLedger, material.startedAt, material.endedAt);
  return internalCompactionRolloutEvidenceV1Schema.parse({
    ...material,
    evidenceDigest: sha256DomainSeparated(
      'kite.compaction.internal-rollout-evidence.v1',
      canonicalJson(material),
    ),
  });
}

export function verifyInternalCompactionRolloutEvidenceV1(input: {
  evidence: unknown;
  expected: CompactionRolloutExpectedIdentityV1;
  verifiedAt: string;
  maximumAgeSeconds: number;
}): InternalCompactionRolloutVerificationV1 {
  const evidence = internalCompactionRolloutEvidenceV1Schema.parse(input.evidence);
  assertExpectedIdentity(evidence, input.expected);
  const { evidenceDigest: _evidenceDigest, ...materialInput } = evidence;
  const material = internalRolloutMaterialV1Schema.parse(materialInput);
  const rebuiltEvidenceDigest = sha256DomainSeparated(
    'kite.compaction.internal-rollout-evidence.v1',
    canonicalJson(material),
  );
  if (rebuiltEvidenceDigest !== evidence.evidenceDigest)
    throw new Error('evidence_digest_mismatch');
  verifyGateLedger(evidence.gateLedger, evidence.startedAt, evidence.endedAt);

  const reasons = new Set<string>(['authenticated_internal_rollout_authority_not_configured']);
  for (const stage of evidence.stages) {
    if (stage.outcome !== 'passed' || stage.sampleCount === 0) {
      reasons.add(`${stage.stage}_not_passed`);
    }
  }
  const shadow = evidence.stages[1];
  if (shadow.summaryDispatchCount !== 0) reasons.add('internal_shadow_summary_dispatch_observed');
  if (shadow.checkpointWriteCount !== 0) reasons.add('internal_shadow_checkpoint_write_observed');
  addGateReasons(evidence.gateLedger, reasons, [
    'continuation_non_inferiority',
    'false_trigger_bound',
    'resource_bound',
    'rollback_rehearsal',
  ]);
  addFreshnessReason(evidence.endedAt, input.verifiedAt, input.maximumAgeSeconds, reasons);
  const withoutDigest = {
    schema: 'InternalCompactionRolloutVerificationV1' as const,
    status: 'blocked' as const,
    evidenceEligible: false as const,
    authenticatedAuthorityConfigured: false as const,
    effectiveStage: 'off' as const,
    milestone: null,
    evidenceDigest: evidence.evidenceDigest as `sha256:${string}`,
    gateLedgerDigest: evidence.gateLedger.ledgerDigest as `sha256:${string}`,
    reasonCodes: [...reasons].sort(),
  };
  return {
    ...withoutDigest,
    verificationDigest: sha256DomainSeparated(
      'kite.compaction.internal-rollout-verification.v1',
      canonicalJson(withoutDigest),
    ),
  };
}

const externalShadowMaterialV1Schema = z
  .object({
    schema: z.literal('ExternalCompactionShadowEvidenceV1'),
    identity: compactionRolloutIdentityV1Schema,
    source: compactionRolloutSourceV1Schema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    consent: z
      .object({
        schema: z.literal('ExternalCompactionShadowConsentV1'),
        consentId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/),
        policyRevision: z.string().min(1).max(256),
        cohortDigest: digestSchema,
        required: z.literal(true),
        granted: z.boolean(),
        grantedAt: timestampSchema,
        receiptDigest: digestSchema,
        authentication: z
          .object({
            kind: z.literal('unconfigured'),
            reason: z.literal('external_shadow_consent_authority_not_configured'),
          })
          .strict(),
      })
      .strict(),
    observations: z
      .object({
        eligibilityEvaluationCount: z.number().int().nonnegative(),
        summaryDispatchCount: z.number().int().nonnegative(),
        checkpointWriteCount: z.number().int().nonnegative(),
        falseTriggerCount: z.number().int().nonnegative(),
        maximumFalseTriggerCount: z.number().int().nonnegative(),
        resourceSampleCount: z.number().int().nonnegative(),
        maximumCpuMillis: z.number().int().nonnegative(),
        observedMaximumCpuMillis: z.number().int().nonnegative(),
        maximumMemoryBytes: z.number().int().nonnegative(),
        observedMaximumMemoryBytes: z.number().int().nonnegative(),
      })
      .strict(),
    gateLedger: compactionGateLedgerV1Schema,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (Date.parse(evidence.endedAt) < Date.parse(evidence.startedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'endedAt precedes startedAt.',
      });
    }
    if (
      evidence.startedAt !== evidence.source.startedAt ||
      evidence.endedAt !== evidence.source.endedAt
    ) {
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'source and shadow windows must match.',
      });
    }
    if (Date.parse(evidence.consent.grantedAt) > Date.parse(evidence.startedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['consent', 'grantedAt'],
        message: 'consent must precede the shadow window.',
      });
    }
  });

export const externalCompactionShadowEvidenceV1Schema = externalShadowMaterialV1Schema.extend({
  evidenceDigest: digestSchema,
});

export interface ExternalCompactionShadowGateV1 {
  schema: 'ExternalCompactionShadowGateV1';
  status: 'blocked';
  evidenceEligible: false;
  authenticatedAuthorityConfigured: false;
  permittedSummaryDispatches: 0;
  permittedCheckpointWrites: 0;
  observedSummaryDispatches: number;
  observedCheckpointWrites: number;
  profileDiff: { capability: 'auto_compaction'; maxRollout: 'off'; cohortMaximum: 0 };
  evidenceDigest: `sha256:${string}`;
  gateLedgerDigest: `sha256:${string}`;
  reasonCodes: string[];
  gateDigest: `sha256:${string}`;
}

export function buildExternalCompactionShadowEvidenceV1(
  input: z.input<typeof externalShadowMaterialV1Schema>,
): z.infer<typeof externalCompactionShadowEvidenceV1Schema> {
  const material = externalShadowMaterialV1Schema.parse(input);
  verifyGateLedger(material.gateLedger, material.startedAt, material.endedAt);
  return externalCompactionShadowEvidenceV1Schema.parse({
    ...material,
    evidenceDigest: sha256DomainSeparated(
      'kite.compaction.external-shadow-evidence.v1',
      canonicalJson(material),
    ),
  });
}

export function evaluateExternalCompactionShadowGateV1(input: {
  evidence: unknown;
  expected: CompactionRolloutExpectedIdentityV1;
  verifiedAt: string;
  maximumAgeSeconds: number;
}): ExternalCompactionShadowGateV1 {
  const evidence = externalCompactionShadowEvidenceV1Schema.parse(input.evidence);
  assertExpectedIdentity(evidence, input.expected);
  const { evidenceDigest: _evidenceDigest, ...materialInput } = evidence;
  const material = externalShadowMaterialV1Schema.parse(materialInput);
  const rebuiltEvidenceDigest = sha256DomainSeparated(
    'kite.compaction.external-shadow-evidence.v1',
    canonicalJson(material),
  );
  if (rebuiltEvidenceDigest !== evidence.evidenceDigest)
    throw new Error('evidence_digest_mismatch');
  verifyGateLedger(evidence.gateLedger, evidence.startedAt, evidence.endedAt);

  const reasons = new Set<string>(['authenticated_external_shadow_authority_not_configured']);
  reasons.add('external_shadow_consent_authority_not_configured');
  const observation = evidence.observations;
  if (!evidence.consent.granted) reasons.add('external_shadow_consent_missing');
  if (observation.eligibilityEvaluationCount === 0) reasons.add('eligibility_not_observed');
  if (observation.summaryDispatchCount !== 0) reasons.add('shadow_summary_dispatch_observed');
  if (observation.checkpointWriteCount !== 0) reasons.add('shadow_checkpoint_write_observed');
  if (observation.falseTriggerCount > observation.maximumFalseTriggerCount) {
    reasons.add('false_trigger_bound_exceeded');
  }
  if (
    observation.resourceSampleCount === 0 ||
    observation.observedMaximumCpuMillis > observation.maximumCpuMillis ||
    observation.observedMaximumMemoryBytes > observation.maximumMemoryBytes
  ) {
    reasons.add('resource_bound_not_satisfied');
  }
  addGateReasons(evidence.gateLedger, reasons, ['false_trigger_bound', 'resource_bound']);
  addFreshnessReason(evidence.endedAt, input.verifiedAt, input.maximumAgeSeconds, reasons);
  const withoutDigest = {
    schema: 'ExternalCompactionShadowGateV1' as const,
    status: 'blocked' as const,
    evidenceEligible: false as const,
    authenticatedAuthorityConfigured: false as const,
    permittedSummaryDispatches: 0 as const,
    permittedCheckpointWrites: 0 as const,
    observedSummaryDispatches: observation.summaryDispatchCount,
    observedCheckpointWrites: observation.checkpointWriteCount,
    profileDiff: {
      capability: 'auto_compaction' as const,
      maxRollout: 'off' as const,
      cohortMaximum: 0 as const,
    },
    evidenceDigest: evidence.evidenceDigest as `sha256:${string}`,
    gateLedgerDigest: evidence.gateLedger.ledgerDigest as `sha256:${string}`,
    reasonCodes: [...reasons].sort(),
  };
  return {
    ...withoutDigest,
    gateDigest: sha256DomainSeparated(
      'kite.compaction.external-shadow-gate.v1',
      canonicalJson(withoutDigest),
    ),
  };
}

function verifyReceiptChain(
  receipts: readonly CompactionGateReceiptV1[],
  startedAt?: string,
  endedAt?: string,
): void {
  let previous: string | null = null;
  const checks = new Set<string>();
  for (const [index, receipt] of receipts.entries()) {
    const { receiptDigest: _receiptDigest, ...materialInput } = receipt;
    const material = compactionGateReceiptMaterialV1Schema.parse(materialInput);
    const expectedDigest = sha256DomainSeparated(
      'kite.compaction.gate-receipt.v1',
      canonicalJson(material),
    );
    if (
      receipt.sequence !== index + 1 ||
      receipt.previousReceiptDigest !== previous ||
      receipt.receiptDigest !== expectedDigest ||
      checks.has(receipt.check)
    ) {
      throw new Error('compaction_gate_ledger_invalid');
    }
    if (
      startedAt &&
      endedAt &&
      (Date.parse(receipt.observedAt) < Date.parse(startedAt) ||
        Date.parse(receipt.observedAt) > Date.parse(endedAt))
    ) {
      throw new Error('compaction_gate_receipt_outside_observation_window');
    }
    checks.add(receipt.check);
    previous = receipt.receiptDigest;
  }
}

function verifyGateLedger(
  ledger: CompactionGateLedgerV1,
  startedAt?: string,
  endedAt?: string,
): void {
  const parsed = compactionGateLedgerV1Schema.parse(ledger);
  verifyReceiptChain(parsed.receipts, startedAt, endedAt);
  const material = compactionGateLedgerMaterialV1Schema.parse({
    schema: parsed.schema,
    receipts: parsed.receipts,
  });
  const expected = sha256DomainSeparated(
    'kite.compaction.g3-g4-ledger.v1',
    canonicalJson(material),
  );
  if (parsed.ledgerDigest !== expected) throw new Error('compaction_gate_ledger_digest_mismatch');
}

function assertExpectedIdentity(
  evidence: {
    identity: z.infer<typeof compactionRolloutIdentityV1Schema>;
    source: z.infer<typeof compactionRolloutSourceV1Schema>;
    startedAt: string;
    endedAt: string;
  },
  expected: CompactionRolloutExpectedIdentityV1,
): void {
  const expectedIdentity = compactionRolloutIdentityV1Schema.parse(expected.identity);
  const expectedSource = compactionRolloutSourceV1Schema.parse(expected.source);
  if (
    canonicalJson(evidence.identity) !== canonicalJson(expectedIdentity) ||
    canonicalJson(evidence.source) !== canonicalJson(expectedSource) ||
    evidence.source.headSha !== evidence.identity.artifactIdentity.commit ||
    evidence.source.repository !== evidence.identity.artifactIdentity.canonicalRepository ||
    evidence.source.repositoryId !== evidence.identity.artifactIdentity.repositoryId ||
    evidence.source.artifactDigest !== evidence.identity.artifactIdentity.payloadSha256 ||
    evidence.source.startedAt !== evidence.startedAt ||
    evidence.source.endedAt !== evidence.endedAt
  ) {
    throw new Error('compaction_rollout_identity_mismatch');
  }
}

function addGateReasons(
  ledger: CompactionGateLedgerV1,
  reasons: Set<string>,
  requiredChecks: readonly z.infer<typeof compactionGateCheckSchema>[],
): void {
  const receipts = new Map(ledger.receipts.map((receipt) => [receipt.check, receipt]));
  for (const check of requiredChecks) {
    const receipt = receipts.get(check);
    if (receipt?.outcome !== 'passed' || (receipt?.sampleCount ?? 0) === 0) {
      reasons.add(`${check}_not_passed`);
    }
  }
}

function addFreshnessReason(
  endedAt: string,
  verifiedAt: string,
  maximumAgeSeconds: number,
  reasons: Set<string>,
): void {
  const ended = Date.parse(endedAt);
  const verified = Date.parse(timestampSchema.parse(verifiedAt));
  if (
    !Number.isInteger(maximumAgeSeconds) ||
    maximumAgeSeconds <= 0 ||
    verified < ended ||
    verified - ended > maximumAgeSeconds * 1_000
  ) {
    reasons.add('evidence_stale_or_future');
  }
}
