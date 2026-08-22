import type { AgentPlan, PlanArtifactRef, PlanDocument, PlanStep } from '@kite/runtime-contract';
import { isPlanCompletionEvidenceV1 } from './plan-evidence';
import { computePlanStructuralDigest } from './plan-hashes';

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SAFE_STEP_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}

/** Strict JSON transport shape checked before reducer mapping or normalization. */
export function isAgentPlanTransportV2(value: unknown): value is AgentPlan {
  if (!isRecord(value) || !hasExactKeys(value, ['name', 'description', 'status', 'steps'])) {
    return false;
  }
  if (
    typeof value.name !== 'string' ||
    typeof value.description !== 'string' ||
    (value.status !== 'pending' &&
      value.status !== 'in_progress' &&
      value.status !== 'completed' &&
      value.status !== 'skipped') ||
    !Array.isArray(value.steps)
  ) {
    return false;
  }
  return value.steps.every((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ['id', 'step', 'status', 'note']) ||
      typeof candidate.step !== 'string' ||
      (candidate.status !== 'pending' &&
        candidate.status !== 'in_progress' &&
        candidate.status !== 'completed' &&
        candidate.status !== 'skipped') ||
      (candidate.id !== undefined && typeof candidate.id !== 'string') ||
      (candidate.note !== undefined && typeof candidate.note !== 'string')
    ) {
      return false;
    }
    return true;
  });
}

/** Exact public transport match used when replaying an idempotent immutable V2 draft. */
export function agentPlanTransportMatchesDocumentV2(
  value: unknown,
  document: PlanDocument,
): value is AgentPlan {
  if (
    !isAgentPlanTransportV2(value) ||
    value.name !== document.title ||
    value.description !== document.bodyMarkdown ||
    value.status !== 'pending' ||
    value.steps.length !== document.steps.length
  ) {
    return false;
  }
  return value.steps.every((candidate, index) => {
    const step = document.steps[index];
    return (
      step !== undefined &&
      candidate.id === step.id &&
      candidate.step === step.title &&
      candidate.status === step.status &&
      candidate.note === step.note &&
      Object.hasOwn(candidate, 'note') === (step.note !== undefined)
    );
  });
}

export function isPlanStepMetadata(value: unknown): value is PlanStep {
  if (!isRecord(value)) return false;
  const keys = Object.hasOwn(value, 'note')
    ? ['id', 'title', 'status', 'note']
    : ['id', 'title', 'status'];
  return (
    hasExactKeys(value, keys) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    (value.status === 'pending' ||
      value.status === 'in_progress' ||
      value.status === 'completed' ||
      value.status === 'skipped') &&
    (value.note === undefined || typeof value.note === 'string')
  );
}

export function isPlanStepV2(value: unknown): value is PlanStep {
  return (
    isPlanStepMetadata(value) &&
    SAFE_STEP_ID.test(value.id) &&
    value.title === value.title.trim() &&
    value.title.length >= 1 &&
    value.title.length <= 160 &&
    !/[\r\n]/.test(value.title)
  );
}

/** Validate a full V2 progress/completion transport before reducer mapping. */
export function planStepsFromAgentPlanUpdateV2(
  value: unknown,
  document: PlanDocument,
): PlanStep[] | null {
  if (!isAgentPlanTransportV2(value) || value.name !== document.title) return null;
  if (value.description !== document.bodyMarkdown || value.steps.length !== document.steps.length) {
    return null;
  }
  const steps: PlanStep[] = [];
  for (const [index, candidate] of value.steps.entries()) {
    if (candidate.id == null) return null;
    const step: PlanStep = {
      id: candidate.id,
      title: candidate.step,
      status: candidate.status,
      ...(candidate.note === undefined ? {} : { note: candidate.note }),
    };
    const existing = document.steps[index];
    if (
      !existing ||
      !isPlanStepV2(step) ||
      step.id !== existing.id ||
      step.title !== existing.title
    ) {
      return null;
    }
    steps.push(step);
  }
  return new Set(steps.map((step) => step.id)).size === steps.length ? steps : null;
}

