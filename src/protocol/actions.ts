import type {
  AgentPlan,
  AuthorizationMode,
  ShellGrantUsed,
  ToolApprovalPayload,
  UserInputPayload,
} from './events';

export type UserAction =
  | { type: 'approve'; grant: ShellGrantUsed }
  | { type: 'reject' }
  | { type: 'input'; text: string; answers?: Record<string, string> }
  | { type: 'cancel' }
  | { type: 'switch_auth'; mode: AuthorizationMode }
  | { type: 'approve_plan' }
  | { type: 'approve_plan_auto' }
  | { type: 'approve_plan_manual' }
  | { type: 'supplement_plan'; feedback: string }
  | { type: 'reject_plan' };

export type InterruptPayload =
  | { kind: 'approval'; approval: ToolApprovalPayload }
  | { kind: 'input'; question: UserInputPayload }
  | { kind: 'plan_review'; plan: AgentPlan };
