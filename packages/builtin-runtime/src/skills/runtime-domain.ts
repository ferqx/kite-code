import { dirname, relative } from 'node:path';
import { digestCapabilityValueV1 } from './capability-domain';
import type { SkillWorkflowContract } from './workflow';

export interface SkillFeatureFlagsV1 {
  skillActivationV2: boolean;
  skillWorkflowV1: boolean;
}

export interface SkillActivationV1 {
  activationId: string;
  skillId: string;
  skillRevision: string;
  taskId: string;
  input: unknown;
  contextMode: 'inline' | 'fork';
  agent: string;
  capabilityCeiling: readonly string[];
  verificationMode: 'not_required' | 'best_effort' | 'required';
  requestedBy: 'user' | 'model';
  activatedAt: string;
}

export interface SkillFrameV1 extends SkillActivationV1 {
  status: 'active' | 'closed' | 'invalidated';
  closedAt?: string;
  closeReason?: string;
  output?: Readonly<Record<string, unknown>>;
}

export interface SkillRuntimeStateViewV1 {
  activeTaskId: string | null;
  session: { workspace: string };
  skills: {
    catalogRevision: string;
    frames: Record<string, SkillFrameV1>;
  };
}

export interface SkillForkResultV1 {
  ok: boolean;
  summary: string;
  error?: string;
}

type SkillVerificationCheckV1 =
  | {
      checkId: string;
      type: 'command';
      description: string;
      command: string;
      cwd?: string;
      timeoutMs?: number;
      expectedExitCode?: number;
    }
  | {
      checkId: string;
      type: 'reviewer';
      description: string;
      activationIds?: string[];
      instructions: string;
    };

interface SkillVerificationSpecV1 {
  schemaVersion: 1;
  verificationId: string;
  taskId?: string;
  subject: string;
  checks: SkillVerificationCheckV1[];
  repair: { maxAttempts: number };
  compensation?: { command: string; cwd?: string; timeoutMs?: number };
}

export type SkillRuntimeEventV1 =
  | { type: 'skill.catalog_refreshed'; catalogRevision: string }
  | { type: 'skill.activation_started'; activation: SkillActivationV1 }
  | {
      type: 'skill.frame_closed';
      activationId: string;
      status: 'closed' | 'invalidated';
      reason: string;
      closedAt: string;
      output?: Record<string, unknown>;
    }
  | {
      type: 'verification.requested';
      verificationId: string;
      taskId: string;
      mode: 'best_effort' | 'required';
      spec: SkillVerificationSpecV1;
      requestedAt: string;
    };

export function verificationRequestForSkillV1(input: {
  activation: SkillActivationV1;
  contract: SkillWorkflowContract;
  sourcePath: string;
  workspace: string;
  requestedAt?: string;
}): Extract<SkillRuntimeEventV1, { type: 'verification.requested' }> | undefined {
  const mode = resolveVerificationModeV1(input.contract);
  if (mode === 'not_required') return undefined;
  const verificationId = digestCapabilityValueV1({
    type: 'skill-verification',
    activationId: input.activation.activationId,
    skillRevision: input.activation.skillRevision,
  });
  const checks: SkillVerificationCheckV1[] = [];
  if (input.contract.verification.strategy === 'script' && input.contract.verification.entrypoint) {
    const skillDirectory = dirname(input.sourcePath);
    checks.push({
      checkId: 'skill-script',
      type: 'command',
      description: 'Run the Workflow Contract verification entrypoint.',
      command: `bun run ${shellQuoteV1(input.contract.verification.entrypoint)}`,
      cwd: relative(input.workspace, skillDirectory).replaceAll('\\', '/'),
      timeoutMs: input.contract.verification.timeoutMs,
      expectedExitCode: 0,
    });
  } else {
    checks.push({
      checkId: 'skill-output-review',
      type: 'reviewer',
      description: 'Review the validated Workflow Contract output as independent evidence.',
      activationIds: [input.activation.activationId],
      instructions: `Determine whether the structured output establishes completion of ${input.activation.skillId}.`,
    });
  }
  const spec: SkillVerificationSpecV1 = {
    schemaVersion: 1,
    verificationId,
    taskId: input.activation.taskId,
    subject: `Skill ${input.activation.skillId}`,
    checks,
    repair: { maxAttempts: input.contract.execution.maxAttempts },
    ...(input.contract.recovery.compensation
      ? {
          compensation: {
            command: `bun run ${shellQuoteV1(input.contract.recovery.compensation)}`,
            cwd: relative(input.workspace, dirname(input.sourcePath)).replaceAll('\\', '/'),
            timeoutMs: input.contract.execution.timeoutMs,
          },
        }
      : {}),
  };
  return {
    type: 'verification.requested',
    verificationId,
    taskId: input.activation.taskId,
    mode,
    spec,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
  };
}

function resolveVerificationModeV1(
  contract: SkillWorkflowContract,
): 'not_required' | 'best_effort' | 'required' {
  if (
    [
      contract.effectiveEffects.filesystem,
      contract.effectiveEffects.network,
      contract.effectiveEffects.externalState,
    ].some((effect) => effect === 'write' || effect === 'destructive' || effect === 'unknown')
  ) {
    return 'required';
  }
  return contract.verification.mode;
}

function shellQuoteV1(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
