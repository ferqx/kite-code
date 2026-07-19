import { dirname, relative } from 'node:path';
import { digestCapability } from '@/core/capabilities/catalog';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { SkillActivation } from '@/core/runtime/state';
import type { SkillWorkflowContract } from '@/core/skills/workflow';
import type { EffectProfile } from '@/protocol/capabilities';
import type { VerificationCheck, VerificationSpecV1 } from '@/protocol/verification';
import { resolveVerificationMode } from './policy';

export function verificationRequestForUser(input: {
  spec: VerificationSpecV1;
  baseline?: 'not_required' | 'best_effort' | 'required';
  requestedMode: 'best_effort' | 'required';
  requestedAt?: string;
}): Extract<RuntimeEvent, { type: 'verification.requested' }> {
  return {
    type: 'verification.requested',
    verificationId: input.spec.verificationId,
    ...(input.spec.taskId ? { taskId: input.spec.taskId } : {}),
    mode: resolveVerificationMode({ baseline: input.baseline, userMode: input.requestedMode }),
    spec: input.spec,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
  };
}

export function verificationRequestForCapability(input: {
  invocationId: string;
  capabilityId: string;
  effects: EffectProfile;
  taskId?: string;
  externalReferences?: string[];
  requestedAt?: string;
}): Extract<RuntimeEvent, { type: 'verification.requested' }> {
  const verificationId = digestCapability({
    type: 'capability-verification',
    invocationId: input.invocationId,
  });
  const checks: VerificationCheck[] = [];
  if (input.externalReferences?.length) {
    checks.push({
      checkId: 'external-reference',
      type: 'external_reference',
      description: 'Confirm that execution produced a durable external reference.',
      invocationId: input.invocationId,
    });
  }
  checks.push({
    checkId: 'independent-review',
    type: 'reviewer',
    description: 'Review the original execution receipt and immutable evidence.',
    invocationIds: [input.invocationId],
    instructions: `Determine whether ${input.capabilityId} achieved its externally visible outcome.`,
  });
  const spec: VerificationSpecV1 = {
    schemaVersion: 1,
    verificationId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    subject: `capability invocation ${input.capabilityId}`,
    checks,
    repair: { maxAttempts: 2 },
  };
  return {
    type: 'verification.requested',
    verificationId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    mode: resolveVerificationMode({ capabilityEffects: input.effects }),
    spec,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
  };
}

export function verificationRequestForSkill(input: {
  activation: SkillActivation;
  contract: SkillWorkflowContract;
  sourcePath: string;
  workspace: string;
  requestedAt?: string;
}): Extract<RuntimeEvent, { type: 'verification.requested' }> | undefined {
  const mode = resolveVerificationMode({
    skillMode: input.contract.verification.mode,
    capabilityEffects: input.contract.effectiveEffects,
  });
  if (mode === 'not_required') return undefined;
  const verificationId = digestCapability({
    type: 'skill-verification',
    activationId: input.activation.activationId,
    skillRevision: input.activation.skillRevision,
  });
  const checks: VerificationCheck[] = [];
  if (input.contract.verification.strategy === 'script' && input.contract.verification.entrypoint) {
    const skillDirectory = dirname(input.sourcePath);
    const cwd = relative(input.workspace, skillDirectory).replaceAll('\\', '/');
    checks.push({
      checkId: 'skill-script',
      type: 'command',
      description: 'Run the Workflow Contract verification entrypoint.',
      command: `bun run ${shellQuote(input.contract.verification.entrypoint)}`,
      cwd,
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
  const spec: VerificationSpecV1 = {
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
