import { z } from 'zod';
import { canonicalJson, sha256DomainSeparated } from '../release/canonical-json';
import { releaseArtifactIdentityV1Schema } from '../release/evidence-schema';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const timestampSchema = z.iso.datetime({ offset: true });
const MAX_RETAINED_SAMPLES = 10_000;

export const limitedSloGithubSourceV1Schema = z
  .object({
    repository: z.literal('ferqx/kite-code'),
    repositoryId: z.literal('R_kgDOSKbi8g'),
    headSha: commitSchema,
    ref: z.string().startsWith('refs/'),
    workflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
    workflowRef: z.string().includes('/.github/workflows/'),
    workflowSha: commitSchema,
    runId: z.string().regex(/^[1-9][0-9]*$/),
    runAttempt: z.number().int().positive(),
    jobName: z.string().min(1),
    jobId: z.string().regex(/^[1-9][0-9]*$/),
    artifactName: z.string().min(1),
    artifactId: z.string().regex(/^[1-9][0-9]*$/),
    artifactDigest: digestSchema,
    oidcIssuer: z.literal('https://token.actions.githubusercontent.com'),
    attestationSubjectDigest: digestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const canonicalWorkflowRef = `${value.repository}/${value.workflowPath}@${value.ref}`;
    if (value.workflowRef !== canonicalWorkflowRef) {
      context.addIssue({
        code: 'custom',
        path: ['workflowRef'],
        message: 'Workflow ref must bind the canonical repository, workflow path, and ref.',
      });
    }
  });

export const limitedSloG0V1Schema = z
  .object({
    unauthorized_side_effects: z.number().int().nonnegative(),
    secret_or_content_egress: z.number().int().nonnegative(),
    sandbox_or_workspace_escape: z.number().int().nonnegative(),
    runtime_state_corruption: z.number().int().nonnegative(),
    required_verification_bypass: z.number().int().nonnegative(),
  })
  .strict();

const admissionMaterialSchema = z
  .object({
    schema: z.literal('LimitedSloAdmissionV1'),
    sequence: z.number().int().positive().max(MAX_RETAINED_SAMPLES),
    admissionId: z.string().regex(/^admission_[a-f0-9]{32}$/),
    previousAdmissionDigest: digestSchema.nullable(),
    admittedAt: timestampSchema,
    consentReceiptDigest: digestSchema,
  })
  .strict();

export const limitedSloAdmissionV1Schema = admissionMaterialSchema.extend({
  admissionDigest: digestSchema,
});

const terminalReceiptMaterialSchema = z
  .object({
    schema: z.literal('LimitedSloTerminalReceiptV1'),
    sequence: z.number().int().positive().max(MAX_RETAINED_SAMPLES),
    terminalReceiptId: z.string().regex(/^terminal_[a-f0-9]{32}$/),
    admissionId: z.string().regex(/^admission_[a-f0-9]{32}$/),
    admissionDigest: digestSchema,
    previousTerminalDigest: digestSchema.nullable(),
    finalizedAt: timestampSchema,
    outcomeReceiptDigest: digestSchema,
    checksPassed: z.boolean(),
    humanAccepted: z.boolean(),
    recoveryRequired: z.boolean(),
    recoverySucceeded: z.boolean(),
    unrelatedDiff: z.boolean(),
    falseCompletion: z.boolean(),
    integrated: z.boolean(),
    reverted: z.boolean(),
    g0: limitedSloG0V1Schema,
    g1Failures: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.recoveryRequired && value.recoverySucceeded) {
      context.addIssue({
        code: 'custom',
        path: ['recoverySucceeded'],
        message: 'A non-required recovery cannot claim success.',
      });
    }
    if (value.reverted && !value.integrated) {
      context.addIssue({
        code: 'custom',
        path: ['reverted'],
        message: 'A non-integrated sample cannot be reverted.',
      });
    }
  });

export const limitedSloTerminalReceiptV1Schema = terminalReceiptMaterialSchema.safeExtend({
  terminalDigest: digestSchema,
});

