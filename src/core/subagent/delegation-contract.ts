import type { AgentPhase, SubAgentRole } from '@/protocol/events';

export type DelegatedTaskValidationReasonV1 = 'valid' | 'task_not_bounded';

export interface DelegatedTaskValidationV1 {
  valid: boolean;
  reason: DelegatedTaskValidationReasonV1;
}

/** Validate task structure only; delegation choice belongs to the model. */
export function validateDelegatedTaskV1(input: {
  delegatedTask: string;
}): DelegatedTaskValidationV1 {
  const task = input.delegatedTask.trim();
  if (task.length < 8 || task.length > 8_000) {
    return { valid: false, reason: 'task_not_bounded' };
  }
  return { valid: true, reason: 'valid' };
}

export function planningContinuationAfterPlanSubagentV1(input: {
  phase: AgentPhase;
  role: SubAgentRole;
  childTerminal: boolean;
  childOk?: boolean;
  childStatus?: 'completed' | 'failed' | 'cancelled' | 'exhausted' | 'suspended';
}): readonly ['write_plan:save', 'write_plan:submit'] | readonly [] {
  return input.phase === 'planning' &&
    input.role === 'plan' &&
    input.childTerminal &&
    input.childOk !== false &&
    (input.childStatus === undefined || input.childStatus === 'completed')
    ? (['write_plan:save', 'write_plan:submit'] as const)
    : [];
}