function isPlanArtifactRefV2(value: unknown, plan: PlanDocument): value is PlanArtifactRef {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'artifactId',
      'taskId',
      'planId',
      'version',
      'fileName',
      'relativePath',
      'displayPath',
      'structuralDigest',
      'byteLength',
    ])
  ) {
    return false;
  }
  return (
    value.artifactId === `${plan.planId}:v${plan.version}` &&
    typeof value.taskId === 'string' &&
    SAFE_SEGMENT.test(value.taskId) &&
    value.planId === plan.planId &&
    value.version === plan.version &&
    value.fileName === `v${plan.version}.md` &&
    typeof value.relativePath === 'string' &&
    value.relativePath.length > 0 &&
    typeof value.displayPath === 'string' &&
    value.displayPath.length > 0 &&
    value.structuralDigest === plan.structuralDigest &&
    Number.isInteger(value.byteLength) &&
    (value.byteLength as number) >= 0
  );
}

/**
 * Canonical fail-closed validator for newly written/replayed PlanDocument V2.
 * Persistence, the facade, and reducer replay all use this one definition so
 * malformed event content cannot be normalized into a valid document.
 */
export function isPlanDocumentV2(value: unknown): value is PlanDocument & {
  planSchemaVersion: 2;
} {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      'planSchemaVersion',
      'planId',
      'version',
      'title',
      'bodyMarkdown',
      'steps',
      'structuralDigest',
      'createdAtTurnId',
      'updatedAtTurnId',
      'supersedesPlanVersion',
      'replanReason',
      'completionEvidence',
      'artifact',
    ])
  ) {
    return false;
  }
  if (
    value.planSchemaVersion !== 2 ||
    typeof value.planId !== 'string' ||
    !SAFE_SEGMENT.test(value.planId) ||
    !Number.isInteger(value.version) ||
    (value.version as number) < 1 ||
    typeof value.title !== 'string' ||
    value.title !== value.title.trim() ||
    value.title.length < 1 ||
    value.title.length > 120 ||
    /[\r\n]/.test(value.title) ||
    typeof value.bodyMarkdown !== 'string' ||
    value.bodyMarkdown !== value.bodyMarkdown.trim() ||
    value.bodyMarkdown.length < 20 ||
    value.bodyMarkdown.length > 30_000 ||
    !Array.isArray(value.steps) ||
    value.steps.length < 1 ||
    value.steps.length > 12 ||
    !value.steps.every(isPlanStepV2) ||
    new Set(value.steps.map((step) => step.id)).size !== value.steps.length ||
    typeof value.structuralDigest !== 'string' ||
    !SHA256_DIGEST.test(value.structuralDigest) ||
    typeof value.createdAtTurnId !== 'string' ||
    value.createdAtTurnId.length < 1 ||
    typeof value.updatedAtTurnId !== 'string' ||
    value.updatedAtTurnId.length < 1 ||
    !isPlanCompletionEvidenceV1(value.completionEvidence) ||
    !hasValidPlanRevisionMetadata(value)
  ) {
    return false;
  }
  const plan = value as unknown as PlanDocument;
  return (
    computePlanStructuralDigest(plan) === plan.structuralDigest &&
    (value.artifact === undefined || isPlanArtifactRefV2(value.artifact, plan))
  );
}

/** Shared runtime validation for the optional revision metadata present in V1 and V2 plans. */
export function hasValidPlanRevisionMetadata(value: {
  supersedesPlanVersion?: unknown;
  replanReason?: unknown;
}): boolean {
  return (
    (value.supersedesPlanVersion === undefined ||
      (Number.isInteger(value.supersedesPlanVersion) &&
        (value.supersedesPlanVersion as number) >= 1)) &&
    (value.replanReason === undefined ||
      (typeof value.replanReason === 'string' && value.replanReason.length <= 500))
  );
}