const ledgerMaterialSchema = z
  .object({
    schema: z.literal('LimitedSloSampleLedgerV1'),
    policyDigest: digestSchema,
    limitedApprovalDecisionDigest: digestSchema,
    artifactIdentity: releaseArtifactIdentityV1Schema,
    routeDigest: digestSchema,
    cohortDigest: digestSchema,
    source: limitedSloGithubSourceV1Schema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    droppedSampleCount: z.literal(0),
    consentCompliant: z.literal(true),
    ownerAvailable: z.boolean(),
    ownerAvailabilityReceiptDigest: digestSchema,
    killSwitchAvailable: z.boolean(),
    killSwitchReceiptDigest: digestSchema,
    admissions: z.array(limitedSloAdmissionV1Schema).max(MAX_RETAINED_SAMPLES),
    terminalReceipts: z.array(limitedSloTerminalReceiptV1Schema).max(MAX_RETAINED_SAMPLES),
  })
  .strict();

export const limitedSloSampleLedgerV1Schema = ledgerMaterialSchema.extend({
  ledgerDigest: digestSchema,
});

export type LimitedSloGithubSourceV1 = z.infer<typeof limitedSloGithubSourceV1Schema>;
export type LimitedSloAdmissionMaterialV1 = z.infer<typeof admissionMaterialSchema>;
export type LimitedSloAdmissionV1 = z.infer<typeof limitedSloAdmissionV1Schema>;
export type LimitedSloTerminalReceiptMaterialV1 = z.infer<typeof terminalReceiptMaterialSchema>;
export type LimitedSloTerminalReceiptV1 = z.infer<typeof limitedSloTerminalReceiptV1Schema>;
export type LimitedSloSampleLedgerMaterialV1 = z.infer<typeof ledgerMaterialSchema>;
export type LimitedSloSampleLedgerV1 = z.infer<typeof limitedSloSampleLedgerV1Schema>;

export interface LimitedSloRebuildV1 {
  schema: 'LimitedSloRebuildV1';
  startedAt: string;
  endedAt: string;
  sampleCount: number;
  noData: boolean;
  consentCompliant: true;
  ownerAvailable: boolean;
  killSwitchAvailable: boolean;
  droppedSampleCount: 0;
  g0: z.infer<typeof limitedSloG0V1Schema>;
  g1Failures: number;
  denominators: {
    tasks: number;
    recoveryRequired: number;
    integrated: number;
  };
  errorBudgetBurn: number;
  metrics: {
    task_checks_passed: number;
    human_accepted: number;
    recovery_success: number;
    unrelated_diff: number;
    false_completion: number;
    integrated: number;
    reverted: number;
  };
  ledgerDigest: `sha256:${string}`;
  rebuildDigest: `sha256:${string}`;
}

export function computeLimitedSloAdmissionDigestV1(
  input: LimitedSloAdmissionMaterialV1,
): `sha256:${string}` {
  const material = admissionMaterialSchema.parse(input);
  return sha256DomainSeparated('kite.operations.limited-slo-admission.v1', canonicalJson(material));
}

export function buildLimitedSloAdmissionV1(
  input: LimitedSloAdmissionMaterialV1,
): LimitedSloAdmissionV1 {
  const material = admissionMaterialSchema.parse(input);
  return limitedSloAdmissionV1Schema.parse({
    ...material,
    admissionDigest: computeLimitedSloAdmissionDigestV1(material),
  });
}

export function computeLimitedSloTerminalDigestV1(
  input: LimitedSloTerminalReceiptMaterialV1,
): `sha256:${string}` {
  const material = terminalReceiptMaterialSchema.parse(input);
  return sha256DomainSeparated('kite.operations.limited-slo-terminal.v1', canonicalJson(material));
}

export function buildLimitedSloTerminalReceiptV1(
  input: LimitedSloTerminalReceiptMaterialV1,
): LimitedSloTerminalReceiptV1 {
  const material = terminalReceiptMaterialSchema.parse(input);
  return limitedSloTerminalReceiptV1Schema.parse({
    ...material,
    terminalDigest: computeLimitedSloTerminalDigestV1(material),
  });
}

