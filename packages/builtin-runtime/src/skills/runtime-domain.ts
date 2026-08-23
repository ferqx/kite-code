import { dirname, relative } from 'node:path';
import { digestCapabilityValue } from './capability-domain';
import type { SkillWorkflowContract } from './workflow';

export interface SkillFeatureFlags {
  skillActivation: boolean;
  skillWorkflow: boolean;
}

export interface SkillActivation {
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

export interface SkillFrame extends SkillActivation {
  status: 'active' | 'closed' | 'invalidated';
  closedAt?: string;
  closeReason?: string;
  output?: Readonly<Record<string, unknown>>;
}

export interface SkillRuntimeStateView {
  activeTaskId: string | null;
  session: { workspace: string };
  skills: {
    catalogRevision: string;
    frames: Record<string, SkillFrame>;
  };
}

export interface SkillForkResult {
  ok: boolean;
  summary: string;
  error?: string;
}

type SkillVerificationCheck =
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

interface SkillVerificationSpec {
  schemaVersion: 1;
  verificationId: string;
  taskId?: string;
  subject: string;
  checks: SkillVerificationCheck[];
  repair: { maxAttempts: number };
  compensation?: { command: string; cwd?: string; timeoutMs?: number };
}

export type SkillRuntimeEvent =
  | { type: 'skill.catalog_refreshed'; catalogRevision: string }
  | { type: 'skill.activation_started'; activation: SkillActivation }
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
      spec: SkillVerificationSpec;
      requestedAt: string;
    };

export function verificationRequestForSkill(input: {
  activation: SkillActivation;
  contract: SkillWorkflowContract;
  sourcePath: string;
  workspace: string;
  requestedAt?: string;
}): Extract<SkillRuntimeEvent, { type: 'verification.requested' }> | undefined {
  const mode = resolveVerificationMode(input.contract);
  if (mode === 'not_required') return undefined;
  const verificationId = digestCapabilityValue({
    type: 'skill-verification',
    activationId: input.activation.activationId,
    skillRevision: input.activation.skillRevision,
  });
  const checks: SkillVerificationCheck[] = [];
  if (input.contract.verification.strategy === 'script' && input.contract.verification.entrypoint) {
    const skillDirectory = dirname(input.sourcePath);
    checks.push({
      checkId: 'skill-script',
      type: 'command',
      description: 'Run the Workflow Contract verification entrypoint.',
      command: `bun run ${shellQuote(input.contract.verification.entrypoint)}`,
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
  const spec: SkillVerificationSpec = {
    schemaVersion: 1,
    verificationId,
    taskId: input.activation.taskId,
    subject: `Skill ${input.activation.skillId}`,
    checks,
    repair: { maxAttempts: input.contract.execution.maxAttempts },
    ...(input.contract.recovery.compensation
      ? {
          compensation: {
            command: `bun run ${shellQuote(input.contract.recovery.compensation)}`,
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

function resolveVerificationMode(
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
