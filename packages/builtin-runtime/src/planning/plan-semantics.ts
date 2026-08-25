import { createHash } from 'node:crypto';
import type { AgentPlan, PlanDocument, PlanStep } from '@kite-ai/runtime-contract';
import { isPlanDocument } from './plan-document';
import { computePlanStructuralDigest } from './plan-hashes';

/** The State V2 plan identity used by the Builtin planning projection. */
export function initialPlanId(taskId: string): string {
  return `plan-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`;
}

export interface BuiltinPlanStepInput {
  readonly id: string;
  readonly title: string;
}

export interface BuiltinPlanRevisionInput {
  readonly supersedesPlanVersion: number;
  readonly replanReason: string;
}

export interface CreateBuiltinPlanDocumentInput {
  readonly taskId: string;
  readonly turnId: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly steps: readonly BuiltinPlanStepInput[];
  readonly previous?: PlanDocument;
  /** Explicit revision metadata supplied by the Kernel/App command decision. */
  readonly revision?: BuiltinPlanRevisionInput;
  /** Reuse an already-persisted canonical revision on an idempotent retry. */
  readonly canonicalRevisionIsSaved?: boolean;
}

function emptyCompletionEvidence(): PlanDocument['completionEvidence'] {
  return {
    schemaVersion: 1,
    verification: [],
    execution: [],
    skipped: [],
    unresolved: [],
  };
}

/**
 * Construct a metadata-only State PlanDocument V2 candidate.
 *
 * Artifact persistence and Kernel event admission remain outside this helper.
 * `isPlanDocument` is intentionally used only as Builtin parser/artifact
 * prevalidation; the State reducer/completion guard remains the final
 * persisted-state authority in Agent Kernel.
 */
export function createBuiltinPlanDocument(input: CreateBuiltinPlanDocumentInput): PlanDocument {
  const previous = input.previous;
  const inheritedRevision =
    input.revision ??
    (previous?.supersedesPlanVersion == null
      ? undefined
      : {
          supersedesPlanVersion: previous.supersedesPlanVersion,
          replanReason: previous.replanReason ?? '',
        });
  const candidate: PlanDocument = {
    planSchemaVersion: 2,
    // Task-derived v1 identity makes publication-before-event-commit retries
    // idempotent while preserving the old RM identity contract.
    planId: previous?.planId ?? initialPlanId(input.taskId),
    version: (previous?.version ?? 0) + 1,
    title: input.title,
    bodyMarkdown: input.bodyMarkdown,
    steps: input.steps.map(
      (step): PlanStep => ({
        id: step.id,
        title: step.title,
        status: 'pending',
      }),
    ),
    structuralDigest: '',
    createdAtTurnId: input.turnId,
    updatedAtTurnId: input.turnId,
    completionEvidence: emptyCompletionEvidence(),
    ...(inheritedRevision == null ? {} : inheritedRevision),
  };
  candidate.structuralDigest = computePlanStructuralDigest(candidate);

  const document =
    previous != null &&
    input.canonicalRevisionIsSaved === true &&
    previous.structuralDigest === candidate.structuralDigest
      ? previous
      : candidate;
  if (!isPlanDocument(document)) {
    throw new Error('PlanDocument V2 schema validation failed.');
  }
  return document;
}

/** Stable model-facing projection; it contains no artifact body or evidence. */
export function projectBuiltinPublicPlan(document: PlanDocument): AgentPlan {
  return {
    name: document.title,
    description: document.bodyMarkdown,
    status: 'pending',
    steps: document.steps.map((step) => ({
      step: step.title,
      id: step.id,
      status: step.status,
      ...(step.note === undefined ? {} : { note: step.note }),
    })),
  };
}

/**
 * Check whether a replan draft is the saved canonical next revision. This is
 * a structural identity fact for the Kernel/App adapter, not persistence.
 */
export function isBuiltinSavedReplanRevision(
  document: PlanDocument,
  revision: BuiltinPlanRevisionInput,
): boolean {
  return (
    document.version > revision.supersedesPlanVersion &&
    document.supersedesPlanVersion === revision.supersedesPlanVersion &&
    document.replanReason === revision.replanReason
  );
}