export function computeLimitedSloLedgerDigestV1(
  input: LimitedSloSampleLedgerMaterialV1,
): `sha256:${string}` {
  const material = ledgerMaterialSchema.parse(input);
  return sha256DomainSeparated('kite.operations.limited-slo-ledger.v1', canonicalJson(material));
}

export function buildLimitedSloSampleLedgerV1(
  input: LimitedSloSampleLedgerMaterialV1,
): LimitedSloSampleLedgerV1 {
  const material = ledgerMaterialSchema.parse(input);
  const ledger = limitedSloSampleLedgerV1Schema.parse({
    ...material,
    ledgerDigest: computeLimitedSloLedgerDigestV1(material),
  });
  verifyLimitedSloSampleLedgerV1(ledger);
  return ledger;
}

export function verifyLimitedSloSampleLedgerV1(raw: unknown): LimitedSloSampleLedgerV1 {
  const ledger = limitedSloSampleLedgerV1Schema.parse(raw);
  if (Date.parse(ledger.endedAt) < Date.parse(ledger.startedAt)) {
    throw new Error('Limited SLO ledger observation window is invalid.');
  }
  if (
    ledger.source.repository !== ledger.artifactIdentity.canonicalRepository ||
    ledger.source.repositoryId !== ledger.artifactIdentity.repositoryId ||
    ledger.source.headSha !== ledger.artifactIdentity.commit ||
    ledger.source.workflowSha !== ledger.artifactIdentity.commit ||
    ledger.source.artifactDigest !== ledger.artifactIdentity.payloadSha256 ||
    ledger.source.attestationSubjectDigest !== ledger.artifactIdentity.payloadSha256
  ) {
    throw new Error('Limited SLO source identity does not match the release artifact identity.');
  }

  const admissions = new Map<string, LimitedSloAdmissionV1>();
  let previousAdmission: string | null = null;
  let previousAdmittedAt = Number.NEGATIVE_INFINITY;
  for (const [index, admission] of ledger.admissions.entries()) {
    if (admission.sequence !== index + 1) {
      throw new Error('Limited SLO admission sequence is not contiguous.');
    }
    if (admission.previousAdmissionDigest !== previousAdmission) {
      throw new Error('Limited SLO admission digest chain is broken.');
    }
    if (admissions.has(admission.admissionId)) {
      throw new Error('Limited SLO ledger contains a duplicate admission identity.');
    }
    const { admissionDigest, ...material } = admission;
    if (admissionDigest !== computeLimitedSloAdmissionDigestV1(material)) {
      throw new Error('Limited SLO admission digest mismatch.');
    }
    if (Date.parse(admission.admittedAt) < Date.parse(ledger.startedAt)) {
      throw new Error('Limited SLO admission falls outside the observation window.');
    }
    if (Date.parse(admission.admittedAt) < previousAdmittedAt) {
      throw new Error('Limited SLO admission timestamps are not non-decreasing.');
    }
    admissions.set(admission.admissionId, admission);
    previousAdmission = admissionDigest;
    previousAdmittedAt = Date.parse(admission.admittedAt);
  }

  const terminalByAdmission = new Set<string>();
  const terminalIds = new Set<string>();
  let previousTerminal: string | null = null;
  let previousFinalizedAt = Number.NEGATIVE_INFINITY;
  for (const [index, terminal] of ledger.terminalReceipts.entries()) {
    if (terminal.sequence !== index + 1) {
      throw new Error('Limited SLO terminal receipt sequence is not contiguous.');
    }
    if (terminal.previousTerminalDigest !== previousTerminal) {
      throw new Error('Limited SLO terminal receipt digest chain is broken.');
    }
    if (terminalIds.has(terminal.terminalReceiptId)) {
      throw new Error('Limited SLO ledger contains a duplicate terminal receipt identity.');
    }
    terminalIds.add(terminal.terminalReceiptId);
    const admission = admissions.get(terminal.admissionId);
    if (!admission || terminal.admissionDigest !== admission.admissionDigest) {
      throw new Error('Limited SLO terminal receipt has no matching admission identity.');
    }
    if (terminalByAdmission.has(terminal.admissionId)) {
      throw new Error('Limited SLO admission has duplicate terminal receipts.');
    }
    terminalByAdmission.add(terminal.admissionId);
    const { terminalDigest, ...material } = terminal;
    if (terminalDigest !== computeLimitedSloTerminalDigestV1(material)) {
      throw new Error('Limited SLO terminal receipt digest mismatch.');
    }
    if (
      Date.parse(terminal.finalizedAt) < Date.parse(admission.admittedAt) ||
      Date.parse(terminal.finalizedAt) > Date.parse(ledger.endedAt)
    ) {
      throw new Error('Limited SLO terminal receipt falls outside the observation window.');
    }
    if (Date.parse(terminal.finalizedAt) < previousFinalizedAt) {
      throw new Error('Limited SLO terminal receipt timestamps are not non-decreasing.');
    }
    previousTerminal = terminalDigest;
    previousFinalizedAt = Date.parse(terminal.finalizedAt);
  }
  if (terminalByAdmission.size !== admissions.size) {
    throw new Error('Limited SLO ledger contains an orphan admission without a terminal receipt.');
  }

  const { ledgerDigest, ...material } = ledger;
  if (ledgerDigest !== computeLimitedSloLedgerDigestV1(material)) {
    throw new Error('Limited SLO ledger digest mismatch.');
  }
  return ledger;
}

