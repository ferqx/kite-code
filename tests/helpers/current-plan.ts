import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { computePlanStructuralDigest } from '@kite-ai/builtin-runtime/planning';
import type {
  AgentPlan,
  PlanArtifactRef,
  PlanCompletionEvidence,
  PlanDocument,
} from '@kite-ai/runtime-contract';

export function emptyCurrentPlanEvidence(): PlanCompletionEvidence {
  return {
    schemaVersion: 1,
    verification: [],
    execution: [],
    skipped: [],
    unresolved: [],
  };
}

export const CURRENT_TEST_PLAN_IDENTITY = Object.freeze({
  planId: 'test-plan',
  version: 1,
  structuralDigest: 'a'.repeat(64),
});

export const CURRENT_TEST_PLAN_REVIEW_FACTS = Object.freeze({
  taskId: 'test-task',
  ...CURRENT_TEST_PLAN_IDENTITY,
  artifact: currentPlanArtifact(
    CURRENT_TEST_PLAN_IDENTITY.planId,
    CURRENT_TEST_PLAN_IDENTITY.version,
    CURRENT_TEST_PLAN_IDENTITY.structuralDigest,
  ),
});

export function currentPlanArtifact(
  planId: string,
  version: number,
  structuralDigest: string,
  taskId = 'test-task',
): PlanArtifactRef {
  return {
    artifactId: `${planId}:v${version}`,
    taskId,
    planId,
    version,
    fileName: `v${version}.md`,
    relativePath: `plans/${taskId}/${planId}/v${version}.md`,
    displayPath: `/tmp/plans/${taskId}/${planId}/v${version}.md`,
    structuralDigest,
    byteLength: 1,
  };
}

export function currentPlanDocument(
  input: Omit<PlanDocument, 'planSchemaVersion' | 'completionEvidence' | 'artifact'> & {
    taskId?: string;
    completionEvidence?: PlanCompletionEvidence;
    artifact?: PlanArtifactRef;
  },
): PlanDocument {
  const { taskId, ...document } = input;
  return {
    ...document,
    planSchemaVersion: 2,
    completionEvidence: input.completionEvidence ?? emptyCurrentPlanEvidence(),
    artifact:
      input.artifact ??
      currentPlanArtifact(input.planId, input.version, input.structuralDigest, taskId),
  };
}

export function currentPlanDraftedEvent(input: {
  toolCallId: string;
  planId: string;
  version: number;
  plan: AgentPlan;
  taskId?: string;
  supersedesPlanVersion?: number;
  replanReason?: string;
}): Extract<RuntimeEvent, { type: 'plan.drafted' }> {
  const taskId = input.taskId ?? 'test-task';
  const structuralHash = computePlanStructuralDigest({
    title: input.plan.name,
    bodyMarkdown: input.plan.description,
    steps: input.plan.steps.map((step) => ({
      id: step.id ?? '',
      title: step.step,
      status: step.status,
      ...(step.note === undefined ? {} : { note: step.note }),
    })),
  });
  return {
    type: 'plan.drafted',
    toolCallId: input.toolCallId,
    planId: input.planId,
    version: input.version,
    planSchemaVersion: 2,
    plan: input.plan,
    structuralHash,
    artifact: currentPlanArtifact(input.planId, input.version, structuralHash, taskId),
    taskId,
    ...(input.supersedesPlanVersion === undefined
      ? {}
      : { supersedesPlanVersion: input.supersedesPlanVersion }),
    ...(input.replanReason === undefined ? {} : { replanReason: input.replanReason }),
  };
}
