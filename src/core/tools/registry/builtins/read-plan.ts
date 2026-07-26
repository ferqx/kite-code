import { z } from 'zod';
import { PlanArtifactError } from '@/core/persistence/plan-artifacts';
import { getActivePlanning, getActiveTask } from '@/core/runtime/state';
import { READ_PLAN_CONTRACT } from '@/core/tools/tool-contracts';
import type { ToolSpec } from '../spec';

export const readPlanInputSchema = z.object({
  plan_id: z.string().min(1),
  version: z.number().int().positive().optional(),
  structural_digest: z.string().min(1).optional(),
});

type ReadPlanOutput = { ok: boolean; stdout: string; stderr: string };

export const readPlanSpec: ToolSpec<z.infer<typeof readPlanInputSchema>, ReadPlanOutput> = {
  name: 'read_plan',
  kind: 'runtime_action',
  contract: READ_PLAN_CONTRACT.sections,
  inputSchema: readPlanInputSchema,
  declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  effects: () => ({
    effectClass: 'read_only',
    sideEffect: false,
    classificationReason: 'Reads the active immutable Plan Artifact.',
  }),
  execute: async (input, context) => {
    const runtime = context.planRuntime;
    if (!runtime) {
      return { ok: false, stdout: '', stderr: 'Plan Runtime is unavailable.' };
    }
    const planning = getActivePlanning(runtime.state);
    const task = getActiveTask(runtime.state);
    const taskId = task?.taskId ?? `legacy-${runtime.state.session.threadId}`;
    const document =
      planning.kind === 'planning_draft' ||
      planning.kind === 'replanning_draft' ||
      planning.kind === 'awaiting_review' ||
      planning.kind === 'executing' ||
      planning.kind === 'completed'
        ? planning.document
        : undefined;
    const version = input.version ?? document?.version;
    if (!document || input.plan_id !== document.planId || version !== document.version) {
      return {
        ok: false,
        stdout: '',
        stderr: 'read_plan must reference the active Task plan and its current version.',
      };
    }
    if (input.structural_digest && input.structural_digest !== document.structuralDigest) {
      return {
        ok: false,
        stdout: '',
        stderr: 'read_plan structural_digest does not match the active Artifact.',
      };
    }
    const artifactRef = document.artifact ?? {
      artifactId: `${document.planId}:v${document.version}`,
      taskId,
      planId: document.planId,
      version: document.version,
      fileName: `v${document.version}.md`,
      relativePath: '',
      displayPath: '',
      structuralDigest: document.structuralDigest,
      byteLength: 0,
    };
    try {
      const artifact = runtime.artifacts.read(artifactRef);
      return {
        ok: true,
        stdout: JSON.stringify({
          ok: true,
          status: 'plan_loaded',
          task_id: taskId,
          plan_id: artifact.plan.planId,
          version: artifact.plan.version,
          structural_digest: artifact.plan.structuralDigest,
          title: artifact.plan.title,
          body_markdown: artifact.plan.bodyMarkdown,
          steps: artifact.plan.steps,
          artifact: artifact.artifact,
        }),
        stderr: '',
      };
    } catch (error) {
      return {
        ok: false,
        stdout: '',
        stderr:
          error instanceof PlanArtifactError ? error.message : 'Unable to read the Plan Artifact.',
      };
    }
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
    display: { verb: 'Read', preview: 'Plan' },
  }),
};