export function rebuildLimitedSloObservationV1(raw: unknown): LimitedSloRebuildV1 {
  const ledger = verifyLimitedSloSampleLedgerV1(raw);
  const samples = ledger.terminalReceipts;
  const tasks = ledger.admissions.length;
  const recovery = samples.filter((sample) => sample.recoveryRequired);
  const integrated = samples.filter((sample) => sample.integrated);
  const rate = (count: number, denominator: number): number =>
    denominator === 0 ? 0 : count / denominator;
  const g0 = {
    unauthorized_side_effects: 0,
    secret_or_content_egress: 0,
    sandbox_or_workspace_escape: 0,
    runtime_state_corruption: 0,
    required_verification_bypass: 0,
  };
  let g1Failures = 0;
  for (const sample of samples) {
    for (const key of Object.keys(g0) as Array<keyof typeof g0>) g0[key] += sample.g0[key];
    g1Failures += sample.g1Failures;
  }
  const withoutDigest = {
    schema: 'LimitedSloRebuildV1' as const,
    startedAt: ledger.startedAt,
    endedAt: ledger.endedAt,
    sampleCount: tasks,
    noData: tasks === 0,
    consentCompliant: ledger.consentCompliant,
    ownerAvailable: ledger.ownerAvailable,
    killSwitchAvailable: ledger.killSwitchAvailable,
    droppedSampleCount: ledger.droppedSampleCount,
    g0,
    g1Failures,
    denominators: {
      tasks,
      recoveryRequired: recovery.length,
      integrated: integrated.length,
    },
    errorBudgetBurn: rate(samples.filter((sample) => !sample.checksPassed).length, tasks),
    metrics: {
      task_checks_passed: rate(samples.filter((sample) => sample.checksPassed).length, tasks),
      human_accepted: rate(samples.filter((sample) => sample.humanAccepted).length, tasks),
      recovery_success: rate(
        recovery.filter((sample) => sample.recoverySucceeded).length,
        recovery.length,
      ),
      unrelated_diff: rate(samples.filter((sample) => sample.unrelatedDiff).length, tasks),
      false_completion: rate(samples.filter((sample) => sample.falseCompletion).length, tasks),
      integrated: rate(integrated.length, tasks),
      reverted: rate(integrated.filter((sample) => sample.reverted).length, integrated.length),
    },
    ledgerDigest: ledger.ledgerDigest as `sha256:${string}`,
  };
  return {
    ...withoutDigest,
    rebuildDigest: sha256DomainSeparated(
      'kite.operations.limited-slo-rebuild.v1',
      canonicalJson(withoutDigest),
    ),
  };
}
